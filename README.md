# xbq — Xcode Build Queue

Serial build queue for Xcode projects with git worktrees.

## Problem

Running multiple Claude Code sessions on the same Xcode project requires separate repos, each needing its own SPM resolution and DerivedData (~8GB+ per copy). This tool eliminates that duplication by routing all builds through a single "main" repo.

## How It Works

```
┌──────────────┐   ┌──────────────┐    ┌──────────────┐
│ Claude Code  │   │ Claude Code  │    │ Claude Code  │
│ (worktree A) │   │ (worktree B) │    │ (worktree C) │
└──────┬───────┘   └──────┬───────┘    └──────┬───────┘
       │ snapshot         │ snapshot          │ snapshot
       └──────────────────┼───────────────────┘
                          ▼
               ┌────────────────────┐
               │ xbq (serial queue) │
               │                    │
               │ checkout snapshot  │
               │ (detached HEAD)    │
               │ build/test via     │
               │ Xcode MCP or       │
               │ xcodebuild         │
               └────────┬───────────┘
                        ▼
                  ┌───────────┐
                  │ Main Repo │  ← single DerivedData
                  │ (warm)    │  ← SPM already resolved
                  └───────────┘
```

- Claude Code sessions edit code in lightweight git worktrees (code only, no builds)
- When they need to build/test, they run `xbq build` or `xbq test`
- `xbq` creates a snapshot commit of all changes and checks it out via detached HEAD in the main repo
- Jobs run serially to prevent DerivedData corruption
- Results are returned to the requesting session
- Each worktree gets a `CLAUDE.md` that tells Claude Code to use `xbq`

## Installation

### npm (recommended)

```bash
npm install -g xcode-build-queue
```

### From GitHub

```bash
npm install -g github:a-ulkhan/xbq
```

### From source

```bash
git clone https://github.com/a-ulkhan/xbq.git
cd xbq
make install
```

## Setup

```bash
# Configure (point to your main Xcode repo)
xbq init ~/path/to/your/project

# Start the daemon
xbq daemon start
```

### Optional: `git-restore-mtime`

For best incremental build performance after branch switches:

```bash
pip3 install git-restore-mtime
```

## Quick Start

### Start a new parallel session

```bash
# Create a worktree + launch Claude Code (all-in-one)
xbq session my-feature

# Or create worktree only (e.g. to open in a new terminal)
xbq worktree new my-feature

# Auto-named session (timestamp-based)
xbq session
```

`xbq session` / `xbq worktree new`:
1. Creates a git worktree branching from the default branch
2. Auto-injects `xbq` instructions into the worktree's `CLAUDE.md`
3. Optionally launches Claude Code in the worktree

### Build and test from a worktree

```bash
# Build (changes are captured automatically via diff — no commit needed)
xbq build

# Run tests
xbq test

# With specific destination
xbq build --destination "platform=iOS Simulator,name=iPhone 16,OS=26.2"

# Specific scheme/test plan
xbq test --scheme MyScheme --test-plan All

# Force xcodebuild backend
xbq build --backend xcodebuild

# Legacy branch mode (for pushed branches)
xbq build --branch feature/my-branch
```

## Worktree Management

```bash
# List all worktrees
xbq worktree list

# Clean up merged and stale worktrees (>7 days, no uncommitted changes)
xbq worktree clean

# Force remove all non-main worktrees
xbq worktree clean --force

# Custom age threshold
xbq worktree clean --days 3
```

### Cleanup rules

| Condition | Action |
|-----------|--------|
| Branch merged into default branch | Removed automatically |
| Stale (>7d) with no uncommitted changes | Removed automatically |
| Active with uncommitted work | Kept (unless `--force`) |

Tip: add to crontab for automatic cleanup:
```bash
0 9 * * * xbq worktree clean
```

## Claude Code Integration

Every worktree created by `xbq` gets a `CLAUDE.md` that instructs Claude Code to:

- **NEVER** run `xcodebuild` directly in the worktree
- **NEVER** use Xcode MCP build/test tools directly
- **ALWAYS** use `xbq build` / `xbq test` (changes are captured automatically)

This is automatic — no manual setup needed per session.

To manually manage the Claude integration:

```bash
# Inject xbq instructions into an existing project's CLAUDE.md
xbq setup-claude /path/to/worktree

# Remove xbq instructions
xbq setup-claude --remove /path/to/worktree
```

The injection is idempotent (safe to run multiple times) and uses HTML markers to update in place.

## Queue Management

```bash
# Check daemon and queue status
xbq status

# View recent job results
xbq logs

# View a specific job's full log
xbq logs 20260323-101530-abc123

# Clean old results and logs (default: 7 days)
xbq clean
```

## Daemon

```bash
xbq daemon start      # Start in background
xbq daemon stop       # Stop
xbq daemon status     # Check status + queue info
xbq daemon start -f   # Foreground (for debugging)
```

The daemon auto-starts when you enqueue a job if it's not already running.

## Backends

### Xcode MCP (default)

Uses Xcode 26.3+'s native MCP server (`xcrun mcpbridge`). Requires Xcode to be running with the project open. Provides richer diagnostics.

### xcodebuild (fallback)

Standard CLI build tool. Works headless, no Xcode GUI needed. Auto-selected when mcpbridge is unavailable.

If MCP fails, `xbq` automatically falls back to xcodebuild (configurable).

## Configuration

Stored at `~/.bq/config.json`:

```json
{
  "main_repo": "~/path/to/your/project",
  "workspace": "MyApp.xcworkspace",
  "default_scheme": "MyApp",
  "default_test_plan": "",
  "default_destination": "platform=iOS Simulator,name=iPhone 16",
  "backend": "mcp",
  "xcodebuild_fallback": true,
  "git_restore_mtime": true
}
```

Workspace and scheme are auto-detected during `xbq init`.

## All Commands

| Command | Description |
|---------|-------------|
| `xbq init [path]` | First-time setup — set main repo path |
| `xbq session [name]` | Create worktree + start Claude Code |
| `xbq worktree new [name]` | Create a new worktree |
| `xbq worktree list` | List all worktrees |
| `xbq worktree clean` | Remove merged/stale worktrees |
| `xbq build` | Enqueue a build job |
| `xbq test` | Enqueue a test job |
| `xbq status` | Show daemon + queue status |
| `xbq logs [job-id]` | View build logs / recent results |
| `xbq daemon start\|stop\|status` | Manage the queue daemon |
| `xbq setup-claude [dir]` | Inject/update xbq instructions in CLAUDE.md |
| `xbq clean` | Clean old results and logs |

### Common flags

| Flag | Commands | Description |
|------|----------|-------------|
| `-b, --branch <branch>` | build, test | Branch to build (optional in worktree) |
| `-s, --scheme <scheme>` | build, test | Xcode scheme override |
| `-d, --destination <dest>` | build, test | Simulator destination |
| `-t, --test-plan <plan>` | test | Test plan name |
| `--backend <backend>` | build, test | Force mcp or xcodebuild |
| `--timeout <seconds>` | build, test | Job timeout (default: 1800) |

## Requirements

- Node.js >= 18
- Xcode 26.3+ (for MCP backend) or any Xcode (for xcodebuild backend)
- git
- Optional: `git-restore-mtime` (`pip3 install git-restore-mtime`)
