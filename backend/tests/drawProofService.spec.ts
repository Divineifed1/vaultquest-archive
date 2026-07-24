import { describe, it, expect, vi, beforeEach } from "vitest";
import { DrawProofService } from "../src/services/drawProofService.js";

function makeMockPrisma(overrides: Record<string, any> = {}) {
  return {
    actionLedger: {
      findUnique: vi.fn().mockResolvedValue(overrides.action ?? null),
      findMany: vi.fn().mockResolvedValue(overrides.actions ?? []),
    },
    drawProof: {
      findUnique: vi.fn().mockResolvedValue(overrides.existingProof ?? null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: "proof-uuid", createdAt: new Date(), ...data })
      ),
      update: vi.fn().mockImplementation(({ where, data }) =>
        Promise.resolve({ id: where.drawId, ...data })
      ),
      findMany: vi.fn().mockResolvedValue(overrides.proofs ?? []),
    },
  } as any;
}

function makeSelectWinnerAction(overrides: Record<string, any> = {}) {
  return {
    id: "action-123",
    idempotencyKey: "key-123",
    walletAddress: "admin-address",
    actionType: "select_winner",
    actionPayload: {
      contract_id: "CDRYPPOOL123",
      pool_id: "CDRYPPOOL123",
      round_id: 1,
      winner: "GBBD...LLFL",
      winnerAddress: "GBBD...LLFL",
      prize: "500000",
      amount: "500000",
      asset: "USDC",
      draw_ledger: 1000,
    },
    status: "confirmed",
    txHash: "tx_hash_abc",
    sorobanEventId: "evt-123",
    correlationId: "corr-123",
    errorCode: null,
    errorDetail: null,
    retryCount: 0,
    redactedAt: null,
    createdAt: new Date("2026-07-24T00:00:00Z"),
    updatedAt: new Date("2026-07-24T00:00:00Z"),
    submittedAt: new Date("2026-07-24T00:00:00Z"),
    confirmedAt: new Date("2026-07-24T00:00:01Z"),
    ...overrides,
  };
}

describe("DrawProofService", () => {
  describe("generateProof", () => {
    it("returns null if action not found", async () => {
      const prisma = makeMockPrisma({ action: null });
      const svc = new DrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "nonexistent" });
      expect(result).toBeNull();
    });

    it("returns null if action is not select_winner", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction({ actionType: "deposit" }),
      });
      const svc = new DrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBeNull();
    });

    it("returns null if action is not confirmed", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction({ status: "pending" }),
      });
      const svc = new DrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBeNull();
    });

    it("generates a proof for a confirmed select_winner action", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
      });
      const svc = new DrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });

      expect(result).not.toBeNull();
      expect(result!.drawId).toMatch(/^draw-[0-9a-f]{16}$/);
      expect(result!.roundId).toBe(1);
      expect(result!.contractId).toBe("CDRYPPOOL123");
      expect(result!.proofJson).toBeDefined();
      expect(prisma.drawProof.create).toHaveBeenCalled();
    });

    it("returns existing proof if already generated", async () => {
      const existingProof = {
        id: "existing-uuid",
        drawId: "draw-existing",
        roundId: 1,
        contractId: "CDRYPPOOL123",
        proofJson: { version: "1.0.0", drawId: "draw-existing" },
        proofHash: "hash",
        signature: "sig",
        verified: true,
        verifiedAt: new Date(),
        verificationError: null,
        createdAt: new Date(),
      };
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
        existingProof,
      });
      const svc = new DrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });

      expect(result).not.toBeNull();
      expect(result!.drawId).toBe("draw-existing");
      expect(prisma.drawProof.create).not.toHaveBeenCalled();
    });

    it("returns null if winner is missing from payload", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction({
          actionPayload: { contract_id: "C123", round_id: 1 },
        }),
      });
      const svc = new DrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBeNull();
    });
  });

  describe("verifyProof", () => {
    it("returns null if proof not found", async () => {
      const prisma = makeMockPrisma();
      const svc = new DrawProofService(prisma, null);
      const result = await svc.verifyProof("nonexistent");
      expect(result).toBeNull();
    });

    it("verifies a proof and updates verification status", async () => {
      const storedProof = {
        id: "proof-uuid",
        drawId: "draw-test-001",
        roundId: 1,
        contractId: "C123",
        proofJson: {
          version: "1.0.0",
          drawId: "draw-test-001",
          roundId: 1,
          contractId: "C123",
          snapshot: {
            ledgerSeq: 1000,
            ledgerCloseTime: "2026-07-24T00:00:00Z",
            participantsHash: "abc123",
            participantCount: 1,
            totalDeposits: "1000000",
            poolHash: "pool123",
          },
          randomness: {
            source: "deterministic_placeholder",
            seed: "seed-123",
            seedHash: "seed_hash_123",
            drawnAtLedger: 1000,
          },
          winnerSelection: {
            method: "deterministic_placeholder",
            ticketWeightsHash: "weights123",
            winnerAddress: "addr-a",
            winnerWeight: "1000000",
            totalWeight: "1000000",
            proofHash: "proof123",
          },
          payout: {
            amount: "500000",
            asset: "USDC",
            txHash: "tx_abc",
            ledgerSeq: 1001,
            recipientConfirmed: true,
          },
          metadata: {
            createdAt: "2026-07-24T00:00:00Z",
            engineVersion: "1.0.0",
            contractSpecHash: "spec",
          },
          signature: "placeholder_sig",
        },
        proofHash: "hash",
        signature: "placeholder_sig",
        verified: false,
        verifiedAt: null,
        verificationError: null,
        createdAt: new Date(),
      };

      const prisma = makeMockPrisma({ existingProof: storedProof });
      prisma.drawProof.findUnique.mockResolvedValue(storedProof);
      const svc = new DrawProofService(prisma, null);
      const result = await svc.verifyProof("draw-test-001");

      expect(result).not.toBeNull();
      expect(result!.verification.fields.length).toBeGreaterThan(0);
      expect(prisma.drawProof.update).toHaveBeenCalled();
    });
  });

  describe("getProof", () => {
    it("returns null if not found", async () => {
      const prisma = makeMockPrisma();
      const svc = new DrawProofService(prisma, null);
      const result = await svc.getProof("nonexistent");
      expect(result).toBeNull();
    });

    it("returns proof record if found", async () => {
      const storedProof = {
        id: "proof-uuid",
        drawId: "draw-123",
        roundId: 1,
        contractId: "C123",
        proofJson: { version: "1.0.0" },
        proofHash: "hash",
        signature: "sig",
        verified: true,
        verifiedAt: new Date(),
        verificationError: null,
        createdAt: new Date(),
      };
      const prisma = makeMockPrisma({ existingProof: storedProof });
      const svc = new DrawProofService(prisma, null);
      const result = await svc.getProof("draw-123");
      expect(result).not.toBeNull();
      expect(result!.drawId).toBe("draw-123");
    });
  });

  describe("listProofs", () => {
    it("returns paginated proofs", async () => {
      const proofs = [
        { id: "1", drawId: "d1", roundId: 1, contractId: "C1", proofJson: {}, proofHash: "h1", signature: null, verified: false, verifiedAt: null, verificationError: null, createdAt: new Date() },
        { id: "2", drawId: "d2", roundId: 2, contractId: "C1", proofJson: {}, proofHash: "h2", signature: null, verified: true, verifiedAt: new Date(), verificationError: null, createdAt: new Date() },
      ];
      const prisma = makeMockPrisma({ proofs });
      prisma.drawProof.findMany.mockResolvedValue(proofs);
      const svc = new DrawProofService(prisma, null);
      const result = await svc.listProofs({ limit: 10 });

      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });
  });
});
