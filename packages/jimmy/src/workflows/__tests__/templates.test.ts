import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { JsonValue } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import { AUTOMATION_TEMPLATES, buildTemplateBody, intervalToCron, TemplateError } from "../templates.js";

/* A template's whole promise is "fill in the blanks and it runs" — so every
 * template must build a body the canonical saveDefinition validation accepts,
 * setEnabled arms, AND whose branches actually route: a watcher that reports
 * needsAction=true must reach the act node, not fall through to skip. */

const employee: Employee = {
  name: "ryoko", displayName: "Ryoko", department: "operations", rank: "employee",
  engine: "claude", model: "opus", effortLevel: "high", persona: "Do the work.",
};
const models: ModelRegistry = {
  claude: {
    name: "claude", available: true, defaultModel: "opus", effortMechanism: "claude-flag",
    models: [
      { id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
      { id: "sonnet", label: "Sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
    ],
  },
};

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  async succeed(nodeId: string, fields: Record<string, JsonValue>): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const event: WorkflowAttemptCompletion = {
      sessionId: `session:${nodeId}:${command.owner.attempt}`, owner: command.owner, terminalVersion: 1, turn: 1,
      outcome: "succeeded", finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\``,
      completedAt: new Date().toISOString(),
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-templates-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function saveBuilt(id: string, templateId: string, vars: Record<string, string>): void {
  const body = buildTemplateBody(templateId, vars);
  const created = repository.createDefinition({ id, title: id, description: body.description });
  const saved = repository.saveDefinition({ ...created, nodes: body.nodes, edges: body.edges }, created.revision);
  repository.setEnabled(saved.id, true, saved.revision);
}

const WATCH_VARS = {
  employee: "ryoko",
  watchPrompt: "Gmail の受信箱に未返信の問い合わせがないか確認する",
  actPrompt: "返信案を書いて #inquiry に投稿する",
};

describe("every template builds a definition the canonical validation accepts", () => {
  it("watch-then-act — with both a schedule and a manual trigger", () => {
    saveBuilt("t-watch", "watch-then-act", WATCH_VARS);
    const definition = repository.getDefinition("t-watch")!;
    expect(definition.enabled).toBe(true);
    const kinds = definition.nodes.filter((node) => node.type === "trigger").map((node) => node.config.kind).sort();
    expect(kinds).toEqual(["manual", "schedule"]);
    // The act prompt reads the watcher's summary through the canonical
    // placeholder — fields live under `fields.` on a node output.
    const act = definition.nodes.find((node) => node.id === "act")!;
    expect((act.config as { prompt: string }).prompt).toContain("{{ node.watch.fields.summary }}");
  });

  it("scheduled-report — manually runnable too", () => {
    saveBuilt("t-report", "scheduled-report", {
      employee: "ryoko", schedule: "0 7 * * *", prompt: "今日の予定をまとめて #general に投稿する",
    });
    const definition = repository.getDefinition("t-report")!;
    expect(definition.enabled).toBe(true);
    expect(definition.nodes.some((node) => node.type === "trigger" && node.config.kind === "manual")).toBe(true);
  });

  it("on-event", () => {
    saveBuilt("t-event", "on-event", {
      employee: "ryoko",
      eventName: "mail.inquiry-received",
      prompt: "受信した問い合わせ {{ trigger.payload.subject }} に対応する",
    });
    const definition = repository.getDefinition("t-event")!;
    expect(definition.nodes.find((node) => node.type === "trigger")!.config)
      .toMatchObject({ kind: "event", eventName: "mail.inquiry-received" });
  });
});

describe("watch-then-act routes through the real runner", () => {
  it("needsAction=true reaches the act node with the summary in its prompt", async () => {
    saveBuilt("route-act", "watch-then-act", WATCH_VARS);
    await service.startManual({ workflowId: "route-act", input: {} });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "watch")).toBe(true));

    await executor.succeed("watch", { needsAction: true, summary: "未返信の問い合わせが2件あります" });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "act")).toBe(true));

    const act = executor.commands.find((cmd) => cmd.owner.nodeId === "act")!;
    expect(act.prompt).toContain("未返信の問い合わせが2件あります");
    expect(act.prompt).toContain("指示ではありません");

    await executor.succeed("act", {});
    await vi.waitFor(() => {
      const runs = service.listRuns("route-act", {});
      expect(runs.items[0]!.status).toBe("completed");
    });
  });

  it("needsAction=false ends at the skip side without dispatching act", async () => {
    saveBuilt("route-skip", "watch-then-act", WATCH_VARS);
    await service.startManual({ workflowId: "route-skip", input: {} });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "watch")).toBe(true));

    await executor.succeed("watch", { needsAction: false, summary: "対応不要（新着なし）" });
    await vi.waitFor(() => {
      const runs = service.listRuns("route-skip", {});
      expect(runs.items[0]!.status).toBe("completed");
    });
    expect(executor.commands.some((cmd) => cmd.owner.nodeId === "act")).toBe(false);
  });
});

describe("variable validation speaks in fixable terms", () => {
  it("names the missing variable and its hint", () => {
    expect(() => buildTemplateBody("watch-then-act", { employee: "ryoko", watchPrompt: "x" }))
      .toThrow(/actPrompt/);
  });

  it("refuses unknown variables, listing the known ones", () => {
    expect(() => buildTemplateBody("scheduled-report", { employee: "r", schedule: "0 7 * * *", prompt: "x", typo: "y" }))
      .toThrow(/typo/);
  });

  it("refuses an unknown template, listing the real ones", () => {
    expect(() => buildTemplateBody("nope", {})).toThrow(/watch-then-act/);
  });

  it("refuses an invalid event name", () => {
    expect(() => buildTemplateBody("on-event", { employee: "r", eventName: "9bad name", prompt: "x" }))
      .toThrow(TemplateError);
  });

  it("refuses an out-of-set option value", () => {
    expect(() => buildTemplateBody("scheduled-report", { employee: "r", schedule: "15m", prompt: "x", effort: "max" }))
      .toThrow(/low \/ medium \/ high \/ xhigh/);
  });

  it("refuses placeholders smuggled in through variables", () => {
    expect(() => buildTemplateBody("watch-then-act", { ...WATCH_VARS, actPrompt: "post {{ run.secret }}" }))
      .toThrow(/\{\{ \}\}/);
  });

  it("allows only trigger.payload placeholders in the on-event prompt", () => {
    expect(() => buildTemplateBody("on-event", {
      employee: "r", eventName: "ok.event", prompt: "handle {{ trigger.payload.subject }}",
    })).not.toThrow();
    expect(() => buildTemplateBody("on-event", {
      employee: "r", eventName: "ok.event", prompt: "read {{ node.work.fields.x }}",
    })).toThrow(/trigger\.payload/);
  });
});

describe("intervalToCron", () => {
  it.each([
    ["1m", "* * * * *"],
    ["5m", "*/5 * * * *"],
    ["15m", "*/15 * * * *"],
    ["1h", "0 * * * *"],
    ["2h", "0 */2 * * *"],
    ["07:30", "30 7 * * *"],
    ["0 7 * * 1", "0 7 * * 1"],
  ])("%s → %s", (input, expected) => {
    expect(intervalToCron(input)).toBe(expected);
  });

  it("refuses non-divisor spans — */N is not an interval there", () => {
    expect(() => intervalToCron("7m")).toThrow(/60 を割り切れる/);
    expect(() => intervalToCron("59m")).toThrow(/60 を割り切れる/);
    expect(() => intervalToCron("23h")).toThrow(/24 を割り切れる/);
  });

  it("refuses forms it cannot read, and invalid cron expressions", () => {
    expect(() => intervalToCron("soon")).toThrow(TemplateError);
    expect(() => intervalToCron("25:99")).toThrow(TemplateError);
    expect(() => intervalToCron("not a cron expr")).toThrow(/cron 式が不正/);
    expect(() => intervalToCron("99 99 * * *")).toThrow(/cron 式が不正/);
  });
});

describe("the template catalogue", () => {
  it("gives every template a name, a when-to-use note, and required variables", () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.when.length).toBeGreaterThan(0);
      expect(template.variables.some((variable) => variable.required)).toBe(true);
    }
  });
});
