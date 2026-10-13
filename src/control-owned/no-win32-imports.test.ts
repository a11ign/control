// The part of fleet-layer/no-win32-imports.test.ts with no merged destination (a11ign/a11ign#5345): the worker package's own index (#1772).
// The portable trees moved to a11ign/lab (src/packaging/no-win32-imports-lab.test.ts, #5347) and core (packages/guards/src, #5348); the
// fleet's own slice is a11ign/a11ign#5358. The walker below is kept only to answer the one test that stays.

/**
 * Nothing that runs off Windows may load the capture driver at import time.
 *
 * ## The fault, measured 2026-08-25
 *
 * `@guidepup/guidepup`'s index CONSTRUCTS a `ScreenReader` at module scope, and its constructor throws
 * `No available supported screen readers` on a host with none. `@a11ign/screenreader-worker`'s package index
 * re-exports `capture-core.mjs`, which imports guidepup. So importing the worker package BY NAME — even for
 * a pure 16-line hasher that has its own dependency-free module — puts that throw on the import path.
 *
 * `worker-code-check.mjs` did exactly that, and both corpus capture runs on the lab died at import:
 *
 *     Error: No available supported screen readers
 *       at new ScreenReader (@guidepup/guidepup/lib/ScreenReader.js:10)
 *       at Object.<anonymous> (@guidepup/guidepup/lib/index.js:44)
 *
 * with no mention of the file that caused it. The pipeline reported `STOPPED at capture` and nothing else,
 * because `retrain-pipeline.mjs` printed only the child's stdout and this went to stderr.
 *
 * ## Why every existing check was blind to it, by construction
 *
 * **macOS resolves VoiceOver, so the constructor succeeds there and the throw never happens.** `npm test`,
 * `npm run lint`, `tsc --noEmit`, `entry-points.test.ts` (which imports every entry point precisely to
 * catch import-time faults) and CLAUDE.md's own `node -e "import('./x.mjs')"` rule all pass on a developer
 * Mac and on the Windows CI runner. The one platform that fails is the one the lab is.
 *
 * That is this repo's recurring shape in a new costume: a check computed on data that shares the flaw
 * cannot see the flaw. So the guard has to be STATIC — a property of the import graph, not of running it.
 *
 * ## The knowledge already existed
 *
 * `worker-http.mjs` states the rule verbatim: *"Deliberately NOT imported from
 * `@a11ign/screenreader-worker`: this package runs on macOS and Linux and must not depend on a win32-only
 * one."* And `deploy.yml` reaches the same conclusion for a different reason. It was written down twice, in
 * prose, and a new file in the same package broke it within the hour — which is the argument for a test
 * rather than a third comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** The module whose mere import throws where there is no screen reader. */
const POISON = "@guidepup/guidepup";

/** Importing this by NAME reaches POISON, because the package index re-exports `capture-core.mjs`. */
const WORKER_PACKAGE = "@a11ign/screenreader-worker";
const WORKER_INDEX = "packages/nvda-worker/src/index.ts";
/** The only file left that reaches guidepup statically ON PURPOSE -- named once, used by the anti-vacuity
 *  test that proves the walker still works (#1772). */
const VOICEOVER_SPIKE = "packages/lab/src/harnesses/run-spike.ts";

/**
 * STATIC imports only — `import x from "y"` and `export … from "y"`.
 *
 * A dynamic `await import()` inside a function is the CORRECT way to reach the driver from portable code
 * and must not be flagged: `capture-fixtures.ts` does exactly that, so the module loads anywhere and only
 * pays for guidepup on the machine that calls the function. That distinction is the whole remedy, so a
 * guard that could not express it would forbid the fix along with the bug.
 */
function staticImports(relative: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(REPO, relative), "utf8");
  } catch {
    return [];
  }
  const specifiers: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\b[^;\n]*?from\s*["']([^"']+)["']/gm)) {
    specifiers.push(match[1]);
  }
  for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specifiers.push(match[1]);
  return specifiers;
}

/** Resolve a specifier to a repo-relative source file, or null when it is not one of ours. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  // The ROOT reaches the driver; the SUBPATH exports deliberately do not. Collapsing the two would either
  // clear a real offender (if subpaths resolved to nothing) or condemn the remedy (if they resolved to the
  // index) — and the whole fix is that they are different.
  if (specifier === WORKER_PACKAGE) return WORKER_INDEX;
  if (specifier.startsWith(`${WORKER_PACKAGE}/`)) {
    const sub = specifier.slice(WORKER_PACKAGE.length + 1);
    return existsSync(join(REPO, `packages/nvda-worker/src/${sub}.ts`))
      ? `packages/nvda-worker/src/${sub}.ts` : null;
  }
  if (!specifier.startsWith(".")) return null;
  const base = resolve(REPO, dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.ts`, join(base, "index.mjs"), join(base, "index.ts")]) {
    // `.js` in a TypeScript import means the `.ts` beside it.
    const swapped = candidate.replace(/\.js$/, ".ts");
    for (const attempt of [candidate, swapped]) {
      if (existsSync(attempt) && statSync(attempt).isFile()) return attempt.slice(REPO.length);
    }
  }
  return null;
}

/** The chain from `entry` to the driver, or null when it never gets there. */
function pathToDriver(entry: string): string[] | null {
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }];
  while (queue.length) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier === POISON) return [...chain, POISON];
      const next = resolveLocal(file, specifier);
      if (next && !seen.has(next)) queue.push({ file: next, chain: [...chain, next] });
    }
  }
  return null;
}

test("the poison really is reachable from a real file, or this guard proves nothing", () => {
  // Assert the mechanism the test exists to detect actually exists. Without this, a broken resolver or a
  // regex that stopped matching would leave every assertion below vacuously true. This used to walk from
  // `WORKER_INDEX`, but #1772 made that unreachable on purpose (see the test below) -- `run-spike.ts`'s own
  // direct, deliberate static import is the remaining proof the walker still works.
  const chain = pathToDriver(VOICEOVER_SPIKE);
  assert.ok(chain, `${VOICEOVER_SPIKE} no longer reaches ${POISON}; the import walker may be broken.`);
});

test("the worker package's own index no longer reaches the driver statically -- guidepup is a lazy import now (#1772)", () => {
  // `capture-setup.ts` and `capture-probes.ts` used to `import … from "@guidepup/guidepup"` at the top of
  // the file, so merely importing `@a11ign/screenreader-worker` BY NAME crashed on any host without a screen
  // reader -- even over the `--worker` HTTP path, which never drives NVDA locally and never needed that
  // throw at all. Both now reach the driver through a dynamic `await import()` inside the function that
  // actually drives NVDA (`ensureGuidepup`), so this static walker can no longer see an edge from the
  // worker's own index to the driver. That absence IS the fix; if this ever finds a chain again, guidepup
  // has gone back to loading at import time.
  const chain = pathToDriver(WORKER_INDEX);
  assert.equal(chain, null, `${WORKER_INDEX} reaches ${POISON} statically again via `
    + `${chain?.join(" -> ")}; the guidepup import in capture-setup.ts/capture-probes.ts must stay a `
    + "dynamic import() inside the function that needs it.");
});
