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
import { buildMemoryContext, isMemoryEligible } from "../context.js";

const mockReadFileSync = vi.mocked(fs.readFileSync);

const CONFIG = {
  portal: { trustedSpeakers: ["U0AAAAAAA"], operatorName: "太郎" },
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

describe("isMemoryEligible", () => {
  it("allows web sessions and trusted-ID Slack DMs", () => {
    expect(isMemoryEligible({ source: "web", config: CONFIG })).toBe(true);
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBe(true);
  });

  it("denies untrusted DMs, missing speaker IDs, and empty config", () => {
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0BBBBBBB", config: CONFIG }),
    ).toBe(false);
    expect(isMemoryEligible({ source: "slack", channel: "D0123456", config: CONFIG })).toBe(false);
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0AAAAAAA", config: undefined }),
    ).toBe(false);
  });

  it("denies SHARED channels even for trusted speakers (session history is reused across participants)", () => {
    expect(
      isMemoryEligible({ source: "slack", channel: "C0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBe(false);
  });

  it("is keyed on immutable IDs only — a speaker impersonating the operator's display name gains nothing", () => {
    // The gate takes no name inputs at all; an untrusted ID with any display
    // name is still denied.
    expect(
      isMemoryEligible({ source: "slack", channel: "C0123456", speakerSlackId: "U0EVIL0000", config: CONFIG }),
    ).toBe(false);
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0EVIL0000", config: CONFIG }),
    ).toBe(false);
  });

  it("denies non-Slack sources with DM-looking channels and cron-like sessions", () => {
    expect(
      isMemoryEligible({ source: "telegram", channel: "D0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBe(false);
    expect(isMemoryEligible({ source: "cron", channel: "cron:daily", config: CONFIG })).toBe(false);
  });
});

describe("buildMemoryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects MEMORY.md for an eligible session, with the privacy instruction", () => {
    setMemoryFile("## Facts\n- オーナーはA社の代表");
    const out = buildMemoryContext({ source: "web", config: CONFIG });
    expect(out).toContain("オーナーはA社の代表");
    expect(out).toContain("Never reveal");
  });

  it("returns null for ineligible sessions even when MEMORY.md exists", () => {
    setMemoryFile("secret facts");
    expect(
      buildMemoryContext({ source: "slack", channel: "C0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBeNull();
  });

  it("returns null when MEMORY.md is missing or empty", () => {
    setMemoryFile(null);
    expect(buildMemoryContext({ source: "web", config: CONFIG })).toBeNull();
    setMemoryFile("   \n  ");
    expect(buildMemoryContext({ source: "web", config: CONFIG })).toBeNull();
  });

  it("caps oversized MEMORY.md by UTF-8 BYTES (Japanese text cannot balloon the prompt)", () => {
    // 12,000 Japanese chars ≈ 36,000 bytes — over the 24,000B cap while being
    // well under it in JS string length.
    setMemoryFile("あ".repeat(12_000));
    const out = buildMemoryContext({ source: "web", config: CONFIG });
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out!, "utf-8")).toBeLessThan(25_000);
    expect(out).toContain("exceeds the injection cap");
    expect(out).not.toContain("�");
  });
});
