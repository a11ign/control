/**
 * THE PLAYBOOK THAT LAYS THE CONTROL PLANE'S HOST VALUE ALSO LAYS ITS CHECKOUT AND ITS PINNED PNPM (a11ign#5306).
 *
 * A rebuilt plane had no `/root/control` and no `pnpm`, so every unit that names the checkout had no working directory.
 * This reads the playbook's task list back, because the text alone cannot say what the tasks do:
 *
 *   - the checkout is control's own repository, at `/root/control`
 *   - the pnpm comes from control's `packageManager` field and must be an exact version, never `latest`
 *   - the install is the lockfile's own: `--frozen-lockfile` and `--ignore-scripts` both in its argv, and no global npm
 *   - the order holds: after the host value is read back, before the loader assertion
 *
 * The loader task is the positive control. If it is not found, the order check would pass against nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PLAYBOOK = readFileSync(new URL("../ansible/control-host-install.yml", import.meta.url), "utf8");

/** A top-level variable of the play, by name. */
const varValue = (name: string) => new RegExp(`^    ${name}: (\\S+)$`, "m").exec(PLAYBOOK)?.[1];

/** The task list, one entry per task: a task opens with a four-space `- name:`. */
const TASKS = PLAYBOOK.split(/^(?= {4}- name: )/m).slice(1).map((body) => ({
  name: /^ {4}- name: (.*)$/m.exec(body)?.[1] ?? "",
  body,
}));

/** The one task whose name contains `fragment`: a missing or doubled task is a failure, not a silent pass. */
function find(fragment: string) {
  const found = TASKS.filter((task) => task.name.includes(fragment));
  assert.equal(found.length, 1, `exactly one task is named with "${fragment}"`);
  return found[0];
}

/** The tokens of a task's `argv:` flow list. */
function argvTokens(body: string): string[] {
  const list = /argv: \[([^\]]*)\]/.exec(body)?.[1];
  assert.ok(list, "the task has an argv list");
  return list.split(",").map((token) => token.trim().replace(/^"|"$/g, ""));
}

test("positive control: the loader task is read from the list (the rest of the order check is vacuous without it)", () => {
  assert.equal(find("must resolve").name.includes("TypeScript"), true);
  assert.ok(TASKS.length >= 10, `the task list is read whole (${TASKS.length} tasks)`);
});

test("the checkout is control's own repository, laid at /root/control", () => {
  assert.equal(varValue("control_repo_url"), "https://github.com/a11ign/control.git");
  assert.equal(varValue("control_checkout"), "/root/control");
  const checkout = find("Control's own checkout");
  assert.match(checkout.body, /ansible\.builtin\.git:/);
  assert.match(checkout.body, /repo: "\{\{ control_repo_url \}\}"/);
  assert.match(checkout.body, /dest: "\{\{ control_checkout \}\}"/);
});

test("the pnpm comes from control's packageManager field, and that field must be an exact version", () => {
  const read = find("Read the pnpm version");
  assert.match(read.body, /path: "\{\{ control_checkout \}\}\/package\.json"/);
  assert.match(find("The pin must be one exact pnpm version").body, /packageManager/);
  assert.ok(find("Refuse a manifest").body.includes("'^pnpm@[0-9]+[.][0-9]+[.][0-9]+$'"), "the refusal names an exact-version regex");
  const activate = argvTokens(find("Activate that pnpm").body);
  assert.deepEqual(activate.slice(0, 2), ["/usr/bin/corepack", "prepare"]);
  assert.equal(activate[2], "{{ control_pnpm_pin }}");
  assert.equal(activate[3], "--activate");
  assert.doesNotMatch(PLAYBOOK, /pnpm@latest/);
});

test("the install is the lockfile's own: --frozen-lockfile and --ignore-scripts in its argv, run in the checkout", () => {
  const install = find("Install control's production dependencies");
  const tokens = argvTokens(install.body);
  assert.deepEqual(tokens.slice(0, 3), ["/usr/bin/corepack", "pnpm", "install"]);
  assert.ok(tokens.includes("--frozen-lockfile"), "the lockfile decides");
  assert.ok(tokens.includes("--ignore-scripts"), "no install script runs");
  assert.match(install.body, /chdir: "\{\{ control_checkout \}\}"/);
});

test("no global npm install appears anywhere in the playbook", () => {
  const offending = PLAYBOOK.split("\n").filter((line) => /\bnpm\b/.test(line) && /(?:^|\s)(?:-g|--global)\b/.test(line));
  assert.deepEqual(offending, []);
});

test("the checkout and install come after the host value is read back, and before the loader assertion", () => {
  const order = [
    find("It must read back exactly"),
    find("Control's own checkout"),
    find("Install control's production dependencies"),
    find("must resolve"),
  ].map((task) => TASKS.indexOf(task));
  assert.ok(order.every((index, i) => i === 0 || index > order[i - 1]), `task order by index: ${order.join(", ")}`);
});
