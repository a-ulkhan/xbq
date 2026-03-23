import { type Job, type JobResult } from "./types.js";
import { loadConfig } from "./config.js";
import { applySnapshot, cleanSnapshot } from "./snapshot.js";
import { expandPath, log, run } from "./utils.js";
import { executeWithMCP } from "./backends/mcp.js";
import { executeWithXcodebuild } from "./backends/xcodebuild.js";

/**
 * Execute a single job: apply patch or checkout branch, build/test, return results.
 */
export async function executeJob(job: Job): Promise<JobResult> {
  const config = loadConfig();
  const repoPath = expandPath(config.main_repo);
  const workspace = config.workspace;

  // 1. Stash any uncommitted changes in main repo
  const stashed = stashIfDirty(repoPath);

  try {
    if (job.snapshot_sha) {
      // Snapshot mode: detached HEAD checkout
      applySnapshot(repoPath, job.snapshot_sha);
    } else if (job.branch) {
      // Branch mode: fetch and checkout
      log.info("Fetching latest changes...");
      run("git fetch --all --prune", { cwd: repoPath, quiet: true });
      log.info(`Checking out branch: ${job.branch}`);
      checkoutBranch(repoPath, job.branch);
    } else {
      throw new Error("Job has neither snapshot_sha nor branch");
    }

    // Restore file timestamps for incremental builds
    if (config.git_restore_mtime) {
      restoreMtime(repoPath);
    }

    // Run build/test via selected backend
    const backend = job.backend || config.backend;
    log.info(`Backend: ${backend}`);

    if (backend === "mcp") {
      try {
        return await executeWithMCP(job, repoPath, workspace);
      } catch (err) {
        if (config.xcodebuild_fallback) {
          log.warn(`MCP failed, falling back to xcodebuild: ${err}`);
          return await executeWithXcodebuild(job, repoPath, workspace);
        }
        throw err;
      }
    } else {
      return await executeWithXcodebuild(job, repoPath, workspace);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Job failed: ${message}`);
    return {
      id: job.id,
      status: "error",
      duration_seconds: 0,
      summary: message,
      failures: [],
      build_errors: [message],
      warnings: [],
      log_path: "",
    };
  } finally {
    // Return to default branch after snapshot checkout
    if (job.snapshot_sha) {
      cleanSnapshot(repoPath);
    }

    // Restore stashed changes
    if (stashed) {
      try {
        run("git stash pop", { cwd: repoPath, quiet: true });
      } catch {
        log.warn("Could not restore stashed changes in main repo");
      }
    }
  }
}

function stashIfDirty(repoPath: string): boolean {
  const status = run("git status --porcelain", { cwd: repoPath, quiet: true });
  if (status.length > 0) {
    log.warn("Main repo has uncommitted changes — stashing");
    run("git stash push -m 'xbq: auto-stash before build'", { cwd: repoPath, quiet: true });
    return true;
  }
  return false;
}

function checkoutBranch(repoPath: string, branch: string): void {
  // Try local branch first
  try {
    run(`git checkout ${branch}`, { cwd: repoPath, quiet: true });
    return;
  } catch {
    // Branch might not exist locally
  }

  // Try tracking remote branch
  try {
    run(`git checkout -b ${branch} origin/${branch}`, { cwd: repoPath, quiet: true });
    return;
  } catch {
    // Already exists or other error
  }

  // Force update local branch to match remote
  try {
    run(`git checkout ${branch}`, { cwd: repoPath, quiet: true });
    run(`git reset --hard origin/${branch}`, { cwd: repoPath, quiet: true });
  } catch (err) {
    throw new Error(`Failed to checkout branch '${branch}': ${err}`);
  }
}

/**
 * Restore file modification times from git history.
 * This helps Xcode's incremental build system avoid unnecessary recompilation.
 */
function restoreMtime(repoPath: string): void {
  try {
    run("which git-restore-mtime", { quiet: true });
    log.dim("Restoring file timestamps...");
    run("git-restore-mtime --skip-missing", { cwd: repoPath, quiet: true });
  } catch {
    // git-restore-mtime not installed, skip silently
  }
}
