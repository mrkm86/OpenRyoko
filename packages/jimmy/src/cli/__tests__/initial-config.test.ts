import { describe, it, expect } from "vitest";
import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_TEMPLATE_PATH, buildInitialConfig } from "../initial-config.js";

describe("initial config generation", () => {
  it("finds the packaged template (regression: lookup used config.yaml, template ships config.default.yaml)", () => {
    expect(fs.existsSync(CONFIG_TEMPLATE_PATH)).toBe(true);
    expect(CONFIG_TEMPLATE_PATH.endsWith("config.default.yaml")).toBe(true);
  });

  it("uses the template so documented defaults (mcp.fetch etc.) actually apply", () => {
    const { source, usedTemplate } = buildInitialConfig("claude", "Ryoko");
    expect(usedTemplate).toBe(true);

    const parsed = yaml.load(source) as any;
    expect(parsed.mcp?.fetch?.enabled).toBe(true);
    expect(parsed.mcp?.browser?.enabled).toBe(true);
    expect(parsed.mcp?.gateway?.enabled).toBe(true);
    expect(parsed.engines?.default).toBe("claude");
    expect(parsed.engines?.claude?.model).toBe("claude-opus-5");
  });

  it("stamps the real package version over the template placeholder", () => {
    const { source } = buildInitialConfig("claude", "Ryoko");
    const parsed = yaml.load(source) as any;
    expect(parsed.jinn?.version).not.toBe("0.3.0");
    expect(parsed.jinn?.version).toMatch(/^\d{4}\.\d+\.\d+/);
  });

  it("applies interactive choices (engine and portal name)", () => {
    const { source } = buildInitialConfig("codex", "Momo");
    const parsed = yaml.load(source) as any;
    expect(parsed.engines?.default).toBe("codex");
    expect(parsed.portal?.portalName).toBe("Momo");
  });
});
