import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { BQ_CONFIG_PATH, ensureDirs, expandPath, log, run } from "./utils.js";
import { type BQConfig, DEFAULT_CONFIG } from "./types.js";

/** All valid config keys */
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof BQConfig)[];

/** Validation rules for config values */
const VALIDATORS: Partial<Record<keyof BQConfig, { choices?: string[]; type?: "boolean" | "string" }>> = {
  backend: { choices: ["mcp", "xcodebuild"] },
  xcodebuild_fallback: { type: "boolean" },
  git_restore_mtime: { type: "boolean" },
};

function parseConfigValue(key: keyof BQConfig, value: string): string | boolean {
  const rule = VALIDATORS[key];
  if (rule?.choices && !rule.choices.includes(value)) {
    log.error(`Invalid value "${value}" for ${key}. Must be one of: ${rule.choices.join(", ")}`);
    process.exit(1);
  }
  if (rule?.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    log.error(`Invalid value "${value}" for ${key}. Must be true or false`);
    process.exit(1);
  }
  return value;
}

export function configList(): void {
  const config = loadConfig();
  const defaults = DEFAULT_CONFIG;

  console.log();
  for (const key of CONFIG_KEYS) {
    const val = config[key];
    const def = defaults[key];
    const modified = val !== def ? " (modified)" : "";
    console.log(`  ${key} = ${val}${modified}`);
  }
  console.log();
}

export function configGet(key: string): void {
  if (!CONFIG_KEYS.includes(key as keyof BQConfig)) {
    log.error(`Unknown config key: ${key}`);
    log.info(`Valid keys: ${CONFIG_KEYS.join(", ")}`);
    process.exit(1);
  }
  const config = loadConfig();
  console.log(config[key as keyof BQConfig]);
}

export function configSet(key: string, value: string): void {
  if (!CONFIG_KEYS.includes(key as keyof BQConfig)) {
    log.error(`Unknown config key: ${key}`);
    log.info(`Valid keys: ${CONFIG_KEYS.join(", ")}`);
    process.exit(1);
  }

  const config = loadConfig();
  const parsed = parseConfigValue(key as keyof BQConfig, value);
  (config as unknown as Record<string, unknown>)[key] = parsed;
  saveConfig(config);
  log.ok(`${key} = ${parsed}`);
}

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
    log.warn("No .xcworkspace found — set manually: xbq config set workspace MyApp.xcworkspace");
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
