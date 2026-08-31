/**
 * Atomic workflow creation — fork-specific gateway composition (not an upstream
 * file). Lives under gateway/ deliberately: the workflows runtime itself never
 * touches a raw database handle (see todo-capability-boundary.test.ts).
 *
 * `createDefinition` → `saveDefinition` → `setEnabled` are three repository
 * transactions; a failure between them strands a skeleton (or disabled)
 * definition whose id then conflicts on retry. Wrapping the three service
 * calls in ONE better-sqlite3 transaction on the same connection turns the
 * inner transactions into savepoints, so any failure rolls the whole create
 * back to nothing.
 */
import type Database from "better-sqlite3";
import type { WorkflowService } from "../workflows/service.js";
import type { WorkflowNode } from "../workflows/model.js";

export interface AtomicCreateInput {
  id: string;
  title: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: Array<{ id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }>;
  enable: boolean;
}

export interface AtomicCreateResult {
  id: string;
  revision: number;
  enabled: boolean;
}

export function createWorkflowAtomically(
  database: Database.Database,
  service: WorkflowService,
  input: AtomicCreateInput,
): AtomicCreateResult {
  const run = database.transaction(() => {
    const created = service.createDefinition({
      id: input.id, title: input.title,
      ...(input.description ? { description: input.description } : {}),
    });
    const saved = service.saveDefinition(
      { ...created, nodes: input.nodes, edges: input.edges } as never,
      created.revision,
    );
    const armed = input.enable
      ? service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision })
      : saved;
    return { id: armed.id, revision: armed.revision, enabled: armed.enabled };
  });
  return run.immediate();
}
