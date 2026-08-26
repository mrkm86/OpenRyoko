import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../shared/paths.js";
import { getPackageVersion } from "../shared/version.js";

/** The packaged template's file name is config.default.yaml — keep this
 *  lookup in sync with template/, or setup silently falls back to
 *  FALLBACK_CONFIG and documented defaults (mcp, sessions, portal) are lost. */
export const CONFIG_TEMPLATE_PATH = path.join(TEMPLATE_DIR, "config.default.yaml");

export const FALLBACK_CONFIG = `jinn:
  version: "0.0.0"

gateway:
  port: 7777
  host: "127.0.0.1"
  # allowedHosts: ["ryoko.example.com"]
  # trustProxyHeaders: false
  # trustedProxyAddresses: ["127.0.0.1"]
engines:
  default: claude
  claude:
    bin: claude
    model: claude-opus-5
    effortLevel: xhigh
  codex:
    bin: codex
    model: gpt-5.6-sol
connectors: {}
mcp:
  browser:
    enabled: true
    provider: playwright
  fetch:
    enabled: true
  gateway:
    enabled: true
portal: {}
logging:
  file: true
  stdout: true
  level: info
`;

/**
 * Build the config.yaml contents for a fresh setup: template (or fallback)
 * with the package version stamped and the interactive choices applied.
 */
export function buildInitialConfig(
  chosenEngine: "claude" | "codex",
  chosenName: string,
): { source: string; usedTemplate: boolean } {
  const usedTemplate = fs.existsSync(CONFIG_TEMPLATE_PATH);
  let source = usedTemplate
    ? fs.readFileSync(CONFIG_TEMPLATE_PATH, "utf-8")
    : FALLBACK_CONFIG;

  source = source.replace(/version:\s*"[^"]*"/, `version: "${getPackageVersion()}"`);
  source = source.replace(/default:\s*claude/, `default: ${chosenEngine}`);

  if (chosenName !== "Ryoko") {
    if (source.includes("portalName: Ryoko")) {
      source = source.replace("portalName: Ryoko", `portalName: "${chosenName}"`);
    } else {
      source = source.replace("portal: {}", `portal:\n  portalName: "${chosenName}"`);
    }
  }

  return { source, usedTemplate };
}
