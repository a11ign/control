/**
 * CONTROL STARTS ITS OWN COMMANDS (ADR 0045 cut 7, a11ign/a11ign#5085).
 *
 * The core started 31 of control's commands from its own `package.json` (`fleet:*`, `lab:*`, `doctor`, `worker:code`), by a path into a laid
 * copy of this package. They are this repository's now, under the names the core used, and this file is where "they exist, and each one
 * names a file this repository holds" is held: it runs in this repository's own `pnpm test`, which `src/` tests do not (they run laid in the
 * core, whose manifest for this package carries no `scripts`).
 *
 * WHAT IT DOES NOT SHOW: a command RUNNING. Running `fleet:*` and `lab:*` reaches the fleet and the lab, which the row that wrote this may
 * not do (the resource ban). The row that deploys with the pins runs `fleet:deploy --limit=<one box>` and is the reading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string>; dependencies?: Record<string, string>; };

/** The commands the core's `package.json` started with `packages/control` in them, at a11ign/a11ign `70361744f`. */
const COMMANDS = [
  "doctor", "worker:code", "fleet:status", "fleet:link-view", "fleet:discover", "fleet:wake", "fleet:auto-off", "fleet:auto-off-schedule",
  "fleet:patch-schedule", "lab:job", "lab:pipeline", "lab:failed-units", "lab:watch", "fleet:watch", "lab:status", "lab:log", "fleet:tailscale",
  "fleet:deploy", "fleet:sleep", "fleet:provision", "fleet:patch", "lab:fetch", "lab:stop", "lab:clear-failed", "lab:reset", "lab:corpus-schedule",
  "fleet:recover", "fleet:logs", "fleet:os-rollback", "fleet:inventory-install", "fleet:control-host-install",
];

/** The file a command runs, or why none can be found in it. */
const targetOf = (command: string): string | undefined => /(?:node |ansible-playbook )(\S+\.(?:ts|yml))/.exec(command)?.[1];

test("the 31 commands are control's, none reaches into `packages/control`, and each names a file this repository holds", () => {
  assert.equal(COMMANDS.length, 31, "positive control: the list is the 31 the row names");
  const problems: string[] = [];
  for (const name of COMMANDS) {
    const command = manifest.scripts[name];
    if (command === undefined) { problems.push(`${name}: not in package.json`); continue; }
    if (command.includes("packages/control")) problems.push(`${name}: ${command} still reaches into a laid packages/control`);
    const target = targetOf(command);
    if (target === undefined || !existsSync(`${ROOT}${target}`)) problems.push(`${name}: ${command} names ${target ?? "no file"}, which is not here`);
  }
  assert.deepEqual(problems, []);
});

test("a command that runs ansible takes its config from this repository's own ansible/", () => {
  const ansible = COMMANDS.filter((name) => manifest.scripts[name]?.includes("ansible-playbook"));
  assert.ok(ansible.length >= 10, `positive control: ${ansible.length} commands run ansible`);
  for (const name of ansible) assert.match(manifest.scripts[name], /^ANSIBLE_CONFIG=ansible\/ansible\.cfg ansible-playbook ansible\//, name);
});

test("the lab commands a lab job dispatch and watch use are all here: job, pipeline, status, log, stop, fetch, reset, watch, failed-units", () => {
  for (const name of ["lab:job", "lab:pipeline", "lab:status", "lab:log", "lab:stop", "lab:fetch", "lab:reset", "lab:watch", "lab:failed-units"]) {
    assert.ok(manifest.scripts[name], `${name} is not a command of this package`);
  }
});

test("`doctor` and `worker:code` run the fleet's bins by name, from the pinned release, and add no dependency to run them", () => {
  assert.equal(manifest.scripts.doctor, "node src/with-control-plane-fleet.ts doctor");
  assert.equal(manifest.scripts["worker:code"], "node src/with-control-plane-fleet.ts worker-code");
  assert.deepEqual(manifest.dependencies ?? {}, {}, "the published fleet is unpacked beside a run and never declared (ADR 0012)");
});
