import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";

// Paths
const home = homedir();
export const BQ_HOME = process.env.BQ_HOME || join(home, ".bq");
export const BQ_CONFIG_PATH = join(BQ_HOME, "config.json");
export const BQ_QUEUE_DIR = join(BQ_HOME, "queue");
export const BQ_ACTIVE_DIR = join(BQ_HOME, "active");
export const BQ_RESULTS_DIR = join(BQ_HOME, "results");
export const BQ_LOGS_DIR = join(BQ_HOME, "logs");
export const BQ_PID_FILE = join(BQ_HOME, "daemon.pid");
export const BQ_LOCK_FILE = join(BQ_HOME, "daemon.lock");
export const BQ_FLEET_DIR = join(BQ_HOME, "fleet");
export const BQ_FLEET_SESSIONS_DIR = join(BQ_FLEET_DIR, "sessions");
export const BQ_FLEET_TEMPLATES_DIR = join(BQ_FLEET_DIR, "templates");

// Colors
// Prefix for all log/status output
const PREFIX = "xbq";

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export const log = {
  info: (msg: string) => console.log(`${c.blue(`[${PREFIX}]`)} ${msg}`),
  ok: (msg: string) => console.log(`${c.green(`[${PREFIX}]`)} ${msg}`),
  warn: (msg: string) => console.log(`${c.yellow(`[${PREFIX}]`)} ${msg}`),
  error: (msg: string) => console.error(`${c.red(`[${PREFIX}]`)} ${msg}`),
  status: (msg: string) => console.log(`${c.cyan(`[${PREFIX}]`)} ${msg}`),
  dim: (msg: string) => console.log(`${c.dim(`[${PREFIX}] ${msg}`)}`),
};

export function ensureDirs(): void {
  for (const dir of [BQ_HOME, BQ_QUEUE_DIR, BQ_ACTIVE_DIR, BQ_RESULTS_DIR, BQ_LOGS_DIR, BQ_FLEET_DIR, BQ_FLEET_SESSIONS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function generateJobId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export function expandPath(p: string): string {
  return p.startsWith("~") ? join(home, p.slice(1)) : p;
}

/**
 * Run a command and return stdout. Throws on non-zero exit.
 */
export function run(cmd: string, opts?: { cwd?: string; quiet?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd,
      encoding: "utf-8",
      stdio: opts?.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
    }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`Command failed: ${cmd}\n${e.stderr || e.message}`);
  }
}

/**
 * Spawn a long-running process and stream output to a log file + optional callback.
 */
export function spawnWithLog(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    logPath: string;
    onLine?: (line: string) => void;
  }
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const logStream = require("node:fs").createWriteStream(opts.logPath, { flags: "a" });
    const child: ChildProcess = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";

    const handleData = (data: Buffer) => {
      const text = data.toString();
      output += text;
      logStream.write(text);
      if (opts.onLine) {
        for (const line of text.split("\n").filter(Boolean)) {
          opts.onLine(line);
        }
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("close", (code) => {
      logStream.end();
      resolve({ exitCode: code ?? 1, output });
    });

    child.on("error", (err) => {
      logStream.end();
      output += `\nProcess error: ${err.message}`;
      resolve({ exitCode: 1, output });
    });
  });
}

/**
 * Check if a process with the given PID is alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
