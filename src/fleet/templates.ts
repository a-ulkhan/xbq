import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BQ_FLEET_TEMPLATES_DIR } from "../utils.js";
import type { FleetTemplate } from "./types.js";

const BUILT_IN: FleetTemplate[] = [
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

/**
 * Load a template by name. Checks user-defined templates first, then built-ins.
 */
export function loadTemplate(name: string): FleetTemplate | undefined {
  // Check user-defined templates directory first
  if (existsSync(BQ_FLEET_TEMPLATES_DIR)) {
    const userFile = join(BQ_FLEET_TEMPLATES_DIR, `${name}.json`);
    if (existsSync(userFile)) {
      try {
        return JSON.parse(readFileSync(userFile, "utf-8")) as FleetTemplate;
      } catch {
        // Fall through to built-in
      }
    }
  }

  return BUILT_IN.find((t) => t.name === name);
}

/**
 * List all available templates (user-defined + built-in, user overrides built-in).
 */
export function listTemplates(): FleetTemplate[] {
  const templates = new Map<string, FleetTemplate>();

  // Built-ins first
  for (const t of BUILT_IN) {
    templates.set(t.name, t);
  }

  // User-defined override built-ins
  if (existsSync(BQ_FLEET_TEMPLATES_DIR)) {
    for (const file of readdirSync(BQ_FLEET_TEMPLATES_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const t = JSON.parse(
          readFileSync(join(BQ_FLEET_TEMPLATES_DIR, file), "utf-8")
        ) as FleetTemplate;
        templates.set(t.name, t);
      } catch {
        // Skip malformed templates
      }
    }
  }

  return [...templates.values()];
}
