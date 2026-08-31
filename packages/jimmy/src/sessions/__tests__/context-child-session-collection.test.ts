import { describe, it, expect } from "vitest";
import { buildContext } from "../context.js";

// Sibling of context-process-lifetime.test.ts. There, a detached job died with the
// one-shot process and the agent had promised to report back. Here the same shape of
// failure happens one level up: the protocol told an orchestrator to spawn a child,
// end its turn, and rely on the onComplete callback. That callback is fire-and-forget
// and is skipped outright when the child has no parentSessionId, when the employee sets
// alwaysNotify:false, or when the parent is already in error — so a parent that ends its
// turn waiting for it stops with no error and nobody is told.
describe("buildContext — child session results are collected, not awaited", () => {
  const baseOpts = {
    source: "slack",
    channel: "C123",
    user: "U123",
  };

  const stubConfig = {
    jinn: { version: "0.0.0" },
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "" },
      codex: { bin: "codex", model: "" },
    },
    connectors: {},
    logging: { level: "info", stdout: false, file: "" },
  };

  function delegationContext() {
    // The delegation protocol is COO-only: it is omitted when `employee` is set.
    return buildContext({ ...baseOpts, config: stubConfig as never });
  }

  it("includes the delegation protocol for a COO session", () => {
    expect(delegationContext()).toContain("## Employee Delegation Protocol");
  });

  it("omits the delegation protocol for an employee session", () => {
    const ctx = buildContext({ ...baseOpts, employee: "some-employee" as never, config: stubConfig as never });
    expect(ctx).not.toContain("## Employee Delegation Protocol");
  });

  it("tells the orchestrator to read the child's result itself", () => {
    const ctx = delegationContext();
    expect(ctx).toContain("Collect the result yourself");
    expect(ctx).toContain("ryoko api GET /api/sessions/<child-id>");
  });

  it("never promises that a completion notification will arrive", () => {
    const ctx = delegationContext();
    // The old wording was an unconditional promise, and agents followed it.
    expect(ctx).not.toContain("NEVER poll or wait");
    expect(ctx).not.toContain("will message you automatically");
    expect(ctx).not.toMatch(/no polling needed/i);
  });

  it("names the three conditions under which the notification is skipped", () => {
    const ctx = delegationContext();
    expect(ctx).toContain("delivery is NOT guaranteed");
    expect(ctx).toContain("parentSessionId");
    expect(ctx).toContain("alwaysNotify: false");
    expect(ctx).toContain("in \\`error\\`".replace(/\\/g, ""));
  });

  it("warns that a parent waiting on the notification stops silently", () => {
    expect(delegationContext()).toContain("stops\nsilently, and nobody is told");
  });

  it("points at the job runner, which does guarantee a wake-up", () => {
    const ctx = delegationContext();
    expect(ctx).toContain("ryoko job run");
    expect(ctx).toContain("guarantee a wake-up on exit");
  });

  it("requires parentSessionId so the notification is at least attempted", () => {
    expect(delegationContext()).toContain("Always pass \\`parentSessionId\\`".replace(/\\/g, ""));
  });
});
