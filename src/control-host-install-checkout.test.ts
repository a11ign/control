/**
 * THE PLAYBOOK THAT LAYS THE CONTROL PLANE'S HOST VALUE ALSO LAYS ITS CHECKOUT AND ITS PINNED PNPM (a11ign#5306).
 *
 * A rebuilt plane had no `/root/control` and no `pnpm`, so every unit that names the checkout had no working directory.
 * The first half reads the playbook's task list back, because the text alone cannot say what the tasks do:
 *
 *   - the checkout is control's own repository, at `/root/control`
 *   - the pnpm comes from control's `packageManager` field and must be an exact version, never `latest`
 *   - the install is the lockfile's own: `--frozen-lockfile` and `--ignore-scripts` both in its argv, and no global npm
 *   - the order holds: after the host value is read back, before the loader assertion
 *
 * The loader task is the positive control. If it is not found, the order check would pass against nothing.
 *
 * The second half RUNS the playbook under `ansible-playbook` against localhost, with every boundary that reaches
 * outside the plane replaced: control's repository is a local fixture on branch `main`, not GitHub; corepack is a
 * recording stub, so the argv the playbook asks for and the directory it asks from are what the stub logs; the host
 * value, the checkout and the loader live in a temporary directory. The valid-pin run is the positive control for the
 * refusal runs: it proves the stub is reached at all.
 *
 * Honest skip: without `ansible-playbook`, or without `/usr/bin/node` (the loader probe names that path), the execution
 * tests skip with the reason named. They do not pass and they do not fail. The text tests always run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./git-safe-env.ts";

const PLAYBOOK = readFileSync(new URL("../ansible/control-host-install.yml", import.meta.url), "utf8");
/** A top-level variable of the play, by name. */
const varValue = (name: string) => new RegExp(`^    ${name}: (\\S+)$`, "m").exec(PLAYBOOK)?.[1];

/** The task list, one entry per task: a task opens with a four-space `- name:`. */
const TASKS = PLAYBOOK.split(/^(?= {4}- name: )/m).slice(1).map((body) => ({
  name: /^ {4}- name: (.*)$/m.exec(body)?.[1] ?? "",
  body,
}));

/** The one task whose name contains `fragment`: a missing or doubled task is a failure, not a silent pass. */
function find(fragment: string) {
  const found = TASKS.filter((task) => task.name.includes(fragment));
  assert.equal(found.length, 1, `exactly one task is named with "${fragment}"`);
  return found[0];
}

/** The tokens of a task's `argv:` flow list. */
function argvTokens(body: string): string[] {
  const list = /argv: \[([^\]]*)\]/.exec(body)?.[1];
  assert.ok(list, "the task has an argv list");
  return list.split(",").map((token) => token.trim().replace(/^"|"$/g, ""));
}

test("positive control: the loader task is read from the list (the rest of the order check is vacuous without it)", () => {
  assert.equal(find("must resolve").name.includes("TypeScript"), true);
  assert.ok(TASKS.length >= 10, `the task list is read whole (${TASKS.length} tasks)`);
});

test("the checkout is control's own repository, laid at /root/control", () => {
  assert.equal(varValue("control_repo_url"), "https://github.com/a11ign/control.git");
  assert.equal(varValue("control_checkout"), "/root/control");
  const checkout = find("Control's own checkout");
  assert.match(checkout.body, /ansible\.builtin\.git:/);
  assert.match(checkout.body, /repo: "\{\{ control_repo_url \}\}"/);
  assert.match(checkout.body, /dest: "\{\{ control_checkout \}\}"/);
});

test("the pnpm comes from control's packageManager field, and that field must be an exact version", () => {
  const read = find("Read the pnpm version");
  assert.match(read.body, /path: "\{\{ control_checkout \}\}\/package\.json"/);
  assert.match(find("The pin must be one exact pnpm version").body, /packageManager/);
  assert.ok(find("Refuse a manifest").body.includes("'^pnpm@[0-9]+[.][0-9]+[.][0-9]+$'"), "the refusal names an exact-version regex");
  const activate = argvTokens(find("Activate that pnpm").body);
  assert.deepEqual(activate.slice(0, 2), ["{{ control_corepack }}", "prepare"]);
  assert.equal(activate[2], "{{ control_pnpm_pin }}");
  assert.equal(activate[3], "--activate");
  assert.doesNotMatch(PLAYBOOK, /pnpm@latest/);
});

test("the install is the lockfile's own: --frozen-lockfile and --ignore-scripts in its argv, run in the checkout", () => {
  const install = find("Install control's production dependencies");
  const tokens = argvTokens(install.body);
  assert.deepEqual(tokens.slice(0, 3), ["{{ control_corepack }}", "pnpm", "install"]);
  assert.ok(tokens.includes("--frozen-lockfile"), "the lockfile decides");
  assert.ok(tokens.includes("--ignore-scripts"), "no install script runs");
  assert.match(install.body, /chdir: "\{\{ control_checkout \}\}"/);
});

test("no global npm install appears anywhere in the playbook", () => {
  const offending = PLAYBOOK.split("\n").filter((line) => /\bnpm\b/.test(line) && /(?:^|\s)(?:-g|--global)\b/.test(line));
  assert.deepEqual(offending, []);
});

test("the checkout and install come after the host value is read back, and before the loader assertion", () => {
  const order = [
    find("It must read back exactly"),
    find("Control's own checkout"),
    find("Install control's production dependencies"),
    find("must resolve"),
  ].map((task) => TASKS.indexOf(task));
  assert.ok(order.every((index, i) => i === 0 || index > order[i - 1]), `task order by index: ${order.join(", ")}`);
});

/** The playbook's path, for the run. `PLAYBOOK` above is its text. */
const PLAYBOOK_PATH = fileURLToPath(new URL("../ansible/control-host-install.yml", import.meta.url));
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
  const run = spawnSync("ansible-playbook", ["-i", "localhost,", "-e", `@${varsPath}`, PLAYBOOK_PATH], {
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
