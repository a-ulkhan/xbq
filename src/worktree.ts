import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { getMainRepo, loadConfig } from "./config.js";
import { setupClaude } from "./setup-claude.js";
import { log, run } from "./utils.js";

interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

const WORKTREE_DIR_NAME = "worktrees";

function getWorktreeBase(): string {
  const mainRepo = getMainRepo();
  const parent = join(mainRepo, "..");
  const repoName = basename(mainRepo);
  return join(parent, `${repoName}-worktrees`);
}

/**
 * Create a new worktree and optionally start Claude Code in it.
 */
export function createWorktree(name?: string, opts?: { startClaude?: boolean }): string {
  const mainRepo = getMainRepo();
  const base = getWorktreeBase();

  // Generate name if not provided
  if (!name) {
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const rand = Math.random().toString(36).slice(2, 6);
    name = `session-${ts}-${rand}`;
  }

  const worktreePath = join(base, name);

  if (existsSync(worktreePath)) {
    log.warn(`Worktree already exists: ${worktreePath}`);
    if (opts?.startClaude) {
      launchClaude(worktreePath);
    }
    return worktreePath;
  }

  // Fetch latest first
  log.info("Fetching latest...");
  run("git fetch --all --prune", { cwd: mainRepo, quiet: true });

  // Get default branch
  const defaultBranch = getDefaultBranch(mainRepo);

  // Create worktree with a new branch based on default branch
  const branchName = name;
  log.info(`Creating worktree: ${name} (from ${defaultBranch})`);

  try {
    run(
      `git worktree add -b ${branchName} "${worktreePath}" origin/${defaultBranch}`,
      { cwd: mainRepo, quiet: true }
    );
  } catch {
    // Branch might already exist
    try {
      run(
        `git worktree add "${worktreePath}" ${branchName}`,
        { cwd: mainRepo, quiet: true }
      );
    } catch (err) {
      log.error(`Failed to create worktree: ${err}`);
      process.exit(1);
    }
  }

  log.ok(`Worktree created: ${worktreePath}`);
  log.dim(`Branch: ${branchName}`);

  // Auto-inject xbq instructions into CLAUDE.md
  setupClaude(worktreePath);

  if (opts?.startClaude) {
    launchClaude(worktreePath);
  }

  return worktreePath;
}

/**
 * List all worktrees.
 */
export function listWorktrees(): void {
  const mainRepo = getMainRepo();
  const worktrees = getWorktrees(mainRepo);

  if (worktrees.length === 0) {
    log.info("No worktrees found");
    return;
  }

  console.log();
  for (const wt of worktrees) {
    const icon = wt.isMain ? "📦" : "🌿";
    const age = getAge(wt.path);
    const status = wt.isMain ? "(main)" : age;
    console.log(`  ${icon} ${wt.branch.padEnd(30)} ${wt.path}`);
    console.log(`     ${wt.head.slice(0, 8)} ${status}`);
  }
  console.log();
}

/**
 * Clean up worktrees that have been merged or are stale.
 */
export function cleanWorktrees(opts?: { force?: boolean; maxAgeDays?: number }): void {
  const mainRepo = getMainRepo();
  const defaultBranch = getDefaultBranch(mainRepo);
  const worktrees = getWorktrees(mainRepo).filter(wt => !wt.isMain);

  if (worktrees.length === 0) {
    log.info("No worktrees to clean");
    return;
  }

  const maxAge = (opts?.maxAgeDays ?? 7) * 86400 * 1000;
  let cleaned = 0;

  for (const wt of worktrees) {
    const shouldClean = shouldCleanWorktree(wt, mainRepo, defaultBranch, maxAge, opts?.force);

    if (shouldClean.clean) {
      log.info(`Removing: ${wt.branch} — ${shouldClean.reason}`);
      try {
        run(`git worktree remove "${wt.path}" --force`, { cwd: mainRepo, quiet: true });
        // Also delete the branch if it was merged
        if (shouldClean.reason.includes("merged")) {
          try {
            run(`git branch -d ${wt.branch}`, { cwd: mainRepo, quiet: true });
          } catch {
            // Branch might not exist or can't be deleted
          }
        }
        cleaned++;
      } catch (err) {
        log.warn(`Could not remove ${wt.branch}: ${err}`);
      }
    }
  }

  if (cleaned > 0) {
    log.ok(`Cleaned ${cleaned} worktree(s)`);
    // Prune stale worktree refs
    run("git worktree prune", { cwd: mainRepo, quiet: true });
  } else {
    log.info("Nothing to clean");
  }
}

function shouldCleanWorktree(
  wt: WorktreeInfo,
  mainRepo: string,
  defaultBranch: string,
  maxAge: number,
  force?: boolean
): { clean: boolean; reason: string } {
  // Check if branch is merged into default branch
  try {
    const merged = run(
      `git branch --merged origin/${defaultBranch}`,
      { cwd: mainRepo, quiet: true }
    );
    if (merged.split("\n").some(b => b.trim() === wt.branch)) {
      return { clean: true, reason: "merged into " + defaultBranch };
    }
  } catch {
    // Ignore
  }

  // Check if worktree has no uncommitted changes and is old
  if (force) {
    return { clean: true, reason: "force clean" };
  }

  // Check age
  try {
    const stat = statSync(wt.path);
    const age = Date.now() - stat.mtimeMs;
    if (age > maxAge) {
      // Check for uncommitted changes
      const status = run("git status --porcelain", { cwd: wt.path, quiet: true });
      if (status.length === 0) {
        return { clean: true, reason: `stale (${Math.round(age / 86400000)}d old, no changes)` };
      }
    }
  } catch {
    // Can't stat, probably already gone
    return { clean: true, reason: "path inaccessible" };
  }

  return { clean: false, reason: "" };
}

function getWorktrees(mainRepo: string): WorktreeInfo[] {
  const output = run("git worktree list --porcelain", { cwd: mainRepo, quiet: true });
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice(9), isMain: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.isMain = true;
      current.branch = current.branch || "(bare)";
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo);

  // Mark the main repo
  if (worktrees.length > 0) {
    worktrees[0]!.isMain = true;
  }

  return worktrees;
}

function getDefaultBranch(repoPath: string): string {
  try {
    const ref = run("git symbolic-ref refs/remotes/origin/HEAD", { cwd: repoPath, quiet: true });
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Try common defaults
    for (const branch of ["master", "main", "develop"]) {
      try {
        run(`git rev-parse --verify origin/${branch}`, { cwd: repoPath, quiet: true });
        return branch;
      } catch {
        continue;
      }
    }
    return "master";
  }
}

function getAge(path: string): string {
  try {
    const stat = statSync(path);
    const days = Math.round((Date.now() - stat.mtimeMs) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  } catch {
    return "unknown";
  }
}

function launchClaude(worktreePath: string): void {
  log.info(`Starting Claude Code in ${worktreePath}`);
  try {
    execSync(`claude`, {
      cwd: worktreePath,
      stdio: "inherit",
    });
  } catch {
    // Claude exited, that's fine
  }
}
