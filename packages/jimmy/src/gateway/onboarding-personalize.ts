/**
 * Name personalization for the instruction / persona Markdown files.
 * Must match BOTH the Japanese templates ("# X — 運用指示書", "あなたは **X**")
 * and the upstream English forms ("You are **X**", "You are X, the COO ...") —
 * the Web onboarding previously only knew the English forms, so renames from
 * the UI never reached the Japanese files.
 */

export function personalizeInstructionMd(md: string, name: string): string {
  let out = md.replace(
    /^(# )[^\n—]+( — 運用指示書)$/m,
    (_m, p1: string, p2: string) => p1 + name + p2,
  );
  out = out.replace(
    /^(あなたは \*\*)[^*]+(\*\*)/m,
    (_m, p1: string, p2: string) => p1 + name + p2,
  );
  out = out.replace(/You are \*\*[^*]+\*\*/, () => `You are **${name}**`);
  out = out.replace(
    /^You are \w+, the COO of the user's AI organization\.$/m,
    () => `You are ${name}, the COO of the user's AI organization.`,
  );
  return out;
}

export function personalizeIdentityMd(md: string, name: string): string {
  return md
    .replace(/^(# IDENTITY — ).+$/m, (_m, p1: string) => p1 + name)
    .replace(/^(## Name\n).+$/m, (_m, p1: string) => p1 + name);
}
