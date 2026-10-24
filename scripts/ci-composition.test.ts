import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codeOf, workflowCode } from "./workflow-code.ts";

const ci = workflowCode("ci.yml");

test("the job the protection requires exists, named `gate`, and runs on the queue's branches too", () => {
  assert.match(ci, /^ {2}gate:$/m);
  assert.match(ci, /^ {2}pull_request:$/m);
  assert.match(ci, /^ {2}merge_group:$/m);
});

test("the core is laid at a full commit sha, never a branch", () => {
  const pin = /^ {2}CORE_REF: ([^\s]+)$/m.exec(ci);
  assert.ok(pin, "positive control: the pin is found");
  assert.match(pin[1], /^[0-9a-f]{40}$/);
  assert.match(ci, /ref: "\$\{\{ env\.CORE_REF \}\}"/, "the checkout uses the pin");
});

test("this repository's package replaces the core's own after the core's install and before anything checks it, as the files the core knows it by", () => {
  const install = /- run: pnpm install --frozen-lockfile\n\s+working-directory: core/.exec(ci)?.index ?? -1;
  const lay = ci.indexOf("rm -rf core/packages/control");
  assert.ok(install > 0, "positive control: the core's install step is found");
  assert.ok(lay > 0, "positive control: the laying step is found");
  // a11ign/a11ign#4516: the core's `prepare` (run by that install) lays the core's own control, so laying first would be replaced by it.
  assert.ok(install < lay, "laid after the install");
  assert.ok(lay < ci.indexOf("pnpm exec rstest run"), "laid before the tests");
  assert.match(ci, /pnpm exec eslint --no-ignore packages\/control/);
  assert.match(ci, /tsc --noEmit -p tsconfig\.control\.json/);
  assert.match(ci, /cp -R control\/src control\/ansible control\/layers\.json control\/deploy-pins\.json control\/pnpm-lock\.yaml control\/CLAUDE\.md control\/README\.md core\/packages\/control\//, "the package is the root's files, not a directory of it");
  assert.match(ci, /control\/package\.json > core\/packages\/control\/package\.json/, "the laid manifest is cut from the root's");
  assert.match(ci, /> core\/tsconfig\.control\.json/, "the laid typecheck config is written, not tracked: this repository holds one tsconfig");
  assert.doesNotMatch(ci, /control\/packages\/control/, "nothing reads a `packages/control` of THIS repository");
});

test("the layout check is a step of the job `gate` waits for (ADR 0043, Decision 7; a11ign/a11ign#4217)", () => {
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts["layout-check"], "layout-check", "positive control: the script is found");
  const step = ci.indexOf("run: pnpm run layout-check");
  assert.ok(step > ci.indexOf("  checks:"), "in the `checks` job");
  assert.ok(step < ci.indexOf("run: pnpm test"), "before the tests, so a layout failure reads red without waiting for them");
});

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

test("the tests run on rstest through @a11ign/toolchain's config, and no `tsx --test` is left (ADR 0043, a11ign/a11ign#3960)", () => {
  assert.match(manifest.scripts.test, /^rstest run --config scripts\/rstest\/rstest\.config\.ts$/, "positive control: the test script is found");
  assert.ok(manifest.devDependencies["@a11ign/toolchain"] && manifest.devDependencies["@rstest/core"], "both are devDependencies");
  assert.match(readFileSync(new URL("./rstest/rstest.config.ts", import.meta.url), "utf8"), /defineToolchainConfig\(/, "the config is a call into the toolchain");
  for (const [where, text] of [["package.json", JSON.stringify(manifest.scripts)], ["ci.yml", ci]] as const) assert.doesNotMatch(text, /tsx --test/, where);
});

test("`tsc --noEmit` is a step of the job the ruleset requires, and runs before this repository's tests", () => {
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit", "positive control: the script is found");
  const typecheck = ci.indexOf("run: pnpm run typecheck");
  assert.ok(typecheck > 0, "gate runs the typecheck");
  assert.ok(typecheck < ci.indexOf("run: pnpm test"), "typecheck first, so a type error reads red without waiting for the suite");
  assert.ok(ci.indexOf("  checks:") < typecheck, "in the `checks` job, which `gate` waits for");
});

test("`gate` waits for `changeset`, `checks`, `ansible` and `release-dry-run` and accepts success only, so a red or skipped need cannot read as a pass (a11ign/a11ign#4127, #4135, #4919, #5066)", () => {
  const gate = ci.slice(ci.indexOf("  gate:"));
  assert.ok(gate.startsWith("  gate:"), "positive control: the gate job is found");
  assert.match(gate, /needs: \[changeset, checks, ansible, release-dry-run\]/);
  assert.match(gate, /if: always\(\) && !cancelled\(\)/, "a skipped required check counts as passed, so gate must run when a need fails");
  for (const need of ["changeset", "checks", "ansible", "release-dry-run"]) assert.ok(gate.includes(`needs.${need}.result`), `${need}'s result is read`);
  assert.doesNotMatch(gate, /skipped/, "no skipped allowance");
});

test("a pull request touching the install dry-runs the release's version step, with the release's own toolchain and no way to write (a11ign/a11ign#5066, a11ign/agent-org#888)", () => {
  const job = /^ {2}release-dry-run:\n([\s\S]*?)\n\n/m.exec(ci)?.[1];
  assert.ok(job, "positive control: the release-dry-run job is found");
  assert.doesNotMatch(job, /^ {4}if:/m, "no job condition: `gate` accepts success only, so a skipped job would read red; the steps carry the condition instead");
  assert.match(job, /^ {4}permissions:\n {6}contents: read$/m, "read only, and nothing below pushes");
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /fetch-depth: 0/, "`changeset version` deepens a shallow clone and hangs on a --depth=1 one");
  assert.doesNotMatch(job, /--depth=1|git push|secrets\./);
  assert.match(job, /\^\(package\\\.json\|pnpm-lock\\\.yaml\|\\\.npmrc\)\$\|\^\\\.github\/workflows\//, "the four paths the row names");
  assert.match(job, /pnpm install --frozen-lockfile\n\s+pnpm exec changeset version\n\s+pnpm install --lockfile-only/, "the release's three commands, in order");
  const gated = job.split(/^ {6}- /m).filter((step) => /pnpm\/action-setup|setup-node|release's version step/.test(step));
  assert.equal(gated.length, 3, "positive control: the three steps that do the work are found");
  for (const step of gated) assert.match(step, /if: steps\.touched\.outputs\.touched == 'true'/);
});

test("the dry run uses the toolchain `release.yml` gives the shared workflow, so it is never a pass on a toolchain the release does not use (a11ign/a11ign#5066)", () => {
  const release = workflowCode("release.yml");
  const job = /^ {2}release-dry-run:\n([\s\S]*?)\n\n/m.exec(ci)?.[1] ?? "";
  assert.match(job, /pnpm\/action-setup@v6\n\s+if: [^\n]+\n(?! {8}with:)/, "no `version`: pnpm comes from `packageManager`");
  assert.doesNotMatch(release, /^ {6}(pnpm-version|changesets-version|node-version):/m,
    "release.yml sets none of the three, so the shared workflow's defaults apply and the job repeats them; if it sets one, the job must follow it");
  assert.match(job, /node-version: 22$/m, "the shared workflow's default");
  assert.match(job, /CHANGESETS_VERSION: 3\.0\.3$/m, "the shared workflow's default `changesets-version`");
  assert.match(readFileSync(new URL("../package.json", import.meta.url), "utf8"), /"packageManager": "pnpm@/);
});

test("the changeset check is the shared workflow at a full sha, with this repository's releasable paths and the permission it needs (a11ign/a11ign#4127, #4135)", () => {
  const call = /^ {2}changeset:\n([\s\S]*?)\n\n/m.exec(ci)?.[1];
  assert.ok(call, "positive control: the changeset job is found");
  assert.match(call, /uses: a11ign\/toolchain\/\.github\/workflows\/changeset-required\.yml@[0-9a-f]{40}$/m);
  assert.match(call, /releasable-paths: src\/ ansible\/ layers\.json deploy-pins\.json$/m, "this repository's releasable paths, `deploy-pins.json` among them: a pin move is a change to that file alone and lands on a host only through a release (ceo, control#69); the core's dora entry follows in the row after a11ign/a11ign#4217");
  assert.match(call, /pull-requests: read/, "without it the whole run is a startup_failure");
  assert.match(ci, /^ {4}types: \[opened, synchronize, reopened, edited\]$/m, "`edited`: the no-release line is added by editing the body");
});

test("the playbooks are checked in this repository's own CI, on every pull request, and a mistyped `hosts:` is not skipped (a11ign/a11ign#4919, #4425)", () => {
  const job = /^ {2}ansible:\n([\s\S]*?)\n\n/m.exec(ci)?.[1];
  assert.ok(job, "positive control: the ansible job is found");
  assert.doesNotMatch(job, /^ {4}if:/m, "no condition: `gate` accepts success only, so a job a path filter skipped would read red");
  const useAction = job.indexOf("uses: ./.github/actions/ansible-collections");
  assert.ok(useAction > 0, "the job installs its collections through the composite action, which holds the cache and refuses Galaxy");
  assert.ok(useAction < job.indexOf("ansible-playbook"), "installed before the first playbook is parsed");
  assert.doesNotMatch(job, /ansible-galaxy collection install/, "no second copy of the install in the job: the action holds the only one");
  assert.match(job, /ansible-playbook -i ansible\/inventory\.example\.yml --syntax-check/);
  assert.match(job, /working-directory: ansible\n\s+run: python3 check-modules\.py/, "check-modules.py globs from its own directory");
  assert.doesNotMatch(job, /lay-layer|packages\/control/, "it reads this repository's root and needs no core");
  assert.match(job, /case "\$playbook" in ansible\/inventory\.example\.yml\|ansible\/requirements\.yml\) continue ;; esac/, "the files that are not playbooks are named");
  assert.doesNotMatch(job, /grep -q "[^"]*hosts:/, "a content filter on `hosts:` skips a playbook whose `hosts:` is mistyped");
});

const collectionsAction = codeOf(readFileSync(new URL("../.github/actions/ansible-collections/action.yml", import.meta.url), "utf8"));

test("the collections are cached on requirements.yml's hash alone, installed only on a miss, and Galaxy is unreachable from the install (A11-210)", () => {
  assert.match(collectionsAction, /^ {2}using: composite$/m, "positive control: the composite action is found");
  assert.match(collectionsAction, /uses: actions\/cache@v6\n\s+id: collections-cache\n\s+with:\n\s+path: ~\/\.ansible\/collections$/m, "the cache holds the install path");
  assert.match(collectionsAction, /key: ansible-collections-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('ansible\/requirements\.yml'\) \}\}$/m, "keyed on requirements.yml");
  assert.doesNotMatch(collectionsAction, /restore-keys/, "a partial match would restore a different pinned set and the install would be skipped over it");
  assert.match(collectionsAction, /ansible collections cache: \$\{\{ steps\.collections-cache\.outputs\.cache-hit == 'true' && 'HIT' \|\| 'MISS' \}\}/, "HIT or MISS is printed, so the run log can be quoted");
  const install = /- name: Install the collections these playbooks import\n([\s\S]*?)(?=\n {4}- name: |$)/.exec(collectionsAction)?.[1];
  assert.ok(install, "positive control: the install step is found");
  assert.match(install, /if: steps\.collections-cache\.outputs\.cache-hit != 'true'/, "skipped on a hit: a run with an unchanged file installs nothing");
  assert.match(install, /run: ansible-galaxy collection install -r ansible\/requirements\.yml -p ~\/\.ansible\/collections$/m);
  assert.match(install, /ANSIBLE_GALAXY_SERVER: http:\/\/127\.0\.0\.1:\d+\/$/m, "Galaxy is unreachable from the install by design: a dependency that would come from it fails the pull request that adds it");
  assert.match(collectionsAction, /ansible-galaxy collection list -p ~\/\.ansible\/collections/, "what is installed is listed, on a hit and on a miss");
});

test("`main` saves the cache pull requests restore, with the same action, on a push to main, daily and on demand (A11-210)", () => {
  const cache = workflowCode("ansible-collections-cache.yml");
  assert.match(cache, /^ {2}push:\n {4}branches: \[main\]$/m, "positive control: it runs on a push to main");
  assert.match(cache, /^ {6}- ansible\/requirements\.yml$/m);
  assert.match(cache, /^ {6}- \.github\/actions\/ansible-collections\/\*\*$/m);
  assert.match(cache, /^ {2}schedule:\n {4}- cron: /m, "a restore each day keeps the cache from the 7-day eviction");
  assert.match(cache, /^ {2}workflow_dispatch:$/m);
  assert.match(cache, /^ {2}contents: read$/m);
  assert.match(cache, /- uses: \.\/\.github\/actions\/ansible-collections$/m, "the same action as ci.yml, so the same key");
  assert.doesNotMatch(cache, /ansible-galaxy collection install/, "the action holds the only install");
  assert.ok(cache.indexOf("pip install ansible-core") < cache.indexOf("uses: ./.github/actions/ansible-collections"), "ansible-core is installed before the action runs");
});
