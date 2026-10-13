// Control's half of the stamp's file-list guard. The stamp's own test lives in the fleet
// (`provision-stamp.test.ts`, a11ign#5350) and pins the FIVE hashed files. This file asks the other
// question: whether every file control's Ansible role can hand to a guest is classified as hashed or
// exempt. It cannot read the stamp itself, because control has no dependencies (ADR 0012), so the
// control-owned part of the list is restated below as a literal.
/**
 * THE STAMP'S FILE LIST IS PINNED BY NOTHING unless something enumerates the role. The fleet's stamp test
 * asserts the hashed files have not silently changed; it cannot say whether they are the RIGHT ones. A new
 * task file or custom Ansible module that provisioning reads can ship with nothing asking whether it belongs
 * in the hash, and the failure is silent in the worst direction: the stamp keeps matching across a real
 * environment change, `fleet-consistency` calls a split fleet consistent, and two guests with different
 * NVDA/Edge behaviour share one capture cache entry.
 *
 * This is a DISCOVERING test, in the shape `busy-worker-guard.test.ts` already uses for the identical problem
 * one layer over (a worker playbook nobody classified). It enumerates every task file under
 * `roles/worker/tasks/`, every custom module under the `a11y.worker` collection, and the NIC driver blobs
 * `bespoke.yml` stages, and requires each to be either HASHED or EXEMPT with a reason — never silently
 * uncovered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROLE = fileURLToPath(new URL("../../ansible/roles/worker/", import.meta.url));
const MODULES = fileURLToPath(
  new URL("../../ansible/collections/ansible_collections/a11y/worker/plugins/modules/", import.meta.url));

/**
 * The control-owned files the fleet's stamp hashes (`$ENVIRONMENT_FILES` in `stamp-provision-revision.ps1`),
 * restated as a LITERAL. Control cannot read the stamp, so nothing here checks this set against it: if the
 * stamp changes, this test answers from the stale copy until someone edits it. The fleet's
 * `provision-stamp.test.ts` is the authority for the full list.
 */
const HASHED_HERE = new Set([
  "ansible/roles/worker/defaults/main.yml",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_speech_viewer.ps1",
]);

/** Every task file `main.yml` imports — the whole of what the Ansible path can DO to a guest. */
function taskFiles(): string[] {
  return readdirSync(ROLE + "tasks")
    .filter((f) => f.endsWith(".yml"))
    .map((f) => `ansible/roles/worker/tasks/${f}`);
}

/** Every custom `a11y.worker` module — the PowerShell implementation and its documentation pair. */
function moduleFiles(): string[] {
  return readdirSync(MODULES)
    .filter((f) => f.endsWith(".ps1") || f.endsWith(".py"))
    .map((f) => `ansible/collections/ansible_collections/a11y/worker/plugins/modules/${f}`);
}

/** The NIC driver blobs `bespoke.yml` stages onto a guest with the inbox driver. */
function driverFiles(): string[] {
  return readdirSync(ROLE + "files/intel-e1d")
    .map((f) => `ansible/roles/worker/files/intel-e1d/${f}`);
}

/**
 * Why a discovered file does not need to be in `$ENVIRONMENT_FILES`. A REASON, never a bare name, so
 * that widening the hash means arguing with a sentence rather than deleting a string — the identical
 * discipline `busy-worker-guard.test.ts`'s `EXEMPT` already uses.
 *
 * Every entry states what the file changes and WHERE (if anywhere) that change is already caught, so a
 * reader can tell "correctly excluded" from "not yet decided" without re-deriving the audit.
 */
const EXEMPT: Record<string, string> = {
  "ansible/roles/worker/tasks/main.yml":
    "Only imports the other task files below in order. Carries no value of its own.",
  "ansible/roles/worker/tasks/policy.yml":
    "Applies registry DWORDs, but every VALUE it writes (worker_edge_policy, worker_edge_update_policy, "
    + "worker_quiet_policy, worker_content_delivery_values) is declared in defaults/main.yml, which is "
    + "already hashed. A refactor here (batching writes, changing the read-back shape) cannot move the "
    + "environment without also touching the file that is hashed.",
  "ansible/roles/worker/tasks/display.yml":
    "Sets worker_display_mode and installs worker_display_driver_url/_sha256/_version (all from the "
    + "already-hashed defaults/main.yml), the same reasoning as policy.yml above: the VALUE this task "
    + "applies is declared in a file the stamp already hashes, so a refactor here (which mechanism sets "
    + "the mode -- the interactive scheduled task in run-interactive.yml, since #1567 2026-09-21 -- the "
    + "read-back shape, the install/reboot handling) cannot move the environment without also touching "
    + "the file that is hashed. set-display-mode.ps1 itself is outside this test's discovery (it lives "
    + "in the fleet's src/provisioning/, not roles/worker/) and carries no environment value "
    + "of its own -- it only applies what worker_display_mode already hashes, same as this task did inline.",
  "ansible/roles/worker/tasks/edge-version.yml":
    "Installs and pins worker_edge_version (from the already-hashed defaults/main.yml), but the effect — "
    + "which Edge build actually runs — is independently re-measured every capture via browserVersion, a "
    + "cache-key field read from the live binary rather than assumed from provisioning intent. A bug here "
    + "shows up as a live mismatch, which is louder and more reliable than a stale stamp.",
  "ansible/roles/worker/tasks/nvda.yml":
    "Installs guidepup/NVDA (screenReaderVersion and guidepupVersion are live-measured cache-key fields, "
    + "same reasoning as edge-version.yml) and invokes a11y_speech_viewer, which IS hashed (HASHED_HERE).",
  "ansible/roles/worker/tasks/tasks.yml":
    "Registers the scheduled task (LogonType, RunLevel). Getting these wrong makes NVDA fail to start at "
    + "all (\"NVDA is not supported\") or capture nothing (an elevated worker cannot read the browser) — a "
    + "loud, total capture failure, not the silent per-guest evidence drift the stamp exists to catch.",
  "ansible/roles/worker/tasks/bespoke.yml":
    "Power timeouts, NIC wake, Defender and browser-profile directories — reliability and disk. Also "
    + "writes provision-revision.txt itself, which cannot sensibly hash its own input.\n\n"
    + "row 1201 AMENDED THIS REASON RATHER THAN INHERITING IT. The old wording said \"not what a capture "
    + "hears\", and this file now writes `.a11y-profile-origin`, which `browser-profile.mjs` reads to "
    + "decide a profile's identity — and that identity IS an `environmentKey` input. So the premise the "
    + "old sentence rested on moved under it. The exemption still holds, for a different and narrower "
    + "reason: the stamp exists to stop two guests' EVIDENCE BLENDING, and this record can only make the "
    + "key MORE discriminating. A guest whose profile was created fresh and one whose profile was adopted "
    + "now report different identities and therefore cannot share a cache entry — which is the direction "
    + "the stamp wants. Hashing this file instead would bump provisionRevision fleet-wide and invalidate "
    + "every cached pair to record a fact that already separates the guests it needs to separate.",
  "ansible/roles/worker/tasks/packages.yml":
    "Node and Git versions, and the repo clone. Neither Node nor Git touches NVDA/Edge announcement "
    + "content; the repo's checked-out COMMIT is deliberately a separate, non-cache-key precondition "
    + "(assertFleetRunsThisCheckout), not this stamp's job.",
  "ansible/roles/worker/tasks/account.yml":
    "Account identity and auto-logon. No relationship to what a capture observes.",
  "ansible/roles/worker/tasks/firewall.yml":
    "Network reachability (port rules, sshd). No relationship to what a capture observes.",
  "ansible/roles/worker/tasks/powershell-native-image.yml":
    "NGEN of System.Management.Automation (#2672): changes how fast powershell.exe STARTS, never what a "
    + "capture hears. It reads before it writes and names its assembly in the task file, not in "
    + "defaults/main.yml, so it moves no hashed value.",
  "ansible/roles/worker/tasks/verify.yml":
    "Read-only checks against what earlier tasks already did. Writes nothing.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_defender.ps1":
    "Windows Defender real-time monitoring, off for memory headroom. Perf only.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_defender.py":
    "Documentation for a11y_defender.ps1 (see that entry). No independent runtime effect.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nic_power.ps1":
    "NIC selective-suspend and wake settings. Affects Wake-on-LAN and reachability, never capture content.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nic_power.py":
    "Documentation for a11y_nic_power.ps1 (see that entry). No independent runtime effect.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_wake_prereqs.ps1":
    "Firmware Wake-on-LAN and the adapter's IP configuration (#3230). Affects whether a box can be woken and "
    + "where it answers, never capture content.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_wake_prereqs.py":
    "Documentation for a11y_wake_prereqs.ps1 (see that entry). No independent runtime effect.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_boot_order.ps1":
    "Firmware boot order, network boot out of it (#3387), ON by default behind worker_enforce_boot_order (#3492). Affects "
    + "what a box tries to boot and whether a PXE server can take it, never what a capture hears, so it is "
    + "EXEMPT like the other firmware/power modules. #3387's done-when 8 asked for HASHED, which needs a line "
    + "in `$ENVIRONMENT_FILES` in stamp-provision-revision.ps1, outside that row's Region; reported on the row "
    + "rather than widened here. `provisionRevision` DOES move when the default flips (#3492), because "
    + "`worker_enforce_boot_order` lives in defaults/main.yml, which IS hashed: the fleet reads INCONSISTENT until "
    + "the next fleet:provision, which is expected and not a regression.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_boot_order.py":
    "Documentation for a11y_boot_order.ps1 (see that entry). No independent runtime effect.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_power_timeouts.ps1":
    "AC sleep timeouts, so the worker does not vanish. Affects reachability, never capture content.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_power_timeouts.py":
    "Documentation for a11y_power_timeouts.ps1 (see that entry). No independent runtime effect.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_onedrive.ps1":
    "Evicts OneDrive to stop a focus-stealing toast. Real evidence risk, but an INTERMITTENT one-off event "
    + "per capture, not a persistent per-guest state that silently blends two populations the way a "
    + "config default does — gate:stability's content comparison is what actually catches this class.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_onedrive.py":
    "Documentation for a11y_onedrive.ps1 (see that entry). No independent runtime effect.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nvda.ps1":
    "Installs NVDA via guidepup. Which build lands is screenReaderVersion/guidepupVersion, live-measured "
    + "cache-key fields — the same reasoning as edge-version.yml above.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_nvda.py":
    "Documentation for a11y_nvda.ps1 (see that entry). No independent runtime effect.",
  "ansible/collections/ansible_collections/a11y/worker/plugins/modules/a11y_speech_viewer.py":
    "Documentation for a11y_speech_viewer.ps1, which IS hashed. Ansible requires the .py/.ps1 pair and "
    + "only the .ps1 has runtime effect, so hashing the docstring would churn the capture cache for a "
    + "prose edit — the same reason every other .py pair here is exempt.",
  "ansible/roles/worker/files/intel-e1d/e1d.inf":
    "Intel NIC driver. Wake-on-LAN and reachability, never capture content.",
  "ansible/roles/worker/files/intel-e1d/e1d.sys":
    "Intel NIC driver. Wake-on-LAN and reachability, never capture content.",
  "ansible/roles/worker/files/intel-e1d/e1d.cat":
    "Intel NIC driver catalogue (signature). Wake-on-LAN and reachability, never capture content.",
  "ansible/roles/worker/files/intel-e1d/e1dmsg.dll":
    "Intel NIC driver messages. Wake-on-LAN and reachability, never capture content.",
};

function discovered(): string[] {
  return [...taskFiles(), ...moduleFiles(), ...driverFiles()];
}

test("provision-stamp-inputs.test.ts discovers a non-trivial set of files", () => {
  // The vacuity guard. A change to this role's layout that silently emptied the discovery functions would
  // make every test below pass by examining nothing.
  const found = discovered();
  assert.ok(found.length >= 15, `expected to discover the role's task and module files, found ${found.length}`);
});

test("every task file, custom module and driver blob is HASHED or EXEMPT with a reason", () => {
  for (const file of discovered()) {
    if (HASHED_HERE.has(file)) continue;
    assert.ok(EXEMPT[file], `${file} is neither in the stamp's $ENVIRONMENT_FILES nor in EXEMPT — nobody `
      + "has decided whether it belongs in the capture cache key. Add it to one, with a reason.");
    assert.ok(EXEMPT[file].length > 40, `${file}: an exemption needs a reason, not a name`);
  }
});

test("every EXEMPT entry names a file that still exists, so the list cannot rot into a phantom", () => {
  const present = new Set(discovered());
  for (const file of Object.keys(EXEMPT)) {
    assert.ok(present.has(file),
      `EXEMPT names ${file}, which discovery no longer finds under roles/worker/ or the a11y.worker collection`);
  }
});

test("no file is both HASHED and EXEMPT — the contradiction the last fix nearly left behind", () => {
  // An exemption saying "not yet remedied" beside a hash that remedies it is worse than either alone,
  // because a reader trusts the prose.
  for (const exempt of Object.keys(EXEMPT)) {
    assert.ok(!HASHED_HERE.has(exempt),
      `${exempt} is in $ENVIRONMENT_FILES AND in EXEMPT. One of them is wrong, and whichever a reader `
      + "happens to consult decides what they believe.");
  }
});
