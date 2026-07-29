import cron from "node-cron";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { sweepOrphans } from "./services/reconciler.js";
import { QuestService } from "./services/questService.js";
import { BackupService } from "./services/backupService.js";
import { NotificationService } from "./services/notificationService.js";
import type { StellarIndexer } from "./services/stellarIndexer.js";
import { pingDatabase } from "./db.js";
import type { LedgerService } from "./services/ledger.js";
import { LeaseService } from "./services/leaseService.js";

// #506 — one worker id per process, reused across every job lease this
// process acquires, so ownership/takeover metrics can be attributed to a
// specific process instance.
const WORKER_ID = `${process.env.HOSTNAME ?? "worker"}-${randomUUID().slice(0, 8)}`;

/**
 * Runs `fn` only if `jobName`'s lease is successfully acquired for this
 * process — i.e. no other worker currently holds an unexpired lease for
 * the same job. Skips (and logs) rather than running when the lease
 * can't be acquired, so overlapping ticks across replicas (or a slow tick
 * of the same job) never run concurrently. The lease is intentionally
 * NOT released on failure — see LeaseService.releaseJobLease's comment —
 * so a crashed tick forces a cooldown instead of an immediate retry loop.
 */
async function withJobLease(
  leases: LeaseService,
  jobName: string,
  ttlMs: number,
  logger: Logger,
  fn: () => Promise<void>
): Promise<void> {
  const handle = await leases.acquireJobLease({ jobName, workerId: WORKER_ID, ttlMs });
  if (!handle) {
    logger.info({ jobName }, "job lease held by another worker, skipping this tick");
    return;
  }

  try {
    await fn();
    await leases.releaseJobLease(jobName, WORKER_ID);
  } catch (err) {
    logger.error({ jobName, err }, "job tick failed while holding lease");
    // Deliberately not released — see releaseJobLease's doc comment.
    throw err;
  }
}

export function startReconcilerCron(opts: {
  prisma: PrismaClient;
  ttlMinutes: number;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/1 * * * *";
  const leases = new LeaseService(opts.prisma);
  // Lease TTL is a few schedule intervals, not one — a slow-but-alive
  // reconciler tick renewing partway through shouldn't get pre-empted by
  // its own lease expiring (see startIndexerCron/startQuestCron for the
  // same reasoning applied to their own schedules).
  const leaseTtlMs = 5 * 60 * 1000;
  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "reconciler-sweep", leaseTtlMs, opts.logger, async () => {
        const result = await sweepOrphans(opts.prisma, { ttlMinutes: opts.ttlMinutes });
        opts.logger.info({ result }, "reconciler sweep complete");
      });
    } catch (err) {
      opts.logger.error({ err }, "reconciler sweep failed");
    }
  });
  return task;
}

/**
 * Periodically re-evaluates savings quests for wallets with recently confirmed
 * ledger activity (#26). The lookback window is kept slightly larger than the
 * schedule interval so a slow tick never skips a wallet.
 */
export function startQuestCron(opts: {
  prisma: PrismaClient;
  logger: Logger;
  schedule?: string;
  lookbackMinutes?: number;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/2 * * * *";
  const lookbackMinutes = opts.lookbackMinutes ?? 10;
  const questService = new QuestService(opts.prisma);
  const leases = new LeaseService(opts.prisma);
  const leaseTtlMs = 5 * 60 * 1000;

  const task = cron.schedule(schedule, async () => {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    try {
      await withJobLease(leases, "quest-evaluation", leaseTtlMs, opts.logger, async () => {
        const result = await questService.evaluateRecent(since);
        // #505 — grant processing runs under the same lease as the sweep
        // that creates grant intents; RewardGrant's own idempotencyKey
        // unique constraint is the real double-grant guard (see
        // createRewardGrantIfAbsent), the shared lease is just the
        // first, cheaper line of defense against overlapping ticks.
        const grants = await questService.processGrants();
        opts.logger.info({ result, grants }, "quest evaluation sweep complete");
      });
    } catch (err) {
      opts.logger.error({ err }, "quest evaluation sweep failed");
    }
  });
  return task;
}

/**
 * Drives the Stellar indexer daemon on a schedule (#indexer). Each tick polls
 * Horizon for new contract events and reconciles them into the ledger. The
 * tick is skipped when the database is unreachable so we never fetch events we
 * cannot persist.
 */
export function startIndexerCron(opts: {
  prisma: PrismaClient;
  indexer: StellarIndexer;
  ledger: LedgerService;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/1 * * * *";
  const leases = new LeaseService(opts.prisma);
  const leaseTtlMs = 5 * 60 * 1000;
  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "stellar-indexer", leaseTtlMs, opts.logger, async () => {
        if (!(await pingDatabase(opts.prisma))) {
          opts.logger.warn({}, "indexer tick skipped: database unreachable");
          return;
        }
        const result = await opts.indexer.tick();
        opts.logger.info({ result }, "indexer tick complete");

        // Persist cursor/ledger progress so a restart resumes exactly where the
        // last successful tick left off instead of replaying or skipping events.
        if (result.latestLedger !== null) {
          await opts.ledger.updateIndexerCheckpoint({
            latestLedger: result.latestLedger,
            lastProcessedEventId: result.cursor,
            success: true
          });
        }
      });
    } catch (err) {
      opts.logger.error({ err }, "indexer tick failed");
      try {
        const existing = await opts.ledger.getIndexerCheckpoint();
        await opts.ledger.updateIndexerCheckpoint({
          latestLedger: existing?.latestLedger ?? 0,
          success: false,
          lastError: err instanceof Error ? err.message : String(err)
        });
      } catch {
        // best-effort; don't let checkpoint persistence mask the original error
      }
    }
  });
  return task;
}

/**
 * Runs automated PostgreSQL backups on a schedule (issue #275).
 *
 * Each tick calls `BackupService.run()` which shells out to `pg_dump` and
 * prunes files older than `retainDays`. The cron is only started when
 * `BACKUP_DIR` is set in the environment.
 */
export function startBackupCron(opts: {
  backupDir: string;
  databaseUrl: string;
  retainDays?: number;
  pgDumpPath?: string;
  logger: Logger;
  schedule?: string;
  prisma: PrismaClient;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "0 2 * * *"; // default: daily at 02:00
  const svc = new BackupService({
    backupDir: opts.backupDir,
    databaseUrl: opts.databaseUrl,
    retainDays: opts.retainDays,
    pgDumpPath: opts.pgDumpPath,
    logger: opts.logger
  });
  const leases = new LeaseService(opts.prisma);
  // Backups run once daily and pg_dump can legitimately take a while on a
  // large database — a generous TTL avoids a still-running dump losing
  // its lease to a "takeover" from the next day's schedule (which
  // wouldn't even fire for ~24h anyway, but keeps this consistent with
  // the other jobs' reasoning).
  const leaseTtlMs = 60 * 60 * 1000;

  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "db-backup", leaseTtlMs, opts.logger, async () => {
        const result = await svc.run();
        opts.logger.info({ result }, "backup: completed");
      });
    } catch (err) {
      opts.logger.error({ err }, "backup: failed");
    }
  });
  return task;
}

/**
 * Periodically generates maturity / claim-window reminder notifications
 * (issue #446). `leadHours` controls how far ahead of a position's lock/draw
 * date a reminder is created; generation is idempotent so re-running never
 * duplicates notifications.
 */
export function startNotificationReminderCron(opts: {
  prisma: PrismaClient;
  leadHours: number;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/5 * * * *";
  const notificationService = new NotificationService(opts.prisma, opts.leadHours);
  const leases = new LeaseService(opts.prisma);
  const leaseTtlMs = 5 * 60 * 1000;

  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "notification-reminders", leaseTtlMs, opts.logger, async () => {
        const created = await notificationService.generateReminders();
        opts.logger.info({ created }, "notification reminder sweep complete");
      });
    } catch (err) {
      opts.logger.error({ err }, "notification reminder sweep failed");
    }
  });
  return task;
}
