/**
 * EVERY git invocation this repo makes ON A GUEST must disable repository hooks.
 *
 * ## The incident
 *
 * Measured 2026-09-07, on a fleet deploy that had been green ninety minutes earlier. `a11y-worker-2`
 * failed at "Fetch and fast-forward the guest checkout":
 *
 *     Updated 2 paths from the index
 *     /usr/bin/env: 'bash': No such file or directory
 *     git checkout failed with 127
 *
 * `post-checkout` is `#!/usr/bin/env bash` and these guests have no bash, so `git checkout` there exits
 * 127 and takes the deploy with it. Nine boxes survived the same play. That is not luck about the code --
 * it is a fuse burning at a rate nobody could see: `prepare` runs `install-git-hooks.mjs`, so a guest's
 * own `npm install` -- a STEP OF THE DEPLOY -- sets `core.hooksPath` on that guest and arms the failure
 * for its NEXT deploy. Worker-2 had completed a full deploy at the commit that added the hook; the other
 * nine had reached the fetch and stopped when it failed. Every box gets there eventually, one deploy
 * apart, so "nine of ten passed" was the shape of a fleet-wide breakage caught one box in.
 *
 * ## Why this is a call-site rule and not a configuration one
 *
 * The tempting fix is to stop `install-git-hooks.mjs` running on a guest. That is a STATE, and it can
 * drift: an `npm install` run by hand, a box provisioned from an older path, a future `prepare` step, and
 * the guest is armed again with nothing reporting it. Disabling hooks at the call site is unconditional
 * and needs nothing to be true about the machine.
 *
 * It is also the more honest statement of the fact. Every git operation on a guest is performed BY a
 * playbook, against a checkout nobody authors in: a worker is an appliance. A `pre-commit` guard against
 * sweeping up a colleague's work, and a `pre-push` gate that runs the unit suite, have no work to do
 * there. They can only fail.
 *
 * ## Why a non-existent path and not an empty one
 *
 * Git resolves an EMPTY `core.hooksPath` relative to the working directory, so `post-checkout` would
 * still be found in a checkout root that contains one -- which is exactly the case here, because the
 * hooks are tracked files in the repository being checked out. A path that does not exist makes every
 * hook unfindable, which is what "no hooks" has to mean.
 *
 * ## Why it discovers rather than lists
 *
 * A remedy applied at some call sites and not all is this repo's most expensive recurring shape, and
 * CLAUDE.md's own remedy is to make the copies unable to disagree. `deploy.yml` is the only playbook
 * that runs `git checkout`, so a test naming it would pass today and say nothing when `provision.yml`
 * grows a checkout, or when a `post-merge` hook is added and breaks the two `git merge` calls that are
 * safe only because no such hook is shipped yet. This fails until a new guest-side git call carries the
 * flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ANSIBLE = fileURLToPath(new URL("../ansible/", import.meta.url));

/** The flag every guest-side git call must carry, verbatim. */
export const NO_HOOKS = "-c core.hooksPath=";

/**
 * A git invocation inside a Windows shell block: `git <subcommand>` or `& git <subcommand>`, where what
 * follows is not already the flag. Deliberately not "the line contains git" -- `$dirty = git status ...`
 * and `Run "checkout" checkout -- .` are both real invocations and neither starts the line with `git`.
 *
 * Two details, both found by the shape test below rather than by reading:
 *
 * - `rest` is `\S`, not `[-\w]`. `& git @args` is deploy.yml's `Run` helper -- the single call site every
 *   fetch, checkout and merge in that playbook goes through -- and `@` is neither a dash nor a word
 *   character, so the narrower class MISSED the most important invocation in the repository while
 *   reporting the two least important ones. A discovery test that cannot see the shared helper is the
 *   `examinedNothing` defect with a green tick.
 * - the lookbehind excludes a preceding quote. `throw "git $what failed with $LASTEXITCODE"` is a message
 *   ABOUT a git call, not one, and a real invocation is never written with a quote against its `g`.
 */
const GIT_CALL = /(?<![\w./\-"'])&?\s*\bgit\s+(?!-c\s+core\.hooksPath=)(?<rest>\S[^\n]*)/g;

/**
 * Every `.yml` under `ansible/`, read once. Includes `tasks/` and `roles/`, because a task file included
 * into a guest-targeting play runs on the guest exactly as an inline task does.
 *
 */
function playbooks(dir: string = ANSIBLE): { name: string, text: string }[] {
  const found: { name: string, text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) found.push(...playbooks(`${path}/`));
    else if (entry.name.endsWith(".yml")) found.push({ name: path.slice(ANSIBLE.length), text: readFileSync(path, "utf8") });
  }
  return found;
}

/**
 * The `ansible.windows.win_shell` blocks in one playbook -- the only module here that runs a command ON
 * A GUEST. `ansible.builtin.shell` and `command` run on the control plane or the lab, which are Linux
 * boxes with bash and with hooks that are meant to run; this rule is about Windows appliances only.
 *
 * A block ends at the next line indented no further than the module key itself, which is how a YAML
 * block scalar ends.
 *
 */
export function windowsShellBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const opener = /^(?<indent>\s*)ansible\.windows\.win_shell:\s*\|/.exec(lines[i]);
    if (!opener) continue;
    const indent = (opener.groups?.indent ?? "").length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() && (line.length - line.trimStart().length) <= indent) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

/**
 * Comment lines are stripped before matching. Both `#` (YAML/PowerShell) comments in these blocks TALK
 * about git commands -- this file's own patch notes quote `git checkout` -- and a test that fails on
 * prose describing the rule is a test nobody keeps.
 *
 * Returns the offending invocations, without the flag.
 */
export function gitCallsMissingNoHooks(block: string): string[] {
  const code = block.split("\n").filter((line: string) => !/^\s*#/.test(line)).join("\n");
  return [...code.matchAll(GIT_CALL)].map((m) => `git ${(m.groups?.rest ?? "").trim()}`);
}

test("every git call in a Windows guest shell disables repository hooks -- DISCOVERED, not listed", () => {
  const offenders: string[] = [];
  let examined = 0;
  for (const { name, text } of playbooks()) {
    for (const block of windowsShellBlocks(text)) {
      for (const call of gitCallsMissingNoHooks(block)) {
        examined += 1;
        offenders.push(`${name}: ${call}`);
      }
      examined += (block.match(/git\s+-c\s+core\.hooksPath=/g) ?? []).length;
    }
  }

  // A guard that examined nothing reports the same green as a guard that passed. There are eight such
  // calls across three playbooks today; the floor is what makes a regex that stops matching visible.
  assert.ok(examined >= 8,
    `this test found only ${examined} guest-side git call(s) -- it is meant to see at least 8, so the `
    + "discovery is broken rather than the playbooks being clean");

  assert.deepEqual(offenders, [],
    "these run git ON A GUEST without `-c core.hooksPath=`, so a repository hook the guest cannot "
    + "execute will fail the command -- `post-checkout` is `#!/usr/bin/env bash` and a worker has no "
    + `bash:\n  ${offenders.join("\n  ")}`);
});

test("the rule is about WINDOWS shells only -- a Linux control-plane git call is not caught", () => {
  // The control plane and the lab are Linux boxes whose hooks are meant to run. If this ever starts
  // matching `ansible.builtin.shell`, the rule has widened past the fact it encodes and would demand the
  // flag where the hooks are the point.
  const linux = [
    "    - name: something",
    "      ansible.builtin.shell: |",
    "        git fetch --quiet origin",
    "      args:",
    "        chdir: /opt/a11y",
  ].join("\n");
  assert.deepEqual(windowsShellBlocks(linux), []);
});

test("it catches the real shapes -- a bare call, an assignment, and a PowerShell call operator", () => {
  const block = [
    "        $ErrorActionPreference = \"Stop\"",
    "        # git checkout is mentioned in prose here and must not count",
    "        function Run($what) { & git @args }",
    "        $dirty = git status --porcelain",
    "        git rev-parse HEAD",
  ].join("\n");
  assert.deepEqual(gitCallsMissingNoHooks(block), [
    "git @args }",
    "git status --porcelain",
    "git rev-parse HEAD",
  ]);
});

test("a call that already carries the flag is not reported", () => {
  assert.deepEqual(gitCallsMissingNoHooks("        git -c core.hooksPath=a11y-no-hooks fetch --quiet origin"), []);
});
