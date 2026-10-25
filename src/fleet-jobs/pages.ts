import { createHash } from "node:crypto";

const isUrl = (text: string): boolean => {
  try { return ["http:", "https:"].includes(new URL(text).protocol); } catch { return false; }
};

/**
 * The pages a file or a submit names. Three shapes are read, because the current scripts use all three: a JSON list of URLs or of `{ url }`,
 * `capture_fleet.py`'s `{ "sample": [{ "url" }] }`, and text with one URL per line (`#` starts a comment). A duplicate is kept once, since
 * two records of one page on one pass would have one name.
 */
export function parsePages(text: string): { pages: string[] } | { refusal: string } {
  let listed: unknown[];
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch (cause) { return { refusal: `the pages are not JSON: ${(cause as Error).message}` }; }
    const list = Array.isArray(parsed) ? parsed : (parsed as { sample?: unknown })?.sample;
    if (!Array.isArray(list)) return { refusal: "the pages are JSON but neither a list nor { \"sample\": [...] }" };
    listed = list;
  } else {
    listed = trimmed.split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim()).filter(Boolean);
  }
  const urls = listed.map((entry) => typeof entry === "string" ? entry : (entry as { url?: unknown })?.url);
  const bad = urls.findIndex((url) => typeof url !== "string" || !isUrl(url));
  if (bad !== -1) return { refusal: `a page is not an http or https URL: ${JSON.stringify(listed[bad])}` };
  const pages = [...new Set(urls as string[])];
  return pages.length ? { pages } : { refusal: "no pages were named" };
}

/** A page's record name: readable, safe in a path, and unique even where two URLs read the same once their punctuation is gone. */
export function recordFile(page: string, pass: number): string {
  const readable = page.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  const hash = createHash("sha1").update(page).digest("hex").slice(0, 8);
  return `${readable || "page"}-${hash}.p${pass}.json`;
}
