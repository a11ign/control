// @ts-check
/**
 * The CALLER of `post-qualification-status.ts`: `lab:job -e job=gate-stability -e row=<n> --qualify-sha=<sha>`
 * says on `<sha>` what the fleet part of the release gate found (#3289, #3136 done-when 3, done-when 6).
 *
 * ## The sequence, and why each step is where it is
 *
 * 1. `pending` is posted IMMEDIATELY BEFORE `ansible-playbook` starts, not when the command line is read:
 *    every refusal in `lab-job.ts` (stale fleet, a worker that will not wake) happens before the dispatch,
 *    and a `pending` posted ahead of them would be left standing by a run that never began, which the release
 *    reads as "wait" until its own bound runs out.
 * 2. The verdict is posted when the dispatch returns, from the record the playbook already writes for the
 *    host (`run-job.yml`, "Tell the gate this job ended"). `ansible-playbook`'s own exit status is NOT the
 *    job's: a failed assert is 2 whatever the job exited with, which would read as INCONCLUSIVE. The job's
 *    exit is in the record, and the record names the commit the lab ran.
 * 3. ONE re-run on a first `failure` (#3136 outcome 2; `release-reads-qualification.mjs` reads
 *    failure, pending, then success as a pass and two failures as a regression). `success` on the re-run
 *    replaces the first `failure`; a second `failure` stays. Nothing is softened: the same argv, the same gate.
 *
 * ## What it refuses to say
 *
 * `success` needs ALL of: the dispatch exited 0, the record is this run's for this row, the commit the lab
 * ran starts with the sha being qualified, the record's exit is 0 and its outcome is `success`. Any one
 * missing is "no readable verdict", which `qualificationStatus` posts as `failure`, never as a pass.
 *
 * The lab is pinned to the sha by construction (`-e ref=<sha>` is added; the playbook resolves a 40-character
 * ref), so the commit check is a second line and not the first.
 *
 * ## The layers are pinned to the sha too, by ITS lockfile (#3920)
 *
 * A layer that lives in its own repository is part of what the sha claims, and `lab-layer-checkouts.yml` refuses a job whose
 * `layer_refs` does not name every one. They are read here, by the poster, from the sha's OWN `pnpm-lock.yaml`
 * (`git show <sha>:pnpm-lock.yaml`), the pin `scripts/lay-layer.mjs` lays from, so the release and the lab cannot name two builds.
 * Each pinned version becomes the tag `@a11ign/<package>@<version>`, which `git ls-remote` resolves on the layer's own `remote` to
 * a full commit (the peeled one for an annotated tag, as `run-job.yml` reads it). A tag the remote does not hold is a REFUSAL
 * naming the layer, the tag and the remote, BEFORE anything is posted or dispatched: never a guess, never `main`, and never an
 * operator-typed ref, which would be a second pin that can disagree with the one the release publishes.
 *
 * Imports the poster, the layer resolver and the sandboxed git. The poster holds the one named edge to the lab package; this file adds none.
 * Runs from a raw checkout with no install, so `node:` imports and relative paths only.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../../worker-fleet/src/git-safe-env.ts";
import { layerDeclaration, layerPinTag, separateLayers } from "./layer-checkouts.ts";
import { renderResult, requireFullSha, EXIT, type Outcome } from "./post-qualification-status.ts";

export const QUALIFY_FLAG = "--qualify-sha=";

/** The only job whose verdict is the `qualification` status: the payload names `gate:stability` in every description. */
export const QUALIFIED_JOB = "gate-stability";

/** A first `failure` is re-run once, and only once (#3136 outcome 2). */
const MAX_ATTEMPTS = 2;

const RECORD_SCHEMA = 1;

/** How much of a sha a refusal quotes: enough to find it, short enough to read. */
const ABBREVIATED_SHA = 12;

/** Where `run-job.yml` writes one JSON record per finished run, on the host that ran the playbook. */
export function defaultRecordDir(home = homedir()) {
  return join(home, ".cache", "a11ign", "lab-jobs");
}

export type JobRecord = { schema?: unknown, job?: unknown, row?: unknown, invocation?: unknown, outcome?: unknown, exit?: unknown, commit?: unknown };
export type ReadRecord = (query: { job: string, row: number, since: number }) => JobRecord | undefined;
export type Post = (input: { sha: string, outcome?: Outcome, run?: string }) => import("./post-qualification-status.ts").PostResult;
export type Poster = { post: Post, readRecord: ReadRecord, layerRefs: LayerRefsAt, now?: () => number, say?: (text: string) => void };
export type LayerRefsAt = (sha: string) => { layer_refs: Record<string, string> } | { refusal: string };
export type Git = (args: string[]) => { status: number | null, stdout: string, stderr: string };

/**
 * The newest record THIS run wrote: the right job, the right row, written after `since`. Two runs of one
 * job for one row are told apart by time alone, so a record older than the dispatch is never read as its
 * verdict. A file that does not parse is skipped with its name printed, never silently.
 */
export function readRecordFrom(dir: string, { job, row, since }: { job: string; row: number; since: number; }, say: (text: string) => void = () => {}): JobRecord | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const found = names
    .filter((name) => name.startsWith(`${job}-`) && name.endsWith(".json"))
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .filter(({ at }) => at >= since)
    .sort((a, b) => b.at - a.at)
    .flatMap(({ path }) => {
      try {
        return [(JSON.parse(readFileSync(path, "utf8")) as JobRecord)];
      } catch (error) {
        say(`qualification: ${path} does not parse (${error instanceof Error ? error.message : String(error)}); not read\n`);
        return [];
      }
    });
  return found.find((record) => record.schema === RECORD_SCHEMA && record.job === job && record.row === row);
}

/**
 * What the dispatch and its record together stand for, as the poster's `Outcome`. `{}` is "no readable
 * verdict", which is posted as a `failure`.
 */
export function outcomeOf({ status, record, sha }: { status: number; record: JobRecord | undefined; sha: string; }): Outcome {
  if (!record || !Number.isInteger(record.exit)) return ({} as Outcome);
  const ranCommit = typeof record.commit === "string" ? record.commit : "";
  const ranThisSha = ranCommit.length > 0 && sha.startsWith(ranCommit);
  if (!ranThisSha) return ({} as Outcome);
  const passed = record.exit === 0;
  // A PASS is the one reading that releases, so it is the one that must agree with itself three ways.
  if (passed && (status !== 0 || record.outcome !== "success")) return ({} as Outcome);
  return { exitCode: (record.exit as number) };
}

/** The label a reader finds the lab run by: the job and the systemd invocation the record names. */
function runLabel(record: JobRecord | undefined): string | undefined {
  return record && typeof record.invocation === "string" && record.invocation
    ? `${QUALIFIED_JOB}-${record.invocation}` : undefined;
}

/**
 * The qualification request on a command line: the sha, and the argv to dispatch (the flag stripped, the
 * ref pinned), or the reason this cannot be a qualified run. `undefined` when the flag is absent.
 */
export function qualificationRequest(argv: string[], { job, row, ref, worker, describeOnly }: { job: string | undefined; row: string | undefined; ref: string | undefined; worker?: string | undefined; describeOnly: boolean; }): { sha: string; row: number; argv: string[]; } | { refusal: string; } | undefined {
  const flag = argv.find((arg) => arg.startsWith(QUALIFY_FLAG));
  if (flag === undefined) return undefined;
  const sha = flag.slice(QUALIFY_FLAG.length);
  try {
    requireFullSha(sha);
  } catch (error) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (job !== QUALIFIED_JOB || describeOnly) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: a \`qualification\` status is the verdict of ${QUALIFIED_JOB} alone, and `
      + `this command names ${describeOnly ? "a describe-only run, which runs nothing" : `job=${job ?? "(none)"}`}.` };
  }
  if (!/^\d+$/.test(row ?? "")) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: it needs -e row=<n>. The playbook records the job's exit code only for `
      + "a run bound to a row, and without that record there is no verdict to post." };
  }
  if (!worker) {
    // The playbook's assert on the job's required parameters refuses this launch AFTER `pending` is posted, and a refused launch
    // has no job record, so the caller would post `failure` on a sha no run touched (#3988). Only a launch that never posts is clean.
    return { refusal: `REFUSING ${QUALIFY_FLAG}: ${QUALIFIED_JOB} needs -e worker=<n>; the playbook refuses a launch without it, `
      + "and a refused launch has no verdict." };
  }
  if (ref !== undefined && ref !== sha) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: -e ref=${ref} would run the lab at a different commit from the sha `
      + "being qualified. Drop the ref: it is set from the sha." };
  }
  const forwarded = argv.filter((arg) => !arg.startsWith(QUALIFY_FLAG));
  const pinned = ref === undefined ? [...forwarded, "-e", `ref=${sha}`] : forwarded;
  return { sha, row: Number(row), argv: pinned };
}

/**
 * The qualification request with `layer_refs` added, or the reason there are none to add (#3920). `request` is what
 * `qualificationRequest` returned for a run that can begin; this is the one step that asks anything of git, so a refusal
 * here is read before the poster has said `pending` and before anything is dispatched.
 *
 * An operator-typed `layer_refs` is refused, not merged: ansible takes the later `-e` over the earlier, so a typed one would
 * silently replace the lockfile's, which is the second pin this exists to remove.
 */
export function withLayerRefs(request: { sha: string; row: number; argv: string[]; }, layerRefsAt: LayerRefsAt): { sha: string; row: number; argv: string[]; } | { refusal: string; } {
  if (request.argv.some((arg) => arg.includes("layer_refs"))) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: layer_refs is set from the lockfile at ${request.sha.slice(0, ABBREVIATED_SHA)}, never typed. `
      + "A typed one would be a second pin that can disagree with the one the release publishes." };
  }
  const found = layerRefsAt(request.sha);
  if ("refusal" in found) return { refusal: `REFUSING ${QUALIFY_FLAG}: ${found.refusal}` };
  return { ...request, argv: [...request.argv, "-e", JSON.stringify({ layer_refs: found.layer_refs })] };
}

/**
 * What a tag the lab can ask `git ls-remote` for looks like, with no glob character in it: `@a11ign/<package>@<version>` before a
 * repository's first flat version, `v<version>` from it (`releaseTag`, #4363).
 */
const RESOLVABLE_TAG = /^(?:@a11ign\/[a-z0-9-]+@|v)\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/;

/**
 * The package a layer's tags are named for: the `package` its declaration in `layers.json` carries, else the layer's KEY, the same
 * rule `scripts/lay-layer.mjs` reads the pin by. A key is not always its package (the layer `nvda-worker` is
 * `@a11ign/screenreader-worker`), and `layers.json` is the one place that says so; nothing is inferred from the repository's name.
 * A declaration this copy of `layers.json` does not yet carry falls back to the key, which cannot resolve, and that is a refusal.
 *
 *
 * @returns {string} the package's name without its scope
 */
export function packageOfLayer({ name, package: declared }: { name: string; package?: string; }): string {
  return declared ?? name;
}

/**
 * The commit a tag names on `remote`: the peeled one for an annotated tag, else the tag's own. Read from the exact ref names, so a
 * different tag that merely ends the same way is not taken for it. `undefined` is "the remote holds no such tag", which is not an
 * error of git's; `{ failed }` is git not answering, which must never read as a missing tag.
 */
function commitOfTag({ remote, tag, git }: { remote: string; tag: string; git: Git; }): string | undefined | { failed: string; } {
  const answer = git(["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (answer.status !== 0) return { failed: answer.stderr.trim() || `git ls-remote exited ${answer.status}` };
  const refs = new Map(answer.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha, ref] = line.split("\t");
    return ([ref, sha] as [string, string]);
  }));
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  return commit !== undefined && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
}

/**
 * `pnpm-lock.yaml` as it is AT `sha`. A sha this checkout has not fetched is fetched once, which writes only to `.git`; one that is
 * still not there is a refusal that says so rather than a lockfile guessed from the working tree, which is whatever is checked out.
 */
function lockfileAt({ sha, git }: { sha: string; git: Git; }): { lockfile: string; } | { refusal: string; } {
  let shown = git(["show", `${sha}:pnpm-lock.yaml`]);
  if (shown.status !== 0) {
    git(["fetch", "--quiet", "origin"]);
    shown = git(["show", `${sha}:pnpm-lock.yaml`]);
  }
  if (shown.status !== 0) return { refusal: `${sha.slice(0, ABBREVIATED_SHA)}'s pnpm-lock.yaml could not be read (${shown.stderr.trim() || `git exited ${shown.status}`}), so no layer can be pinned to it.` };
  return { lockfile: shown.stdout };
}

/**
 * `layer_refs` for `sha`: every layer that lives in its own repository, at the commit its tag names on its remote, the tag being the
 * one the sha's own lockfile pins. Every problem is collected, so one refusal names every layer that could not be pinned, each with its
 * tag and its remote.
 *
 * @param {{ sha: string, git: Git, layers: { name: string, remote: string, package?: string }[] }} where `layers` are those with a repository of their own
 */
export function layerRefsFor({ sha, git, layers }: { sha: string; git: Git; layers: { name: string; remote: string; package?: string; }[]; }): { layer_refs: Record<string, string>; } | { refusal: string; } {
  const read = lockfileAt({ sha, git });
  if ("refusal" in read) return read;
  const layer_refs: Record<string, string> = {};
  const unpinned: string[] = [];
  for (const layer of layers) {
    const pin = layerPinTag(read.lockfile, packageOfLayer(layer));
    if ("refusal" in pin) {
      unpinned.push(`layer ${layer.name} (${layer.remote}): ${pin.refusal}`);
      continue;
    }
    const commit = RESOLVABLE_TAG.test(pin.tag) ? commitOfTag({ remote: layer.remote, tag: pin.tag, git }) : undefined;
    if (typeof commit === "string") layer_refs[layer.name] = commit;
    else if (commit === undefined) unpinned.push(`layer ${layer.name} is pinned at ${pin.tag} by the lockfile, and ${layer.remote} holds no such tag`);
    else unpinned.push(`layer ${layer.name}: ${layer.remote} could not be asked for ${pin.tag} (${commit.failed})`);
  }
  if (unpinned.length > 0) {
    return { refusal: `${unpinned.join("; ")}. Nothing was posted or dispatched: a layer ref is never guessed, so the lockfile must pin a version whose tag exists.` };
  }
  return { layer_refs };
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GIT_TIMEOUT_MS = 60_000;

const gitInCheckout: Git = (args) => {
  const result = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: sandboxGitEnv() });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * The real `layerRefs` of the poster: this checkout's git, and the layers `layers.json` declares with a repository of their own.
 */
export const layerRefsFromLockfile: LayerRefsAt = (sha) =>
  layerRefsFor({ sha, git: gitInCheckout, layers: separateLayers().map((name) => {
    const { remote, package: declared } = layerDeclaration(name);
    if (remote === undefined) throw new Error(`layer "${name}" declares no remote, so it is not a separate layer`);
    return { name, remote, package: declared };
  }) });

/**
 * `dispatch`, wrapped so the run announces itself and says how it ended. The returned function is the
 * dispatch `run` already takes, and `seen.state` is what the verdict post said (`undefined` if nothing was).
 *
 *
 *
 * @param {{ state: string | undefined }} seen written to, so the caller can decide on the re-run
 */
export function announcingDispatch({ sha, row, dispatch }: { sha: string; row: number; dispatch: (forwarded: string[]) => number | void; }, { post, readRecord, now = Date.now, say = (text) => process.stdout.write(text) }: Poster, seen: { state: string | undefined; }): (forwarded: string[]) => number {
  return (forwarded) => {
    const started = post({ sha, outcome: { started: true } });
    say(renderResult(started));
    if (!started.posted) {
      say(`qualification: ${QUALIFIED_JOB} was NOT dispatched, because its start could not be said on the sha.\n`);
      return started.reason === "no-credential" ? EXIT.NOT_YET : EXIT.REFUSED;
    }
    const since = now();
    const status = dispatch(forwarded) ?? 1;
    const record = readRecord({ job: QUALIFIED_JOB, row, since });
    const verdict = post({ sha, outcome: outcomeOf({ status, record, sha }), run: runLabel(record) });
    say(renderResult(verdict));
    seen.state = verdict.posted ? verdict.payload.state : undefined;
    return status;
  };
}

/**
 * Run the attempts: one, then ONE more if the first said `failure`. `attempt` is a whole `lab-job` run, so
 * the re-run goes through the same wake and staleness checks as the first.
 *
 *
 * @returns {Promise<number | void>} the last dispatch's status
 */
export async function runQualified({ attempt, announce, say = (text) => process.stdout.write(text) }: {
        attempt: (wrap: (dispatch: (forwarded: string[]) => number | void) => (forwarded: string[]) => number) => Promise<number | void>;
        announce: (dispatch: (forwarded: string[]) => number | void, seen: { state: string | undefined; }) => (forwarded: string[]) => number;
        say?: (text: string) => void;
    }): Promise<number | void> {
  let status: number | void = undefined;
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    const seen = { state: undefined };
    status = await attempt((dispatch) => announce(dispatch, seen));
    if (seen.state !== "failure") break;
    if (n < MAX_ATTEMPTS) say(`qualification: first ${QUALIFIED_JOB} run said failure; re-running once on a fresh run (#3136).\n`);
  }
  return status;
}
