/**
 * THE LAB'S FORCED COMMAND (A11-263, ADR `0004-the-lab-submits-fleet-jobs-through-a-forced-command-key`): the one request it runs, the requests it refuses, and the play that
 * installs the key it guards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { controlPlaneTransport } from "./cli.ts";
import { GATE_REFUSED, gate, gateCommand } from "./gate.ts";
import type { Gated } from "./gate.ts";
import { CONTROL_TSX_LOADER, SERVICE_CHECKOUT } from "./paths.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

/** The command a real `cli.ts` call puts on the ssh line: its transport, with the plane's address and key supplied and this machine not the plane. */
function sentFor(remoteArgs: string[]): string {
  const env = process.env;
  const saved = { host: env.A11Y_CONTROL_HOST, key: env.A11Y_PVE_KEY };
  env.A11Y_CONTROL_HOST = "203.0.113.9";
  env.A11Y_PVE_KEY = "/nonexistent/key";
  try {
    const { file, args } = controlPlaneTransport(remoteArgs);
    assert.equal(file, "ssh", "a machine that is not the control plane reaches it over ssh");
    return args.at(-1)!;
  } finally {
    if (saved.host === undefined) delete env.A11Y_CONTROL_HOST; else env.A11Y_CONTROL_HOST = saved.host;
    if (saved.key === undefined) delete env.A11Y_PVE_KEY; else env.A11Y_PVE_KEY = saved.key;
  }
}

const accepted = (original: string | undefined): { file: string; args: string[]; cwd: string } => {
  const gated: Gated = gateCommand(original);
  assert.ok(!("refusal" in gated), "refusal" in gated ? gated.refusal : "");
  return gated as { file: string; args: string[]; cwd: string };
};
const refusal = (original: string | undefined): string => {
  const gated = gateCommand(original);
  assert.ok("refusal" in gated, `accepted ${JSON.stringify(original)}`);
  return (gated as { refusal: string }).refusal;
};

const REMOTE = ["--import", CONTROL_TSX_LOADER, "src/fleet-jobs/remote.ts"];
const PREFIX = `cd ${SERVICE_CHECKOUT} && /usr/bin/node --import ${CONTROL_TSX_LOADER} src/fleet-jobs/remote.ts`;

test("the request the fleet command sends runs remote.ts from the service's checkout with the arguments it was given: a submit, a tar, a list with options", () => {
  const submit = accepted(sentFor(["submit"]));
  assert.deepEqual(submit, { file: "/usr/bin/node", args: [...REMOTE, "submit"], cwd: SERVICE_CHECKOUT });
  assert.deepEqual(accepted(sentFor(["tar", "fj-20261025T140000-ab12cd"])).args, [...REMOTE, "tar", "fj-20261025T140000-ab12cd"]);
  assert.deepEqual(accepted(sentFor(["list", "--label", "A11-263", "--state", "done", "--limit", "5"])).args,
    [...REMOTE, "list", "--label", "A11-263", "--state", "done", "--limit", "5"]);
  assert.deepEqual(accepted(sentFor(["lease-list"])).args, [...REMOTE, "lease-list"]);
  assert.deepEqual(accepted(sentFor(["recapture"])).args, [...REMOTE, "recapture"]);
});

test("a quote inside an argument comes through as that one argument, and shell words in one stay words", () => {
  for (const argument of ["it's", "'", "a'b'c", "''", "x; rm -rf /", "$(id)", "`id`", "a && b", "two words", "", "line\nbreak", "\\"]) {
    assert.deepEqual(accepted(sentFor(["status", argument])).args.slice(-2), ["status", argument], JSON.stringify(argument));
  }
  assert.deepEqual(accepted(sentFor(["list", "--label", "it's", "--state", "done"])).args.slice(3), ["list", "--label", "it's", "--state", "done"], "arguments keep their count");
});

test("a request with no arguments is the form too: remote.ts answers its own usage", () => {
  assert.deepEqual(accepted(PREFIX).args, REMOTE);
});

test("each of these is refused, with the command it was given and exit 2: a second command, another path, another loader, an unquoted argument, a double-quoted one, an empty command, none", () => {
  const sent = sentFor(["submit"]);
  const cases: [string, string | undefined][] = [
    ["`;` after the program", `${sent}; id`],
    ["`;` inside the program's tail", `${PREFIX}; id`],
    ["`&&` after the arguments", `${sent} && id`],
    ["`&&` after a quoted argument", `${PREFIX} 'status' && id`],
    ["a pipe", `${PREFIX} 'status' | sh`],
    ["a redirect", `${PREFIX} 'status' > /root/.ssh/authorized_keys`],
    ["a command substitution outside quotes", `${PREFIX} $(id)`],
    ["another path", `cd ${SERVICE_CHECKOUT} && /usr/bin/node --import ${CONTROL_TSX_LOADER} src/fleet-jobs/cli.ts 'status'`],
    ["another checkout", `cd /root/control && /usr/bin/node --import ${CONTROL_TSX_LOADER} src/fleet-jobs/remote.ts 'status'`],
    ["another loader", `cd ${SERVICE_CHECKOUT} && /usr/bin/node --import /tmp/evil.mjs src/fleet-jobs/remote.ts 'status'`],
    ["another program", `cd ${SERVICE_CHECKOUT} && /bin/sh --import ${CONTROL_TSX_LOADER} src/fleet-jobs/remote.ts 'status'`],
    ["a path that only starts like the remote half", `${PREFIX}.evil 'status'`],
    ["an unquoted argument", `${PREFIX} status`],
    ["a double-quoted argument", `${PREFIX} "status"`],
    ["a quote that is never closed", `${PREFIX} 'status`],
    ["text glued to a quote", `${PREFIX} 'status'x`],
    ["no space before the arguments", `${PREFIX}'status'`],
    ["a shell, asked for with no command at all", "/bin/sh"],
    ["a shell command", "id"],
    ["a file copy request", "scp -t /root/.ssh/authorized_keys"],
    ["an sftp request", "internal-sftp"],
    ["an empty command", ""],
    ["no command (an interactive login)", undefined],
  ];
  for (const [what, original] of cases) {
    const why = refusal(original);
    assert.match(why, /^refused: this key runs only the fleet job service's remote half/, what);
    assert.ok(why.includes(JSON.stringify(original ?? "")), `${what}: the refusal names the command it was given`);
    const errs: string[] = [];
    const ran: string[] = [];
    assert.equal(gate(original, { err: (text) => errs.push(text), run: (file) => { ran.push(file); return 0; } }), GATE_REFUSED, what);
    assert.deepEqual(ran, [], `${what}: nothing ran`);
    assert.equal(errs.join(""), `${why}\n`, `${what}: the refusal is on stderr`);
  }
});

test("an accepted request runs the program and answers the exit code it ended with, so remote.ts's refusals (2, 4, 5, 6) reach the lab", () => {
  for (const code of [0, 2, 4, 5, 6]) {
    const seen: unknown[] = [];
    const ended = gate(sentFor(["status", "fj-x"]), { run: (file, args, cwd) => { seen.push([file, args, cwd]); return code; } });
    assert.equal(ended, code);
    assert.deepEqual(seen, [["/usr/bin/node", [...REMOTE, "status", "fj-x"], SERVICE_CHECKOUT]]);
  }
});

test("the checkout and the loader are the plane's own unless a test hands others in, and then only those are the form", () => {
  const where = { checkout: "/tmp/service", loader: "/tmp/loader.mjs" };
  const original = "cd /tmp/service && /usr/bin/node --import /tmp/loader.mjs src/fleet-jobs/remote.ts 'status'";
  assert.deepEqual(gateCommand(original, where), { file: "/usr/bin/node", args: ["--import", "/tmp/loader.mjs", "src/fleet-jobs/remote.ts", "status"], cwd: "/tmp/service" });
  assert.ok("refusal" in gateCommand(original), "the plane's own form does not accept a test's paths");
});

test("run as the forced command, with a request it refuses, the program ends 2 and says so on stderr (a real process, as sshd starts it)", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/fleet-jobs/gate.ts"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8", env: { ...process.env, SSH_ORIGINAL_COMMAND: "cat /etc/shadow" } });
  assert.equal(run.status, GATE_REFUSED);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /refused: this key runs only the fleet job service's remote half.*"cat \/etc\/shadow"/);
  const none = spawnSync(process.execPath, ["--import", "tsx", "src/fleet-jobs/gate.ts"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "SSH_ORIGINAL_COMMAND")) });
  assert.equal(none.status, GATE_REFUSED, "a login with no command is refused too");
});

/** The playbook without its comment lines: the tasks, which the comments explain. */
const PLAY = read("ansible/fleet-jobs-lab-access.yml");
const TASKS = PLAY.replace(/^\s*#.*$/gm, "");

test("the lab-access play installs the key on the plane as restrict,command=<the gate through the plane's loader>, replacing any earlier line with its comment", () => {
  assert.match(TASKS, /restrict,command="\/usr\/bin\/node --import \{\{ control_tsx_loader \}\} \{\{ fleet_jobs_checkout \}\}\/src\/fleet-jobs\/gate\.ts" \{\{ lab_fleet_jobs_pub \}\} a11y-lab-fleet-jobs/);
  assert.match(TASKS, /control_tsx_loader: \/opt\/a11y-tsx\/node_modules\/tsx\/dist\/esm\/index\.mjs/);
  assert.equal(/control_tsx_loader:\s*(\S+)/.exec(TASKS)?.[1], CONTROL_TSX_LOADER, "the loader is the one the unit and the gate name");
  assert.match(TASKS, new RegExp(`fleet_jobs_checkout: ${SERVICE_CHECKOUT}\\b`), "the gate is run from the service's own checkout");
  assert.match(TASKS, /regexp: ' a11y-lab-fleet-jobs\$'/, "an earlier line with the comment is replaced, so a rotation leaves one key");
  assert.match(TASKS, /path: \/root\/\.ssh\/authorized_keys/);
});

test("the key is made on the lab and its private half never leaves it: ssh-keygen runs on a11y_lab, only the public half is read, and nothing fetches or copies the private file", () => {
  assert.match(TASKS, /hosts: a11y_lab/);
  assert.match(TASKS, /ssh-keygen, -t, ed25519/);
  assert.match(TASKS, /creates: \/root\/\.ssh\/a11y-fleet-jobs\b/);
  assert.match(TASKS, /\/root\/\.ssh\/a11y-fleet-jobs\.pub/);
  assert.ok(!/ansible\.builtin\.fetch|ansible\.builtin\.synchronize|\bscp\b|slurp:\s*\n\s*(src|path): \/root\/\.ssh\/a11y-fleet-jobs\n/.test(TASKS), "nothing copies the private file off the lab");
  const slurped = [...TASKS.matchAll(/ansible\.builtin\.slurp:\s*\n\s*src: (\S+)/g)].map((match) => match[1]).filter((src) => src!.startsWith("/root/.ssh/"));
  assert.deepEqual(slurped, ["/root/.ssh/a11y-fleet-jobs.pub"], "the one file read from the lab's .ssh is the public half");
  assert.ok(!/ansible\.builtin\.(shell|raw)\b/.test(TASKS), "no task runs a shell");
});

test("the lab's checkout of control is at the ref asked for, installed from its lockfile alone with no install script, and the wrapper sources fleet.env then runs the CLI", () => {
  assert.match(TASKS, /fleet_jobs_ref: main/);
  assert.match(TASKS, /fleet_cli_checkout: \/opt\/a11y-fleet-cli/);
  assert.match(TASKS, /dest: "\{\{ fleet_cli_checkout \}\}"/);
  assert.match(TASKS, /version: "\{\{ fleet_jobs_ref \}\}"/);
  assert.match(TASKS, /--frozen-lockfile, --ignore-scripts/);
  assert.match(TASKS, /dest: \/etc\/a11ign\/fleet\.env/);
  assert.match(TASKS, /A11Y_PVE_KEY=\/root\/\.ssh\/a11y-fleet-jobs/);
  assert.match(TASKS, /A11Y_CONTROL_HOST=\{\{ hostvars\[groups\['a11y_control'\]\[0\]\]\.ansible_host \}\}/);
  assert.match(TASKS, /dest: \/usr\/local\/bin\/fleet/);
  assert.match(TASKS, /set -a; \. \/etc\/a11ign\/fleet\.env; set \+a; exec \/usr\/bin\/node \/opt\/a11y-fleet-cli\/src\/fleet-jobs\/cli\.ts "\$@"/);
  const argvs = [...TASKS.matchAll(/^\s*argv: (.*)$/gm)].map((match) => match[1]!);
  assert.deepEqual(argvs.filter((argv) => /\bnpm\b|\bnpx\b|pnpm, (add|dlx|update)/.test(argv)), [], "nothing installs but the lockfile");
});

test("the play reads back from the lab: `fleet lease list --json` answers JSON, and the gate refuses `id` over the same key", () => {
  assert.match(TASKS, /argv: \[\/usr\/local\/bin\/fleet, lease, list, --json\]/);
  assert.match(TASKS, /from_json/);
  assert.match(TASKS, /-i, \/root\/\.ssh\/a11y-fleet-jobs/);
  assert.match(TASKS, /IdentitiesOnly=yes/);
  assert.match(TASKS, /lab_control_host: "\{\{ hostvars\[groups\['a11y_control'\]\[0\]\]\.ansible_host \}\}"/);
  assert.match(TASKS, /"root@\{\{ lab_control_host \}\}", id\]/);
  assert.match(TASKS, /refused: this key runs only the fleet job service/);
  assert.match(TASKS, /rc == GATE_REFUSED|gate_probe\.rc == 2/, "the refusal is the gate's exit 2, not any ssh failure");
});
