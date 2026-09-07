/**
 * #83: `fleet-playbook.mjs` and `lab-pipeline.mjs` both hardcoded a real, specific LAN address as
 * `process.env.A11Y_CONTROL_HOST || "<real address>"`, one file away from `packages/control/README.md`
 * saying outright that value must never be committed. `requireControlPlaneHost` is the fix: a required
 * value refused loudly when absent, never guessed at with something that happens to work on one machine.
 *
 * #85: the SAME two files did the identical thing for `A11Y_PVE_KEY`, defaulting to a real, specific key
 * filename -- missed by #83's own investigation, which stopped at the address (this file's header
 * comment said outright "A11Y_PVE_KEY already had no such fallback", and that was false). See
 * `control-plane-host.mjs`'s own header for why `A11Y_SSH_KEY` (the fleet's key, not the control plane's)
 * is a deliberately different, NOT-fixed case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireControlPlaneHost, requireControlPlaneKey, readControlHostFile } from "./control-plane-host.mjs";

/** Runs `fn` with both env vars saved and restored, and a real temp file cleaned up after -- #285. */
function withHostEnv(fn: (filePath: string) => void): void {
  const beforeHost = process.env.A11Y_CONTROL_HOST;
  const beforeFile = process.env.A11Y_CONTROL_HOST_FILE;
  const dir = mkdtempSync(join(tmpdir(), "control-host-file-"));
  try {
    fn(join(dir, "control-host"));
  } finally {
    if (beforeHost === undefined) delete process.env.A11Y_CONTROL_HOST; else process.env.A11Y_CONTROL_HOST = beforeHost;
    if (beforeFile === undefined) delete process.env.A11Y_CONTROL_HOST_FILE; else process.env.A11Y_CONTROL_HOST_FILE = beforeFile;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("returns A11Y_CONTROL_HOST when it is set", () => {
  const before = process.env.A11Y_CONTROL_HOST;
  try {
    process.env.A11Y_CONTROL_HOST = "control.example.test";
    assert.equal(requireControlPlaneHost(), "control.example.test");
  } finally {
    if (before === undefined) delete process.env.A11Y_CONTROL_HOST; else process.env.A11Y_CONTROL_HOST = before;
  }
});

test("REFUSES rather than guessing when A11Y_CONTROL_HOST is unset", () => {
  const before = process.env.A11Y_CONTROL_HOST;
  try {
    delete process.env.A11Y_CONTROL_HOST;
    assert.throws(() => requireControlPlaneHost(), /A11Y_CONTROL_HOST is required/);
  } finally {
    if (before === undefined) delete process.env.A11Y_CONTROL_HOST; else process.env.A11Y_CONTROL_HOST = before;
  }
});

test("an empty string is treated the same as unset, not as a chosen empty host", () => {
  const before = process.env.A11Y_CONTROL_HOST;
  try {
    process.env.A11Y_CONTROL_HOST = "";
    assert.throws(() => requireControlPlaneHost(), /A11Y_CONTROL_HOST is required/);
  } finally {
    if (before === undefined) delete process.env.A11Y_CONTROL_HOST; else process.env.A11Y_CONTROL_HOST = before;
  }
});

// A private IPv4 literal used as a fallback default -- `... || "10.x.x.x"` / `"192.168.x.x"` -- is exactly
// the shape #83 removed. Pinned against the SOURCE TEXT of both files that used to carry it, so a reverted
// fallback fails a fast, offline test rather than waiting to be found in a public repo a second time.
const FALLBACK_PRIVATE_IP = /A11Y_CONTROL_HOST\s*\|\|\s*["'](10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

test("fleet-playbook.mjs no longer falls back to a hardcoded private address", () => {
  const source = readFileSync(new URL("./fleet-playbook.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, FALLBACK_PRIVATE_IP);
  assert.match(source, /requireControlPlaneHost\(\)/, "the loud refusal must still be wired in, not just removed");
});

test("lab-pipeline.mjs no longer falls back to a hardcoded private address", () => {
  const source = readFileSync(new URL("./lab-pipeline.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, FALLBACK_PRIVATE_IP);
  assert.match(source, /requireControlPlaneHost\(\)/, "the loud refusal must still be wired in, not just removed");
});

test("returns A11Y_PVE_KEY when it is set", () => {
  const before = process.env.A11Y_PVE_KEY;
  try {
    process.env.A11Y_PVE_KEY = "/tmp/example_ed25519";
    assert.equal(requireControlPlaneKey(), "/tmp/example_ed25519");
  } finally {
    if (before === undefined) delete process.env.A11Y_PVE_KEY; else process.env.A11Y_PVE_KEY = before;
  }
});

test("REFUSES rather than guessing when A11Y_PVE_KEY is unset", () => {
  const before = process.env.A11Y_PVE_KEY;
  try {
    delete process.env.A11Y_PVE_KEY;
    assert.throws(() => requireControlPlaneKey(), /A11Y_PVE_KEY is required/);
  } finally {
    if (before === undefined) delete process.env.A11Y_PVE_KEY; else process.env.A11Y_PVE_KEY = before;
  }
});

// A hardcoded key path used as a fallback default -- `A11Y_PVE_KEY || \`${HOME}/.ssh/...\`` -- is exactly
// the shape #85 removed. Pinned against the SOURCE TEXT of both files, so a reverted fallback fails a
// fast, offline test rather than waiting to be found in a public repo a second time.
//
// JS-ONLY, DELIBERATELY: this matches the `||` spelling, never Ansible's `lookup('env', 'A11Y_PVE_KEY')
// | default(...)`, which is the IDENTICAL fallback shape and is still live on `main` at
// group_vars/a11y_hypervisor.yml:11 and group_vars/a11y_lab.yml:49 -- a nameable follow-up (the Ansible
// side needs an assert task, not this pattern; `| mandatory` does not work here, see the commit message),
// not covered by this guard, which only ever checks the two JS call sites #85 fixed.
const FALLBACK_KEY_PATH = /A11Y_PVE_KEY\s*\|\|/;

test("fleet-playbook.mjs no longer falls back to a hardcoded key path", () => {
  const source = readFileSync(new URL("./fleet-playbook.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, FALLBACK_KEY_PATH);
  assert.match(source, /requireControlPlaneKey\(\)/, "the loud refusal must still be wired in, not just removed");
});

test("lab-pipeline.mjs no longer falls back to a hardcoded key path", () => {
  const source = readFileSync(new URL("./lab-pipeline.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, FALLBACK_KEY_PATH);
  assert.match(source, /requireControlPlaneKey\(\)/, "the loud refusal must still be wired in, not just removed");
});

/**
 * #285: a value installed once on the machine that owns it -- the third state between "committed to git"
 * and "typed into every shell". `readControlHostFile` and the precedence it feeds `requireControlPlaneHost`
 * are what this row adds; the tests above must keep passing unchanged, which is the proof that #83's
 * refusal survives this row rather than being softened by it.
 */

test("readControlHostFile: null when the file does not exist, never thrown", () => {
  withHostEnv((filePath) => {
    assert.equal(readControlHostFile(filePath), null);
  });
});

test("readControlHostFile: the trimmed content when the file exists", () => {
  withHostEnv((filePath) => {
    writeFileSync(filePath, "control.example.test\n");
    assert.equal(readControlHostFile(filePath), "control.example.test");
  });
});

test("readControlHostFile: an empty (or whitespace-only) file is null, not a chosen empty host", () => {
  withHostEnv((filePath) => {
    writeFileSync(filePath, "  \n");
    assert.equal(readControlHostFile(filePath), null);
  });
});

test("requireControlPlaneHost: falls back to the file when A11Y_CONTROL_HOST is unset", () => {
  withHostEnv((filePath) => {
    delete process.env.A11Y_CONTROL_HOST;
    process.env.A11Y_CONTROL_HOST_FILE = filePath;
    writeFileSync(filePath, "from-file.example.test");
    assert.equal(requireControlPlaneHost(), "from-file.example.test");
  });
});

test("requireControlPlaneHost: the env var WINS over the file when both are set -- #285's own precedence rule", () => {
  withHostEnv((filePath) => {
    process.env.A11Y_CONTROL_HOST = "from-env.example.test";
    process.env.A11Y_CONTROL_HOST_FILE = filePath;
    writeFileSync(filePath, "from-file.example.test");
    assert.equal(requireControlPlaneHost(), "from-env.example.test");
  });
});

test("MUTATION target: still REFUSES when neither the env var nor the file exists -- the property #83 bought", () => {
  withHostEnv((filePath) => {
    delete process.env.A11Y_CONTROL_HOST;
    process.env.A11Y_CONTROL_HOST_FILE = filePath; // never written -- absent, exactly like the issue's own acceptance
    assert.throws(() => requireControlPlaneHost(), /A11Y_CONTROL_HOST is required/);
  });
});

test("requireControlPlaneHost's refusal names the installer, so the fix is one command away", () => {
  withHostEnv((filePath) => {
    delete process.env.A11Y_CONTROL_HOST;
    process.env.A11Y_CONTROL_HOST_FILE = filePath;
    assert.throws(() => requireControlPlaneHost(), /fleet:control-host-install/);
  });
});
