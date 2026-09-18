/**
 * #1356: `readControlPlaneFleet` is the ONE function every operator-host reader now calls instead of a
 * checkout's own `inventory.yml`. `inventorySources`/`inventoryReadScript`/`parseInventoryReads`/
 * `controlPlaneFleet` are the pieces #1343 already proved through `fleet-playbook.test.ts`, moved here
 * unchanged -- those tests still exercise them, through this file's re-exports from `fleet-playbook.mjs`.
 * What is NEW here, and untested until now, is `readControlPlaneFleet` ITSELF: the wiring from
 * "ansible.cfg's text" through "ssh reads" to "a resolved fleet or a refusal", with every dependency
 * injected so this never needs a real control plane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readControlPlaneFleet, inventoryPathFor } from "./control-plane-fleet.mjs";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.mjs";

const IN_TREE_FALLBACK = `${CONTROL_PLANE_CHECKOUT_PATH}/packages/control/ansible/inventory.yml`;

const ANSIBLE_CFG = "[defaults]\ninventory = /etc/a11ign/inventory.yml,inventory.yml\n";
const GROUP_VARS = "a11y_port: 8765\n";
const REAL_INVENTORY = ["all:", "  children:", "    a11y_workers:", "      hosts:",
  "        a11y-worker-2:", "          ansible_host: 192.0.2.2"].join("\n") + "\n";

test("#1356: readControlPlaneFleet wires ansible.cfg's sources into the injected ssh read, and resolves "
  + "a real fleet -- the shape every operator-host reader now depends on", () => {
  const readPaths: string[][] = [];
  const { workers, refusal } = readControlPlaneFleet({
    ansibleCfgText: ANSIBLE_CFG, groupVarsText: GROUP_VARS,
    readInventories: (sources) => { readPaths.push(sources); return [{ path: sources[0], text: REAL_INVENTORY }]; },
  });
  assert.equal(refusal, null);
  assert.deepEqual(workers, [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" }]);
  assert.deepEqual(readPaths[0], ["/etc/a11ign/inventory.yml", IN_TREE_FALLBACK]);
});

test("#1356: a malformed ansible.cfg refuses before any ssh read is attempted", () => {
  let readInventoriesCalled = false;
  const { workers, refusal } = readControlPlaneFleet({
    ansibleCfgText: "[defaults]\n", groupVarsText: GROUP_VARS,
    readInventories: () => { readInventoriesCalled = true; return []; },
  });
  assert.deepEqual(workers, []);
  assert.match(String(refusal), /the control plane's inventory could not be read \(ansible\.cfg declares no `inventory =` line/);
  assert.equal(readInventoriesCalled, false, "no `inventory =` line means nothing to read -- refuse before asking");
});

test("#1356: an unreachable control plane refuses with ssh's own stderr, never a raw stack", () => {
  const { workers, refusal } = readControlPlaneFleet({
    ansibleCfgText: ANSIBLE_CFG, groupVarsText: GROUP_VARS,
    readInventories: () => { throw Object.assign(new Error("Command failed"), { stderr: "ssh: connect to host 192.0.2.1 port 22: Connection timed out\n" }); },
  });
  assert.deepEqual(workers, []);
  assert.match(String(refusal), /the control plane could not be reached \(ssh: connect to host 192\.0\.2\.1 port 22: Connection timed out\)/);
});

test("#1356: no inventory source on the control plane refuses, never a silently empty fleet", () => {
  const { workers, refusal } = readControlPlaneFleet({
    ansibleCfgText: ANSIBLE_CFG, groupVarsText: GROUP_VARS, readInventories: () => [],
  });
  assert.deepEqual(workers, []);
  assert.match(String(refusal), /no inventory exists at \/etc\/a11ign\/inventory\.yml or/);
});

test("#1356 MUTATION TARGET: readInventories must be called with inventorySources' real output, not a "
  + "hand-rolled list -- swap the sources argument for an empty array and the real path breaks silently", () => {
  // A caller-supplied `readInventories` that ignores its `sources` argument entirely and always answers
  // as if asked about a fixed path would still pass the three tests above; this one pins that the argument
  // it receives is the ACTUAL sources `inventorySources(ansibleCfgText)` derived, not a stand-in.
  let received: string[] = [];
  readControlPlaneFleet({
    ansibleCfgText: ANSIBLE_CFG, groupVarsText: GROUP_VARS,
    readInventories: (sources) => { received = sources; return []; },
  });
  assert.deepEqual(received, ["/etc/a11ign/inventory.yml", IN_TREE_FALLBACK]);
});

// --- #1683/#1684: the DURABLE inventory copy is tried first, matching ansible.cfg's own stated precedence.
// Shared here (not in fleet-wake.test.ts) because fleet-discover.mjs (#1684) needs the same function and
// fleet-wake.mjs already imports FROM fleet-discover.mjs -- a shared, neutral home avoids a cycle.

test("#1683: when the durable copy exists, it wins -- no checkout inventory.yml needed at all", () => {
  const path = inventoryPathFor({
    installed: "/etc/a11ign/inventory.yml", inTree: "/checkout/packages/control/ansible/inventory.yml",
    exists: (p) => p === "/etc/a11ign/inventory.yml",
  });
  assert.equal(path, "/etc/a11ign/inventory.yml");
});

test("#1683: with no durable copy, the in-tree checkout path is the fallback -- today's exact behaviour, unchanged", () => {
  const path = inventoryPathFor({
    installed: "/etc/a11ign/inventory.yml", inTree: "/checkout/packages/control/ansible/inventory.yml",
    exists: () => false,
  });
  assert.equal(path, "/checkout/packages/control/ansible/inventory.yml");
});

test("#1683 MUTATION TARGET: the durable path must be CHECKED, not assumed -- a machine with neither must "
  + "still fall through to the in-tree path (main()'s own ENOENT refusal reads it), never claim the "
  + "durable one exists unconditionally", () => {
  let checked = "";
  const path = inventoryPathFor({
    installed: "/etc/a11ign/inventory.yml", inTree: "/checkout/packages/control/ansible/inventory.yml",
    exists: (p) => { checked = p; return false; },
  });
  assert.equal(checked, "/etc/a11ign/inventory.yml", "the durable path must actually be asked about");
  assert.equal(path, "/checkout/packages/control/ansible/inventory.yml");
});

test("#1683: the real defaults name the same durable path ansible.cfg's own first-listed source does, "
  + "and the real in-tree path this file always read", () => {
  const path = inventoryPathFor({ exists: () => false });
  assert.match(path, /packages\/control\/ansible\/inventory\.yml$/);
});
