import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(),
      // paths.ts runs migrateLegacyHome() at module load — never let a
      // per-path existsSync mock reach the real renameSync.
      renameSync: vi.fn(),
    },
  };
});
vi.mock("../../gateway/org.js", () => ({ scanOrg: vi.fn(() => ({ departments: [] })) }));
vi.mock("../../gateway/services.js", () => ({ buildServiceRegistry: vi.fn(() => new Map()) }));
vi.mock("../../jobs/state.js", () => ({ findJobsNeedingAttention: vi.fn(() => []) }));

import fs from "node:fs";
import type { JinnConfig } from "../../shared/types.js";
import { buildMemoryContext, isTrustedSpeaker } from "../context.js";

const mockReadFileSync = vi.mocked(fs.readFileSync);

const CONFIG = {
  portal: { trustedSpeakers: ["U0AAAAAAA"] },
} as unknown as JinnConfig;

function setMemoryFile(content: string | null) {
  mockReadFileSync.mockImplementation((p) => {
    if (String(p).endsWith("MEMORY.md")) {
      if (content === null) throw new Error("ENOENT");
      return content;
    }
    throw new Error("ENOENT");
  });
}

describe("isTrustedSpeaker", () => {
  it("trusts the operator, private web sessions, and listed Slack IDs", () => {
    expect(isTrustedSpeaker({ source: "slack", speakerIsOperator: true, config: CONFIG })).toBe(true);
    expect(isTrustedSpeaker({ source: "web", speakerIsOperator: false, config: CONFIG })).toBe(true);
    expect(
      isTrustedSpeaker({ source: "slack", speakerIsOperator: false, speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBe(true);
  });

  it("does not trust unlisted speakers, missing speakers (cron), or empty config", () => {
    expect(
      isTrustedSpeaker({ source: "slack", speakerIsOperator: false, speakerSlackId: "U0BBBBBBB", config: CONFIG }),
    ).toBe(false);
    expect(isTrustedSpeaker({ source: "slack", speakerIsOperator: false, config: CONFIG })).toBe(false);
    expect(
      isTrustedSpeaker({ source: "slack", speakerIsOperator: false, speakerSlackId: "U0AAAAAAA", config: undefined }),
    ).toBe(false);
  });
});

describe("buildMemoryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects MEMORY.md for a trusted speaker, with the privacy instruction", () => {
    setMemoryFile("## Facts\n- オーナーはA社の代表");
    const out = buildMemoryContext({ source: "slack", speakerIsOperator: true, config: CONFIG });
    expect(out).toContain("オーナーはA社の代表");
    expect(out).toContain("Never reveal");
  });

  it("returns null for untrusted speakers even when MEMORY.md exists", () => {
    setMemoryFile("secret facts");
    const out = buildMemoryContext({
      source: "slack",
      speakerIsOperator: false,
      speakerSlackId: "U0BBBBBBB",
      config: CONFIG,
    });
    expect(out).toBeNull();
  });

  it("returns null when MEMORY.md is missing or empty", () => {
    setMemoryFile(null);
    expect(buildMemoryContext({ source: "web", speakerIsOperator: false, config: CONFIG })).toBeNull();
    setMemoryFile("   \n  ");
    expect(buildMemoryContext({ source: "web", speakerIsOperator: false, config: CONFIG })).toBeNull();
  });

  it("caps oversized MEMORY.md with a trim notice", () => {
    setMemoryFile("x".repeat(30_000));
    const out = buildMemoryContext({ source: "web", speakerIsOperator: false, config: CONFIG });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(25_000);
    expect(out).toContain("exceeds the injection cap");
  });
});
