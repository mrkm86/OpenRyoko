/**
 * Automation templates — fork-specific (not an upstream file).
 *
 * Three fill-in-the-blanks shapes that cover most automations without a node
 * editor. Each template builds a full WorkflowDefinition body (nodes + edges)
 * from a flat variable map, so the web UI and the CLI share one source of
 * truth: pick a template, supply variables, save the result through the
 * ordinary definition API. Nothing here bypasses validation — the built body
 * still goes through `saveDefinition`, which runs the canonical schema.
 */
import type { WorkflowDefinition, WorkflowNode } from "./model.js";

type WorkflowEdge = WorkflowDefinition["edges"][number];

export interface TemplateVariableSpec {
  key: string;
  /** Short label, e.g. UI form label. */
  label: string;
  /** One-line hint: what to write here, with an example. */
  hint: string;
  required: boolean;
  default?: string;
  /** Fixed choices where they exist (engine names, effort levels). */
  options?: readonly string[];
}

export interface AutomationTemplate {
  id: "watch-then-act" | "scheduled-report" | "on-event";
  /** Compact display name (亮介方針: 簡潔名 + 「こういう時」の注釈). */
  name: string;
  /** The "use this when…" annotation shown beside the name. */
  when: string;
  /** Display-only flow sketch. */
  flow: string;
  variables: TemplateVariableSpec[];
}

export class TemplateError extends Error {}

const COMMON_MODEL_VARS: TemplateVariableSpec[] = [
  { key: "engine", label: "エンジン", hint: "claude / codex / gemini", required: false, default: "claude", options: ["claude", "codex", "gemini"] },
  { key: "model", label: "モデル", hint: "例: opus, sonnet, gpt-5.6-sol", required: false, default: "opus" },
  { key: "effort", label: "effort", hint: "low / medium / high / xhigh", required: false, default: "high", options: ["low", "medium", "high", "xhigh"] },
];

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "watch-then-act",
    name: "見張り型",
    when: "新着や変化を定期的にチェックして、あった時だけ AI に対応させたい",
    flow: "定期 → 判定(軽いモデル) → 必要な時だけ実行(重いモデル)",
    variables: [
      { key: "employee", label: "担当", hint: "実行する employee 名（例: ryoko）", required: true },
      { key: "interval", label: "間隔", hint: "5m / 15m / 30m / 1h、または cron 式", required: false, default: "15m" },
      { key: "watchPrompt", label: "何を見張るか", hint: "例: Gmail の受信箱に未返信の問い合わせがないか確認する", required: true },
      { key: "actPrompt", label: "見つけた時に何をするか", hint: "例: 問い合わせへの返信案を書いて #inquiry に投稿する", required: true },
      { key: "lightEngine", label: "判定エンジン", hint: "判定に使う安いエンジン", required: false, default: "claude", options: ["claude", "codex", "gemini"] },
      { key: "lightModel", label: "判定モデル", hint: "判定に使う安いモデル（例: sonnet）", required: false, default: "sonnet" },
      { key: "heavyEngine", label: "実行エンジン", hint: "本処理のエンジン", required: false, default: "claude", options: ["claude", "codex", "gemini"] },
      { key: "heavyModel", label: "実行モデル", hint: "本処理のモデル（例: opus）", required: false, default: "opus" },
      { key: "heavyEffort", label: "実行 effort", hint: "low / medium / high / xhigh", required: false, default: "high", options: ["low", "medium", "high", "xhigh"] },
      { key: "timezone", label: "タイムゾーン", hint: "IANA 名", required: false, default: "Asia/Tokyo" },
    ],
  },
  {
    id: "scheduled-report",
    name: "定時実行型",
    when: "毎朝のブリーフィングなど、決まった時間に1回だけ生成・投稿したい",
    flow: "スケジュール → 生成・投稿",
    variables: [
      { key: "employee", label: "担当", hint: "実行する employee 名（例: ryoko）", required: true },
      { key: "schedule", label: "いつ", hint: "cron 式（例: 0 7 * * * = 毎朝7時）または 15m 等の間隔", required: true },
      { key: "prompt", label: "何をするか", hint: "例: 今日の予定と未読の要点をまとめて #general に投稿する", required: true },
      ...COMMON_MODEL_VARS,
      { key: "timezone", label: "タイムゾーン", hint: "IANA 名", required: false, default: "Asia/Tokyo" },
    ],
  },
  {
    id: "on-event",
    name: "イベント駆動型",
    when: "外部のスクリプトやサービスから合図（イベント）を送って、その時だけ動かしたい",
    flow: "イベント受信 → 実行（同じ fireId の再送は二重実行しない）",
    variables: [
      { key: "employee", label: "担当", hint: "実行する employee 名（例: ryoko）", required: true },
      { key: "eventName", label: "イベント名", hint: "英数と . _ -（例: mail.inquiry-received）。POST /api/workflows/events/<イベント名> で発火", required: true },
      { key: "prompt", label: "何をするか", hint: "受信 payload は {{ trigger.payload.<key> }} で参照可能", required: true },
      ...COMMON_MODEL_VARS,
    ],
  },
];

export function getAutomationTemplate(id: string): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((template) => template.id === id);
}

/** "5m" / "15m" / "2h" / "07:30" → cron; a string with spaces passes through as cron. */
export function intervalToCron(interval: string): string {
  const value = interval.trim();
  if (value.includes(" ")) return value; // already a cron expression
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) throw new TemplateError(`時刻の形式が不正です: "${interval}"`);
    return `${minute} ${hour} * * *`;
  }
  const span = /^(\d+)(m|h)$/.exec(value);
  if (!span) throw new TemplateError(`間隔の形式が不正です: "${interval}"（例: 15m, 2h, 07:30, または cron 式）`);
  const amount = Number(span[1]);
  if (amount < 1) throw new TemplateError(`間隔は1以上にしてください: "${interval}"`);
  if (span[2] === "m") {
    if (amount > 59) throw new TemplateError(`分間隔は59以下にしてください（それ以上は cron 式で）: "${interval}"`);
    return `*/${amount} * * * *`;
  }
  if (amount > 23) throw new TemplateError(`時間間隔は23以下にしてください（それ以上は cron 式で）: "${interval}"`);
  return amount === 1 ? "0 * * * *" : `0 */${amount} * * *`;
}

function fixed(value: string): { source: "fixed"; value: string } {
  return { source: "fixed", value };
}

function resolveVars(template: AutomationTemplate, vars: Record<string, string>): Record<string, string> {
  const known = new Set(template.variables.map((item) => item.key));
  for (const key of Object.keys(vars)) {
    if (!known.has(key)) {
      throw new TemplateError(`テンプレート「${template.name}」に変数 "${key}" はありません（使える変数: ${[...known].join(", ")}）`);
    }
  }
  const resolved: Record<string, string> = {};
  for (const spec of template.variables) {
    const value = vars[spec.key]?.trim() || spec.default;
    if (!value) {
      if (spec.required) throw new TemplateError(`変数 "${spec.key}"（${spec.label}）は必須です。${spec.hint}`);
      continue;
    }
    if (spec.options && !spec.options.includes(value)) {
      throw new TemplateError(`変数 "${spec.key}" の値 "${value}" は使えません（${spec.options.join(" / ")} から選択）`);
    }
    resolved[spec.key] = value;
  }
  return resolved;
}

export interface BuiltTemplateBody {
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** Build the definition body for a template. The result still goes through
 *  the ordinary saveDefinition validation — this never bypasses the schema. */
export function buildTemplateBody(templateId: string, vars: Record<string, string>): BuiltTemplateBody {
  const template = getAutomationTemplate(templateId);
  if (!template) {
    throw new TemplateError(
      `テンプレート "${templateId}" はありません（${AUTOMATION_TEMPLATES.map((item) => item.id).join(" / ")}）`,
    );
  }
  const v = resolveVars(template, vars);

  if (template.id === "watch-then-act") {
    const cron = intervalToCron(v.interval!);
    const nodes: WorkflowNode[] = [
      { id: "start", type: "trigger", name: "定期起動", config: { kind: "schedule", cron, timezone: v.timezone! } },
      {
        id: "watch", type: "employee", name: "判定", config: {
          employee: fixed(v.employee!),
          engine: fixed(v.lightEngine!),
          model: fixed(v.lightModel!),
          prompt: `${v.watchPrompt}\n\n確認した結果を報告してください。対応が必要な場合は needsAction を true にし、summary に「何が起きていて、何をすべきか」を1〜3行で書いてください。対応が不要なら needsAction を false にしてください。`,
          output: {
            fields: {
              needsAction: { type: "boolean", required: true, description: "対応が必要か" },
              summary: { type: "string", required: true, description: "状況の要約（不要時は『対応不要』と理由）" },
            },
            allowAdditionalFields: true,
          },
        },
      },
      {
        id: "decide", type: "condition", name: "対応が必要か", config: {
          cases: [{
            port: "act", label: "対応が必要",
            all: [{ left: { source: "node", nodeId: "watch", path: "needsAction" }, operator: "equals", right: { source: "fixed", value: true } }],
          }],
          defaultPort: "skip",
        },
      },
      {
        id: "act", type: "employee", name: "実行", config: {
          employee: fixed(v.employee!),
          engine: fixed(v.heavyEngine!),
          model: fixed(v.heavyModel!),
          effort: fixed(v.heavyEffort!) as { source: "fixed"; value: "low" | "medium" | "high" | "xhigh" },
          prompt: `判定係の報告:\n{{ node.watch.summary }}\n\n${v.actPrompt}`,
          output: { fields: {}, allowAdditionalFields: true },
        },
      },
      { id: "done", type: "end", name: "完了", config: { result: "success" } },
      { id: "skipped", type: "end", name: "対応不要", config: { result: "success", message: "対応不要と判定" } },
    ];
    const edges: WorkflowEdge[] = [
      { id: "e-start-watch", from: { nodeId: "start", port: "success" }, to: { nodeId: "watch", port: "input" } },
      { id: "e-watch-decide", from: { nodeId: "watch", port: "success" }, to: { nodeId: "decide", port: "input" } },
      { id: "e-decide-act", from: { nodeId: "decide", port: "act" }, to: { nodeId: "act", port: "input" } },
      { id: "e-decide-skip", from: { nodeId: "decide", port: "skip" }, to: { nodeId: "skipped", port: "input" } },
      { id: "e-act-done", from: { nodeId: "act", port: "success" }, to: { nodeId: "done", port: "input" } },
    ];
    return {
      description: `${v.interval} ごとに見張り、必要な時だけ ${v.heavyEngine}/${v.heavyModel} で対応（テンプレート: 見張り型）`,
      nodes, edges,
    };
  }

  if (template.id === "scheduled-report") {
    const cron = intervalToCron(v.schedule!);
    const nodes: WorkflowNode[] = [
      { id: "start", type: "trigger", name: "定時起動", config: { kind: "schedule", cron, timezone: v.timezone! } },
      {
        id: "work", type: "employee", name: "実行", config: {
          employee: fixed(v.employee!),
          engine: fixed(v.engine!),
          model: fixed(v.model!),
          effort: fixed(v.effort!) as { source: "fixed"; value: "low" | "medium" | "high" | "xhigh" },
          prompt: v.prompt!,
          output: { fields: {}, allowAdditionalFields: true },
        },
      },
      { id: "done", type: "end", name: "完了", config: { result: "success" } },
    ];
    const edges: WorkflowEdge[] = [
      { id: "e-start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
      { id: "e-work-done", from: { nodeId: "work", port: "success" }, to: { nodeId: "done", port: "input" } },
    ];
    return { description: `スケジュール ${cron} で実行（テンプレート: 定時実行型）`, nodes, edges };
  }

  // on-event
  const eventName = v.eventName!;
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(eventName)) {
    throw new TemplateError(`イベント名 "${eventName}" が不正です（英字始まり、英数と . _ -、80文字まで）`);
  }
  const nodes: WorkflowNode[] = [
    { id: "start", type: "trigger", name: "イベント受信", config: { kind: "event", eventName } },
    {
      id: "work", type: "employee", name: "実行", config: {
        employee: fixed(v.employee!),
        engine: fixed(v.engine!),
        model: fixed(v.model!),
        effort: fixed(v.effort!) as { source: "fixed"; value: "low" | "medium" | "high" | "xhigh" },
        prompt: v.prompt!,
        output: { fields: {}, allowAdditionalFields: true },
      },
    },
    { id: "done", type: "end", name: "完了", config: { result: "success" } },
  ];
  const edges: WorkflowEdge[] = [
    { id: "e-start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
    { id: "e-work-done", from: { nodeId: "work", port: "success" }, to: { nodeId: "done", port: "input" } },
  ];
  return { description: `イベント ${eventName} で起動（テンプレート: イベント駆動型）`, nodes, edges };
}
