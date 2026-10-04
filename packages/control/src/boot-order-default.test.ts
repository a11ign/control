/**
 * PROVISIONING ENFORCES THE FIRMWARE BOOT ORDER BY DEFAULT, AND ONE FLAG IS THE SWITCH (#3492).
 *
 * `worker_enforce_boot_order` shipped false (#3387) so no provision wrote firmware before a session had read a
 * boot-order name on one box. #3388 then ran it on 13 workers and #3400 and #3389 wrote the other two, so the
 * default is true. A default is only a default if nothing overrides it on the way to the module, so this also
 * pins that `bespoke.yml` passes the flag through and hard-codes no value of its own: a literal `enforce: false`
 * there would leave the role default true and the module reading, and every provision would say it enforced.
 *
 * What it cannot show is a worker's firmware: that is the next `fleet:provision`, which is `orchestrator`'s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROLE = fileURLToPath(new URL("../ansible/roles/worker/", import.meta.url));
const read = (rel: string) => readFileSync(`${ROLE}${rel}`, "utf8");

/** Comments out: a value named in PROSE is not a value that applies. */
const codeLines = (source: string) => source.split("\n").filter((line) => !/^\s*#/.test(line));

const DEFAULT_LINE = /^worker_enforce_boot_order:\s*(\S+)\s*$/;

test("the role default is true", () => {
  const declarations = codeLines(read("defaults/main.yml")).filter((line) => DEFAULT_LINE.test(line));
  assert.equal(declarations.length, 1, "exactly one declaration, or there is no single switch");
  assert.equal(DEFAULT_LINE.exec(declarations[0])?.[1], "true");
});

test("bespoke.yml passes the flag to the module and hard-codes no value", () => {
  const code = codeLines(read("tasks/bespoke.yml"));
  const enforceLines = code.filter((line) => /^\s*enforce:/.test(line));
  assert.deepEqual(
    enforceLines.map((line) => line.trim()),
    ['enforce: "{{ worker_enforce_boot_order }}"'],
    "the module's only `enforce` argument in the role is the flag",
  );
  const taskAt = code.findIndex((line) => /a11y\.worker\.a11y_boot_order:/.test(line));
  assert.ok(taskAt >= 0, "positive control: the a11y_boot_order task is found");
  assert.match(code[taskAt + 1], /enforce: "\{\{ worker_enforce_boot_order \}\}"/, "the argument sits under that task");
});

test("no comment in the role's defaults or bespoke tasks still says it ships off", () => {
  // Present tense only: "it shipped OFF" in a historical sentence is read, not a claim about the default.
  const stale = /\bships off\b/i;
  const defaults = read("defaults/main.yml").split("\n").filter((line) => stale.test(line));
  const bespoke = read("tasks/bespoke.yml").split("\n").filter((line) => stale.test(line));
  assert.deepEqual([...defaults, ...bespoke], []);
});
