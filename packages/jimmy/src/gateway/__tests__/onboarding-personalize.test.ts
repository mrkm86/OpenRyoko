import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { personalizeInstructionMd, personalizeIdentityMd } from "../onboarding-personalize.js";

// Resolved relative to this test file — TEMPLATE_DIR from shared/paths.js
// assumes the dist layout and misresolves when vitest runs from src/.
const TEMPLATE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "template",
);

function renderedTemplate(filename: string): string {
  const raw = fs.readFileSync(path.join(TEMPLATE_DIR, filename), "utf-8");
  return raw.replaceAll("{{portalName}}", "Ryoko").replaceAll("{{portalSlug}}", "ryoko");
}

describe("Web onboarding name personalization", () => {
  it("renames the identity line of the shipped Japanese CLAUDE.md (regression: regex only knew the English upstream form)", () => {
    const md = personalizeInstructionMd(renderedTemplate("CLAUDE.md"), "Momo");
    expect(md).toContain("あなたは **Momo**");
    expect(md).not.toContain("あなたは **Ryoko**");
    expect(md).toContain("# Momo — 運用指示書");
  });

  it("renames the shipped Japanese AGENTS.md the same way", () => {
    const md = personalizeInstructionMd(renderedTemplate("AGENTS.md"), "Momo");
    expect(md).toContain("あなたは **Momo**");
    expect(md).not.toContain("あなたは **Ryoko**");
  });

  it("still handles the upstream English forms", () => {
    const en = [
      "You are Jinn, the COO of the user's AI organization.",
      "",
      "Intro: You are **Jinn** — a personal AI assistant.",
    ].join("\n");
    const md = personalizeInstructionMd(en, "Momo");
    expect(md).toContain("You are Momo, the COO of the user's AI organization.");
    expect(md).toContain("You are **Momo**");
  });

  it("syncs the IDENTITY.md Name section", () => {
    const md = personalizeIdentityMd(renderedTemplate("IDENTITY.md"), "Momo");
    expect(md).toContain("# IDENTITY — Momo");
    expect(md).toMatch(/## Name\nMomo/);
  });

  it("does not mangle unrelated bold text or headings", () => {
    const md = personalizeInstructionMd("# 別の見出し\n**強調** はそのまま。", "Momo");
    expect(md).toBe("# 別の見出し\n**強調** はそのまま。");
  });
});
