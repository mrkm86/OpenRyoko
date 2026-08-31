import { beforeEach, describe, expect, it, vi } from "vitest";

/* The CLI is the agent-facing surface: what matters is that it picks the right
 * API route for each verb, merges the two automation kinds into one view, and
 * fails in words that tell the caller (a human or Claude Code) what to run
 * next — not that it prints prettily. */

const request = vi.fn();
vi.mock("../api.js", () => ({
  requestGatewayApi: (opts: unknown) => request(opts),
}));

import {
  runAutomationList,
  runAutomationToggle,
  runWorkflowCreate,
} from "../automation.js";

function ok(body: unknown): { ok: true; status: number; body: string } {
  return { ok: true, status: 200, body: JSON.stringify(body) };
}

function logCapture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); });
  return { lines, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  request.mockReset();
});

describe("automation list", () => {
  it("merges workflows and cron jobs into one view", async () => {
    request.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/api/cron") return ok([{ id: "daily-briefing", schedule: "50 6 * * *", enabled: true }]);
      if (path === "/api/workflows") return ok([{ id: "inquiry-watch", title: "問い合わせ見張り", enabled: true, revision: 2, retiredAt: null }]);
      throw new Error(`unexpected ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationList({ json: true });
    } finally {
      capture.restore();
    }
    const payload = JSON.parse(capture.lines.join("\n")) as { workflowsEnabled: boolean; automations: Array<{ kind: string; id: string }> };
    expect(payload.workflowsEnabled).toBe(true);
    expect(payload.automations.map((row) => `${row.kind}:${row.id}`))
      .toEqual(["workflow:inquiry-watch", "cron:daily-briefing"]);
  });

  it("degrades to cron-only when the workflow engine is disabled (404)", async () => {
    request.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/api/cron") return ok([{ id: "daily-briefing", enabled: true }]);
      return { ok: false, status: 404, body: "" };
    });
    const capture = logCapture();
    try {
      await runAutomationList({ json: true });
    } finally {
      capture.restore();
    }
    const payload = JSON.parse(capture.lines.join("\n")) as { workflowsEnabled: boolean; automations: unknown[] };
    expect(payload.workflowsEnabled).toBe(false);
    expect(payload.automations).toHaveLength(1);
  });
});

describe("automation enable/disable routes by kind", () => {
  it("a cron id goes to PUT /api/cron/:id", async () => {
    request.mockImplementation(async ({ method, path }: { method: string; path: string }) => {
      if (path === "/api/cron" && method === "GET") return ok([{ id: "daily-briefing", enabled: true }]);
      if (path === "/api/cron/daily-briefing" && method === "PUT") return ok({ id: "daily-briefing", enabled: false });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationToggle("daily-briefing", false, { json: true });
    } finally {
      capture.restore();
    }
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "PUT", path: "/api/cron/daily-briefing" }));
  });

  it("a workflow id reads the revision, then posts enable with it", async () => {
    request.mockImplementation(async ({ method, path }: { method: string; path: string }) => {
      if (path === "/api/cron") return ok([]);
      if (path === "/api/workflows/inquiry-watch" && method === "GET") return ok({ id: "inquiry-watch", revision: 4 });
      if (path === "/api/workflows/inquiry-watch/enable" && method === "POST") return ok({ enabled: true, revision: 5 });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationToggle("inquiry-watch", true, { json: true });
    } finally {
      capture.restore();
    }
    const enableCall = request.mock.calls.find(([opts]) => (opts as { path: string }).path.endsWith("/enable"))![0] as { data: string };
    expect(JSON.parse(enableCall.data)).toEqual({ expectedRevision: 4 });
  });
});

describe("workflow create --template", () => {
  it("creates, saves the built body, and enables when asked", async () => {
    const calls: Array<{ method: string; path: string; data?: string }> = [];
    request.mockImplementation(async (opts: { method: string; path: string; data?: string }) => {
      calls.push(opts);
      if (opts.path === "/api/workflows" && opts.method === "POST") return ok({ id: "inquiry-watch", title: "inquiry-watch", revision: 1 });
      if (opts.path === "/api/workflows/inquiry-watch" && opts.method === "PUT") return ok({ id: "inquiry-watch", revision: 2, enabled: false });
      if (opts.path === "/api/workflows/inquiry-watch/enable") return ok({ enabled: true, revision: 3 });
      throw new Error(`unexpected ${opts.method} ${opts.path}`);
    });
    const capture = logCapture();
    try {
      await runWorkflowCreate({
        template: "watch-then-act", name: "inquiry-watch", enable: true, json: true,
        set: ["employee=ryoko", "watchPrompt=新着問い合わせを確認", "actPrompt=返信案を投稿"],
      });
    } finally {
      capture.restore();
    }
    const saved = JSON.parse(calls.find((call) => call.method === "PUT")!.data!) as {
      definition: { nodes: Array<{ id: string }> }; expectedRevision: number;
    };
    expect(saved.expectedRevision).toBe(1);
    expect(saved.definition.nodes.map((node) => node.id)).toEqual(["start", "watch", "decide", "act", "done", "skipped"]);
    expect(JSON.parse(capture.lines.join("\n"))).toEqual({ id: "inquiry-watch", revision: 2, enabled: true });
  });

  it("surfaces template variable errors as fixable messages, before any API call", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(String(line)); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    try {
      const { reportCliFailure } = await import("../automation.js");
      await runWorkflowCreate({ template: "watch-then-act", name: "x", set: ["employee=ryoko"] })
        .catch((error) => { expect(() => reportCliFailure(error)).toThrow("exit"); });
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(errors.join("\n")).toMatch(/watchPrompt/);
    expect(request).not.toHaveBeenCalled();
  });
});
