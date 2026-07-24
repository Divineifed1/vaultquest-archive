import { z } from "zod";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const SnapshotSchema = z.object({
  ledgerSeq: z.number().int().positive(),
  ledgerCloseTime: z.string().datetime(),
  participantsHash: z.string().min(1),
  participantCount: z.number().int().nonnegative(),
  totalDeposits: z.string().min(1),
  poolHash: z.string().min(1),
});

const RandomnessSchema = z.object({
  source: z.enum(["soroban_prng", "external_beacon", "deterministic_placeholder"]),
  seed: z.string().min(1),
  seedHash: z.string().min(1),
  drawnAtLedger: z.number().int().positive(),
});

const WinnerSelectionSchema = z.object({
  method: z.enum(["weighted_random", "deterministic_placeholder"]),
  ticketWeightsHash: z.string().min(1),
  winnerAddress: z.string().min(1),
  winnerWeight: z.string().min(1),
  totalWeight: z.string().min(1),
  proofHash: z.string().min(1),
});

const PayoutSchema = z.object({
  amount: z.string().min(1),
  asset: z.string().min(1),
  txHash: z.string().min(1),
  ledgerSeq: z.number().int().positive(),
  recipientConfirmed: z.boolean(),
});

const MetadataSchema = z.object({
  createdAt: z.string().datetime(),
  engineVersion: z.string().min(1),
  contractSpecHash: z.string().min(1),
});

export const DrawProofSchema = z.object({
  version: z.literal("1.0.0"),
  drawId: z.string().min(1),
  roundId: z.number().int().nonnegative(),
  contractId: z.string().min(1),
  snapshot: SnapshotSchema,
  randomness: RandomnessSchema,
  winnerSelection: WinnerSelectionSchema,
  payout: PayoutSchema,
  metadata: MetadataSchema,
  signature: z.string().optional(),
});

export type DrawProof = z.infer<typeof DrawProofSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Randomness = z.infer<typeof RandomnessSchema>;
export type WinnerSelection = z.infer<typeof WinnerSelectionSchema>;
export type Payout = z.infer<typeof PayoutSchema>;

// ─── Hashing ──────────────────────────────────────────────────────────────────

const HEX_CHARS = "0123456789abcdef";

async function sha256Hex(data: string): Promise<string> {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    const encoder = new TextEncoder();
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(data));
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => HEX_CHARS[b >> 4] + HEX_CHARS[b & 0x0f])
      .join("");
  }

  const { createHash } = await import("crypto");
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

export { sha256Hex as computeHash };

// ─── Canonicalization ─────────────────────────────────────────────────────────

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function canonicalize(proof: Omit<DrawProof, "signature">): string {
  const withoutSig = { ...proof, signature: undefined };
  const sorted = sortKeys(withoutSig);
  return JSON.stringify(sorted);
}

// ─── Proof Hashing ────────────────────────────────────────────────────────────

export async function computeProofHash(proof: Omit<DrawProof, "signature">): Promise<string> {
  const canonical = canonicalize(proof);
  return sha256Hex(canonical);
}

export async function signProof(
  proof: Omit<DrawProof, "signature">,
  secret: string
): Promise<string> {
  const canonical = canonicalize(proof);
  const payload = canonical + ":" + secret;
  return sha256Hex(payload);
}

// ─── Deterministic Draw ID ────────────────────────────────────────────────────

export async function computeDrawId(
  contractId: string,
  roundId: number,
  drawLedger: number
): Promise<string> {
  const input = `${contractId}:${roundId}:${drawLedger}`;
  const hash = await sha256Hex(input);
  return `draw-${hash.slice(0, 16)}`;
}

// ─── Participant & Weight Hashing ─────────────────────────────────────────────

export interface ParticipantEntry {
  address: string;
  deposit: string;
  lockupMultiplier: number;
}

export async function computeParticipantsHash(
  participants: ParticipantEntry[]
): Promise<string> {
  const sorted = [...participants].sort((a, b) => a.address.localeCompare(b.address));
  const serialized = JSON.stringify(
    sorted.map((p) => [p.address, p.deposit, p.lockupMultiplier])
  );
  return sha256Hex(serialized);
}

export interface TicketWeight {
  address: string;
  weight: string;
}

export async function computeTicketWeightsHash(
  weights: TicketWeight[]
): Promise<string> {
  const sorted = [...weights].sort((a, b) => a.address.localeCompare(b.address));
  const serialized = JSON.stringify(sorted.map((w) => [w.address, w.weight]));
  return sha256Hex(serialized);
}

export async function computePoolHash(poolState: Record<string, unknown>): Promise<string> {
  const sorted = sortKeys(poolState);
  return sha256Hex(JSON.stringify(sorted));
}

// ─── Winner Proof Hash ────────────────────────────────────────────────────────

export async function computeWinnerProofHash(
  winnerAddress: string,
  seedHash: string,
  participantsHash: string
): Promise<string> {
  const input = `${winnerAddress}:${seedHash}:${participantsHash}`;
  return sha256Hex(input);
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface VerificationField {
  name: string;
  status: "pass" | "fail" | "unverified";
  detail?: string;
}

export interface VerificationResult {
  verified: boolean;
  fields: VerificationField[];
  verifiedAt: string;
}

function fieldPass(name: string): VerificationField {
  return { name, status: "pass" };
}

function fieldFail(name: string, detail: string): VerificationField {
  return { name, status: "fail", detail };
}

function fieldUnverified(name: string, detail: string): VerificationField {
  return { name, status: "unverified", detail };
}

export async function verifyProofIntegrity(
  proof: DrawProof
): Promise<VerificationResult> {
  const fields: VerificationField[] = [];

  const { signature, ...proofBody } = proof;
  const expectedDocHash = await computeProofHash(proofBody);
  if (proof.signature && expectedDocHash === proof.signature) {
    fields.push(fieldPass("document_integrity"));
  } else if (!proof.signature) {
    fields.push(fieldUnverified("document_integrity", "No signature stored in document"));
  } else {
    fields.push(fieldFail("document_integrity", `expected ${expectedDocHash}, got ${proof.signature}`));
  }

  const expectedWinnerHash = await computeWinnerProofHash(
    proof.winnerSelection.winnerAddress,
    proof.randomness.seedHash,
    proof.snapshot.participantsHash
  );
  if (expectedWinnerHash === proof.winnerSelection.proofHash) {
    fields.push(fieldPass("winner_proof_hash"));
  } else {
    fields.push(fieldFail(
      "winner_proof_hash",
      `expected ${expectedWinnerHash}, got ${proof.winnerSelection.proofHash}`
    ));
  }

  const recomputedSeedHash = await sha256Hex(proof.randomness.seed);
  if (recomputedSeedHash === proof.randomness.seedHash) {
    fields.push(fieldPass("seed_hash"));
  } else {
    fields.push(fieldFail(
      "seed_hash",
      `expected ${recomputedSeedHash}, got ${proof.randomness.seedHash}`
    ));
  }

  const allPass = fields.every((f) => f.status === "pass");
  const anyFail = fields.some((f) => f.status === "fail");

  return {
    verified: allPass && !anyFail,
    fields,
    verifiedAt: new Date().toISOString(),
  };
}

// ─── Proof Assembly ───────────────────────────────────────────────────────────

export interface DrawProofInput {
  roundId: number;
  contractId: string;
  participants: ParticipantEntry[];
  poolState: Record<string, unknown>;
  randomnessSource: Randomness["source"];
  randomnessSeed: string;
  drawnAtLedger: number;
  winnerAddress: string;
  payoutTxHash: string;
  payoutLedgerSeq: number;
  payoutAmount: string;
  payoutAsset: string;
  payoutConfirmed: boolean;
  contractSpecHash: string;
}

export async function assembleDrawProof(
  input: DrawProofInput
): Promise<DrawProof> {
  const participantsHash = await computeParticipantsHash(input.participants);
  const poolHash = await computePoolHash(input.poolState);
  const seedHash = await sha256Hex(input.randomnessSeed);

  const totalDeposits = input.participants
    .reduce((sum, p) => sum + BigInt(p.deposit), BigInt(0))
    .toString();

  const weights: TicketWeight[] = input.participants.map((p) => ({
    address: p.address,
    weight: (
      BigInt(p.deposit) * BigInt(p.lockupMultiplier)
    ).toString(),
  }));
  const ticketWeightsHash = await computeTicketWeightsHash(weights);
  const totalWeight = weights
    .reduce((sum, w) => sum + BigInt(w.weight), BigInt(0))
    .toString();

  const winnerWeight =
    weights.find((w) => w.address === input.winnerAddress)?.weight ?? "0";

  const proofHash = await computeWinnerProofHash(
    input.winnerAddress,
    seedHash,
    participantsHash
  );

  const drawId = await computeDrawId(
    input.contractId,
    input.roundId,
    input.drawnAtLedger
  );

  const snapshotLedgerTime = new Date().toISOString();

  const proof: Omit<DrawProof, "signature"> = {
    version: "1.0.0",
    drawId,
    roundId: input.roundId,
    contractId: input.contractId,
    snapshot: {
      ledgerSeq: input.drawnAtLedger,
      ledgerCloseTime: snapshotLedgerTime,
      participantsHash,
      participantCount: input.participants.length,
      totalDeposits,
      poolHash,
    },
    randomness: {
      source: input.randomnessSource,
      seed: input.randomnessSeed,
      seedHash,
      drawnAtLedger: input.drawnAtLedger,
    },
    winnerSelection: {
      method:
        input.randomnessSource === "deterministic_placeholder"
          ? "deterministic_placeholder"
          : "weighted_random",
      ticketWeightsHash,
      winnerAddress: input.winnerAddress,
      winnerWeight,
      totalWeight,
      proofHash,
    },
    payout: {
      amount: input.payoutAmount,
      asset: input.payoutAsset,
      txHash: input.payoutTxHash,
      ledgerSeq: input.payoutLedgerSeq,
      recipientConfirmed: input.payoutConfirmed,
    },
    metadata: {
      createdAt: new Date().toISOString(),
      engineVersion: "1.0.0",
      contractSpecHash: input.contractSpecHash,
    },
  };

  const docHash = await computeProofHash(proof);
  return { ...proof, signature: docHash } as DrawProof;
}
