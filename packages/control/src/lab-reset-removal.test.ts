/**
 * `lab:reset`'s named-removal shell, driven against a REAL git repository.
 *
 * This is the one piece of this project's logic that no other check can reach. It is POSIX shell inside a
 * YAML block scalar inside a Jinja-templated playbook: lint does not see it, `tsc` does not see it, and
 * the playbook only runs against the lab. Its own comments record three bugs already found by running it
 * and none by reading it — a folded scalar that joined an `if/else` into three sequential statements, a
 * `split('\n')` that did not split, and a `when:` gated on an unrelated condition.
 *
 * Two more were found on 2026-09-01, and both are asserted here.
 *
 * FIRST: doing the work and then denying it. The task above this one removes untracked files that origin
 * already carries — which is precisely what an operator does to make a removal safe — so for a pushed
 * changeset the ordinary path is that this task finds nothing left. It called that "neither untracked nor
 * a tracked modification", failed the play, and printed "Nothing was changed" about a file it HAD removed.
 * A caller using this as a precondition concludes the lab is still blocked and takes the wrong next step.
 *
 * SECOND: `... | while` runs the loop in a subshell, so `rc=1` never escaped it and `exit $rc` was
 * unconditionally 0. Invisible in production because `failed_when: false` hands the verdict to an assert
 * that reads stdout — so the status was wrong and nothing consumed it. Dead code that reads as live is
 * this repo's most expensive shape; `refreshBrowseBuffer` was inert for every capture ever taken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = resolve(HERE, "../ansible/lab-reset.yml");

/** The shell exactly as Ansible will hand it to `/bin/sh` — parsed from the playbook, never retyped. */
function removalShell(): string {
  const doc = parse(readFileSync(PLAYBOOK, "utf8"));
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object") {
      const task = node as Record<string, unknown>;
      if (typeof task.name === "string" && task.name.startsWith("Remove a named untracked path")) {
        found.push((task["ansible.builtin.shell"] as { cmd: string }).cmd);
      }
      Object.values(task).forEach(walk);
    }
  };
  walk(doc);
  assert.equal(found.length, 1, "expected exactly one named-removal task in lab-reset.yml");
  return found[0];
}

/** A throwaway repo in the four states the shell must tell apart. */
function scenario(): { dir: string; dirty: string } {
  const dir = mkdtempSync(join(tmpdir(), "lab-reset-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "tracked.txt"), "modified\n");   // a TRACKED modification
  writeFileSync(join(dir, "untracked.txt"), "new\n");      // UNTRACKED, still present
  // `gone.txt` is deliberately NOT created: untracked in the pre-checkout porcelain, already deleted by
  // the origin-carries sweep. That is the state the first version got wrong.
  return { dir, dirty: " M tracked.txt\n?? untracked.txt\n?? gone.txt" };
}

function run(cmd: string, dir: string, dirty: string, path: string): { rc: number; out: string } {
  const script = join(dir, ".removal.sh");
  writeFileSync(script, cmd);
  try {
    const out = execFileSync("sh", [script], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, LAB_DIRTY_BEFORE: dirty, LAB_REMOVALS: path },
    });
    return { rc: 0, out: out.trim() };
  } catch (error) {
    const e = error as { status?: number; stdout?: unknown };
    return { rc: e.status ?? -1, out: String(e.stdout ?? "").trim() };
  }
}

test("each of the four states gets its own verdict, and only one of them refuses", () => {
  const cmd = removalShell();
  const { dir, dirty } = scenario();
  try {
    const untracked = run(cmd, dir, dirty, "untracked.txt");
    assert.match(untracked.out, /^removed untracked\.txt$/, "an untracked file is deleted");
    assert.equal(untracked.rc, 0);

    const tracked = run(cmd, dir, dirty, "tracked.txt");
    assert.match(tracked.out, /^restored tracked\.txt/, "a tracked modification was already discarded");
    assert.equal(tracked.rc, 0);

    // THE REGRESSION. Gone AND untracked-before means the sweep above took it: success, not refusal.
    const gone = run(cmd, dir, dirty, "gone.txt");
    assert.match(gone.out, /already removed gone\.txt/,
      "a file the origin-carries sweep already took must report success, not 'neither untracked nor tracked'");
    assert.equal(gone.rc, 0, "and it must not fail the play — the removal the operator asked for happened");

    const unknown = run(cmd, dir, dirty, "never-seen.txt");
    assert.match(unknown.out, /^REFUSED: never-seen\.txt/, "a path that was never dirty is still refused");
    assert.equal(unknown.rc, 1, "and the refusal must reach the exit status, not just stdout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loop does not run in a subshell, so a refusal reaches the exit status", () => {
  // Mutation, pinned: the pipe form is what shipped, and it makes `exit $rc` unconditionally 0 while
  // stdout still says REFUSED. Without this assertion a revert to it passes every other check here.
  const cmd = removalShell();
  assert.ok(!/\|\s*while IFS= read -r path/.test(cmd),
    "`... | while` puts the loop in a subshell and discards rc; feed it with a heredoc instead");
  assert.ok(/done <</.test(cmd), "the loop must be fed by a heredoc so rc survives");

  const { dir, dirty } = scenario();
  try {
    const mutated = cmd
      .replace("while IFS= read -r path; do", "printf '%s\\n' \"$LAB_REMOVALS\" | while IFS= read -r path; do")
      .replace(/done <<LAB_REMOVALS_EOF\n[\s\S]*?\nLAB_REMOVALS_EOF/, "done");
    assert.equal(run(mutated, dir, dirty, "never-seen.txt").rc, 0,
      "the mutation must reproduce the bug — if this is already 1, the assertion above proves nothing");
    assert.equal(run(cmd, dir, dirty, "never-seen.txt").rc, 1, "and the shipped form must fix it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
