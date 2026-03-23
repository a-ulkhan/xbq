import { join } from "node:path";
import { type Job, type JobResult } from "../types.js";
import { BQ_LOGS_DIR, log, spawnWithLog } from "../utils.js";

/**
 * Execute a build/test job using xcodebuild.
 */
export async function executeWithXcodebuild(
  job: Job,
  repoPath: string,
  workspace: string
): Promise<JobResult> {
  const logPath = join(BQ_LOGS_DIR, `${job.id}.log`);
  const workspacePath = join(repoPath, workspace);
  const startTime = Date.now();
  const destination = job.destination || "platform=iOS Simulator,name=iPhone 16";

  const args: string[] = [];

  if (job.action === "test") {
    args.push(
      "test",
      "-workspace", workspacePath,
      "-scheme", job.scheme,
      "-destination", destination,
      "-resultBundlePath", join(BQ_LOGS_DIR, `${job.id}.xcresult`)
    );
    if (job.test_plan) {
      args.push("-testPlan", job.test_plan);
    }
  } else {
    args.push(
      "build",
      "-workspace", workspacePath,
      "-scheme", job.scheme,
      "-destination", destination
    );
  }

  log.info(`Running: xcodebuild ${args.slice(0, 3).join(" ")} ...`);

  const failures: string[] = [];
  const buildErrors: string[] = [];
  const warnings: string[] = [];

  const { exitCode, output } = await spawnWithLog("xcodebuild", args, {
    cwd: repoPath,
    logPath,
    onLine: (line) => {
      if (line.includes("** BUILD FAILED **")) {
        buildErrors.push("Build failed");
      } else if (line.includes("** TEST FAILED **")) {
        // Will parse individual failures below
      } else if (line.includes("** BUILD SUCCEEDED **")) {
        log.ok("Build succeeded");
      } else if (line.includes("** TEST SUCCEEDED **")) {
        log.ok("Tests succeeded");
      } else if (line.match(/error:/i)) {
        buildErrors.push(line.trim());
      } else if (line.match(/Test Case .* failed/)) {
        failures.push(line.trim());
      } else if (line.match(/warning:/i) && warnings.length < 20) {
        warnings.push(line.trim());
      }
    },
  });

  const duration = Math.round((Date.now() - startTime) / 1000);

  // Parse test count from output
  let summary = "";
  const testSummary = output.match(/Executed (\d+) tests?, with (\d+) failures?/);
  if (testSummary) {
    const [, total, failed] = testSummary;
    const passed = parseInt(total!) - parseInt(failed!);
    summary = `${passed}/${total} tests passed`;
    if (parseInt(failed!) > 0) {
      summary += ` (${failed} failed)`;
    }
  } else if (exitCode === 0) {
    summary = job.action === "test" ? "All tests passed" : "Build succeeded";
  } else {
    summary = job.action === "test" ? "Tests failed" : "Build failed";
  }

  return {
    id: job.id,
    status: exitCode === 0 ? "passed" : "failed",
    duration_seconds: duration,
    summary,
    failures,
    build_errors: buildErrors,
    warnings,
    log_path: logPath,
  };
}
