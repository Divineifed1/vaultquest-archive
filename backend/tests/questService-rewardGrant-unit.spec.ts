import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { QuestService } from "../src/services/questService.js";

function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test"
  });
}

function idempotencyKeyFor(walletAddress: string, questId: string): string {
  return createHash("sha256").update(`${walletAddress}:${questId}`).digest("hex");
}

describe("QuestService reward-grant idempotency Unit Tests (No Database Required) (#505)", () => {
  it("evaluateWallet creates a RewardGrant with a deterministic idempotencyKey when a quest newly completes", async () => {
    const rewardGrantCreate = vi.fn(async () => ({}));
    const mockPrisma = {
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        findMany: vi.fn(async () => []), // no prior rows — everything is a fresh evaluation
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: {
        create: rewardGrantCreate
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    await svc.evaluateWallet("GWALLET1");

    // first_win completes on a single confirmed claim (target: 1).
    expect(rewardGrantCreate).toHaveBeenCalledWith({
      data: {
        walletAddress: "GWALLET1",
        questId: "first_win",
        idempotencyKey: idempotencyKeyFor("GWALLET1", "first_win")
      }
    });
  });

  it("does not create a duplicate RewardGrant for a quest that was already completed", async () => {
    const rewardGrantCreate = vi.fn(async () => ({}));
    const mockPrisma = {
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        // first_win was already completed in a prior sweep.
        findMany: vi.fn(async () => [
          {
            questId: "first_win",
            progress: 1,
            status: "completed",
            completedAt: new Date("2026-01-01T00:00:00Z")
          }
        ]),
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: { create: rewardGrantCreate }
    } as any;

    const svc = new QuestService(mockPrisma);
    await svc.evaluateWallet("GWALLET1");

    expect(rewardGrantCreate).not.toHaveBeenCalled();
  });

  it("swallows a P2002 unique-violation when a grant for this wallet/quest already exists (idempotent insert)", async () => {
    const mockPrisma = {
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: {
        create: vi.fn(async () => {
          throw makeP2002Error();
        })
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    // Must not throw — a concurrent/replayed grant-intent insert racing
    // us here is the expected, correct outcome of idempotency, not an error.
    await expect(svc.evaluateWallet("GWALLET1")).resolves.toBeDefined();
  });

  it("rethrows a non-P2002 error from grant creation", async () => {
    const mockPrisma = {
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: {
        create: vi.fn(async () => {
          throw new Error("connection reset");
        })
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    await expect(svc.evaluateWallet("GWALLET1")).rejects.toThrow("connection reset");
  });
});

describe("QuestService.processGrants Unit Tests (No Database Required) (#505)", () => {
  it("marks pending grants as granted (placeholder payout, pending #505 clarification)", async () => {
    const grant = { id: "g1", attempts: 0, status: "pending" };
    const mockPrisma = {
      rewardGrant: {
        findMany: vi.fn(async () => [grant]),
        update: vi.fn(async () => ({}))
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.processGrants();

    expect(result).toEqual({ granted: 1, failed: 0 });
    expect(mockPrisma.rewardGrant.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: expect.objectContaining({ status: "granted", attempts: 1 })
    });
  });

  it("only fetches grants below maxAttempts, so exhausted grants are excluded from the query", async () => {
    const findMany = vi.fn(async () => []);
    const mockPrisma = { rewardGrant: { findMany, update: vi.fn() } } as any;

    const svc = new QuestService(mockPrisma);
    await svc.processGrants(5);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "pending", attempts: { lt: 5 } }
      })
    );
  });

  it("increments attempts and stays pending on failure below maxAttempts", async () => {
    const grant = { id: "g1", attempts: 1, status: "pending" };
    const mockPrisma = {
      rewardGrant: {
        findMany: vi.fn(async () => [grant]),
        update: vi
          .fn()
          .mockRejectedValueOnce(new Error("payout failed"))
          .mockResolvedValueOnce({})
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.processGrants(5);

    expect(result).toEqual({ granted: 0, failed: 1 });
    expect(mockPrisma.rewardGrant.update).toHaveBeenNthCalledWith(2, {
      where: { id: "g1" },
      data: {
        attempts: 2,
        lastError: "payout failed",
        status: "pending" // 2 < 5, stays pending for another retry
      }
    });
  });

  it("flips to failed (dead-letter) once attempts reaches maxAttempts", async () => {
    const grant = { id: "g1", attempts: 4, status: "pending" }; // one more failure hits maxAttempts=5
    const mockPrisma = {
      rewardGrant: {
        findMany: vi.fn(async () => [grant]),
        update: vi
          .fn()
          .mockRejectedValueOnce(new Error("payout failed"))
          .mockResolvedValueOnce({})
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.processGrants(5);

    expect(result).toEqual({ granted: 0, failed: 1 });
    expect(mockPrisma.rewardGrant.update).toHaveBeenNthCalledWith(2, {
      where: { id: "g1" },
      data: {
        attempts: 5,
        lastError: "payout failed",
        status: "failed" // 5 >= 5 maxAttempts — dead-lettered, not retried again
      }
    });
  });
});
