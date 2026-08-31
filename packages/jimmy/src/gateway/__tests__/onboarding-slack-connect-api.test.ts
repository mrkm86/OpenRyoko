import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* The whole Slack hookup as one server-side operation. The property under
 * test: a failed attempt NEVER leaves config.yaml worse than it found it —
 * bad tokens are refused before any write, and a connector that fails to
 * start after a write gets the previous Slack block put back. */

function fakePost(pathname: string, body: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = "POST";
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

function stubSlack(botOk: boolean, appOk = true): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const method = String(url).split("/api/")[1]!;
    const answer = method === "auth.test"
      ? (botOk ? { ok: true, team: "TEKION", user: "ryoko" } : { ok: false, error: "invalid_auth" })
      : (appOk ? { ok: true } : { ok: false, error: "invalid_auth" });
    return { ok: true, status: 200, json: async () => answer } as Response;
  }));
}

function readConfig(): { connectors?: { slack?: Record<string, unknown> } } {
  return (yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as { connectors?: { slack?: Record<string, unknown> } }) || {};
}

function contextWith(reload: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>): ApiContext {
  return {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
    reloadAllConnectors: reload,
  } as unknown as ApiContext;
}

const PREVIOUS = { botToken: "xoxb-OLD", appToken: "xapp-OLD", allowFrom: "U123" };

async function connect(context: ApiContext, botToken = "xoxb-NEW", appToken = "xapp-NEW"): Promise<Record<string, unknown>> {
  const { res, read } = fakeResponse();
  await handleApiRequest(fakePost("/api/onboarding/slack/connect", { botToken, appToken }), res, context);
  const { status, body } = read();
  expect(status).toBe(200);
  return body as Record<string, unknown>;
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml.dump({ engines: { default: "claude" }, connectors: { slack: PREVIOUS } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("POST /api/onboarding/slack/connect", () => {
  it("refuses at verify and writes nothing when the bot token is bad", async () => {
    stubSlack(false);
    const reload = vi.fn();
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, stage: "verify", bot: { ok: false, error: "invalid_auth" } });
    expect(reload).not.toHaveBeenCalled();
    expect(readConfig().connectors?.slack).toEqual(PREVIOUS); // untouched
  });

  it("saves and reports the workspace when tokens verify and the connector starts", async () => {
    stubSlack(true);
    const reload = vi.fn().mockResolvedValue({ started: ["slack"], stopped: ["slack"], errors: [] });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: true, team: "TEKION", user: "ryoko" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readConfig().connectors?.slack).toMatchObject({ botToken: "xoxb-NEW", appToken: "xapp-NEW", allowFrom: "U123" });
  });

  it("restores the previous Slack block when the connector fails to start after the save", async () => {
    stubSlack(true);
    const reload = vi.fn()
      .mockResolvedValueOnce({ started: [], stopped: ["slack"], errors: ["slack: An API error occurred: invalid_auth"] })
      .mockResolvedValueOnce({ started: ["slack"], stopped: [], errors: [] });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, stage: "reload", rolledBack: true });
    expect(String(outcome.error)).toContain("invalid_auth");
    expect(reload).toHaveBeenCalledTimes(2); // the failed start, then the rollback reload
    expect(readConfig().connectors?.slack).toEqual(PREVIOUS);
  });

  it("treats a reload that throws as a failure and rolls back too", async () => {
    stubSlack(true);
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ started: ["slack"], stopped: [], errors: [] });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, stage: "reload", rolledBack: true, error: "socket hang up" });
    expect(readConfig().connectors?.slack).toEqual(PREVIOUS);
  });

  it("removes the Slack block again when there was none before a failed attempt", async () => {
    fs.writeFileSync(CONFIG_PATH, yaml.dump({ engines: { default: "claude" }, connectors: {} }));
    stubSlack(true);
    const reload = vi.fn()
      .mockResolvedValueOnce({ started: [], stopped: [], errors: ["slack: invalid_auth"] })
      .mockResolvedValueOnce({ started: [], stopped: [], errors: [] });
    const outcome = await connect(contextWith(reload));
    expect(outcome).toMatchObject({ ok: false, rolledBack: true });
    expect(readConfig().connectors?.slack).toBeUndefined();
  });
});
