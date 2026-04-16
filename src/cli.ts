#!/usr/bin/env node
import { Command } from "commander";
import { initConfig, configList, configGet, configSet } from "./config.js";
import { startDaemon, stopDaemon, daemonStatus } from "./daemon.js";
import { enqueueAndWait } from "./enqueue.js";
import { createWorktree, listWorktrees, cleanWorktrees } from "./worktree.js";
import { setupClaude, removeClaude } from "./setup-claude.js";
import { fleetStatus, fleetLaunch, fleetStop } from "./fleet/manager.js";
import { listTemplates, createTemplate, deleteTemplate, getTemplatePath, seedDefaults } from "./fleet/templates.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { BQ_LOGS_DIR, BQ_RESULTS_DIR, log } from "./utils.js";
import type { JobResult } from "./types.js";

const program = new Command();

program
  .name("xbq")
  .description("Serial build queue for Xcode projects with git worktrees")
  .version("0.5.0");

// --- init ---
program
  .command("init [repo-path]")
  .description("Initialize xbq with your main Xcode repo path")
  .action(async (repoPath?: string) => {
    await initConfig(repoPath);
  });

// --- build ---
program
  .command("build")
  .description("Enqueue a build job")
  .option("-b, --branch <branch>", "Branch to build (optional in worktree)")
  .option("-s, --scheme <scheme>", "Xcode scheme")
  .option("-d, --destination <dest>", "Simulator destination (e.g. 'platform=iOS Simulator,name=iPhone 16,OS=18.0')")
  .option("--backend <backend>", "Backend: mcp or xcodebuild")
  .option("--timeout <seconds>", "Timeout in seconds", "1800")
  .action(async (opts) => {
    const result = await enqueueAndWait({
      action: "build",
      branch: opts.branch,
      scheme: opts.scheme,
      destination: opts.destination,
      backend: opts.backend,
      timeout: parseInt(opts.timeout),
    });
    printResult(result);
    process.exit(result.status === "passed" ? 0 : 1);
  });

// --- test ---
program
  .command("test")
  .description("Enqueue a test job")
  .option("-b, --branch <branch>", "Branch to test (optional in worktree)")
  .option("-s, --scheme <scheme>", "Xcode scheme")
  .option("-t, --test-plan <plan>", "Test plan name")
  .option("-d, --destination <dest>", "Simulator destination")
  .option("-o, --only-testing <identifiers...>", "Run only specific tests (Target/Class or Target/Class/method)")
  .option("--backend <backend>", "Backend: mcp or xcodebuild")
  .option("--timeout <seconds>", "Timeout in seconds", "1800")
  .action(async (opts) => {
    const result = await enqueueAndWait({
      action: "test",
      branch: opts.branch,
      scheme: opts.scheme,
      testPlan: opts.testPlan,
      onlyTesting: opts.onlyTesting,
      destination: opts.destination,
      backend: opts.backend,
      timeout: parseInt(opts.timeout),
    });
    printResult(result);
    process.exit(result.status === "passed" ? 0 : 1);
  });

// --- daemon ---
const daemon = program
  .command("daemon")
  .description("Manage the build queue daemon");

daemon
  .command("start")
  .description("Start the daemon")
  .option("-f, --foreground", "Run in foreground")
  .action(async (opts) => {
    if (opts.foreground) {
      await startDaemon({ foreground: true });
    } else {
      await startDaemon();
    }
  });

daemon
  .command("stop")
  .description("Stop the daemon")
  .action(() => {
    stopDaemon();
  });

daemon
  .command("status")
  .description("Show daemon and queue status")
  .action(() => {
    daemonStatus();
  });

// --- status ---
program
  .command("status")
  .description("Show queue status")
  .action(() => {
    daemonStatus();
  });

// --- logs ---
program
  .command("logs [job-id]")
  .description("View build logs")
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .action((jobId?: string, opts?: { lines: string }) => {
    if (jobId) {
      const logPath = join(BQ_LOGS_DIR, `${jobId}.log`);
      if (!existsSync(logPath)) {
        log.error(`Log not found: ${logPath}`);
        process.exit(1);
      }
      const content = readFileSync(logPath, "utf-8");
      const lines = content.split("\n");
      const n = parseInt(opts?.lines || "50");
      console.log(lines.slice(-n).join("\n"));
    } else {
      // List recent results
      if (!existsSync(BQ_RESULTS_DIR)) {
        log.info("No results yet");
        return;
      }
      const files = readdirSync(BQ_RESULTS_DIR)
        .filter(f => f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, 10);

      if (files.length === 0) {
        log.info("No results yet");
        return;
      }

      console.log("Recent jobs:");
      for (const f of files) {
        const r: JobResult = JSON.parse(readFileSync(join(BQ_RESULTS_DIR, f), "utf-8"));
        const icon = r.status === "passed" ? "\x1b[32m\u2713\x1b[0m" : r.status === "failed" ? "\x1b[31m\u2717\x1b[0m" : "\x1b[33m!\x1b[0m";
        console.log(`  ${icon} ${r.id}  ${r.summary}  (${r.duration_seconds}s)`);
      }
    }
  });

// --- worktree ---
const worktree = program
  .command("worktree")
  .description("Manage git worktrees for parallel sessions");

worktree
  .command("new [name]")
  .description("Create a new worktree (and optionally start Claude Code)")
  .option("-c, --claude", "Start Claude Code in the new worktree")
  .action((name?: string, opts?: { claude?: boolean }) => {
    const path = createWorktree(name, { startClaude: opts?.claude });
    console.log(path);
  });

worktree
  .command("list")
  .description("List all worktrees")
  .action(() => {
    listWorktrees();
  });

worktree
  .command("clean")
  .description("Remove merged and stale worktrees")
  .option("-f, --force", "Force remove all non-main worktrees")
  .option("-d, --days <n>", "Max age in days for stale worktrees", "7")
  .action((opts) => {
    cleanWorktrees({
      force: opts.force,
      maxAgeDays: parseInt(opts.days),
    });
  });

// --- session (shortcut: worktree new + claude) ---
program
  .command("session [name]")
  .description("Create a worktree and start Claude Code in it")
  .option("-p, --prompt <prompt>", "Initial prompt to pass to Claude")
  .action((name: string | undefined, opts: { prompt?: string }) => {
    createWorktree(name, { startClaude: true, prompt: opts.prompt });
  });

// --- setup-claude ---
program
  .command("setup-claude [dir]")
  .description("Inject xbq instructions into CLAUDE.md (run in worktree root)")
  .option("--remove", "Remove xbq instructions from CLAUDE.md")
  .action((dir?: string, opts?: { remove?: boolean }) => {
    if (opts?.remove) {
      removeClaude(dir);
    } else {
      setupClaude(dir);
    }
  });

// --- config ---
const config = program
  .command("config")
  .description("View and update configuration");

config
  .command("list")
  .description("Show all config values")
  .action(() => {
    configList();
  });

config
  .command("get <key>")
  .description("Get a config value")
  .action((key: string) => {
    configGet(key);
  });

config
  .command("set <key> <value>")
  .description("Set a config value")
  .action((key: string, value: string) => {
    configSet(key, value);
  });

// --- fleet ---
const fleet = program
  .command("fleet")
  .description("Manage fleet of parallel Claude sessions across worktrees");

fleet
  .command("status")
  .description("Show all fleet sessions and their state")
  .action(() => {
    fleetStatus();
  });

fleet
  .command("launch [name]")
  .description("Create a worktree and track it as a fleet session")
  .option("-t, --template <template>", "Template: code-review, feature, bugfix")
  .option("--mr <iid>", "GitLab MR IID (for code-review template)")
  .option("--ticket <key>", "Jira ticket key (for feature/bugfix template)")
  .option("-p, --prompt <prompt>", "Additional prompt for Claude")
  .action((name: string | undefined, opts: { template?: string; mr?: string; ticket?: string; prompt?: string }) => {
    fleetLaunch(name, opts);
  });

fleet
  .command("stop <name>")
  .description("Mark a fleet session as stopped")
  .action((name: string) => {
    fleetStop(name);
  });

const templates = fleet
  .command("templates")
  .description("Manage fleet templates");

templates
  .command("list")
  .description("List available fleet templates")
  .action(() => {
    const all = listTemplates();
    if (all.length === 0) {
      log.info("No templates found. Run 'xbq fleet templates seed' to create defaults.");
      return;
    }
    console.log();
    for (const t of all) {
      console.log(`  ${t.name}`);
      console.log(`    ${t.prompt_prefix.split("\n")[0]}`);
      if (t.permissions) {
        console.log(`    permissions: ${t.permissions.join(", ")}`);
      }
      console.log();
    }
  });

templates
  .command("create <name>")
  .description("Create a new template")
  .requiredOption("--prompt <prompt>", "Prompt prefix (use {ticket}, {mr} as placeholders)")
  .option("--permissions <perms...>", "Permission list")
  .action((name: string, opts: { prompt: string; permissions?: string[] }) => {
    const filePath = createTemplate(name, opts.prompt, opts.permissions);
    log.ok(`Template '${name}' created: ${filePath}`);
    log.info("Edit the JSON file to customize further.");
  });

templates
  .command("edit <name>")
  .description("Open a template in $EDITOR")
  .action((name: string) => {
    const filePath = getTemplatePath(name);
    if (!filePath) {
      log.error(`Template '${name}' not found.`);
      process.exit(1);
    }
    const editor = process.env.EDITOR || "vi";
    require("node:child_process").execSync(`${editor} ${filePath}`, { stdio: "inherit" });
  });

templates
  .command("delete <name>")
  .description("Delete a template")
  .action((name: string) => {
    deleteTemplate(name);
    log.ok(`Template '${name}' deleted.`);
  });

templates
  .command("seed")
  .description("Seed default templates (code-review, feature, bugfix)")
  .action(() => {
    seedDefaults();
  });

// --- clean ---
program
  .command("clean")
  .description("Clean old results and logs")
  .option("-d, --days <n>", "Remove results older than N days", "7")
  .action((opts) => {
    const maxAge = parseInt(opts.days) * 86400 * 1000;
    const now = Date.now();
    let cleaned = 0;

    for (const dir of [BQ_RESULTS_DIR, BQ_LOGS_DIR]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        const stat = require("node:fs").statSync(path);
        if (now - stat.mtimeMs > maxAge) {
          require("node:fs").unlinkSync(path);
          cleaned++;
        }
      }
    }

    log.ok(`Cleaned ${cleaned} old files`);
  });

function printResult(result: JobResult): void {
  console.log();
  if (result.status === "passed") {
    log.ok(result.summary);
  } else if (result.status === "failed") {
    log.error(result.summary);
    if (result.build_errors.length > 0) {
      console.log("\n  Build errors:");
      for (const e of result.build_errors.slice(0, 10)) {
        console.log(`    \x1b[31m\u2022\x1b[0m ${e}`);
      }
    }
    if (result.failures.length > 0) {
      console.log("\n  Test failures:");
      for (const f of result.failures.slice(0, 10)) {
        console.log(`    \x1b[31m\u2022\x1b[0m ${f}`);
      }
    }
  } else {
    log.error(result.summary);
  }

  if (result.log_path) {
    console.log(`\n  Full log: xbq logs ${result.id}`);
  }
  console.log();
}

program.parse();
