import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { BQ_CONFIG_PATH, ensureDirs, expandPath, log, run } from "./utils.js";
import { type BQConfig, DEFAULT_CONFIG } from "./types.js";

export function loadConfig(): BQConfig {
  if (!existsSync(BQ_CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = readFileSync(BQ_CONFIG_PATH, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export function saveConfig(config: BQConfig): void {
  ensureDirs();
  writeFileSync(BQ_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function getMainRepo(): string {
  const config = loadConfig();
  if (!config.main_repo) {
    log.error("No main repo configured. Run 'xbq init' first.");
    process.exit(1);
  }
  return expandPath(config.main_repo);
}

/**
 * Auto-detect an .xcworkspace in the given directory.
 * Excludes project.xcworkspace (Xcode internal).
 */
export function detectWorkspace(repoPath: string): string | null {
  try {
    const entries = readdirSync(repoPath).filter(
      (e) => e.endsWith(".xcworkspace") && e !== "project.xcworkspace"
    );
    return entries.length > 0 ? entries[0]! : null;
  } catch {
    return null;
  }
}

/**
 * Derive a scheme name from a workspace name.
 * "Foo.xcworkspace" → "Foo"
 */
export function detectScheme(_repoPath: string, workspace: string): string {
  return workspace.replace(".xcworkspace", "");
}

export async function initConfig(repoPath?: string): Promise<void> {
  ensureDirs();

  const config = loadConfig();

  // Resolve repo path
  let repo = repoPath || config.main_repo;
  if (!repo) {
    // Try current directory
    const cwd = process.cwd();
    if (existsSync(`${cwd}/.git`)) {
      repo = cwd;
    } else {
      log.error("Please provide the main repo path: xbq init <path>");
      process.exit(1);
    }
  }
  repo = expandPath(repo);

  // Validate
  if (!existsSync(repo)) {
    log.error(`Directory not found: ${repo}`);
    process.exit(1);
  }
  if (!existsSync(`${repo}/.git`)) {
    log.error(`Not a git repo: ${repo}`);
    process.exit(1);
  }

  config.main_repo = repo;

  // Auto-detect workspace
  const workspace = detectWorkspace(repo);
  if (workspace) {
    config.workspace = workspace;
    log.ok(`Found workspace: ${config.workspace}`);
  } else {
    log.warn("No .xcworkspace found — set workspace manually in ~/.bq/config.json");
  }

  // Auto-detect scheme from workspace name
  if (config.workspace) {
    config.default_scheme = detectScheme(repo, config.workspace);
    log.ok(`Default scheme: ${config.default_scheme}`);
  }

  // Detect backend
  try {
    run("xcrun --find mcpbridge", { quiet: true });
    config.backend = "mcp";
    log.ok("Xcode MCP (mcpbridge) found — default backend: mcp");
  } catch {
    config.backend = "xcodebuild";
    log.warn("mcpbridge not found — default backend: xcodebuild");
  }

  config.xcodebuild_fallback = true;
  config.git_restore_mtime = true;

  saveConfig(config);

  log.ok(`Configuration saved to ${BQ_CONFIG_PATH}`);
  console.log();
  console.log(`  Main repo:     ${config.main_repo}`);
  console.log(`  Workspace:     ${config.workspace || "(not detected)"}`);
  console.log(`  Scheme:        ${config.default_scheme || "(not detected)"}`);
  console.log(`  Destination:   ${config.default_destination}`);
  console.log(`  Backend:       ${config.backend}`);
  console.log();
  log.info("Next: run 'xbq daemon start' to start the build queue");
}
