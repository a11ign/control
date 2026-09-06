import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CFG = readFileSync(join(import.meta.dirname, "../ansible/ansible.cfg"), "utf8");

/**
 * THE INVENTORY MUST NOT LIVE ONLY INSIDE A CHECKOUT, because a checkout is a thing that gets pulled.
 *
 * `inventory.yml` is untracked and gitignored, so a `git pull` DELETES it. Measured 2026-09-06 on the
 * control plane — the one machine that must have it:
 *
 *     [WARNING]: Unable to parse .../inventory.yml as an inventory source
 *     skipping: no hosts matched          ...and ansible EXITED 0
 *
 * Ten workers untouched, the wrapper reporting success. Untracked-but-inside-the-tree is precisely what a
 * pull removes, so the remedy is for the file not to be in the tree at all.
 *
 * This pins the CONFIG rather than the file, deliberately: the file cannot be committed (that is the whole
 * point of #54) so no test can assert it exists. What can be asserted is that ansible is told to look
 * somewhere a pull cannot reach FIRST.
 */

test("ansible is told to look outside the checkout before looking inside it", () => {
  const line = CFG.split("\n").find((l) => /^inventory\s*=/.test(l));
  assert.ok(line, "ansible.cfg must set `inventory`; without it ansible falls back to /etc/ansible/hosts");
  const sources = line.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(sources.length >= 2,
    `inventory names only ${sources.join(", ")}. A single in-tree path is what a pull deletes — the state `
    + "that made fleet:deploy reach zero hosts and exit 0.");
  assert.ok(sources[0].startsWith("/"),
    `the FIRST source is '${sources[0]}', which is relative and therefore inside the checkout. The absolute `
    + "path must come first, or the in-tree copy shadows it and the fix does nothing on a machine that "
    + "has both.");
});

test("the in-tree path is kept as a fallback, so a laptop with no /etc copy still works", () => {
  // Removing it would be the tidier change and would break every developer machine at once. The fallback
  // is what makes this landable before the file is placed anywhere.
  const line = CFG.split("\n").find((l) => /^inventory\s*=/.test(l)) ?? "";
  assert.match(line, /inventory\.yml\s*$/,
    "the relative `inventory.yml` must remain LAST, as the fallback during migration");
});

test("the config records the three states it was verified in", () => {
  // A claim this load-bearing, about a mechanism that already failed silently once, must carry its
  // evidence at the point somebody would change it — not in a commit message they will not read.
  assert.match(CFG, /in-tree DELETED/,
    "the comment must name the post-pull state, which is the one this exists for");
  assert.match(CFG, /0 hosts/,
    "and the measured failure of the old config, or the reader has only an assertion");
});
