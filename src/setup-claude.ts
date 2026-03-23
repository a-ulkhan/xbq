import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./utils.js";

const MARKER_START = "<!-- xbq:start -->";
const MARKER_END = "<!-- xbq:end -->";

const SNIPPET = `${MARKER_START}
## Build Queue (xbq)

This project uses \`xbq\` (Xcode Build Queue) for all build and test operations. You are working in a **lightweight worktree** — do NOT build or run tests directly here.

### Rules

1. **NEVER run \`xcodebuild\` directly** in this worktree. Always use \`xbq\`.
2. **NEVER run Xcode MCP build/test tools** directly. Route through \`xbq\`.

### Workflow

\`\`\`bash
# 1. Build (automatically captures your changes via diff)
xbq build

# 2. Test
xbq test

# 3. Test with specific plan
xbq test --test-plan All

# 4. Build with specific destination
xbq build --destination "platform=iOS Simulator,name=iPhone 16,OS=18.0"

# 5. Check queue status
xbq status
\`\`\`

### Important

- Changes are captured automatically — no need to commit before building
- \`xbq\` is a serial queue — your job may wait if another session is building
- Results include build errors and test failures in structured output
- For full logs: \`xbq logs <job-id>\`
- Exit code is 0 on success, 1 on failure — use it to determine next steps
${MARKER_END}`;

/**
 * Inject xbq instructions into CLAUDE.md at a given path.
 * If CLAUDE.md exists, appends the snippet (or updates if already present).
 * If CLAUDE.md doesn't exist, creates it.
 */
export function setupClaude(targetDir?: string): void {
  const dir = targetDir || process.cwd();
  const claudeMd = join(dir, "CLAUDE.md");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf-8");

    if (content.includes(MARKER_START)) {
      // Update existing snippet
      const regex = new RegExp(
        `${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`,
        "g"
      );
      const updated = content.replace(regex, SNIPPET);
      writeFileSync(claudeMd, updated);
      log.ok(`Updated xbq section in ${claudeMd}`);
    } else {
      // Append
      appendFileSync(claudeMd, "\n\n" + SNIPPET + "\n");
      log.ok(`Added xbq section to ${claudeMd}`);
    }
  } else {
    writeFileSync(claudeMd, SNIPPET + "\n");
    log.ok(`Created ${claudeMd} with xbq instructions`);
  }
}

/**
 * Remove xbq instructions from CLAUDE.md.
 */
export function removeClaude(targetDir?: string): void {
  const dir = targetDir || process.cwd();
  const claudeMd = join(dir, "CLAUDE.md");

  if (!existsSync(claudeMd)) {
    log.warn("No CLAUDE.md found");
    return;
  }

  const content = readFileSync(claudeMd, "utf-8");
  if (!content.includes(MARKER_START)) {
    log.warn("No xbq section found in CLAUDE.md");
    return;
  }

  const regex = new RegExp(
    `\\n*${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`,
    "g"
  );
  const updated = content.replace(regex, "\n");
  writeFileSync(claudeMd, updated.trim() + "\n");
  log.ok(`Removed xbq section from ${claudeMd}`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
