import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Job, type JobResult } from "./types.js";
import { loadConfig } from "./config.js";
import { createSnapshot, isInWorktree } from "./snapshot.js";
import {
  BQ_PID_FILE,
  BQ_QUEUE_DIR,
  BQ_RESULTS_DIR,
  ensureDirs,
  generateJobId,
  isProcessAlive,
  log,
} from "./utils.js";

export interface EnqueueOptions {
  action: "build" | "test";
  branch?: string;
  scheme?: string;
  testPlan?: string;
  destination?: string;
  backend?: "mcp" | "xcodebuild";
  timeout?: number;
}

/**
 * Enqueue a job, wait for result, and return it.
 */
export async function enqueueAndWait(opts: EnqueueOptions): Promise<JobResult> {
  ensureDirs();
  const config = loadConfig();

  // Ensure daemon is running
  ensureDaemonRunning();

  // Determine build strategy
  const jobId = generateJobId();
  let branch: string | undefined = opts.branch;
  let snapshotSha: string | undefined;

  if (!branch) {
    if (isInWorktree()) {
      snapshotSha = createSnapshot();
      log.ok(`Snapshot: ${snapshotSha.slice(0, 8)}`);
    } else {
      log.error("Not in a worktree. Specify --branch or run from a worktree.");
      process.exit(1);
    }
  }

  // Create job
  const job: Job = {
    id: jobId,
    action: opts.action,
    branch,
    snapshot_sha: snapshotSha,
    scheme: opts.scheme || config.default_scheme,
    test_plan: opts.action === "test" ? (opts.testPlan || config.default_test_plan || undefined) : undefined,
    destination: opts.destination || config.default_destination,
    backend: opts.backend || config.backend,
    submitted_at: new Date().toISOString(),
    submitted_by: detectWorktreeName(),
  };

  // Write to queue
  const jobFile = join(BQ_QUEUE_DIR, `${job.id}.json`);
  writeFileSync(jobFile, JSON.stringify(job, null, 2) + "\n");

  // Show queue position
  const queueSize = readdirSync(BQ_QUEUE_DIR).filter(f => f.endsWith(".json")).length;
  if (queueSize > 1) {
    log.status(`Queued (position: ${queueSize})`);
  } else {
    log.status("Queued (next up)");
  }

  // Wait for result
  const timeout = opts.timeout || 1800; // 30 min
  return waitForResult(job.id, timeout);
}

function ensureDaemonRunning(): void {
  if (existsSync(BQ_PID_FILE)) {
    const pid = parseInt(readFileSync(BQ_PID_FILE, "utf-8").trim());
    if (isProcessAlive(pid)) return;
  }

  // Auto-start daemon in background
  log.info("Starting daemon...");
  const { spawn } = require("node:child_process");
  const daemonProcess = spawn(
    process.argv[0]!, // node
    [process.argv[1]!, "daemon", "start"],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  daemonProcess.unref();

  // Wait briefly for daemon to start
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (existsSync(BQ_PID_FILE)) {
      const pid = parseInt(readFileSync(BQ_PID_FILE, "utf-8").trim());
      if (isProcessAlive(pid)) {
        log.ok("Daemon started");
        return;
      }
    }
    require("node:child_process").execSync("sleep 0.2");
  }

  log.warn("Daemon may not have started — will proceed anyway");
}

async function waitForResult(jobId: string, timeoutSec: number): Promise<JobResult> {
  const resultFile = join(BQ_RESULTS_DIR, `${jobId}.json`);
  const startTime = Date.now();
  let lastStatus = "";

  while (true) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (elapsed > timeoutSec) {
      log.error(`Timed out after ${timeoutSec}s`);
      return {
        id: jobId,
        status: "error",
        duration_seconds: elapsed,
        summary: `Timed out after ${timeoutSec}s`,
        failures: [],
        build_errors: ["Job timed out"],
        warnings: [],
        log_path: "",
      };
    }

    if (existsSync(resultFile)) {
      const result: JobResult = JSON.parse(readFileSync(resultFile, "utf-8"));
      return result;
    }

    // Periodic status update (every 10s)
    if (elapsed > 0 && elapsed % 10 === 0) {
      const status = `Waiting... (${elapsed}s)`;
      if (status !== lastStatus) {
        log.status(status);
        lastStatus = status;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function detectWorktreeName(): string {
  try {
    const cwd = process.cwd();
    const match = cwd.match(/worktrees?\/([^/]+)/);
    if (match) return match[1]!;
    return cwd.split("/").pop() || "unknown";
  } catch {
    return "unknown";
  }
}
