/**
 * EVERY playbook that restarts a worker must first ask whether that worker is capturing.
 *
 * This is a DISCOVERING test, not a list of three assertions, and the reason is the defect it was written
 * for. On 2026-09-05 `sleep.yml` had the refusal and `provision-role.yml` had copied it, each carrying a
 * comment saying the check must be asked over HTTP "so the two cannot disagree about busy" -- and
 * `deploy.yml`, the one play that REBOOTS every guest it touches, had nothing. A `capture-real-pages` run
 * started one minute after a different one finished, the progress file still described the finished run,
 * the fleet read as free, and a deploy went out three minutes later. Twelve in-flight captures died:
 * "worker forgot capture <id> after accepting it -- it restarted mid-capture, so the work is gone".
 * `provision.yml` was unguarded too and nobody had noticed, because nothing was looking.
 *
 * That is this repo's most expensive recurring shape -- a remedy applied at some call sites and not all --
 * and its own stated remedy is to make the copies unable to disagree. A test naming `provision-role.yml`
 * by hand could never have seen `deploy.yml`; this one fails until a NEW worker playbook is classified.
 *
 * The exemptions are the interesting half and they are exemptions in the OPPOSITE direction: `recover.yml`
 * and `restart.yml` exist precisely to act on a worker that is busy AND WEDGED -- `busy: true` for three
 * and a half hours, every capture returning 429 because a hung capture never released the flag. Adding
 * this check to either would make the remedy refuse the only situation it is for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ANSIBLE = fileURLToPath(new URL("../ansible/", import.meta.url));

/**
 * Why a worker-targeting playbook does not need the check. A REASON, never a bare name, so that removing
 * an entry means arguing with a sentence rather than deleting a string.
 */
const EXEMPT: Record<string, string> = {
  "recover.yml":
    "It exists to kill a worker that is busy and WEDGED -- a capture that began at 03:00 and was still "
    + "`current` at 06:32 with every readiness check green. Refusing on `busy` would refuse its only case.",
  "restart.yml":
    "The remedy for the wedge: /health answers but every capture returns 429 because a hung capture never "
    + "released `busy`. Same inversion as recover.yml -- `busy` is the symptom it treats.",
  "collect-logs.yml": "Reads files off the guest. Starts and stops nothing.",
  "ssh-key.yml": "Writes an authorized_keys file. Does not touch the worker process.",
  "wake.yml": "Wake-on-LAN to a machine that is OFF. A worker that answers /health is not its subject.",
};

function playbooksTargetingWorkers(): string[] {
  return readdirSync(ANSIBLE)
    .filter((f) => f.endsWith(".yml") && !f.endsWith(".local.yml"))
    .filter((f) => f !== "inventory.yml" && f !== "requirements.yml")
    .filter((f) => /^\s{2}hosts:.*a11y_workers/m.test(readFileSync(ANSIBLE + f, "utf8")));
}

/** Comments describe the check; only the executable half performs it. */
function executable(file: string): string {
  return readFileSync(ANSIBLE + file, "utf8")
    .split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

test("every worker playbook either asks /health for `busy`, or is exempt with a reason", () => {
  const found = playbooksTargetingWorkers();
  assert.ok(found.length >= 6, `expected to discover the worker playbooks, found ${found.length}`);

  for (const file of found) {
    if (EXEMPT[file]) {
      assert.ok(EXEMPT[file].length > 40, `${file}: an exemption needs a reason, not a name`);
      continue;
    }
    const play = executable(file);
    assert.match(play, /\.json\.busy/,
      `${file} restarts a worker and never asks whether it is capturing. Either add the check (copy the `
      + `shape from sleep.yml) or add it to EXEMPT with the reason it does not need one.`);
    // Over HTTP from the control plane, which is the channel the DISPATCHER uses. Over SSH it would be a
    // different question answered a different way, and the two could then disagree about "busy".
    assert.match(play, /url: "http:\/\/\{\{ ansible_host \}\}:\{\{ a11y_port \}\}\/health"/,
      `${file} must ask over HTTP, the same channel the dispatcher asks on`);
  }
});

test("a play that would leave the fleet SPLIT fails hard; sleep, which cannot, only skips", () => {
  // The distinction is the point rather than an inconsistency. A half-slept fleet is harmless: some boxes
  // are off, some are on, and nothing about the evidence changes. A half-DEPLOYED fleet runs two
  // `codeVersion`s, which `assertFleetRunsThisCheckout` refuses at the start of every capture run; a
  // half-PROVISIONED one splits `provisionRevision`, a capture cache key and a fleet-consistency
  // MUST_MATCH field. Skipping the busy box in either case leaves you a stale fleet AND a destroyed run.
  for (const file of ["deploy.yml", "provision.yml", "provision-role.yml"]) {
    assert.match(executable(file), /ansible\.builtin\.fail:/, `${file} must FAIL on a busy worker`);
  }
  const sleep = executable("sleep.yml");
  assert.match(sleep, /a11y_force_sleep/, "sleep.yml skips a busy box and takes an explicit override");
});

test("the refusal is overridable, and the override is named in the message that refuses", () => {
  // A guard with no way past it is one people work around by other means -- this repo reached for
  // `A11Y_SKIP_VERIFY=1` six times in one evening for a refusal it did not understand. An override that
  // the refusal itself names is the difference between a deliberate act and a workaround.
  for (const [file, flag] of [
    ["deploy.yml", "a11y_force_deploy"], ["provision.yml", "a11y_force_provision"],
  ] as const) {
    const play = executable(file);
    assert.match(play, new RegExp(`not \\(${flag} \\| default\\(false\\) \\| bool\\)`),
      `${file} must be overridable with -e ${flag}=true`);
    assert.match(play, new RegExp(`-e ${flag}=true`),
      `${file}'s refusal message must name its own override, or nobody will find it`);
  }
});

test("every exemption names a playbook that exists, so the list cannot rot into a phantom", () => {
  const present = new Set(readdirSync(ANSIBLE));
  for (const file of Object.keys(EXEMPT)) {
    assert.ok(present.has(file), `EXEMPT names ${file}, which is not in ansible/ any more`);
  }
});
