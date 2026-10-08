/**
 * THIS REPOSITORY COUNTS ITS `.js`/`.mjs`/`.cjs` SOURCE AGAINST A COMMITTED BASELINE (a11ign/a11ign#4265; the check is `@a11ign/toolchain/mjs-ratchet`, ADR 0043,
 * a11ign/a11ign#4243). The standard is TypeScript source, and the count may only go down: a new `.mjs` fails and is named.
 *
 * It is a test, not a workflow step, and it lives in `scripts/` (this repository's own `include`, and its own `tsconfig.json`), so `pnpm test` and the merge gate run it against THIS repository's `@a11ign/toolchain` pin and no workflow file is touched. Under `packages/control/` it would resolve the core's pin at `CORE_REF` in CI (0.1.3, no `./mjs-ratchet`). The baseline is found by walking up from THIS
 * FILE to `mjs-ratchet.baseline.json`, so moving the test (the layout flatten, a11ign/a11ign#4217) edits nothing.
 *
 * The controls build small trees in a temp directory, with no `.git`, which the function reads by walking the directory: a copy of the real baseline with one name
 * removed must fail and name the file, or the first test passing on the real tree would prove nothing about the check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_FILE, checkMjsRatchet, findBaselineRoot, parseBaseline } from "@a11ign/toolchain/mjs-ratchet";

const HERE = fileURLToPath(import.meta.url);
const committed = () => readFileSync(join(findBaselineRoot(HERE), BASELINE_FILE), "utf8");
const committedBaseline = () => parseBaseline(committed()).baseline;

/** A tree holding a stub for each basename in `files`, under `src/`, plus the baseline `baseline`; `from` is a path inside it. */
function treeWith({ files, baseline }: { files: string[]; baseline: unknown }): { from: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mjs-ratchet-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, BASELINE_FILE), JSON.stringify(baseline));
  for (const name of files) writeFileSync(join(root, "src", name), "// stub\n");
  return { from: join(root, "src"), remove: () => rmSync(root, { recursive: true, force: true }) };
}

function inTree(spec: { files: string[]; baseline: unknown }, check: (from: string) => void): void {
  const tree = treeWith(spec);
  try {
    check(tree.from);
  } finally {
    tree.remove();
  }
}

test("the repository's real tree passes against its committed baseline", () => {
  const result = checkMjsRatchet({ from: HERE });
  assert.equal(result.ok, true, result.message);
  // The positive control: the read found this repository's own scripts, so 'ok' is not 'the walk read nothing'.
  assert.ok(result.count > 0, `the ratchet counted ${result.count} files in ${result.root}`);
  assert.equal(result.baselineCount, committedBaseline().files.length);
});

test("the committed baseline is well-formed, and every exception it lists says why", () => {
  const { baseline, problems } = parseBaseline(committed());
  assert.deepEqual(problems, []);
  assert.ok(baseline.files.length > 0, "the baseline lists no file, so the controls below would be built from nothing");
  for (const entry of baseline.exceptions) assert.ok(entry.why.trim() !== "", `exception ${entry.path} has no why`);
});

test("a copy of the baseline with one name removed fails and NAMES the file", () => {
  const { files } = committedBaseline();
  const removed = files[0];
  inTree({ files, baseline: { files: files.slice(1), exceptions: [] } }, (from) => {
    const result = checkMjsRatchet({ from });
    assert.equal(result.ok, false);
    assert.match(result.message, new RegExp(removed.replace(/\./g, "\\.")));
  });
});

test("the same tree against the whole baseline passes (the negative control's positive twin)", () => {
  const { files } = committedBaseline();
  inTree({ files, baseline: { files, exceptions: [] } }, (from) => {
    const result = checkMjsRatchet({ from });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.count, files.length);
  });
});

test("a baseline listing a file the tree lacks passes, and says it can be lowered", () => {
  const { files } = committedBaseline();
  inTree({ files: files.slice(1), baseline: { files, exceptions: [] } }, (from) => {
    const result = checkMjsRatchet({ from });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /can be lowered to/);
  });
});

test("an exception with no `why` fails", () => {
  const { files } = committedBaseline();
  const [kept, ...rest] = files;
  inTree({ files, baseline: { files: rest, exceptions: [{ path: `src/${kept}` }] } }, (from) => {
    const result = checkMjsRatchet({ from });
    assert.equal(result.ok, false);
    assert.match(result.message, /has no `why`/);
  });
});

test("an exception WITH a `why` is accepted (the control for the failure above)", () => {
  const { files } = committedBaseline();
  const [kept, ...rest] = files;
  inTree({ files, baseline: { files: rest, exceptions: [{ path: `src/${kept}`, why: "a tool reads only this name" }] } }, (from) => {
    const result = checkMjsRatchet({ from });
    assert.equal(result.ok, true, result.message);
  });
});
