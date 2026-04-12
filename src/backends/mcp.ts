import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { type Job, type JobResult } from "../types.js";
import { BQ_LOGS_DIR, log } from "../utils.js";

/**
 * Minimal MCP client that talks to Xcode's mcpbridge via JSON-RPC over stdio.
 */
class MCPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn("xcrun", ["mcpbridge"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(new Error(`Failed to spawn mcpbridge: ${err}`));
        return;
      }

      this.process.stdout?.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.dim(`mcpbridge: ${msg}`);
      });

      this.process.on("error", (err) => {
        reject(new Error(`mcpbridge error: ${err.message}`));
      });

      this.process.on("close", (code) => {
        for (const [, { reject: r }] of this.pending) {
          r(new Error(`mcpbridge exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Initialize MCP session
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "xbq", version: "0.1.0" },
      }).then(() => {
        this.sendNotification("notifications/initialized", {});
        resolve();
      }).catch(reject);
    });
  }

  private processBuffer(): void {
    // MCP uses Content-Length framed messages
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // Skip malformed messages
      }
    }
  }

  private sendRaw(msg: object): void {
    const body = JSON.stringify(msg);
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    this.process?.stdin?.write(frame);
  }

  private sendRequest(method: string, params: object): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 300_000); // 5 min timeout for builds

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendNotification(method: string, params: object): void {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest("tools/call", { name, arguments: args });
  }

  disconnect(): void {
    this.process?.kill();
    this.process = null;
  }
}

/**
 * Execute a build/test job using Xcode MCP.
 */
export async function executeWithMCP(
  job: Job,
  repoPath: string,
  workspace: string
): Promise<JobResult> {
  const logPath = join(BQ_LOGS_DIR, `${job.id}.log`);
  const logStream: WriteStream = createWriteStream(logPath, { flags: "a" });
  const startTime = Date.now();

  const appendLog = (msg: string) => {
    logStream.write(msg + "\n");
  };

  const client = new MCPClient();

  try {
    log.info("Connecting to Xcode MCP...");
    await client.connect();
    log.ok("Connected to Xcode MCP");

    let result: unknown;

    if (job.action === "build") {
      log.info(`Building scheme: ${job.scheme}`);
      appendLog(`[bq] Building scheme: ${job.scheme}`);

      result = await client.callTool("build", {
        scheme: job.scheme,
        workspace: join(repoPath, workspace),
        ...(job.destination ? { destination: job.destination } : {}),
      });
    } else {
      log.info(`Testing scheme: ${job.scheme}, plan: ${job.test_plan || "default"}`);
      appendLog(`[bq] Testing scheme: ${job.scheme}`);

      result = await client.callTool("run_tests", {
        scheme: job.scheme,
        workspace: join(repoPath, workspace),
        ...(job.test_plan ? { testPlan: job.test_plan } : {}),
        ...(job.only_testing && job.only_testing.length > 0 ? { onlyTesting: job.only_testing } : {}),
        ...(job.destination ? { destination: job.destination } : {}),
      });
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    appendLog(`[bq] Completed in ${duration}s`);
    appendLog(JSON.stringify(result, null, 2));

    // Parse MCP response
    return parseMCPResult(job.id, result, duration, logPath);
  } catch (err: unknown) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    const message = err instanceof Error ? err.message : String(err);
    appendLog(`[bq] Error: ${message}`);

    return {
      id: job.id,
      status: "error",
      duration_seconds: duration,
      summary: `MCP error: ${message}`,
      failures: [],
      build_errors: [message],
      warnings: [],
      log_path: logPath,
    };
  } finally {
    client.disconnect();
    logStream.end();
  }
}

function parseMCPResult(
  jobId: string,
  raw: unknown,
  duration: number,
  logPath: string
): JobResult {
  // MCP tool results come as { content: [{ type: "text", text: "..." }] }
  const r = raw as { content?: Array<{ type: string; text: string }> };
  const text = r?.content?.map((c) => c.text).join("\n") || JSON.stringify(raw);

  const failures: string[] = [];
  const buildErrors: string[] = [];
  const warnings: string[] = [];

  for (const line of text.split("\n")) {
    if (line.match(/error:/i)) buildErrors.push(line.trim());
    else if (line.match(/Test Case .* failed/)) failures.push(line.trim());
    else if (line.match(/warning:/i) && warnings.length < 20) warnings.push(line.trim());
  }

  const hasError = buildErrors.length > 0 || failures.length > 0;
  const testMatch = text.match(/Executed (\d+) tests?, with (\d+) failures?/);
  let summary = "";

  if (testMatch) {
    const [, total, failed] = testMatch;
    summary = `${parseInt(total!) - parseInt(failed!)}/${total} tests passed`;
  } else if (text.includes("BUILD SUCCEEDED") || text.includes("TEST SUCCEEDED")) {
    summary = "Succeeded";
  } else if (hasError) {
    summary = `${buildErrors.length} errors, ${failures.length} test failures`;
  } else {
    summary = "Completed (check logs for details)";
  }

  return {
    id: jobId,
    status: hasError ? "failed" : "passed",
    duration_seconds: duration,
    summary,
    failures,
    build_errors: buildErrors,
    warnings,
    log_path: logPath,
  };
}
