// a11ign/a11ign#5552: the leak rehearsal's `win_powershell` starts the PUBLISHED launcher, the file the a11ysrv task runs since #5551, and passes the repo
// root as argument 2 (the release launcher refuses to start without it). The row's Acceptance is a source-text grep, and it cannot see the launch: the
// published path is also in the existence check's `$need`, so swapping the launch to `dist\server.mjs` left the grep green (the reviewer's mutation on
// control PR #110). These tests read the script's own `$launcher` assignment and `Start-Process` argument list, with the variables bound the way
// PowerShell binds them, and the two mutations below are the negative controls: each must be refused by the same reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const PLAYBOOK = readFileSync(
  fileURLToPath(new URL("../../ansible/auth-leak-check.yml", import.meta.url)), "utf8");

const PLAY = "Run the ADR 0038 leak check on one worker and restore it";
const RUN_BLOCK = "The run, and its restore";
const WRITE_SCRIPT = "Write the script the one-shot task runs";

const PUBLISHED_PATH = String.raw`{{ a11y_repo_path }}\node_modules\@a11ign\screenreader-worker\launcher\run-server.cmd`;
const NODE_EXE = String.raw`C:\Program Files\nodejs\node.exe`;
const EXPECTED_ARGUMENTS = `"${NODE_EXE}" "{{ a11y_repo_path }}"`;

/** The script the one-shot task writes, read from the YAML as Ansible reads it: the `win_copy` content of the task inside the run's block. */
function oneShotScript(playbook: string): string {
  const plays = parse(playbook) as Array<{ name?: string; tasks?: Array<{ name?: string; block?: Array<Record<string, unknown>> }> }>;
  const block = plays.find((play) => play.name === PLAY)?.tasks?.find((task) => task.name === RUN_BLOCK)?.block;
  assert.ok(block, `the block '${RUN_BLOCK}' is gone -- this test examines nothing`);
  const write = block.find((task) => task.name === WRITE_SCRIPT);
  assert.ok(write, `the task '${WRITE_SCRIPT}' is gone -- this test examines nothing`);
  return (write["ansible.windows.win_copy"] as { content: string }).content;
}

/** The script's own `$name = 'literal'` assignments, the first one winning: what its `Join-Path` and argument list are built from. */
function literalBindings(script: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const [, name = "", value = ""] of script.matchAll(/^\s*\$(\w+) = '([^']*)'\s*$/gm)) {
    if (!bindings.has(name)) bindings.set(name, value);
  }
  return bindings;
}

/** A PowerShell string built as `'literal' + $variable + 'literal'`, with each variable taken from the script's own bindings. */
function concatenation(expression: string, bindings: Map<string, string>): string {
  return expression.split("+").map((term) => {
    const literal = /^\s*'(.*)'\s*$/.exec(term);
    if (literal) return literal[1];
    const variable = /^\s*\$(\w+)\s*$/.exec(term)?.[1] ?? "";
    assert.ok(bindings.has(variable), `the argument list reads '${term.trim()}', which the script does not bind: this test examines nothing`);
    return bindings.get(variable) ?? "";
  }).join("");
}

/** What the script launches and with which arguments, read from its `$launcher` assignment and its `Start-Process` call. */
function launchedBy(script: string): { path?: string; arguments?: string } {
  const bindings = literalBindings(script);
  const launcher = /^\s*\$launcher = Join-Path \$repo '([^']*)'\s*$/m.exec(script)?.[1];
  const argumentList = /Start-Process -FilePath \$launcher -ArgumentList \((.+?)\) -WorkingDirectory \$repo/.exec(script)?.[1];
  return {
    path: launcher === undefined ? undefined : `${bindings.get("repo") ?? ""}\\${launcher}`,
    arguments: argumentList === undefined ? undefined : concatenation(argumentList, bindings),
  };
}

const REAL = oneShotScript(PLAYBOOK);

test("the leak worker is started from the PUBLISHED run-server.cmd, the file the a11ysrv task runs (#5552)", () => {
  assert.equal(launchedBy(REAL).path, PUBLISHED_PATH);
});

test("the leak worker gets node.exe as argument 1 and the repo root as argument 2 (the release launcher refuses without it) (#5552)", () => {
  assert.equal(launchedBy(REAL).arguments, EXPECTED_ARGUMENTS);
});

// The mutations are made to the PLAYBOOK, not the one-shot script, because the prerequisite string lives in another task (`$need`): the row's grep reads the
// whole file, and the reader must see the same file's launch and nothing else.
test("NEGATIVE CONTROL: the reviewer's mutation, the launch swapped to dist\\server.mjs, is read as that and refused, though the published path stays in $need (#5552)", () => {
  const mutated = PLAYBOOK.replace(/(\$launcher = Join-Path \$repo ')[^']*'/, (_, head: string) => `${head}node_modules\\@a11ign\\screenreader-worker\\dist\\server.mjs'`);
  assert.notEqual(mutated, PLAYBOOK, "positive control: the mutation was applied to the $launcher assignment");
  assert.ok(mutated.includes(String.raw`node_modules\@a11ign\screenreader-worker\launcher\run-server.cmd`),
    "positive control: the published path is still in the playbook ($need), so the row's grep would still be green on this mutation");
  assert.equal(launchedBy(oneShotScript(mutated)).path, String.raw`{{ a11y_repo_path }}\node_modules\@a11ign\screenreader-worker\dist\server.mjs`,
    "positive control: the reader sees the mutated launch, so the refusal below is a reading and not an empty read");
  assert.notEqual(launchedBy(oneShotScript(mutated)).path, PUBLISHED_PATH, "a launch on dist\\server.mjs must not read as the published launcher");
});

test("NEGATIVE CONTROL: a launch that drops argument 2, the repo root, is refused (#5552)", () => {
  const mutated = PLAYBOOK.replace(`('"' + $node + '" "' + $repo + '"')`, () => `('"' + $node + '"')`);
  assert.notEqual(mutated, PLAYBOOK, "positive control: the mutation was applied to the ArgumentList");
  assert.notEqual(launchedBy(oneShotScript(mutated)).arguments, EXPECTED_ARGUMENTS, "a launch without the repo root must not read as passing");
});
