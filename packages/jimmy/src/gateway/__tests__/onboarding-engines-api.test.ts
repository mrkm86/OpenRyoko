import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";

/* The onboarding wizard's "does the engine actually run" check. /api/status
 * hard-codes available:true; this route resolves the binary and runs it, so
 * the wizard can show a real ✓/✗ instead of echoing config. */

function fakeGet(pathname: string): IncomingMessage {
  const readable = Readable.from([]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1" };
  readable.method = "GET";
  readable.url = pathname;
  return readable;
}

function fakeResponse(): { res: ServerResponse; read: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader(name: string, value: string) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: chunks.length ? JSON.parse(chunks.join("")) : null }) };
}

describe("GET /api/onboarding/engines", () => {
  it("reports runnable engines with a version, and missing binaries as not installed", async () => {
    const context = {
      getConfig: () => ({
        gateway: {}, connectors: {},
        engines: {
          default: "claude",
          claude: { bin: process.execPath, model: "opus" }, // node itself: always runnable
          codex: { bin: "ryoko-no-such-binary-xyz", model: "gpt" },
        },
      }),
      connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    } as unknown as ApiContext;

    const { res, read } = fakeResponse();
    await handleApiRequest(fakeGet("/api/onboarding/engines"), res, context);

    const { status, body } = read();
    expect(status).toBe(200);
    const payload = body as { default: string; engines: Array<Record<string, unknown>> };
    expect(payload.default).toBe("claude");
    const claude = payload.engines.find((engine) => engine.name === "claude")!;
    expect(claude.installed).toBe(true);
    expect(claude.runnable).toBe(true);
    expect(String(claude.version)).toMatch(/^v?\d+/);
    expect(claude.auth).toBeDefined(); // login state is reported alongside
    const codex = payload.engines.find((engine) => engine.name === "codex")!;
    expect(codex.installed).toBe(false);
    expect(codex.runnable).toBe(false);
    expect(String(codex.error)).toContain("PATH");
    // gemini is not configured → not listed
    expect(payload.engines.some((engine) => engine.name === "gemini")).toBe(false);
  });
});
