import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import { AUTOMATION_TEMPLATES, buildTemplateBody, intervalToCron, TemplateError } from "../templates.js";

/* A template's whole promise is "fill in the blanks and it runs" — so every
 * template must build a body the canonical saveDefinition validation accepts
 * and setEnabled arms. A template that only LOOKS valid is worse than none. */

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-templates-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function saveBuilt(id: string, templateId: string, vars: Record<string, string>): void {
  const body = buildTemplateBody(templateId, vars);
  const created = repository.createDefinition({ id, title: id, description: body.description });
  const saved = repository.saveDefinition({ ...created, nodes: body.nodes, edges: body.edges }, created.revision);
  repository.setEnabled(saved.id, true, saved.revision);
}

describe("every template builds a definition the canonical validation accepts", () => {
  it("watch-then-act", () => {
    saveBuilt("t-watch", "watch-then-act", {
      employee: "ryoko",
      watchPrompt: "Gmail の受信箱に未返信の問い合わせがないか確認する",
      actPrompt: "返信案を書いて #inquiry に投稿する",
    });
    const definition = repository.getDefinition("t-watch")!;
    expect(definition.enabled).toBe(true);
    const trigger = definition.nodes.find((node) => node.type === "trigger")!;
    expect(trigger.config).toMatchObject({ kind: "schedule", cron: "*/15 * * * *", timezone: "Asia/Tokyo" });
    // The act prompt reads the watcher's summary through the canonical placeholder.
    const act = definition.nodes.find((node) => node.id === "act")!;
    expect((act.config as { prompt: string }).prompt).toContain("{{ node.watch.summary }}");
  });

  it("scheduled-report", () => {
    saveBuilt("t-report", "scheduled-report", {
      employee: "ryoko",
      schedule: "0 7 * * *",
      prompt: "今日の予定をまとめて #general に投稿する",
    });
    expect(repository.getDefinition("t-report")!.enabled).toBe(true);
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
});

describe("intervalToCron", () => {
  it.each([
    ["5m", "*/5 * * * *"],
    ["15m", "*/15 * * * *"],
    ["1h", "0 * * * *"],
    ["2h", "0 */2 * * *"],
    ["07:30", "30 7 * * *"],
    ["0 7 * * 1", "0 7 * * 1"],
  ])("%s → %s", (input, expected) => {
    expect(intervalToCron(input)).toBe(expected);
  });

  it("refuses forms it cannot read", () => {
    expect(() => intervalToCron("soon")).toThrow(TemplateError);
    expect(() => intervalToCron("90m")).toThrow(TemplateError);
    expect(() => intervalToCron("25:99")).toThrow(TemplateError);
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
