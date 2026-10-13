/**
 * THE PLAYBOOK RUN, NOT ITS TEXT (a11ign#5306; the verdict on control#91).
 *
 * `control-host-install-checkout.test.ts` reads what the playbook says. This runs it under `ansible-playbook`
 * against localhost, with every boundary that reaches outside the plane replaced:
 *
 *   - control's repository is a local fixture on branch `main`, not GitHub
 *   - corepack is a recording stub, so no real pnpm is installed here; the stub logs the argv it was given
 *     and the directory it was run from
 *   - the host value, the checkout and the loader all live in a temporary directory
 *
 * What the stub logs is what the playbook asked corepack to do, in the order it asked, from the directory it asked.
 * The valid-pin run is the positive control for the refusal runs: it proves the stub is reached at all.
 *
 * Honest skip: without `ansible-playbook`, or without `/usr/bin/node` (the loader probe names that path), this file
 * does not pass and does not fail; it skips with the reason named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./git-safe-env.ts";

const PLAYBOOK = fileURLToPath(new URL("../ansible/control-host-install.yml", import.meta.url));
const HOST_VALUE = "203.0.113.7";
const PIN = "pnpm@10.34.5";

const HAS_ANSIBLE = spawnSync("ansible-playbook", ["--version"]).status === 0;
const HAS_PLANE_NODE = existsSync("/usr/bin/node");
const NO_ANSIBLE = "ansible-playbook is not on PATH -- an honest skip, not a pass. The text tests still ran.";
const NO_PLANE_NODE = "/usr/bin/node is absent -- the loader probe cannot run here, an honest skip, not a pass.";
const skip = !HAS_ANSIBLE ? NO_ANSIBLE : !HAS_PLANE_NODE ? NO_PLANE_NODE : undefined;

/** A corepack stand-in: appends "<cwd>\t<argv>" to the log. `pwd -P` because ansible sets the directory with chdir, not PWD. */
function corepackStub(logPath: string): string {
  return ["#!/bin/sh", `printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> '${logPath}'`, "exit 0", ""].join("\n");
}

/** A git repository on branch `main` holding control's two files the playbook reads. `packageManager` omitted when undefined. */
function fixtureRepo(dir: string, packageManager: string | undefined): string {
  const repo = join(dir, "control-fixture");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "@a11ign/control", packageManager }, null, 2)}\n`);
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const git = (...args: string[]) => {
    const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: sandboxGitEnv() });
    assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  return repo;
}

type LogLine = { cwd: string; argv: string };

function readLog(logPath: string): LogLine[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [cwd, argv] = line.split("\t");
      return { cwd, argv };
    });
}

/** Runs the real playbook once, with the outside-world boundaries pointed at temporary stand-ins. */
function runPlaybook(packageManager: string | undefined) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "control-host-run-")));
  const repo = fixtureRepo(dir, packageManager);
  const corepack = join(dir, "corepack");
  const logPath = join(dir, "corepack.log");
  writeFileSync(corepack, corepackStub(logPath), { mode: 0o755 });
  const loader = join(dir, "loader.mjs");
  writeFileSync(loader, "");
  const checkout = join(dir, "checkout");
  const hostFile = join(dir, "etc-a11ign", "control-host");
  const varsPath = join(dir, "vars.json");
  writeFileSync(varsPath, JSON.stringify({
    a11y_control_host: HOST_VALUE,
    control_host_destination: hostFile,
    control_repo_url: repo,
    control_checkout: checkout,
    control_corepack: corepack,
    control_tsx_loader: loader,
  }));
  const run = spawnSync("ansible-playbook", ["-i", "localhost,", "-e", `@${varsPath}`, PLAYBOOK], {
    cwd: dir,
    encoding: "utf8",
    // The playbook's own `git` module runs under this env too, so the scrub covers the clone as well as the fixture.
    env: sandboxGitEnv({ ANSIBLE_LOCALHOST_WARNING: "False" }),
  });
  return {
    status: run.status,
    output: `${run.stdout}\n${run.stderr}`,
    checkout,
    hostFile,
    log: readLog(logPath),
  };
}

test("a control that pins an exact pnpm: the playbook runs to the end, and corepack is asked for the three things, in order", { skip }, () => {
  const run = runPlaybook(PIN);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.log.map((line) => line.argv), [
    "enable",
    `prepare ${PIN} --activate`,
    "pnpm install --frozen-lockfile --ignore-scripts --prod",
  ], run.output);
});

test("the install runs from control's checkout, and the checkout is control's own files at origin/main", { skip }, () => {
  const run = runPlaybook(PIN);
  assert.equal(run.status, 0, run.output);
  const install = run.log.find((line) => line.argv.startsWith("pnpm install"));
  assert.ok(install, "corepack was asked to install");
  assert.equal(install.cwd, run.checkout);
  assert.equal(readFileSync(join(run.checkout, "package.json"), "utf8").includes(PIN), true);
  assert.equal(readFileSync(join(run.checkout, "pnpm-lock.yaml"), "utf8"), "lockfileVersion: '9.0'\n");
});

test("the host value is written and reads back exactly, in the same run", { skip }, () => {
  const run = runPlaybook(PIN);
  assert.equal(run.status, 0, run.output);
  assert.equal(readFileSync(run.hostFile, "utf8"), HOST_VALUE);
});

test("a manifest that pins no exact pnpm is refused: the assert fails and corepack is never asked for anything", { skip }, () => {
  const run = runPlaybook("pnpm@latest");
  assert.notEqual(run.status, 0, "the playbook must fail");
  assert.match(run.output, /not an exact pnpm version/);
  assert.deepEqual(run.log, [], run.output);
});

test("a manifest with no packageManager at all is refused the same way", { skip }, () => {
  const run = runPlaybook(undefined);
  assert.notEqual(run.status, 0, "the playbook must fail");
  assert.match(run.output, /not an exact pnpm version/);
  assert.deepEqual(run.log, [], run.output);
});
