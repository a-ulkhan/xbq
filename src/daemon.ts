import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Job, type JobResult } from "./types.js";
import { executeJob } from "./executor.js";
import {
  BQ_ACTIVE_DIR,
  BQ_PID_FILE,
  BQ_QUEUE_DIR,
  BQ_RESULTS_DIR,
  ensureDirs,
  isProcessAlive,
  log,
} from "./utils.js";

const POLL_INTERVAL_MS = 1000;

/**
 * Start the daemon in foreground (for development) or detect if already running.
 */
export async function startDaemon(opts: { foreground?: boolean } = {}): Promise<void> {
  ensureDirs();

  // Check if already running
  if (existsSync(BQ_PID_FILE)) {
    const existingPid = parseInt(readFileSync(BQ_PID_FILE, "utf-8").trim());
    if (isProcessAlive(existingPid)) {
      log.warn(`Daemon already running (PID: ${existingPid})`);
      return;
    }
    // Stale PID file
    unlinkSync(BQ_PID_FILE);
  }

  // Write PID
  writeFileSync(BQ_PID_FILE, String(process.pid));
  log.ok(`Daemon started (PID: ${process.pid})`);

  // Clean up stale active jobs
  cleanupActive();

  // Handle signals for graceful shutdown
  const shutdown = () => {
    log.info("Daemon shutting down...");
    try { unlinkSync(BQ_PID_FILE); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Main loop
  while (true) {
    try {
      const job = pickNextJob();
      if (job) {
        await processJob(job);
      }
    } catch (err) {
      log.error(`Daemon error: ${err}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export function stopDaemon(): void {
  if (!existsSync(BQ_PID_FILE)) {
    log.warn("Daemon is not running");
    return;
  }

  const pid = parseInt(readFileSync(BQ_PID_FILE, "utf-8").trim());
  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGTERM");
    log.ok(`Daemon stopped (PID: ${pid})`);
  } else {
    log.warn("Daemon was not running (stale PID file)");
  }
  try { unlinkSync(BQ_PID_FILE); } catch {}
}

export function daemonStatus(): void {
  if (!existsSync(BQ_PID_FILE)) {
    log.info("Daemon is not running");
    showQueueStatus();
    return;
  }

  const pid = parseInt(readFileSync(BQ_PID_FILE, "utf-8").trim());
  if (isProcessAlive(pid)) {
    log.ok(`Daemon is running (PID: ${pid})`);
  } else {
    log.warn("Daemon PID file exists but process is not running");
    try { unlinkSync(BQ_PID_FILE); } catch {}
  }
  showQueueStatus();
}

function showQueueStatus(): void {
  const queued = existsSync(BQ_QUEUE_DIR) ? readdirSync(BQ_QUEUE_DIR).filter(f => f.endsWith(".json")) : [];
  const active = existsSync(BQ_ACTIVE_DIR) ? readdirSync(BQ_ACTIVE_DIR).filter(f => f.endsWith(".json")) : [];

  console.log();
  if (active.length > 0) {
    for (const f of active) {
      const job: Job = JSON.parse(readFileSync(join(BQ_ACTIVE_DIR, f), "utf-8"));
      const source = job.snapshot_sha ? `snapshot ${job.snapshot_sha.slice(0, 8)}` : `branch ${job.branch}`;
      log.status(`Running: ${job.action} on ${source} (${job.id})`);
    }
  }

  if (queued.length > 0) {
    log.info(`Queued: ${queued.length} job(s)`);
    for (const f of queued.sort()) {
      const job: Job = JSON.parse(readFileSync(join(BQ_QUEUE_DIR, f), "utf-8"));
      const source = job.snapshot_sha ? `snapshot ${job.snapshot_sha.slice(0, 8)}` : `branch ${job.branch}`;
      console.log(`  - ${job.action} on ${source} (${job.id})`);
    }
  } else if (active.length === 0) {
    log.info("Queue is empty");
  }
}

/**
 * Pick the oldest job from the queue (FIFO).
 */
function pickNextJob(): Job | null {
  if (!existsSync(BQ_QUEUE_DIR)) return null;

  const files = readdirSync(BQ_QUEUE_DIR)
    .filter(f => f.endsWith(".json"))
    .sort(); // Lexicographic = chronological since IDs are timestamp-prefixed

  if (files.length === 0) return null;

  const file = files[0]!;
  const jobPath = join(BQ_QUEUE_DIR, file);
  const activePath = join(BQ_ACTIVE_DIR, file);

  // Move to active
  const job: Job = JSON.parse(readFileSync(jobPath, "utf-8"));
  renameSync(jobPath, activePath);

  return job;
}

/**
 * Process a job and write the result.
 */
async function processJob(job: Job): Promise<void> {
  log.info(`Processing job: ${job.id} (${job.action} on ${job.branch})`);
  const activeFile = join(BQ_ACTIVE_DIR, `${job.id}.json`);

  let result: JobResult;
  try {
    result = await executeJob(job);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      id: job.id,
      status: "error",
      duration_seconds: 0,
      summary: message,
      failures: [],
      build_errors: [message],
      warnings: [],
      log_path: "",
    };
  }

  // Write result
  writeFileSync(
    join(BQ_RESULTS_DIR, `${job.id}.json`),
    JSON.stringify(result, null, 2) + "\n"
  );

  // Remove from active
  try { unlinkSync(activeFile); } catch {}

  if (result.status === "passed") {
    log.ok(`Job ${job.id}: ${result.summary} (${result.duration_seconds}s)`);
  } else {
    log.error(`Job ${job.id}: ${result.summary} (${result.duration_seconds}s)`);
  }
}

/**
 * Clean up stale active jobs (from crashed daemon).
 */
function cleanupActive(): void {
  if (!existsSync(BQ_ACTIVE_DIR)) return;

  const files = readdirSync(BQ_ACTIVE_DIR).filter(f => f.endsWith(".json"));
  for (const f of files) {
    log.warn(`Requeuing stale active job: ${f}`);
    renameSync(join(BQ_ACTIVE_DIR, f), join(BQ_QUEUE_DIR, f));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
