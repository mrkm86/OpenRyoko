/**
 * `ryoko automation` / `ryoko workflow` — the machine-friendly face of the
 * automation hub. Everything speaks through the gateway API (same routes the
 * web UI uses), takes `--json` for agents, and explains its own failures in
 * fixable terms. Claude Code / Codex are first-class callers here.
 */
import { requestGatewayApi } from "./api.js";
import { AUTOMATION_TEMPLATES, buildTemplateBody, TemplateError } from "../workflows/templates.js";

interface CronJobRow {
  id: string;
  schedule?: string;
  enabled?: boolean;
  employee?: string;
  description?: string;
  lastRun?: { at?: string; timestamp?: string; status?: string } | null;
}

interface WorkflowSummaryRow {
  id: string;
  title: string;
  enabled: boolean;
  revision: number;
  retiredAt: string | null;
}

class CliFailure extends Error {}

function fail(message: string): never {
  throw new CliFailure(message);
}

async function gateway(method: string, apiPath: string, data?: unknown): Promise<unknown> {
  let result;
  try {
    result = await requestGatewayApi({ method, path: apiPath, ...(data === undefined ? {} : { data: JSON.stringify(data) }) });
  } catch (error) {
    fail(`ゲートウェイに接続できません（${error instanceof Error ? error.message : String(error)}）。\`ryoko status\` で稼働を確認してください。`);
  }
  if (result.status === 404 && apiPath.startsWith("/api/workflows")) {
    fail("Workflow エンジンが無効です。config.yaml に `workflows:\\n  enabled: true` を追記してゲートウェイを再起動してください。");
  }
  if (!result.ok) {
    let detail = result.body;
    try {
      const parsed = JSON.parse(result.body) as { message?: string; issues?: unknown };
      detail = parsed.message ?? result.body;
      if (parsed.issues) detail += `\n${JSON.stringify(parsed.issues, null, 2)}`;
    } catch { /* leave raw */ }
    fail(`${method} ${apiPath} が失敗しました（HTTP ${result.status}）: ${detail}`);
  }
  try {
    return result.body ? JSON.parse(result.body) : null;
  } catch {
    fail(`${apiPath} の応答を JSON として読めませんでした`);
  }
}

function emit(json: boolean, data: unknown, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  human();
}

function cronLastRunAt(job: CronJobRow): string {
  const at = job.lastRun?.at ?? job.lastRun?.timestamp;
  return typeof at === "string" ? at : "—";
}

/** One merged table: workflows and cron jobs, the same rows the web page shows. */
export async function runAutomationList(opts: { json?: boolean }): Promise<void> {
  const [cronJobs, workflowResult] = await Promise.all([
    gateway("GET", "/api/cron") as Promise<CronJobRow[]>,
    (async () => {
      try {
        return await gateway("GET", "/api/workflows") as WorkflowSummaryRow[];
      } catch (error) {
        // Workflows disabled is a normal state for the merged list — show cron alone.
        if (error instanceof CliFailure && error.message.includes("Workflow エンジンが無効")) return null;
        throw error;
      }
    })(),
  ]);

  const rows = [
    ...(workflowResult ?? []).filter((item) => !item.retiredAt).map((item) => ({
      kind: "workflow" as const, id: item.id, title: item.title, enabled: item.enabled, schedule: null as string | null, lastRun: null as string | null,
    })),
    ...cronJobs.map((job) => ({
      kind: "cron" as const, id: job.id, title: job.description ?? job.id, enabled: job.enabled !== false,
      schedule: job.schedule ?? null, lastRun: cronLastRunAt(job),
    })),
  ];

  emit(Boolean(opts.json), { workflowsEnabled: workflowResult !== null, automations: rows }, () => {
    if (workflowResult === null) {
      console.log("(Workflow エンジンは無効。cron のみ表示 — 有効化は config.workflows.enabled: true)\n");
    }
    const pad = (value: string, width: number) => value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
    console.log(`${pad("種別", 10)} ${pad("ID", 34)} ${pad("状態", 6)} ${pad("スケジュール", 16)} 最終実行`);
    for (const row of rows) {
      console.log(`${pad(row.kind, 10)} ${pad(row.id, 34)} ${pad(row.enabled ? "ON" : "off", 6)} ${pad(row.schedule ?? "—", 16)} ${row.lastRun ?? "—"}`);
    }
    console.log(`\n${rows.length} 件。詳細: ryoko workflow show <id> / 切替: ryoko automation enable|disable <id>`);
  });
}

/** enable/disable works on either kind by the same verb — the caller should
 *  not have to know which storage a row lives in. */
export async function runAutomationToggle(id: string, enabled: boolean, opts: { json?: boolean }): Promise<void> {
  const cronJobs = await gateway("GET", "/api/cron") as CronJobRow[];
  const cron = cronJobs.find((job) => job.id === id);
  if (cron) {
    await gateway("PUT", `/api/cron/${encodeURIComponent(id)}`, { enabled });
    emit(Boolean(opts.json), { kind: "cron", id, enabled }, () => {
      console.log(`cron ${id} を ${enabled ? "有効" : "無効"} にしました`);
    });
    return;
  }
  const definition = await gateway("GET", `/api/workflows/${encodeURIComponent(id)}`) as { revision: number };
  const saved = await gateway("POST", `/api/workflows/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
    { expectedRevision: definition.revision }) as { enabled: boolean; revision: number };
  emit(Boolean(opts.json), { kind: "workflow", id, enabled: saved.enabled }, () => {
    console.log(`workflow ${id} を ${saved.enabled ? "有効" : "無効"} にしました`);
  });
}

export async function runWorkflowTemplates(opts: { json?: boolean }): Promise<void> {
  emit(Boolean(opts.json), { templates: AUTOMATION_TEMPLATES }, () => {
    for (const template of AUTOMATION_TEMPLATES) {
      console.log(`${template.id} — ${template.name}`);
      console.log(`  こういう時: ${template.when}`);
      console.log(`  流れ: ${template.flow}`);
      console.log(`  変数:`);
      for (const variable of template.variables) {
        const req = variable.required ? "必須" : `任意${variable.default ? ` (既定 ${variable.default})` : ""}`;
        console.log(`    --set ${variable.key}=…  ${variable.label}（${req}）${variable.hint ? ` — ${variable.hint}` : ""}`);
      }
      console.log("");
    }
  });
}

export interface WorkflowCreateOptions {
  template?: string;
  file?: string;
  name?: string;
  title?: string;
  set: string[];
  enable?: boolean;
  json?: boolean;
}

export async function runWorkflowCreate(opts: WorkflowCreateOptions): Promise<void> {
  if (!opts.template && !opts.file) {
    fail("--template <id> か --file <def.json> のどちらかを指定してください。テンプレ一覧: ryoko workflow templates");
  }
  if (!opts.name) fail("--name <id> は必須です（英数とハイフン。例: --name inquiry-watch）");
  const id = opts.name;

  let body: { description?: string; nodes: unknown[]; edges: unknown[] };
  if (opts.template) {
    const vars: Record<string, string> = {};
    for (const pair of opts.set) {
      const eq = pair.indexOf("=");
      if (eq < 1) fail(`--set の形式が不正です: "${pair}"（--set key=value）`);
      vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    try {
      body = buildTemplateBody(opts.template, vars);
    } catch (error) {
      if (error instanceof TemplateError) fail(error.message);
      throw error;
    }
  } else {
    const { readFileSync } = await import("node:fs");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(opts.file!, "utf-8"));
    } catch (error) {
      fail(`${opts.file} を読めませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
    const definition = parsed as { nodes?: unknown[]; edges?: unknown[]; description?: string };
    if (!Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
      fail(`${opts.file} に nodes / edges がありません。GET /api/workflows/<id> が返す definition と同じ形にしてください`);
    }
    body = { description: definition.description, nodes: definition.nodes, edges: definition.edges };
  }

  const created = await gateway("POST", "/api/workflows", {
    id, title: opts.title ?? id, ...(body.description ? { description: body.description } : {}),
  }) as { id: string; revision: number };
  const saved = await gateway("PUT", `/api/workflows/${encodeURIComponent(id)}`, {
    definition: { ...created, nodes: body.nodes, edges: body.edges },
    expectedRevision: created.revision,
  }) as { id: string; revision: number; enabled: boolean };

  let enabled = saved.enabled;
  if (opts.enable) {
    const armed = await gateway("POST", `/api/workflows/${encodeURIComponent(id)}/enable`,
      { expectedRevision: saved.revision }) as { enabled: boolean };
    enabled = armed.enabled;
  }

  emit(Boolean(opts.json), { id, revision: saved.revision, enabled }, () => {
    console.log(`workflow ${id} を作成しました（${enabled ? "有効" : "無効のまま。有効化: ryoko automation enable " + id}）`);
  });
}

export async function runWorkflowShow(id: string, opts: { json?: boolean }): Promise<void> {
  const definition = await gateway("GET", `/api/workflows/${encodeURIComponent(id)}`) as {
    id: string; title: string; enabled: boolean; revision: number; description?: string | null;
    nodes: Array<{ id: string; type: string; name: string }>;
  };
  emit(Boolean(opts.json), definition, () => {
    console.log(`${definition.id} — ${definition.title}（${definition.enabled ? "有効" : "無効"} / rev ${definition.revision}）`);
    if (definition.description) console.log(definition.description);
    console.log(`ノード: ${definition.nodes.map((node) => `${node.name}[${node.type}]`).join(" → ")}`);
  });
}

export async function runWorkflowStart(id: string, opts: { json?: boolean }): Promise<void> {
  const run = await gateway("POST", `/api/workflows/${encodeURIComponent(id)}/runs`, { input: {} }) as {
    id: string; status: string;
  };
  emit(Boolean(opts.json), { runId: run.id, status: run.status }, () => {
    console.log(`run ${run.id} を開始しました（${run.status}）。履歴: ryoko workflow runs ${id}`);
  });
}

export async function runWorkflowRuns(id: string, opts: { json?: boolean }): Promise<void> {
  const result = await gateway("GET", `/api/workflows/${encodeURIComponent(id)}/runs`) as {
    items: Array<{ id: string; status: string; startedAt: string; endedAt: string | null;
      currentOrFailingNode: { label: string; state: string } | null }>;
  };
  emit(Boolean(opts.json), result, () => {
    if (result.items.length === 0) {
      console.log("実行履歴はまだありません。手動実行: ryoko workflow run " + id);
      return;
    }
    for (const run of result.items) {
      const node = run.currentOrFailingNode ? ` @ ${run.currentOrFailingNode.label}(${run.currentOrFailingNode.state})` : "";
      console.log(`${run.startedAt}  ${run.status}${node}  ${run.id}`);
    }
  });
}

export async function runWorkflowList(opts: { json?: boolean }): Promise<void> {
  const items = await gateway("GET", "/api/workflows") as WorkflowSummaryRow[];
  emit(Boolean(opts.json), { workflows: items }, () => {
    for (const item of items) {
      console.log(`${item.enabled ? "ON " : "off"}  ${item.id} — ${item.title}${item.retiredAt ? "（退役）" : ""}`);
    }
    if (items.length === 0) console.log("workflow はまだありません。作成: ryoko workflow create --template <id> --name <id> --set k=v");
  });
}

export function reportCliFailure(error: unknown): never {
  if (error instanceof CliFailure) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
