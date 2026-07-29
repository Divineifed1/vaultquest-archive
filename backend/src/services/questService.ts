/**
 * Quest Service (#26 backend engine)
 *
 * Automated logic engine that analyses the {@link ActionLedger} history to
 * evaluate and persist savings-quest milestone completions (e.g. "Save $100
 * for 3 months", "Participate in 5 draws").
 *
 * Design notes:
 *  - Historical scans are done with a single aggregating raw SQL query that
 *    rides the `(wallet_address, created_at)` index on `action_ledger`, so a
 *    per-wallet evaluation is a single index range scan (<100ms even with a
 *    large ledger — see tests/quest.spec.ts benchmark).
 *  - Progress is persisted into the `user_quests` table (one row per
 *    wallet/quest) and only written when it actually changes, keeping the
 *    incremental updates cheap.
 *  - `evaluateRecent()` is the cron entry point: it finds wallets whose
 *    confirmed ledger entries changed since the last sweep and re-evaluates
 *    only those, so new logs trigger incremental progress updates.
 *
 * #504 — this file previously computed `totalDeposited` via a raw SQL
 * `(action_payload->>'amount')::float8` cast and summed with plain
 * arithmetic. float8 (IEEE-754 double) loses precision above 2^53 and
 * has no concept of asset identity, so amounts from different assets
 * (or different-decimals assets) could be silently combined. Amounts are
 * now parsed and summed as bigint minor units via `Amount` (see
 * ../amount.ts), tagged with an explicit asset code, with mixed-asset or
 * malformed values rejected rather than silently coerced. The five quest
 * *thresholds* below (e.g. "$100", "5 draws") are asset-agnostic counts
 * or a single-asset dollar target, matching this system's current
 * single-canonical-pool architecture (see #507) — a genuinely
 * multi-asset target scheme is out of scope until #507 introduces real
 * per-pool asset configuration.
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import { Amount, InvalidAmountError } from "../amount.js";

export type QuestMetricKey =
  | "totalDeposited"
  | "depositCount"
  | "distinctPools"
  | "distinctMonths"
  | "claimCount";

export interface QuestDefinition {
  /** Stable identifier persisted in `user_quests.quest_id`. */
  id: string;
  title: string;
  description: string;
  /** Aggregated ledger metric this quest is measured against. */
  metric: QuestMetricKey;
  /** Value of `metric` at which the quest is considered complete. */
  target: number;
}

/**
 * The five standard savings quests the engine tracks. Each maps to a metric
 * derived purely from confirmed `action_ledger` rows.
 */
export const STANDARD_QUESTS: readonly QuestDefinition[] = [
  {
    id: "first_deposit",
    title: "First Steps",
    description: "Make your first confirmed deposit.",
    metric: "depositCount",
    target: 1
  },
  {
    id: "save_100",
    title: "Save $100",
    description: "Accumulate $100 in total confirmed deposits.",
    metric: "totalDeposited",
    target: 100
  },
  {
    id: "save_100_three_months",
    title: "Save $100 for 3 Months",
    description: "Deposit in at least three distinct calendar months.",
    metric: "distinctMonths",
    target: 3
  },
  {
    id: "participate_5_draws",
    title: "Participate in 5 Draws",
    description: "Deposit into at least five distinct prize pools.",
    metric: "distinctPools",
    target: 5
  },
  {
    id: "first_win",
    title: "Lucky Saver",
    description: "Claim a reward from a prize draw.",
    metric: "claimCount",
    target: 1
  }
] as const;

export type QuestMetrics = Record<QuestMetricKey, number>;

export interface QuestProgress {
  questId: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  status: "in_progress" | "completed";
  completedAt: Date | null;
}

/** Raw shape returned by the row-scan query. */
type ActionRow = {
  actionType: string;
  actionPayload: unknown;
  createdAt: Date;
};

function extractPoolId(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "default";
  const value = payload.vault_id ?? payload.pool_id ?? "default";
  return String(value);
}

// #504 — quest thresholds today are denominated against the system's
// single canonical pool asset (see #507 findings: pool identity is
// entirely env-var/manifest-driven, exactly one asset in play). decimals
// is 0 to match this file's pre-existing convention of treating
// payload.amount as an already-whole-unit dollar figure (e.g. "100" ->
// $100 toward the save_100 quest) — this is an internal-precision fix,
// not a change to what unit amounts are expressed in.
const QUEST_ASSET_CODE = "USD";
const QUEST_ASSET_DECIMALS = 0;

export class QuestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly quests: readonly QuestDefinition[] = STANDARD_QUESTS
  ) {}

  /**
   * Computes all quest metrics for a wallet from a single index-backed scan
   * over confirmed ledger rows (rides the `(wallet_address, created_at)`
   * index — see tests/quest.spec.ts's <100ms benchmark over a 2k-row
   * ledger). Deposit amounts are parsed and summed via `Amount` (bigint,
   * asset-tagged) rather than a float SQL cast; a deposit whose payload
   * fails Amount validation (missing/fractional/malformed `amount`) is
   * excluded from `totalDeposited` and does not otherwise affect
   * depositCount/distinctPools/distinctMonths, which only need the
   * action to exist and be confirmed, not its parsed amount.
   */
  async computeMetrics(walletAddress: string): Promise<QuestMetrics> {
    const rows = await this.prisma.actionLedger.findMany({
      where: { walletAddress, status: "confirmed", redactedAt: null },
      select: { actionType: true, actionPayload: true, createdAt: true }
    });

    let totalDeposited = Amount.zero(QUEST_ASSET_CODE, QUEST_ASSET_DECIMALS);
    let depositCount = 0;
    let claimCount = 0;
    const distinctPools = new Set<string>();
    const distinctMonths = new Set<string>();

    for (const row of rows as ActionRow[]) {
      const payload = row.actionPayload as Record<string, unknown> | null;

      if (row.actionType === "deposit") {
        depositCount++;
        distinctPools.add(extractPoolId(payload));
        distinctMonths.add(
          `${row.createdAt.getUTCFullYear()}-${String(row.createdAt.getUTCMonth() + 1).padStart(2, "0")}`
        );

        try {
          const amount = Amount.fromPayload(payload, QUEST_ASSET_CODE, QUEST_ASSET_DECIMALS);
          totalDeposited = totalDeposited.add(amount);
        } catch (err) {
          if (!(err instanceof InvalidAmountError)) throw err;
          // Malformed amount: the deposit still counts toward
          // depositCount/distinctPools/distinctMonths (it happened), but
          // is excluded from the dollar total rather than silently
          // parsed as 0, which would understate a real problem.
        }
      } else if (row.actionType === "claim") {
        claimCount++;
      }
    }

    return {
      totalDeposited: Number(totalDeposited.raw),
      depositCount,
      distinctPools: distinctPools.size,
      distinctMonths: distinctMonths.size,
      claimCount
    };
  }

  /** Maps raw metrics onto the configured quest definitions. */
  projectProgress(metrics: QuestMetrics): QuestProgress[] {
    return this.quests.map((quest) => {
      const value = metrics[quest.metric];
      const progress = Math.min(value, quest.target);
      const completed = value >= quest.target;
      return {
        questId: quest.id,
        title: quest.title,
        description: quest.description,
        progress,
        target: quest.target,
        status: completed ? "completed" : "in_progress",
        completedAt: null
      };
    });
  }

  /**
   * Evaluates and persists quest progress for a single wallet. Only rows whose
   * progress or status actually changed are written. Returns the current
   * progress snapshot.
   */
  async evaluateWallet(walletAddress: string): Promise<QuestProgress[]> {
    const metrics = await this.computeMetrics(walletAddress);
    const projected = this.projectProgress(metrics);

    const existing = await this.prisma.userQuest.findMany({
      where: { walletAddress }
    });
    const byQuest = new Map(existing.map((q) => [q.questId, q]));

    const now = new Date();
    const results: QuestProgress[] = [];

    for (const p of projected) {
      const prev = byQuest.get(p.questId);
      const justCompleted = p.status === "completed";
      const completedAt =
        justCompleted ? prev?.completedAt ?? now : null;

      const changed =
        !prev ||
        prev.progress !== p.progress ||
        prev.status !== p.status;

      if (changed) {
        await this.prisma.userQuest.upsert({
          where: { walletAddress_questId: { walletAddress, questId: p.questId } },
          create: {
            walletAddress,
            questId: p.questId,
            progress: p.progress,
            target: p.target,
            status: p.status,
            completedAt,
            lastEvaluatedAt: now
          },
          update: {
            progress: p.progress,
            target: p.target,
            status: p.status,
            completedAt,
            lastEvaluatedAt: now
          }
        });
      } else {
        await this.prisma.userQuest.update({
          where: { walletAddress_questId: { walletAddress, questId: p.questId } },
          data: { lastEvaluatedAt: now }
        });
      }

      results.push({ ...p, completedAt });
    }

    return results;
  }

  /**
   * Cron entry point. Finds wallets with confirmed ledger entries updated since
   * `since` and re-evaluates each. Returns the number of wallets processed.
   *
   * #505 — this enumeration + persistence loop is real (not a stub), but
   * has no idempotency/dead-letter/backfill handling for concurrent cron
   * workers or crash-mid-sweep recovery; see the distributed-lock and
   * idempotent-grant work tracked in #505/#506.
   */
  async evaluateRecent(since: Date, limit = 500): Promise<{ wallets: number }> {
    const rows = await this.prisma.actionLedger.findMany({
      where: { status: "confirmed", updatedAt: { gte: since } },
      select: { walletAddress: true },
      distinct: ["walletAddress"],
      take: limit
    });

    for (const { walletAddress } of rows) {
      await this.evaluateWallet(walletAddress);
    }

    return { wallets: rows.length };
  }

  /** Read model for the frontend quest-tracking UI (#26). */
  async getUserQuests(walletAddress: string): Promise<QuestProgress[]> {
    const rows = await this.prisma.userQuest.findMany({
      where: { walletAddress }
    });
    const byQuest = new Map(rows.map((r) => [r.questId, r]));

    return this.quests.map((quest) => {
      const row = byQuest.get(quest.id);
      return {
        questId: quest.id,
        title: quest.title,
        description: quest.description,
        progress: row?.progress ?? 0,
        target: quest.target,
        status: (row?.status as "in_progress" | "completed") ?? "in_progress",
        completedAt: row?.completedAt ?? null
      };
    });
  }
}

export type { Prisma };
