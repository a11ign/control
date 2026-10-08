import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { declaresBootstrap } from "./fleet-playbook.mjs";

const ANSIBLE = join(import.meta.dirname, "../ansible");
const playbooks = () => readdirSync(ANSIBLE).filter((f) => f.endsWith(".yml"));
const read = (f: string) => readFileSync(join(ANSIBLE, f), "utf8");

/**
 * A BOOTSTRAP PLAYBOOK MUST DEPEND ON NOTHING IT BOOTSTRAPS, and the rule is general rather than
 * "inventory-install is special".
 *
 * `fleet-playbook.mjs` normally starts a playbook as a systemd unit ON the control plane, for a measured
 * reason: 2026-09-05, a caller was killed 100 s into a ten-machine reboot and the unit survived. A playbook
 * that BOOTSTRAPS the control plane cannot use that path, and `inventory-install.yml` found both ways it
 * fails, in order:
 *
 *   `hosts: control_plane`  the group is DEFINED IN THE INVENTORY IT INSTALLS. Zero hosts; refused.
 *   `hosts: localhost`      under the unit path "localhost" IS the control plane, where the source file is
 *                           missing — which is the incident that created the need.
 *
 * So it runs from the operator's machine with `-i '<host>,'`. The DECLARATION lives in the playbook rather
 * than in a list inside the wrapper, because the risk of an exception is never the first one — it is the
 * second, acquired by copy-paste with nobody re-arguing it. This test is what makes that impossible.
 */

test("a bootstrap playbook may not target a group that comes from the inventory it installs", () => {
  const bootstraps = playbooks().filter((f) => declaresBootstrap(f));
  // ANTI-VACUITY: if the marker is renamed this finds none and passes having checked nothing.
  assert.ok(bootstraps.length >= 1,
    "no playbook declares `a11y_bootstrap`; the marker has been renamed and this test is blind");

  for (const f of bootstraps) {
    const src = read(f);
    assert.doesNotMatch(src, /^\s*hosts:\s*(a11y_workers|control_plane)\s*$/m,
      `${f} declares a11y_bootstrap AND targets a group defined in inventory.yml — the file a bootstrap `
      + "installs. That is the circularity this marker exists to prevent; use `hosts: all` and let the "
      + "wrapper pass the target with -i.");
    assert.match(src, /^\s*hosts:\s*all\s*$/m,
      `${f} declares a11y_bootstrap, so its target must come from the command line (\`hosts: all\`)`);
  }
});

test("a long-running playbook must never declare it — the unit path is what it would lose", () => {
  // The exception is safe because a sub-second file copy has nothing to outlive. A deploy does, and the
  // unit-based path exists for exactly that. Approximated by refusing the playbooks known to be long.
  const LONG = ["deploy.yml", "provision-role.yml", "recover.yml", "sleep.yml"];
  for (const f of LONG) {
    if (!playbooks().includes(f)) continue;
    assert.equal(declaresBootstrap(f), false,
      `${f} takes minutes and must keep the systemd-unit path, which survives the caller being killed. `
      + "A bootstrap declaration would make it die with the terminal.");
  }
});

test("the wrapper DISCOVERS the marker rather than listing the playbook", () => {
  // A hardcoded list would let the second exception in silently, which is the actual risk.
  const wrapper = readFileSync(join(import.meta.dirname, "fleet-playbook.mjs"), "utf8");
  assert.match(wrapper, /declaresBootstrap\(chosen\)/,
    "the dispatch must ask the playbook, not consult a list");
  assert.doesNotMatch(wrapper, /LOCAL_PLAYBOOKS|new Set\(\["inventory-install/,
    "a hardcoded set is how a second exception arrives with nobody arguing for it");
});
