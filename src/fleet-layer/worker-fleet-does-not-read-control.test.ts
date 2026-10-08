// Relocated from packages/worker-fleet/src/worker-fleet-does-not-read-control.test.ts by #3504: it reads control/lab/guards/the root, so it stays in the core and reads the fleet through the layer checkout at packages/worker-fleet.
/**
 * `@a11ign/screenreader-fleet` IS PUBLISHED. `@a11ign/control` NEVER IS.
 *
 * `control-has-no-dependencies.test.ts` walks the import graph OUT of `control` and refuses a package-name
 * specifier, because that direction — `control -> worker-fleet` by relative path — is the sanctioned one
 * (`control` has no `node_modules`, so nothing it touches may need one to resolve). It cannot see the
 * REVERSE edge, because reading a FILE by a hardcoded relative path is not an import specifier its walker
 * looks at.
 *
 * That reverse edge was real: `fleet-env.mjs`, `fleet-status.mjs`, `fleet-discover.mjs` and `fleet-wake.mjs`
 * all read `../../control/ansible/inventory.yml` and `group_vars/a11y_workers.yml` directly — architecture
 * audit §3.2. `fleet-status.mjs`, `fleet-discover.mjs` and `fleet-wake.mjs` had ZERO cross-package
 * dependents in either direction (confirmed by grep before moving them), so they moved to
 * `packages/control/src/` outright — the "more honest and larger" remedy the audit named, made cheap by
 * measuring that there was nothing on the far side to keep them here for.
 *
 * `fleet-env.mjs` could not move: `doctor.mjs` and `check-worker-code.mjs` are PUBLISHED `bin` entries that
 * must keep resolving this monorepo's own bare-metal fleet correctly when run as `npm run doctor` — so its
 * two inventory-reading functions take the path as an INJECTED parameter instead, defaulting to the same
 * file. The default does not by itself make an installed tarball correct (it still names a path that will
 * never exist outside this checkout), which is why it is not treated as a clean bill of health below: it
 * is EXEMPT, with the reason spelled out, not silently passed.
 *
 * THIS IS THE GUARD THAT WOULD HAVE CAUGHT IT. It walks every module reachable from `worker-fleet`'s own
 * PUBLISHED surface — `exports` and `bin`, the only things an external `npm install` can reach — the same
 * way `control-has-no-dependencies.test.ts` walks `control`'s reachable set, and refuses any file
 * reference (import specifier, or a `new URL(...)`/`readFileSync` path) that resolves into
 * `packages/control`, unless the exact file:line is named in `EXEMPT` with a reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { installedPackageDir } from "../../../guards/src/layer-file.mjs";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = fileURLToPath(new URL("../../../worker-fleet/src/", import.meta.url));
// The layer checkout carries no package.json, so the published surface is read from the INSTALLED package -- the manifest an
// external `npm install` actually gets, which is the surface this guard is about.
const PKG_DIR = installedPackageDir("@a11ign/screenreader-fleet", import.meta.dirname);
if (PKG_DIR === undefined) throw new Error("@a11ign/screenreader-fleet is not installed, so its published surface cannot be read");
const PKG = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

/**
 * The published surface's entry points, as SOURCE files — never `dist`, for the reason every other
 * source-reading guard in this repo gives: a build can go stale between a source change and the test that
 * would catch it, and reading `dist` is how that staleness hides.
 *
 * Derived from `package.json`'s own `exports`/`bin`, not hand-listed: a target ending `.js` is TypeScript
 * compiled to `dist`, so the source is the same name under `src/` with a `.ts` extension; `.mjs` targets
 * are copied verbatim, so the source is the identical filename. `.sh` is not JavaScript and carries no
 * import graph to walk.
 */
function publishedEntryPoints(): string[] {
  const targets = new Set<string>();
  for (const entry of Object.values(PKG.exports ?? {}) as Record<string, string>[]) {
    if (entry.default) targets.add(entry.default);
  }
  for (const target of Object.values(PKG.bin ?? {}) as string[]) targets.add(target);
  return [...targets]
    .filter((t) => !t.endsWith(".sh"))
    .map((t) => t.replace(/^\.\/dist\//, "").replace(/^\.\/src\//, ""))
    .map((name) => (name.endsWith(".js") ? name.replace(/\.js$/, ".ts") : name))
    // The registry manifest names a built `.mjs` for a source that is TypeScript (`dist/index.mjs` is `src/index.ts`).
    .map((name) => (name.endsWith(".mjs") && !existsSync(resolve(SRC, name)) && existsSync(resolve(SRC, name.replace(/\.mjs$/, ".ts")))
      ? name.replace(/\.mjs$/, ".ts") : name));
}

/** Comments stripped, so a file path mentioned in PROSE is not mistaken for one the code resolves. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every relative-path-shaped string literal in a file: `from "..."`, and `new URL("...", ...)` — the
 * shape every inventory-reading reference in this package actually used. One extractor for both, because
 * an import specifier and a file-read path are the same kind of fact (`where does this code reach`) and
 * this repo's own history is full of a second reader of one shape drifting from the first.
 */
function relativeLiterals(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/\bfrom\s+"(\.[^"]+)"/g)) specs.push(m[1]);
  for (const m of source.matchAll(/new URL\(\s*"(\.[^"]+)"/g)) specs.push(m[1]);
  return specs;
}

/**
 * Why a file:line reaching outside `worker-fleet` is not a violation. Keyed by `path:line`, not just
 * `path`, so a file with several references cannot hide a new bad one behind an old justified one —
 * `cli-flags.test.ts`'s own docstring names exactly this shape of guard as the one worth building.
 *
 * A REASON, never a bare acknowledgement, matching every other EXEMPT table added this session.
 */
const EXEMPT: Record<string, string> = {
  "fleet-env.mjs:98":
    "GAP, recorded 2026-09-06 (architecture audit §3.2), not fully closed: the monorepo's own default for INVENTORY and GROUP_VARS. "
    + "doctor.mjs and check-worker-code.mjs are published bins that must keep resolving THIS monorepo's "
    + "bare-metal fleet when run as `npm run doctor`, so the path is an injected PARAMETER rather than "
    + "an unconditional read. Since screenreader-fleet 0.4.1 (#3803) ONE helper, `monorepoAnsibleFile`, builds both defaults, "
    + "each is used only when that path EXISTS, and otherwise the bin exits 2 naming the path and the flag that supplies it "
    + "(`--inventory`, `--group-vars`), so an installed tarball no longer inherits a path it can never find. What is left is the "
    + "NAME of the monorepo's path in a published file: honesty, not breakage. It is built from `resolve(..., \"control\", ...)` "
    + "segments, not a relative import literal, so the scan above does not see it and this entry is read back by the test below alone.",
};

/** Which real file a relative import specifier resolves to — `.mjs` and TS's `.js`-means-`.ts` both apply. */
function resolveImport(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.mjs`, `${base}.ts`, base.replace(/\.js$/, ".ts")]) {
    try { readFileSync(candidate, "utf8"); return candidate; } catch { continue; }
  }
  return undefined;
}

/** Every module reachable from `entry`, following relative imports — mirrors control-has-no-dependencies.test.ts. */
function walk(entryFile: string): Map<string, string> {
  const files = new Map<string, string>(); // absolute path -> source
  const queue = [resolve(SRC, entryFile)];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    let source: string;
    try { source = readFileSync(file, "utf8"); } catch { continue; }
    files.set(file, source);
    for (const m of stripComments(source).matchAll(/\bfrom\s+"(\.[^"]+)"/g)) {
      const resolved = resolveImport(file, m[1]);
      if (resolved && !files.has(resolved)) queue.push(resolved);
    }
  }
  return files;
}

test("every file reachable from worker-fleet's published surface is discovered", () => {
  const entries = publishedEntryPoints();
  assert.ok(entries.length >= 5, `expected several published entry points, found ${entries.length}`);
  let total = 0;
  for (const entry of entries) total += walk(entry).size;
  assert.ok(total >= 5, `the walk from ${entries.join(", ")} found only ${total} file(s) — it is examining `
    + "almost nothing");
});

/**
 * Every reference in ONE file that resolves into `packages/control`, and is not EXEMPT.
 *
 * Line numbers are taken from the RAW source, never stripped — `stripComments` collapses a block comment
 * to zero lines, which would shift every line number below it and make the EXEMPT table's keys (and the
 * verification test that reads them back) disagree with what a reader sees in the file. The patterns
 * matched (`from "..."`, `new URL("...", ...)`) are executable syntax, not prose, so the risk of matching
 * a comment's own example code is low and worth taking for numbering that stays true.
 */
function offendersIn(file: string, source: string): string[] {
  const found: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const spec of relativeLiterals(lines[i])) {
      const resolved = resolve(dirname(file), spec);
      if (!resolved.startsWith(resolve(REPO, "packages/control"))) continue;
      const rel = `${file.slice(SRC.length)}:${i + 1}`;
      if (EXEMPT[rel]) continue;
      found.push(`${rel} resolves into packages/control/ via "${spec}": ${lines[i].trim()}`);
    }
  }
  return found;
}

test("nothing reachable from the published surface reads a file under packages/control, unless EXEMPT", () => {
  const offenders = publishedEntryPoints()
    .flatMap((entry) => [...walk(entry)])
    .flatMap(([file, source]) => offendersIn(file, source));
  assert.deepEqual(offenders, [],
    "worker-fleet is PUBLISHED and packages/control NEVER IS -- a file reachable from the published "
    + "surface (exports + bin) must not resolve into it. Either remove the reference, or add it to EXEMPT "
    + "with the reason it is a deliberate, documented default (see fleet-env.mjs's entries).");
});

test("every EXEMPT entry names a line that still makes the reference it excuses", () => {
  for (const [key, reason] of Object.entries(EXEMPT)) {
    assert.ok(reason.length > 40, `${key}: an exemption needs a reason, not a name`);
    const [file, lineNo] = key.split(":");
    const source = readFileSync(resolve(SRC, file), "utf8");
    const line = source.split("\n")[Number(lineNo) - 1];
    assert.ok(line !== undefined, `EXEMPT names ${key}, which is past the end of ${file} -- the file has moved`);
    assert.match(line, /control/,
      `EXEMPT names ${key}, and that line no longer mentions "control" -- the reference it excuses has moved `
      + "or been removed, so the exemption is stale");
  }
});
