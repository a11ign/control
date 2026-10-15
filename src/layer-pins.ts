// @ts-check
/**
 * WHAT CONTROL DEPLOYS, DECLARED BY CONTROL: `deploy-pins.json`, and the one reader of it (ADR 0045 cut 7, a11ign/a11ign#5085).
 *
 * Control used to hold a COPY of the core's layer manifest (`lay-layer` wrote it into the laid package) and read it from 17 files to
 * learn which worker and fleet it deploys and where a host holds them. A file one repository owns is not copied into another (ADR 0045
 * Decision 1, rule 3), and the worker and the fleet are used through their PUBLISHED packages at a version the consumer declares
 * (rules 1 and 2). So the declaration is control's own: for each layer the package, its version, the `integrity` of that version's
 * tarball, and where a host holds it; and for the lab the tag its jobs run from.
 *
 * THE INTEGRITY IS WHAT MAKES A VERSION A PIN. `npm pack <package>@<version>` returns whatever the registry serves under that name
 * today; `stagePublished` compares the tarball's SHA-512 with the declared `integrity` and REFUSES, naming the layer, the spec and both
 * digests, BEFORE anything is unpacked, and a refusal on any layer unpacks none of them. Nothing here ships anything: what a caller does
 * with `dirs` is its own act, and it has not happened when a refusal is returned.
 *
 * NO DEPENDENCY, STILL (ADR 0012). The unpacked packages are laid as `<into>/node_modules/<package>/` so that the fleet's own
 * `@a11ign/screenreader-worker/...` imports resolve, and nothing is installed: both packages import `node:` modules and each other only,
 * which `layer-pins.test.ts` reads off the real tarballs' shape. `package.json`'s `dependencies` stays `{}`, and this module imports `node:`
 * modules alone (`control-has-no-dependencies.test.ts`).
 */
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One published layer: the package, the release, the digest of that release's tarball, and where a host holds it. */
export type PublishedLayer = { package: string; version: string; integrity: string; path: string; remote: string; source?: string; };
/** The lab's release, which the lab host holds laid beside the core's checkout (and which no registry serves: `lab` is private). */
export type LabPin = { path: string; remote: string; tag: string; lays?: string[]; source?: string; };
/** The core's commit the guests are put on (#5515): a full sha, which is what `commit` must be, because a branch or a tag is not a pin. */
export type CorePin = { remote: string; commit: string; };
export type DeployPins = { layers: Record<string, PublishedLayer>; lab?: LabPin; core?: CorePin; };

/** Where the declaration lives: beside `package.json`, one directory up from `src/`. */
export const DEPLOY_PINS_PATH = fileURLToPath(new URL("../deploy-pins.json", import.meta.url));

const LAYER_NAME = /^[a-z0-9-]+$/;
const PACKAGE_NAME = /^@a11ign\/[a-z0-9-]+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** A SHA-512 SRI digest: 64 bytes is 86 base64 characters and `==`. Another algorithm is not a pin this module can compare. */
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PLAIN_PATH = /^[A-Za-z0-9._/-]{1,100}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const GITHUB_REMOTE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const plainPath = (value: unknown): value is string => typeof value === "string" && PLAIN_PATH.test(value) && !value.includes("..") && !value.startsWith("/");

function publishedLayerRefusal(name: string, layer: unknown): string | null {
  const where = `deploy-pins.json layers.${name}`;
  if (!LAYER_NAME.test(name)) return `${where}: a layer's name is [a-z0-9-]`;
  if (!isObject(layer)) return `${where} is not an object`;
  const { package: pkg, version, integrity, path, remote } = layer;
  if (typeof pkg !== "string" || !PACKAGE_NAME.test(pkg)) return `${where}.package is ${JSON.stringify(pkg)}, not an @a11ign/<name> package`;
  if (typeof version !== "string" || !SEMVER.test(version)) return `${where}.version is ${JSON.stringify(version)}: an exact x.y.z, never a range or a tag`;
  if (typeof integrity !== "string" || !INTEGRITY.test(integrity)) return `${where}.integrity is not a sha512 digest of the tarball (the \`integrity\` \`npm view ${pkg}@${version} dist.integrity\` prints)`;
  if (!plainPath(path)) return `${where}.path is ${JSON.stringify(path)}, not a plain relative path`;
  if (typeof remote !== "string" || remote === "") return `${where}.remote is missing: a host's checkout of the layer is cloned from it`;
  return null;
}

function labRefusal(lab: unknown): string | null {
  if (!isObject(lab)) return "deploy-pins.json lab is not an object";
  const { path, remote, tag, lays, source } = lab;
  if (!plainPath(path)) return `deploy-pins.json lab.path is ${JSON.stringify(path)}, not a plain relative path`;
  if (typeof remote !== "string" || remote === "") return "deploy-pins.json lab.remote is missing";
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) return `deploy-pins.json lab.tag is ${JSON.stringify(tag)}, which is not a v<semver> tag: a branch or a sha is not a pin`;
  if (lays !== undefined && !(Array.isArray(lays) && lays.every((entry) => typeof entry === "string"))) return "deploy-pins.json lab.lays is not a list of names";
  if (source !== undefined && typeof source !== "string") return "deploy-pins.json lab.source is not a path";
  return null;
}

function coreRefusal(core: unknown): string | null {
  if (!isObject(core)) return "deploy-pins.json core is not an object";
  const { remote, commit } = core;
  if (typeof remote !== "string" || !GITHUB_REMOTE.test(remote)) return `deploy-pins.json core.remote is ${JSON.stringify(remote)}, not an https github.com clone URL ending .git`;
  if (typeof commit !== "string" || !FULL_SHA.test(commit)) return `deploy-pins.json core.commit is ${JSON.stringify(commit)}, not a full 40-hex commit: a branch or a short sha is not a pin`;
  return null;
}

/** The declaration as text, or the refusal naming the first thing wrong with it. A pin that cannot be read is never a default. */
export function parseDeployPins(text: string): { pins: DeployPins; } | { refusal: string; } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { refusal: `deploy-pins.json is not JSON (${cause instanceof Error ? cause.message : String(cause)})` };
  }
  if (!isObject(parsed) || !isObject(parsed.layers) || Object.keys(parsed.layers).length === 0) {
    return { refusal: "deploy-pins.json declares no layers: there is nothing to deploy, and an empty pair is refused rather than passed" };
  }
  for (const [name, layer] of Object.entries(parsed.layers)) {
    const refusal = publishedLayerRefusal(name, layer);
    if (refusal !== null) return { refusal };
  }
  if (parsed.lab !== undefined) {
    const refusal = labRefusal(parsed.lab);
    if (refusal !== null) return { refusal };
  }
  if (parsed.core !== undefined) {
    const refusal = coreRefusal(parsed.core);
    if (refusal !== null) return { refusal };
  }
  return { pins: {
    layers: parsed.layers as Record<string, PublishedLayer>,
    ...(parsed.lab === undefined ? {} : { lab: parsed.lab as LabPin }),
    ...(parsed.core === undefined ? {} : { core: parsed.core as CorePin }),
  } };
}

/** `parseDeployPins` over the file, throwing the refusal: the readers of the real file have no useful way to go on without it. */
export function readDeployPins(path: string = DEPLOY_PINS_PATH): DeployPins {
  const read = parseDeployPins(readFileSync(path, "utf8"));
  if ("refusal" in read) throw new Error(read.refusal);
  return read.pins;
}

/** The SRI digest of `bytes`, the spelling `npm view <spec> dist.integrity` and a lockfile's `integrity` use. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Equal digests, compared in constant time over the same length: a length difference is a difference, not an exception. */
function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The refusal for a tarball that is not the pinned one, naming the layer, the spec and both digests; `null` when it is. */
export function integrityRefusal({ layer, spec, bytes, integrity }: { layer: string; spec: string; bytes: Uint8Array; integrity: string; }): string | null {
  const actual = integrityOf(bytes);
  if (sameDigest(actual, integrity)) return null;
  return `layer ${layer}: ${spec} is not the release deploy-pins.json pins: its tarball is ${actual}, the pin is ${integrity}. Nothing was unpacked or shipped.`;
}

/** What fetched a tarball: the file it is in, or why it was not. Injectable, so a test needs no registry. */
export type Pack = (spec: string, into: string) => { tarball: string; } | { failed: string; };
/** What unpacked one: `null` when it did, else why it did not. */
export type Extract = (tarball: string, into: string) => string | null;

const PACK_TIMEOUT_MS = 120_000;

/** `npm pack <spec>`: the registry's tarball for a version, written into `into`, with no lifecycle script run. */
const npmPack: Pack = (spec, into) => {
  const packed = spawnSync("npm", ["pack", spec, "--pack-destination", into, "--silent", "--ignore-scripts"], { encoding: "utf8", timeout: PACK_TIMEOUT_MS });
  if (packed.status !== 0) return { failed: (packed.stderr ?? "").trim().split("\n").pop() || `npm pack exited ${packed.status}` };
  const name = (packed.stdout ?? "").trim().split("\n").pop() ?? "";
  return name === "" ? { failed: "npm pack printed no file name" } : { tarball: join(into, name) };
};

/** `tar -xzf`, dropping the tarball's own `package/` directory so the package's files sit directly in `into`. */
const tarExtract: Extract = (tarball, into) => {
  mkdirSync(into, { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", into, "--strip-components=1"], { encoding: "utf8" });
  return unpacked.status === 0 ? null : (unpacked.stderr ?? "").trim() || `tar exited ${unpacked.status}`;
};

/** A directory of this process's own to hold the unpacked packages: nothing in the checkout, and nothing a second run could be confused by. */
export function makeStage(): string {
  return mkdtempSync(join(tmpdir(), "a11ign-control-published-"));
}

/**
 * THE PUBLISHED LAYERS, FETCHED, VERIFIED AND ONLY THEN UNPACKED.
 *
 * Every layer is packed and compared first, and EVERY mismatch is collected, so one refusal names each layer that is not its pin.
 * Unpacking starts after the last comparison passed: a pin that fails leaves nothing unpacked for anything to run from. `dirs` maps
 * a layer to the directory holding its package (`<into>/node_modules/<package>`), where `dist/` and `package.json` are.
 */
export function stagePublished({ pins, into, pack = npmPack, extract = tarExtract, read = readFileSync }: {
  pins: DeployPins; into: string; pack?: Pack; extract?: Extract; read?: (path: string) => Uint8Array;
}): { dirs: Record<string, string>; } | { refusal: string; } {
  const verified: { name: string; tarball: string; dir: string; }[] = [];
  const refusals: string[] = [];
  for (const [name, layer] of Object.entries(pins.layers)) {
    const spec = `${layer.package}@${layer.version}`;
    const packed = pack(spec, into);
    if ("failed" in packed) {
      refusals.push(`layer ${name}: ${spec} could not be fetched (${packed.failed}), so its pin cannot be checked`);
      continue;
    }
    const refusal = integrityRefusal({ layer: name, spec, bytes: read(packed.tarball), integrity: layer.integrity });
    if (refusal !== null) refusals.push(refusal);
    else verified.push({ name, tarball: packed.tarball, dir: join(into, "node_modules", layer.package) });
  }
  if (refusals.length > 0) return { refusal: refusals.join("; ") };
  const dirs: Record<string, string> = {};
  for (const { name, tarball, dir } of verified) {
    const failed = extract(tarball, dir);
    if (failed !== null) return { refusal: `layer ${name}: ${tarball} verified and could not be unpacked into ${dir} (${failed})` };
    dirs[name] = dir;
  }
  return { dirs };
}

/**
 * THE FIRST VERSION AT WHICH A LAYER'S REPOSITORY TAGS `v<semver>` rather than `<package>@<version>`, keyed by package: the repository's
 * history, not the version's (`screenreader-worker` moved at 0.3.0 and `screenreader-fleet` at 0.5.3, #4363). Both pinned versions are
 * past it, and the table is kept so a pin of an older release still names the tag that repository really made. It is a SECOND COPY of the
 * core's `BARE_TAGS_FROM` in `scripts/lay-layer.ts` (control imports nothing outside its own directory, ADR 0012), and
 * `layer-checkouts.test.ts` fails when the two disagree, wherever the core's file is reachable.
 */
const BARE_TAGS_FROM: Record<string, [number, number, number]> = { "@a11ign/screenreader-worker": [0, 3, 0], "@a11ign/screenreader-fleet": [0, 5, 3] };

/** The tag a release is under in its repository: `v<version>` once the repository tags that way, `<package>@<version>` before. */
export function releaseTag(name: string, version: string): string {
  const from = Object.hasOwn(BARE_TAGS_FROM, name) ? BARE_TAGS_FROM[name] : undefined;
  if (from === undefined) return `${name}@${version}`;
  const [major, minor, patch] = version.split(".").slice(0, 3).map(Number);
  const atOrAfter = major !== from[0] ? major > from[0] : minor !== from[1] ? minor > from[1] : patch >= from[2];
  return atOrAfter ? `v${version}` : `${name}@${version}`;
}

/** A layer's pinned release as a tag in its repository, or the refusal for a layer the pins do not declare. */
export function pinnedTag(pins: DeployPins, layer: string): { tag: string; } | { refusal: string; } {
  const declared = Object.hasOwn(pins.layers, layer) ? pins.layers[layer] : undefined;
  if (declared === undefined) return { refusal: `deploy-pins.json declares no layer ${layer} (declared: ${Object.keys(pins.layers).join(", ")})` };
  return { tag: releaseTag(declared.package, declared.version) };
}

/** `git`, injected: what the callers already pass is `(args) => { status, stdout, stderr }`. */
export type GitRun = (args: string[]) => { status: number | null; stdout: string; stderr: string; };

/**
 * The commit a tag names on `remote`: the peeled one for an annotated tag, else the tag's own. Read from the exact ref names, so a
 * different tag that merely ends the same way is not taken for it. `undefined` is "the remote holds no such tag", which is not an
 * error of git's; `{ failed }` is git not answering, which must never read as a missing tag.
 */
export function commitOfTag({ remote, tag, git }: { remote: string; tag: string; git: GitRun; }): string | undefined | { failed: string; } {
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
 * The commit each pinned release is, which is what a guest's checkout is put on (`a11y_layer_commits`): the pair's second half,
 * derived from the pins rather than typed as `--layer-ref`. Every layer that cannot be resolved is named in one refusal, and a
 * remote that cannot be asked is a different sentence from a tag it does not hold.
 */
export function publishedCommits({ pins, git }: { pins: DeployPins; git: GitRun; }): { commits: Record<string, string>; } | { refusal: string; } {
  const commits: Record<string, string> = {};
  const refusals: string[] = [];
  for (const [name, layer] of Object.entries(pins.layers)) {
    const tag = releaseTag(layer.package, layer.version);
    const commit = commitOfTag({ remote: layer.remote, tag, git });
    if (typeof commit === "string") commits[name] = commit;
    else if (commit === undefined) refusals.push(`layer ${name}: ${layer.remote} holds no tag ${tag}, so ${layer.package}@${layer.version} has no commit to put a checkout on`);
    else refusals.push(`layer ${name}: ${layer.remote} could not be asked for ${tag} (${commit.failed})`);
  }
  return refusals.length > 0 ? { refusal: refusals.join("; ") } : { commits };
}

/**
 * THE PUBLISHED FORM OF A DEPLOY (#5085): every layer's tarball fetched and compared with its pin, the packages unpacked beside each
 * other, and the commit each release's tag names, in one answer. A refusal from either half is the whole answer: the commits are
 * never offered for a pin whose tarball did not verify, so a caller that gets `commits` has also got verified `dirs`.
 */
export function resolvePublished({ pins, into, git, pack, extract }: {
  pins: DeployPins; into: string; git: GitRun; pack?: Pack; extract?: Extract;
}): { commits: Record<string, string>; dirs: Record<string, string>; } | { refusal: string; } {
  const staged = stagePublished({ pins, into, pack, extract });
  if ("refusal" in staged) return staged;
  const resolved = publishedCommits({ pins, git });
  if ("refusal" in resolved) return resolved;
  return { commits: resolved.commits, dirs: staged.dirs };
}

/**
 * The file name the playbooks' layer tasks read their layer list from, taken from the task that reads it. THE OLD PATH (a host that
 * deploys laid source, which stays until the host row) is still the playbooks' own reading of a list control no longer holds, and a
 * test that stands a list beside a play learns the name from that task, so nothing in `src/` names the file a second time.
 */
export function playbookLayerListName(taskText: string): string {
  const named = /playbook_dir ~ '\/\.\.\/([A-Za-z0-9._-]+)'/.exec(taskText);
  if (named === null) throw new Error("the layer-reading task names no file beside the playbook directory");
  return named[1];
}
