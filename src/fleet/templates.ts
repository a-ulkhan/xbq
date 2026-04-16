import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BQ_FLEET_TEMPLATES_DIR, log } from "../utils.js";
import type { FleetTemplate } from "./types.js";

const DEFAULT_TEMPLATES: FleetTemplate[] = [
  {
    name: "code-review",
    prompt_prefix:
      "Review MR !{mr} end-to-end:\n" +
      "1) Fetch the MR diff using gitlab:gitlab skill\n" +
      "2) Run parallel review agents (correctness, concurrency, naming, tests)\n" +
      "3) Post inline comments on critical findings\n" +
      "4) Summarize results",
    permissions: ["Skill(gitlab:gitlab)", "Read", "Grep", "Glob", "Agent"],
  },
  {
    name: "feature",
    prompt_prefix:
      "Implement Jira ticket {ticket} end-to-end:\n" +
      "1) Fetch ticket via jira:jira-get and understand requirements\n" +
      "2) Investigate codebase for relevant files\n" +
      "3) Implement the feature\n" +
      "4) Run xbq build, iterate on errors\n" +
      "5) Commit and push when green",
  },
  {
    name: "bugfix",
    prompt_prefix:
      "Fix Jira ticket {ticket}:\n" +
      "1) Fetch ticket and any linked crash data via jira:jira-get\n" +
      "2) Trace to root cause\n" +
      "3) Implement minimal fix\n" +
      "4) Run xbq build, iterate on errors\n" +
      "5) Commit and push when green",
  },
];

function ensureTemplatesDir(): void {
  if (!existsSync(BQ_FLEET_TEMPLATES_DIR)) {
    mkdirSync(BQ_FLEET_TEMPLATES_DIR, { recursive: true });
  }
}

/**
 * Seed default templates as JSON files if the templates directory is empty.
 */
export function seedDefaults(): void {
  ensureTemplatesDir();
  const existing = readdirSync(BQ_FLEET_TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
  if (existing.length > 0) return;

  for (const t of DEFAULT_TEMPLATES) {
    const filePath = join(BQ_FLEET_TEMPLATES_DIR, `${t.name}.json`);
    writeFileSync(filePath, JSON.stringify(t, null, 2) + "\n");
  }
  log.ok(`Seeded ${DEFAULT_TEMPLATES.length} default templates in ${BQ_FLEET_TEMPLATES_DIR}`);
}

/**
 * Load a template by name from the templates directory.
 */
export function loadTemplate(name: string): FleetTemplate | undefined {
  ensureTemplatesDir();
  const filePath = join(BQ_FLEET_TEMPLATES_DIR, `${name}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as FleetTemplate;
  } catch {
    return undefined;
  }
}

/**
 * List all templates from the templates directory.
 */
export function listTemplates(): FleetTemplate[] {
  ensureTemplatesDir();
  const templates: FleetTemplate[] = [];

  for (const file of readdirSync(BQ_FLEET_TEMPLATES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const t = JSON.parse(
        readFileSync(join(BQ_FLEET_TEMPLATES_DIR, file), "utf-8")
      ) as FleetTemplate;
      templates.push(t);
    } catch {
      // Skip malformed templates
    }
  }

  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create a new template JSON file. Returns the file path.
 */
export function createTemplate(
  name: string,
  promptPrefix: string,
  permissions?: string[]
): string {
  ensureTemplatesDir();
  const filePath = join(BQ_FLEET_TEMPLATES_DIR, `${name}.json`);

  if (existsSync(filePath)) {
    log.error(`Template '${name}' already exists. Use 'edit' to modify it.`);
    process.exit(1);
  }

  const template: FleetTemplate = { name, prompt_prefix: promptPrefix };
  if (permissions && permissions.length > 0) {
    template.permissions = permissions;
  }

  writeFileSync(filePath, JSON.stringify(template, null, 2) + "\n");
  return filePath;
}

/**
 * Delete a template JSON file.
 */
export function deleteTemplate(name: string): void {
  const filePath = join(BQ_FLEET_TEMPLATES_DIR, `${name}.json`);
  if (!existsSync(filePath)) {
    log.error(`Template '${name}' not found.`);
    process.exit(1);
  }
  require("node:fs").unlinkSync(filePath);
}

/**
 * Get the file path for a template (for editing).
 */
export function getTemplatePath(name: string): string | undefined {
  const filePath = join(BQ_FLEET_TEMPLATES_DIR, `${name}.json`);
  return existsSync(filePath) ? filePath : undefined;
}
