import { log, run } from "./utils.js";

/**
 * Detect the default branch (master, main, develop) for a repo.
 */
export function getDefaultBranch(repoPath: string): string {
  try {
    const ref = run("git symbolic-ref refs/remotes/origin/HEAD", { cwd: repoPath, quiet: true });
    return ref.replace("refs/remotes/origin/", "");
  } catch {
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

/**
 * Check if the current directory is inside a git worktree (not the main repo).
 */
export function isInWorktree(): boolean {
  try {
    const commonDir = run("git rev-parse --git-common-dir", { quiet: true }).replace(/\/$/, "");
    const gitDir = run("git rev-parse --git-dir", { quiet: true }).replace(/\/$/, "");
    return commonDir !== gitDir;
  } catch {
    return false;
  }
}

/**
 * Create a snapshot commit of the current worktree state (committed + uncommitted
 * + untracked) without modifying any refs. Returns a SHA that the main repo can
 * checkout via detached HEAD (shared object store across worktrees).
 */
export function createSnapshot(): string {
  const cwd = process.cwd();

  // Check if there are uncommitted changes (staged, unstaged, or untracked)
  const status = run("git status --porcelain", { cwd, quiet: true });

  if (!status) {
    // No uncommitted changes — use HEAD directly
    const sha = run("git rev-parse HEAD", { cwd, quiet: true });
    log.dim("No uncommitted changes — using HEAD");
    return sha;
  }

  // Stage everything (including untracked files) to capture full state
  run("git add -A", { cwd, quiet: true });

  try {
    // Write the current index as a tree object
    const tree = run("git write-tree", { cwd, quiet: true });

    // Create a commit object pointing to this tree (no ref update)
    const head = run("git rev-parse HEAD", { cwd, quiet: true });
    const sha = run(
      `git commit-tree ${tree} -p ${head} -m "xbq snapshot"`,
      { cwd, quiet: true }
    );

    log.dim(`Snapshot: ${sha.slice(0, 8)}`);
    return sha;
  } finally {
    // Always restore the index to its original state
    run("git reset", { cwd, quiet: true });
  }
}

/**
 * Apply a snapshot by checking out the SHA as a detached HEAD in the main repo.
 * Detached HEAD bypasses the worktree branch lock.
 */
export function applySnapshot(repoPath: string, sha: string): void {
  log.info(`Checking out snapshot ${sha.slice(0, 8)}...`);
  try {
    run(`git checkout ${sha}`, { cwd: repoPath, quiet: true });
  } catch (err) {
    throw new Error(`Failed to checkout snapshot ${sha.slice(0, 8)}: ${err}`);
  }
  log.ok("Snapshot applied");
}

/**
 * Clean up the main repo by returning to the default branch.
 */
export function cleanSnapshot(repoPath: string): void {
  const defaultBranch = getDefaultBranch(repoPath);
  try {
    // Discard any index/worktree changes from the snapshot before switching
    run("git reset --hard", { cwd: repoPath, quiet: true });
    run(`git checkout ${defaultBranch}`, { cwd: repoPath, quiet: true });
  } catch {
    log.warn(`Could not return to ${defaultBranch} — attempting force cleanup`);
    try {
      run("git checkout --force " + defaultBranch, { cwd: repoPath, quiet: true });
    } catch {
      log.error(`Failed to restore ${defaultBranch}. Manual cleanup required: cd ${repoPath} && git checkout ${defaultBranch}`);
    }
  }
}

/**
 * Pre-build safety check: ensure the main repo is on its default branch
 * with no uncommitted changes or stale detached HEAD from a previous run.
 */
export function ensureCleanMainRepo(repoPath: string): void {
  const defaultBranch = getDefaultBranch(repoPath);

  // Check if HEAD is detached
  let isDetached = false;
  try {
    run("git symbolic-ref HEAD", { cwd: repoPath, quiet: true });
  } catch {
    isDetached = true;
  }

  if (isDetached) {
    log.warn("Main repo is in detached HEAD (stale snapshot?) — recovering...");
    try {
      run("git reset --hard", { cwd: repoPath, quiet: true });
      run(`git checkout ${defaultBranch}`, { cwd: repoPath, quiet: true });
      log.ok(`Recovered to ${defaultBranch}`);
    } catch {
      throw new Error(
        `Main repo stuck in detached HEAD and recovery failed. ` +
        `Manual fix: cd ${repoPath} && git checkout ${defaultBranch}`
      );
    }
    return;
  }

  // Check if on the expected branch
  const currentBranch = run("git branch --show-current", { cwd: repoPath, quiet: true });
  if (currentBranch !== defaultBranch) {
    log.warn(`Main repo on '${currentBranch}' instead of '${defaultBranch}' — switching...`);
    try {
      run("git reset --hard", { cwd: repoPath, quiet: true });
      run(`git checkout ${defaultBranch}`, { cwd: repoPath, quiet: true });
      log.ok(`Switched to ${defaultBranch}`);
    } catch {
      throw new Error(
        `Could not switch main repo to ${defaultBranch}. ` +
        `Manual fix: cd ${repoPath} && git checkout ${defaultBranch}`
      );
    }
  }
}
