// Quote normalization and matching shared by the Auditor (verification
// against the scraped page) and the Clerk (duplicate detection at filing).

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—‒]/g, "-")
    .replace(/ /g, " ")
    .replace(/[*_`#>\[\]()|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shingles(words: string[], n = 5): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

// Verbatim or near-verbatim (>=80% of 5-word phrases) presence in the page.
export function verifyQuote(quote: string, page: string): { ok: boolean; note: string } {
  const q = normalizeText(quote);
  const p = normalizeText(page);
  if (q.length < 20) return { ok: false, note: "Quote too short to verify" };
  if (p.includes(q)) return { ok: true, note: "Verbatim match in source" };
  const words = q.split(" ");
  if (words.length < 6) return { ok: false, note: "Quote not found in source" };
  const sh = shingles(words);
  const hit = sh.filter((s) => p.includes(s)).length;
  const ratio = hit / sh.length;
  if (ratio >= 0.8)
    return { ok: true, note: `Near-verbatim match (${Math.round(ratio * 100)}% of phrases found)` };
  return {
    ok: false,
    note: `Quote not found in source (${Math.round(ratio * 100)}% of phrases matched)`,
  };
}

// Two quotes are duplicates when one is contained in the other or they share
// most of their phrases.
export function quotesOverlap(a: string, b: string): boolean {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (x.length < 20 || y.length < 20) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const sx = shingles(x.split(" "));
  const sy = new Set(shingles(y.split(" ")));
  if (sx.length === 0 || sy.size === 0) return false;
  const hit = sx.filter((s) => sy.has(s)).length;
  return hit / Math.min(sx.length, sy.size) >= 0.6;
}
