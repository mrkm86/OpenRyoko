import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import fs from "node:fs";
import {
  readManifest,
  writeManifest,
  upsertManifest,
  SKILLS_JSON,
} from "../skills.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

function lastWrittenJson(): any {
  const calls = mockWriteFileSync.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [file, data] = calls[calls.length - 1];
  expect(file).toBe(SKILLS_JSON);
  return JSON.parse(String(data));
}

describe("skills.json manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it("reads the canonical object format shipped in template/skills.json", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        installed: {
          "deploy-fly": { source: "owner/repo@deploy-fly", installedAt: "2026-01-01T00:00:00Z" },
        },
      }),
    );
    expect(readManifest()).toEqual([
      { name: "deploy-fly", source: "owner/repo@deploy-fly", installedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("returns [] for the pristine template ({\"installed\": {}}) instead of crashing", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ installed: {} }));
    const manifest = readManifest();
    expect(manifest).toEqual([]);
    // Regression: the old implementation returned the raw object, so
    // Array methods used by skillsList/skillsUpdate threw TypeError.
    expect(() => manifest.map((e) => e.name)).not.toThrow();
  });

  it("still reads the legacy flat-array format", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify([{ name: "a", source: "s", installedAt: "t" }]),
    );
    expect(readManifest()).toEqual([{ name: "a", source: "s", installedAt: "t" }]);
  });

  it("returns [] for malformed JSON or a missing file", () => {
    mockReadFileSync.mockReturnValue("not json");
    expect(readManifest()).toEqual([]);
    mockExistsSync.mockReturnValue(false);
    expect(readManifest()).toEqual([]);
  });

  it("writes the canonical object format", () => {
    writeManifest([{ name: "a", source: "s", installedAt: "t" }]);
    expect(lastWrittenJson()).toEqual({
      installed: { a: { source: "s", installedAt: "t" } },
    });
  });

  it("upserts into a pristine template manifest end to end", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ installed: {} }));
    upsertManifest("deploy-fly", "owner/repo@deploy-fly");
    const written = lastWrittenJson();
    expect(written.installed["deploy-fly"].source).toBe("owner/repo@deploy-fly");
    expect(typeof written.installed["deploy-fly"].installedAt).toBe("string");
  });
});
