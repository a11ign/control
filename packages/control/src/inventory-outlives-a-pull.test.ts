import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ANSIBLE = join(import.meta.dirname, "../ansible");
const CFG = readFileSync(join(ANSIBLE, "ansible.cfg"), "utf8");
const SHARED_GUARD = "tasks/require-inventory-group.yml";

/** Measured at `9faee29ef`, and each one named below rather than counted. */
const PLAYBOOKS_THAT_NAMED_THE_WRONG_MACHINE = 7;
/** All ten zero-host guards carry the shared include; fewer means one stopped refusing. */
const PLAYBOOKS_CARRYING_THE_GUARD = 10;
/** `packages/control/ansible/` held far more than this when the scan was written. */
const FEWEST_PLAYBOOKS_A_LIVE_SCAN_SEES = 15;
/** The shared refusal is four sentences; a parse returning less than this has gone blind. */
const SHORTEST_CREDIBLE_REFUSAL = 200;

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

/**
 * AND THE REFUSAL MUST NAME A MACHINE THE READER CAN ACT ON — #1980.
 *
 * The three tests above pin where ansible LOOKS for the inventory. These pin what it SAYS when it finds
 * none, which is the other half of the same incident: a checkout with no `inventory.yml` matches no hosts,
 * and ten playbooks carry a `localhost` guard that stops the run and explains what to do about it.
 *
 * Measured 2026-09-22 at `9faee29ef`, when that guard was hand-copied into all ten: SEVEN told the reader
 * to "install the durable copy THIS MACHINE can always read, `npm run fleet:inventory-install`". That
 * command does not install anything on the machine reading it. `inventory-install.yml` declares
 * `# a11y_bootstrap: true`, and `fleet-playbook.mjs`'s `runBootstrapFromHere()` honours that by spawning
 * `ansible-playbook -i root@${CONTROL_PLANE},` — so `/etc/a11ign/inventory.yml` appears on the CONTROL
 * PLANE. Worse, its source is `{{ playbook_dir }}/inventory.yml` read `delegate_to: localhost`, so the
 * command needs the very file the refusal says is missing.
 *
 * Reproduced on the agent host, where every session in this org types these commands: `hostname` is
 * `agents`, `/etc/a11ign/` does not exist, and `sudo -n true` reports interactive authentication is
 * required. The remedy that DOES work here was one clause earlier and read as the lesser option.
 *
 * The property below is not "do not say `this machine`" — that would be a fingerprint of one bad
 * sentence. It is: A REFUSAL THAT NAMES THE INSTALL MUST NAME THE MACHINE THE INSTALL LANDS ON. You
 * cannot satisfy that while claiming the wrong one, because the control plane is the fact the seven were
 * missing.
 */
function remedyHidesWhichMachine(message: string): string | null {
  const flat = message.replace(/\s+/g, " ");
  if (!/fleet:inventory-install|inventory-install\.yml/.test(flat)) {
    // A remedy that does not offer the install cannot misdescribe it. `fleet-link-view.yml` was in that
    // state and was never wrong, only thin.
    return null;
  }
  if (!/control plane/i.test(flat)) {
    return "names `fleet:inventory-install` without naming the control plane, which is where it installs. "
      + "Read on an operator machine, that is an instruction to fix this box by changing another one.";
  }
  // The shape the seven carried, generalised over the words in between: the install introduced as
  // something THIS machine gains. Naming the control plane elsewhere in the message does not undo it.
  if (/this machine[^.]{0,120}(fleet:)?inventory-install/i.test(flat)) {
    return "introduces `fleet:inventory-install` as a copy `this machine` gains. It runs against the "
      + "control plane and writes the file there.";
  }
  return null;
}

/**
 * The seven, VERBATIM at `9faee29ef`, and named one at a time rather than counted.
 *
 * A test that pinned "7 playbooks are wrong" would pass the day an eighth copies the sentence and one of
 * today's is deleted. Each entry is a positive control for the predicate above: a real string, from a real
 * file, that a reader really could not follow. They are quoted here rather than read from the tree because
 * the tree no longer contains them — that is what this row changed.
 */
const THE_SEVEN_AS_THEY_READ: Record<string, string> = {
  "lab-job.yml": "or install the durable copy this machine can always read, `npm run fleet:inventory-install`, which puts it at /etc/a11ign/inventory.yml where `ansible.cfg` looks first.",
  "lab-fetch.yml": "or install the durable copy this machine can always read, `npm run fleet:inventory-install`, which puts it at /etc/a11ign/inventory.yml where `ansible.cfg` looks first.",
  "lab-status.yml": "or install the durable copy this machine can always read, `npm run fleet:inventory-install`, which puts it at /etc/a11ign/inventory.yml where `ansible.cfg` looks first.",
  "lab-log.yml": "or install the durable copy this machine can always read, `npm run fleet:inventory-install`, which puts it at /etc/a11ign/inventory.yml where `ansible.cfg` looks first.",
  "lab-stop.yml": "or install the durable copy this machine can always read, `npm run fleet:inventory-install`, which puts it at /etc/a11ign/inventory.yml where `ansible.cfg` looks first.",
  "lab-reset.yml": "or install the durable copy this machine can always read, `npm run fleet:inventory-install`, which puts it at /etc/a11ign/inventory.yml where `ansible.cfg` looks first.",
  "corpus-schedule.yml": "or install the durable copy this machine can always read, `npm run fleet:inventory-install`, which puts it at /etc/a11ign/inventory.yml where `ansible.cfg` looks first.",
};

test("each of the seven refusals that named the wrong machine is refused, by name", () => {
  const passed = Object.entries(THE_SEVEN_AS_THEY_READ)
    .filter(([, sentence]) => remedyHidesWhichMachine(sentence) === null)
    .map(([file]) => file)
    .sort();
  assert.deepEqual(passed, [],
    "these are the sentences that sent a reader to the wrong box, and the check no longer sees them:\n  "
    + passed.join("\n  "));
  assert.equal(Object.keys(THE_SEVEN_AS_THEY_READ).length, PLAYBOOKS_THAT_NAMED_THE_WRONG_MACHINE,
    "the measurement was seven; if this list is edited, the row's own count stops being checkable");
});

test("the weaker eighth wording is refused too — an unqualified install still reads as local", () => {
  // `update-origin-remote.yml`'s own sentence at `9faee29ef`. It never claimed "this machine", which is
  // why the row counted it separately — but it does not say where the file lands either, and a reader
  // with no inventory has no way to learn that from it. Included so the predicate is a property rather
  // than a denylist of the seven.
  assert.ok(remedyHidesWhichMachine(
    "No host matched `a11y_lab`, so the lab play below would have done NOTHING and exited 0. Run this "
    + "from a checkout that has `packages/control/ansible/inventory.yml`, or install the durable copy "
    + "with `npm run fleet:inventory-install`."));
});

/**
 * THE NEGATIVE CONTROL, and the reason this check could be written precisely.
 *
 * One of the ten was already right. `reset-checkout.yml` carried this at `9faee29ef`, and it is quoted
 * verbatim: a predicate that refused every message would be indistinguishable from a broken one, and this
 * is the sentence that proves the bar is reachable. It is the wording the shared guard was written from.
 */
const RESET_CHECKOUT_AS_IT_READ =
  "No host matched `a11y_workers`, so the worker play below would do NOTHING and exit 0. Run this from "
  + "the control plane, where `/etc/a11ign/inventory.yml` is read, or install it with "
  + "`npm run fleet:inventory-install`.";

test("the one that was already right passes, unchanged", () => {
  assert.equal(remedyHidesWhichMachine(RESET_CHECKOUT_AS_IT_READ), null);
});

test("naming the control plane elsewhere does not license the claim", () => {
  // THE CONTROL FOR THE SECOND RULE, without which it would be dead code: a message that satisfies the
  // first rule and still tells the reader this box gains the file. Not a sentence any playbook ever
  // carried -- it is the next one somebody writes, half-fixing the seven by appending the machine name to
  // a clause that already claimed the wrong one.
  assert.ok(remedyHidesWhichMachine(
    "No host matched `a11y_lab`. Install the durable copy this machine can always read with "
    + "`npm run fleet:inventory-install`, which the control plane also uses."));
});

test("a refusal that offers no install at all is not failed for it", () => {
  // `fleet-link-view.yml`'s wording at `9faee29ef`. Thin, never wrong: "run this from a checkout that has
  // one" is true on every machine. The predicate must not punish it, or it stops being about machines.
  assert.equal(remedyHidesWhichMachine(
    "No host matched `a11y_control`, or no worker matched `a11y_workers`, so this command would have "
    + "asked NOTHING and exited 0. `inventory.yml` is gitignored; run this from a checkout that has one."),
    null);
});

/** The `fail_msg: >-` folded block of a tasks file, as ansible will render it. */
function foldedFailMessage(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s*fail_msg:\s*>-\s*$/.test(l));
  assert.ok(start >= 0, "the shared guard must state its refusal as a folded `fail_msg: >-` block");
  const indent = (lines[start].match(/^\s*/) ?? [""])[0].length;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && (line.match(/^\s*/) ?? [""])[0].length <= indent) break;
    body.push(line.trim());
  }
  return body.join(" ");
}

test("the refusal every playbook now shares names the machine the install lands on", () => {
  // The live one. Everything above is history; this is the sentence an operator reads today.
  const shared = readFileSync(join(ANSIBLE, SHARED_GUARD), "utf8");
  const message = foldedFailMessage(shared);
  assert.ok(message.length > SHORTEST_CREDIBLE_REFUSAL, `the shared fail_msg read as ${message.length} chars — the parse has `
    + "gone blind rather than the message having shrunk");
  assert.equal(remedyHidesWhichMachine(message), null);
  assert.match(message, /inventory\.yml/,
    "and it must still name the file, or the reader knows which machine but not what to put on it");
});

/**
 * ONE SPELLING, enforced structurally — because the defect was never one bad sentence, it was ten copies
 * of one sentence and nothing comparing them. A message check alone passes the day an eleventh playbook
 * hand-writes its own guard with its own remedy.
 */
test("no playbook hand-writes a zero-host inventory guard; they all include the shared one", () => {
  const playbooks = readdirSync(ANSIBLE).filter((f) => f.endsWith(".yml"));
  const handWritten = playbooks
    .filter((f) => /^\s*-\s*groups\['[a-z0-9_]+'\] is defined\s*$/m.test(readFileSync(join(ANSIBLE, f), "utf8")))
    .sort();
  assert.deepEqual(handWritten, [],
    "these assert a group resolved to something with their own copy of the remedy. Include "
    + `\`${SHARED_GUARD}\` with \`inventory_group\`/\`inventory_group_noun\` instead — ten hand-copied `
    + "spellings is how seven of them came to name the wrong machine:\n  " + handWritten.join("\n  "));

  // ANTI-VACUITY, both halves. The scan must be looking at playbooks, and the guard must still be in use:
  // an empty offender list means nothing if the regex stopped matching the shape it hunts.
  assert.ok(playbooks.length >= FEWEST_PLAYBOOKS_A_LIVE_SCAN_SEES,
    `only ${playbooks.length} playbook(s) found in ${ANSIBLE} — the scan has gone blind`);
  assert.match(
    "    - name: Refuse an inventory that resolved no lab\n"
    + "      ansible.builtin.assert:\n        that:\n          - groups['a11y_lab'] is defined\n",
    /^\s*-\s*groups\['[a-z0-9_]+'\] is defined\s*$/m,
    "the block as it was written at `9faee29ef` must still be recognised by the scan above");
  const including = playbooks
    .filter((f) => readFileSync(join(ANSIBLE, f), "utf8").includes(SHARED_GUARD));
  assert.ok(including.length >= PLAYBOOKS_CARRYING_THE_GUARD,
    `only ${including.length} playbook(s) include ${SHARED_GUARD}; ten carried this guard when it was `
    + "consolidated, so a smaller number means one has quietly stopped refusing rather than the fleet "
    + "having shrunk");
});
