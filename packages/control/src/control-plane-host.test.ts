/**
 * #83: `fleet-playbook.mjs` and `lab-pipeline.mjs` both hardcoded a real, specific LAN address as
 * `process.env.A11Y_CONTROL_HOST || "<real address>"`, one file away from `packages/control/README.md`
 * saying outright that value must never be committed. `requireControlPlaneHost` is the fix: a required
 * value refused loudly when absent, never guessed at with something that happens to work on one machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { requireControlPlaneHost } from "./control-plane-host.mjs";

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
