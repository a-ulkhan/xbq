import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { BQ_FLEET_SESSIONS_DIR, log, run } from "../utils.js";
import { getMainRepo } from "../config.js";
import {
  createWorktree,
  getWorktrees,
  getWorktreeBase,
} from "../worktree.js";
import { loadTemplate } from "./templates.js";
import type { SessionState } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sessionPath(name: string): string {
  return join(BQ_FLEET_SESSIONS_DIR, `${name}.json`);
}

function readSession(name: string): SessionState | undefined {
  const p = sessionPath(name);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SessionState;
  } catch {
    return undefined;
  }
}

function writeSession(state: SessionState): void {
  mkdirSync(BQ_FLEET_SESSIONS_DIR, { recursive: true });
  const tmp = sessionPath(state.worktree) + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, sessionPath(state.worktree));
}

function allSessions(): SessionState[] {
  if (!existsSync(BQ_FLEET_SESSIONS_DIR)) return [];
  return readdirSync(BQ_FLEET_SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(
          readFileSync(join(BQ_FLEET_SESSIONS_DIR, f), "utf-8")
        ) as SessionState;
      } catch {
        return undefined;
      }
    })
    .filter((s): s is SessionState => s !== undefined);
}

/**
 * Check if a Claude session is alive in the given worktree path.
 * Uses pgrep to find a claude process whose arguments contain the path.
 */
function isSessionAlive(worktreePath: string): boolean {
  try {
    run(`pgrep -f "claude.*${basename(worktreePath)}"`, { quiet: true });
    return true;
  } catch {
    return false;
  }
}

// ── Fleet Commands ───────────────────────────────────────────────────

/**
 * Show status of all fleet sessions alongside worktree state.
 */
export function fleetStatus(): void {
  const sessions = allSessions();

  if (sessions.length === 0) {
    log.info("No fleet sessions. Use 'xbq fleet launch' to start one.");
    return;
  }

  // Enrich with liveness
  const rows = sessions.map((s) => {
    const alive = s.status === "active" && isSessionAlive(s.path);
    const displayStatus =
      s.status === "active" ? (alive ? "active" : "stale") : s.status;
    return { ...s, displayStatus, alive };
  });

  // Print table
  console.log();
  const nameW = Math.max(20, ...rows.map((r) => r.worktree.length));
  const statusW = 10;
  const taskW = 40;

  const header = [
    "WORKTREE".padEnd(nameW),
    "STATUS".padEnd(statusW),
    "TASK".padEnd(taskW),
    "SINCE",
  ].join("  ");
  console.log(`  ${header}`);
  console.log(`  ${"─".repeat(header.length)}`);

  for (const r of rows) {
    const statusColor =
      r.displayStatus === "active"
        ? `\x1b[32m${r.displayStatus}\x1b[0m`
        : r.displayStatus === "stale"
          ? `\x1b[33m${r.displayStatus}\x1b[0m`
          : r.displayStatus === "stopped"
            ? `\x1b[31m${r.displayStatus}\x1b[0m`
            : `\x1b[2m${r.displayStatus}\x1b[0m`;

    const since = timeSince(r.started_at);
    const task = r.task.length > taskW ? r.task.slice(0, taskW - 3) + "..." : r.task;

    console.log(
      `  ${r.worktree.padEnd(nameW)}  ${statusColor.padEnd(statusW + 9)}  ${task.padEnd(taskW)}  ${since}`
    );
  }
  console.log();

  const active = rows.filter((r) => r.displayStatus === "active").length;
  const stale = rows.filter((r) => r.displayStatus === "stale").length;
  log.dim(
    `${active} active, ${stale} stale, ${rows.length - active - stale} stopped/completed`
  );
}

/**
 * Launch a new fleet session (creates worktree + tracks session state).
 */
export function fleetLaunch(
  name: string | undefined,
  opts: {
    template?: string;
    mr?: string;
    ticket?: string;
    prompt?: string;
  }
): void {
  // Resolve template
  const template = opts.template ? loadTemplate(opts.template) : undefined;
  if (opts.template && !template) {
    log.error(`Unknown template: ${opts.template}`);
    log.info("Available templates: xbq fleet templates");
    process.exit(1);
  }

  // Generate name from template + context if not provided
  if (!name) {
    if (opts.template && opts.mr) {
      name = `${opts.template}-mr-${opts.mr}`;
    } else if (opts.template && opts.ticket) {
      name = `${opts.template}-${opts.ticket.toLowerCase()}`;
    } else if (opts.template) {
      const rand = Math.random().toString(36).slice(2, 6);
      name = `${opts.template}-${rand}`;
    }
    // createWorktree generates a name if still undefined
  }

  // Check for existing active session
  if (name) {
    const existing = readSession(name);
    if (existing && existing.status === "active" && isSessionAlive(existing.path)) {
      log.warn(`Session '${name}' is already active.`);
      log.info(`Path: ${existing.path}`);
      return;
    }
  }

  // Build prompt from template
  let prompt = opts.prompt || "";
  if (template) {
    let prefix = template.prompt_prefix;
    if (opts.mr) prefix = prefix.replace("{mr}", opts.mr);
    if (opts.ticket) prefix = prefix.replace("{ticket}", opts.ticket);
    prompt = prompt ? `${prefix}\n\nAdditional context: ${prompt}` : prefix;
  }

  // Build task description for tracking
  const task = opts.mr
    ? `Review MR !${opts.mr}`
    : opts.ticket
      ? `${opts.template || "work"} ${opts.ticket}`
      : prompt.split("\n")[0] || "manual session";

  // Create worktree (reuses existing createWorktree logic)
  const worktreePath = createWorktree(name, {
    startClaude: false, // We'll launch separately to avoid blocking
    prompt: undefined,
  });

  const worktreeName = basename(worktreePath);

  // Write session state (atomic via tmp + rename)
  const state: SessionState = {
    worktree: worktreeName,
    path: worktreePath,
    branch: worktreeName,
    status: "active",
    task,
    template: opts.template,
    started_at: new Date().toISOString(),
  };
  writeSession(state);

  log.ok(`Fleet session '${worktreeName}' created`);
  log.dim(`Path: ${worktreePath}`);
  log.dim(`Task: ${task}`);

  if (template?.permissions) {
    log.dim(`Permissions: ${template.permissions.join(", ")}`);
  }

  // Print launch command for user
  console.log();
  if (prompt) {
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    log.info(`Launch Claude in this session:`);
    console.log(`  cd ${worktreePath} && claude '${escapedPrompt}'`);
  } else {
    log.info(`Launch Claude in this session:`);
    console.log(`  cd ${worktreePath} && claude`);
  }
  console.log();
}

/**
 * Stop a fleet session and mark it as stopped.
 */
export function fleetStop(name: string): void {
  const state = readSession(name);

  if (!state) {
    log.error(`No fleet session found: ${name}`);
    log.info("Use 'xbq fleet status' to see active sessions.");
    return;
  }

  if (state.status !== "active") {
    log.warn(`Session '${name}' is already ${state.status}.`);
    return;
  }

  state.status = "stopped";
  state.stopped_at = new Date().toISOString();
  writeSession(state);

  log.ok(`Session '${name}' stopped.`);

  const duration = timeSince(state.started_at);
  log.dim(`Duration: ${duration}`);
  log.dim(`Worktree preserved at: ${state.path}`);
}

// ── Utility ──────────────────────────────────────────────────────────

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
