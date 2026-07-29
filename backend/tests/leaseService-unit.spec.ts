import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { LeaseService } from "../src/services/leaseService.js";

function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test"
  });
}

describe("LeaseService.acquireJobLease Unit Tests (No Database Required) (#506)", () => {
  it("acquires a fresh lease when no row exists, with fencingToken 1", async () => {
    const created = { jobName: "quest-evaluation", workerId: "w1", fencingToken: 1n };
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => created)
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    const handle = await svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w1", ttlMs: 60_000 });

    expect(handle).toEqual({ jobName: "quest-evaluation", workerId: "w1", fencingToken: 1n });
  });

  it("takes over an expired lease and bumps the fencing token", async () => {
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => {
          throw makeP2002Error();
        })
      },
      $queryRaw: vi.fn(async () => [{ fencing_token: 5n }])
    } as any;

    const svc = new LeaseService(mockPrisma);
    const handle = await svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w2", ttlMs: 60_000 });

    expect(handle).toEqual({ jobName: "quest-evaluation", workerId: "w2", fencingToken: 5n });
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns null when an unexpired lease is held by another worker", async () => {
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => {
          throw makeP2002Error();
        })
      },
      // No rows updated => the conditional UPDATE's WHERE clause excluded
      // the row because expires_at is still in the future.
      $queryRaw: vi.fn(async () => [])
    } as any;

    const svc = new LeaseService(mockPrisma);
    const handle = await svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w2", ttlMs: 60_000 });

    expect(handle).toBeNull();
  });

  it("rethrows non-P2002 errors instead of treating them as a lock conflict", async () => {
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => {
          throw new Error("connection reset");
        })
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    await expect(
      svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w1", ttlMs: 60_000 })
    ).rejects.toThrow("connection reset");
  });
});

describe("LeaseService.renewJobLease Unit Tests (#506)", () => {
  it("renews when the caller still holds the lease", async () => {
    const mockPrisma = {
      jobLease: { updateMany: vi.fn(async () => ({ count: 1 })) }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.renewJobLease("quest-evaluation", "w1", 60_000)).toBe(true);
  });

  it("fails to renew once another worker has taken over", async () => {
    const mockPrisma = {
      jobLease: { updateMany: vi.fn(async () => ({ count: 0 })) }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.renewJobLease("quest-evaluation", "w1", 60_000)).toBe(false);
  });
});

describe("LeaseService.isFencingTokenCurrent Unit Tests (#506)", () => {
  it("returns true when the token matches the current lease row", async () => {
    const mockPrisma = {
      jobLease: {
        findUnique: vi.fn(async () => ({ jobName: "quest-evaluation", workerId: "w1", fencingToken: 3n }))
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.isFencingTokenCurrent("quest-evaluation", 3n)).toBe(true);
  });

  it("returns false once the token has been superseded by a takeover", async () => {
    const mockPrisma = {
      jobLease: {
        findUnique: vi.fn(async () => ({ jobName: "quest-evaluation", workerId: "w2", fencingToken: 4n }))
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.isFencingTokenCurrent("quest-evaluation", 3n)).toBe(false);
  });

  it("returns false when the lease row no longer exists", async () => {
    const mockPrisma = {
      jobLease: { findUnique: vi.fn(async () => null) }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.isFencingTokenCurrent("quest-evaluation", 1n)).toBe(false);
  });
});
