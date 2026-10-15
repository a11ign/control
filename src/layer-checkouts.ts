// @ts-check
/**
 * WHERE A LAYER'S CODE LIVES ON THIS HOST, asked of one place (ADR 0039 item 6, #3394).
 *
 * The control plane reads the worker's code version to decide whether the fleet runs the right build, and it
 * used to find the worker by a relative path into its source directory. Control runs from a raw checkout
 * with no `node_modules` (ADR 0012), so it cannot use the package name; and once the layer leaves this
 * repository, a reader that guessed the monorepo path would compare the fleet against the WRONG tree and
 * still print a hash. `deploy-pins.json` declares each layer and its path, and this module is the only reader of it (`layer-pins.ts`).
 *
 * REFUSES rather than falls back. An undeclared layer, or a declared one whose directory is not there, throws
 * naming the layer and the path: answering with the monorepo path instead is the silent wrong answer this
 * exists to remove.
 *
 * Imports only `node:` modules, so `control-has-no-dependencies.test.ts` holds. `layerCodeVersion` therefore
 * imports the layer's own `code-version.ts` DYNAMICALLY (`.mjs` at an older tag, `LAYER_HASHER_FILES`), from the resolved directory: still the one hasher,
 * and a static import would name the path this module exists to hide.
 *
 * A layer that lives in its OWN repository declares a `remote`, and a guest then holds a second checkout of it
 * pinned to its own commit (ADR 0039 item 6, row 6b, #3395): `separateLayers` names those, and `layerPins`
 * turns the operator's `--layer-ref=<name>=<sha>` flags into the pair's second half, refusing a missing pin, a
 * short sha and a layer that has no repository of its own. The guest plays read their own list
 * (`ansible/tasks/read-layer-checkouts.yml`); `layer-guests.test.ts` holds the two to the same layers, so they cannot name different ones.
 *
 * THE CONTROL PLANE AND THE LAB MOVE THE LAYER'S CHECKOUT BESIDE THE CORE'S (row 6c, #3396). `layerCheckoutMove`
 * is the control plane's half: the shell that puts each separate layer's checkout on its pinned commit and reads
 * the commit back, REFUSING (exit 4) where the checkout is not there rather than leaving the core's tree to
 * answer for it. The lab's half is `ansible/tasks/run-job.yml` and `lab-reset.yml`, which read the same
 * list and validate a layer's ref with `LAYER_REF`, which is `lab_ref`'s own pattern. With no layer that
 * declares a `remote`, every one of them is a no-op.
 *
 * A HOST THAT HAS INSTALLED HOLDS A SEPARATE LAYER LAID, NOT CLONED (#3819): `scripts/lay-layer.ts` replaces the clone with `src/`
 * and `.layer-ref`. The lab's and the guests' tasks accept that shape, and so does `layerCheckoutMove` (#4150): the control plane's
 * checkout DOES install now (it holds `packages/worker-fleet` laid), and the comment that said it never would stopped the first
 * `fleet:deploy --layer-ref` at the pre-flight, before the playbook. A laid layer has no history to move, so it is not moved: it is
 * ACCEPTED when the commit its `.layer-ref` tag names on the layer's remote is the pin, and refused, naming both, when it is not.
 * A directory with neither a `.git` nor a `.layer-ref` beside `src/` is the core's own tree at that path and still refuses.
 *
 * A PUBLISHED LAYER IS NOT A CHECKOUT ON THE PLANE (#5445). The plane's `/root/control` is a plain clone (#5312) and never held `packages/<layer>`, so a
 * layer whose `deploy-pins.json` entry declares a `package` and `version` is judged by the release `pnpm install` left under `node_modules/<package>/`,
 * and a layer that declares none keeps the refusal above. `layers.json` is untouched: the playbooks' own layer tasks (`ansible/tasks/*layer*.yml`,
 * `roles/worker/defaults/main.yml`) still read it, and no file of `src/` does.
 *
 * `worker-fleet` does NOT use this: it is published and `control` never is
 * (`worker-fleet-does-not-read-control.test.ts`), so its readers ask the worker package by name instead.
 *
 * THE DECLARATION IS CONTROL'S OWN (ADR 0045 rule 3, #5085): `deploy-pins.json`, read lazily so that importing this module never
 * fails for a checkout that lacks it, and every use of a layer then refuses naming the file. There is no laid control to judge and no
 * `pinned.control`: control is deployed from its own checkout, and a layer's version is `layer-pins.ts`'s `pinnedTag`.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { readDeployPins, releaseTag, type DeployPins } from "./layer-pins.ts";

export { releaseTag };

/**
 * The directory a layer's `path` in `deploy-pins.json` is relative to: THIS CHECKOUT'S OWN ROOT, which is where control runs from (ADR 0045
 * rule 1, a11ign/a11ign#5312). It was `../../../` while control sat at `packages/control` under the core, and from a checkout of its own that
 * walks out of it: `layerDeclaration("screenreader-fleet").dir` read `<parent of the checkout>/packages/worker-fleet`, a tree that is not there.
 *
 * The one place control still sits at `packages/control` is the core's CI (`ci.yml` lays it there, with the layers cloned beside it at the
 * core's root), so a checkout whose own path ends `packages/control` answers with the tree above it. A function of the path alone, so a test
 * can hold both shapes without a second checkout.
 */
export function layersRootOf(checkoutRoot: string): string {
  const root = resolve(checkoutRoot);
  const laidUnderATree = basename(root) === "control" && basename(dirname(root)) === "packages";
  return laidUnderATree ? dirname(dirname(root)) : root;
}

const REPO_ROOT = layersRootOf(fileURLToPath(new URL("../", import.meta.url)));

/**
 * The layer's hasher, in the order its spellings are tried: `.ts` since screenreader-worker v0.9.0, `.mjs` before it. THE `.mjs` IS A FALLBACK AND NOT A CONVENTION: a host
 * may still hold a checkout at an `.mjs`-era tag, and refusing it would fail the code-version read of a fleet that is merely behind. It exists because of a11ign/a11ign#4516
 * and goes with the row that removes it; do not copy it to another reader, whose layer files are named by the one extension.
 */
const LAYER_HASHER_FILES = ["code-version.ts", "code-version.mjs"];

/** The first of `LAYER_HASHER_FILES` that `dir` holds, or the first when it holds none, so the import's own error names the file a current layer would have. */
function layerHasherFile(dir: string): string {
  const [current] = LAYER_HASHER_FILES;
  return join(dir, LAYER_HASHER_FILES.find((file) => existsSync(join(dir, file))) ?? current);
}

/** The shape the resolver below reads: the pins file's layers by name. (The lab is not a layer a host holds a checkout of: `lab-laid-copy.ts` reads its pin.) */
export type Manifest = { layers: Record<string, { path: string; remote?: string; branch?: string; package?: string; version?: string; }>; };

/** `deploy-pins.json` as the resolver reads it. */
export function manifestOf(pins: DeployPins): Manifest {
  const layers = Object.fromEntries(Object.entries(pins.layers).map(([name, { path, remote, package: pkg, version }]) => [name, { path, remote, package: pkg, version }]));
  return { layers };
}

/**
 * The name of the layer whose directory is `path` or holds it. `startsWith` of the directory and a slash, so a sibling that shares a
 * prefix (`packages/control-extra`) is not inside it.
 *
 * @param {string} path repo-relative
 * @param {({ name: string, path: string } | null)[]} layers a null is a layer that is not declared, and owns nothing
 */
function owningLayer(path: string, layers: ({ name: string; path: string; } | null)[]): string | null {
  return layers.find((layer) => layer !== null && (path === layer.path || path.startsWith(`${layer.path}/`)))?.name ?? null;
}

/**
 * The resolver over one manifest and one repository root. The exports below close over the real ones; a test
 * closes over a fixture, which is how "a declared layer whose path is absent" is reachable at all.
 */
export function layersFrom({ manifest, root }: { manifest: Manifest; root: string; }) {
  /**
   * What `deploy-pins.json` declares for a layer, WITHOUT asking whether its directory is there: the refusal for a
   * missing clone has to name where the clone goes, and `layerRoot` throws before it can.
   */
  function layerDeclaration(name: string): { name: string; path: string; remote: string | undefined; package: string | undefined; dir: string; } {
    const layer = Object.hasOwn(manifest.layers, name) ? manifest.layers[name] : undefined;
    if (!layer) {
      throw new Error(`layer "${name}" is not declared in deploy-pins.json `
        + `(declared: ${Object.keys(manifest.layers).join(", ") || "none"})`);
    }
    return { name, path: layer.path, remote: layer.remote, package: layer.package, dir: resolve(root, layer.path) };
  }

  /** The layer's directory: where its `package.json` and its `src/` are. */
  function layerRoot(name: string) {
    const { path, dir } = layerDeclaration(name);
    if (!existsSync(dir)) {
      throw new Error(`layer "${name}" is declared at ${path}, and ${dir} does not exist: `
        + "check it out there, or correct its path in deploy-pins.json");
    }
    return dir;
  }

  /** The layer's source directory, the one `codeVersion` hashes. Trailing slash, as `workerSourceDir()`. */
  const layerSourceDir = (name: string) => `${join(layerRoot(name), "src")}/`;

  /**
   * The layer's code hash, computed by the layer's own hasher. A layer with a checkout is hashed from its `src/`. A layer that declares a
   * published release and has NO checkout (the plane, #5445) answers with the release's own `dist/code-version.mjs`, called with no directory,
   * which returns the version the build stamped. A layer that declares neither refuses, naming the checkout and the release both.
   */
  async function layerCodeVersion(name: string) {
    const { dir: checkout, path } = layerDeclaration(name);
    const release = Object.hasOwn(manifest.layers, name) ? manifest.layers[name] : undefined;
    if (!existsSync(checkout) && release?.package !== undefined && release.version !== undefined) {
      return installedReleaseCodeVersion({ name, path, root, package: release.package });
    }
    const dir = layerSourceDir(name);
    const hasher = await import(pathToFileURL(layerHasherFile(dir)).href);
    return hasher.codeVersion(dir);
  }

  /** The layers a guest holds as a second checkout: those that declare a `remote`. */
  const separateLayers = () => Object.entries(manifest.layers).filter(([, layer]) => layer.remote).map(([name]) => name);

  /**
   * The operator's `--layer-ref=<name>=<full sha>` values as `{ name: sha }`, or the refusal to print.
   * A layer is pinned by a FULL sha (the guest asserts `rev-parse HEAD` equals it, which an abbreviation never
   * would), every separate layer must be pinned (no default: a guessed layer commit is a wrong answer about a
   * repository nobody named), and a layer inside the core checkout is refused, because the core's pin already
   * moved it and a second pin would say two things about one directory.
   */
  function layerPins(given: string[]): { pins: Record<string, string>; refusal: string | null; } {
    const separate = separateLayers();
    const pins: Record<string, string> = {};
    for (const value of given) {
      const match = /^([a-z0-9-]+)=([0-9a-f]{40})$/.exec(value);
      if (!match) return refused(`--layer-ref=${value}: <layer name>=<40 lowercase hex>, a full commit.`);
      const [, name, sha] = match;
      if (!separate.includes(name)) {
        return refused(`--layer-ref=${value}: "${name}" is not a layer with its own repository `
          + `(those are: ${separate.join(", ") || "none"}). A layer inside the core checkout moves with the core's commit.`);
      }
      if (Object.hasOwn(pins, name)) return refused(`--layer-ref names "${name}" twice.`);
      pins[name] = sha;
    }
    const unpinned = separate.filter((name) => !Object.hasOwn(pins, name));
    if (unpinned.length) {
      return refused(`${unpinned.join(", ")} lives in its own repository and needs a pin: `
        + unpinned.map((name) => `--layer-ref=${name}=<40 hex>`).join(" "));
    }
    return { pins, refusal: null };
  }

  /** @param {Record<string, string>} pins a value that has passed `layerPins` */
  const layerCheckoutMove = (pins: Record<string, string>) => checkoutMoveFor(manifest, pins);

  /** The read-only command, run on the control plane BEFORE it is moved (#5556), and the judgement of what it printed. */
  const installedLayersRead = () => installedReadFor(manifest);
  const installedLayersJudged = (output: string) => installedJudged(manifest, output);

  /**
   * The layer whose directory holds `path` (repo-relative): a separate layer, or null when it is the core's.
   * A file of a layer's is not tracked by this repository, so "does `git ls-files` list it" cannot be the question asked of it (#3845).
   */
  function layerOwning(path: string): string | null {
    const separate = separateLayers().map((name) => ({ name, path: manifest.layers[name].path }));
    return owningLayer(path, separate);
  }

  return { layerDeclaration, layerRoot, layerSourceDir, layerCodeVersion, separateLayers, layerPins, layerCheckoutMove, layerOwning,
    installedLayersRead, installedLayersJudged };
}

/** What a published layer's release answers for its code version: its own build stamp, read from `node_modules/<package>/dist/code-version.mjs`. */
async function installedReleaseCodeVersion({ name, path, root, package: pkg }: { name: string; path: string; root: string; package: string; }) {
  const hasher = join(root, "node_modules", pkg, "dist", "code-version.mjs");
  if (!existsSync(hasher)) {
    throw new Error(`layer "${name}" is declared at ${path}, which does not exist under ${root}, and its published release ${pkg} is not installed `
      + `(${hasher} is missing): check it out at ${path}, or run pnpm install --frozen-lockfile`);
  }
  return (await import(pathToFileURL(hasher).href)).codeVersion();
}

/**
 * The shell that moves each pinned layer's checkout on the control plane, beside the core's, to its commit,
 * and compares `rev-parse HEAD` with the pin. Appended after the core's own move, so the pair lands or the
 * command fails: a layer left where its branch was is the silent half of the pair (#3395's guest failure).
 *
 * A checkout that is NOT THERE refuses, naming the layer and the path, and never `git`s the core's tree in
 * its place: the monorepo layout answering for a layer that moved is the substitution this exists to stop.
 * A path is restricted to `[A-Za-z0-9._/-]` with no `..` and a pin was restricted by `layerPins` to 40 hex
 * digits, so nothing that reaches the string can close its quotes.
 *
 *
 * @param {Record<string, string>} pins a value that has passed `layerPins`
 * @returns {string} the argv fragment, leading space included, or "" when nothing is pinned
 */
function checkoutMoveFor(manifest: Manifest, pins: Record<string, string>): string {
  return Object.entries(pins).map(([name, sha]) => {
    const layer = Object.hasOwn(manifest.layers, name) ? manifest.layers[name] : undefined;
    if (!layer?.remote) throw new Error(`layer "${name}" has no repository of its own to move`);
    if (!LAYER_REF.test(layer.path) || layer.path.includes("..")) {
      throw new Error(`layer "${name}" is declared at "${layer.path}", which is not a plain relative path`);
    }
    if (!REMOTE_URL.test(layer.remote)) throw new Error(`layer "${name}" declares the remote "${layer.remote}", which is not a plain https URL or path`);
    return layerMoveShell({ name, sha, path: layer.path, remote: layer.remote, published: publishedOf(name, layer) });
  }).join("");
}

/**
 * What a layer's `remote` may look like once it is inside the single quotes of `git ls-remote`: no quote, space, `$` or backtick, and
 * not an option. `deploy-pins.json` declares an https URL; a path is let through so a test can stand a local repository in for it.
 */
const REMOTE_URL = /^[A-Za-z0-9/][A-Za-z0-9._:/@-]*$/;

/** The `@a11ign/<name>` package and exact `x.y.z` release `deploy-pins.json` declares for a published layer: both go inside shell text, so both are held to a pattern first. */
const PUBLISHED_PACKAGE = /^@a11ign\/[a-z0-9-]+$/;
const PUBLISHED_VERSION = /^\d+\.\d+\.\d+$/;

/** A layer control holds as a published dependency: the release it declares, or null for a layer that declares none (a clone or a laid tree is all it can be). */
function publishedOf(name: string, layer: { package?: string; version?: string; }): { package: string; version: string; } | null {
  if (layer.package === undefined && layer.version === undefined) return null;
  if (!PUBLISHED_PACKAGE.test(layer.package ?? "") || !PUBLISHED_VERSION.test(layer.version ?? "")) {
    throw new Error(`layer "${name}" declares the release ${JSON.stringify(layer.package)}@${JSON.stringify(layer.version)}, which is not an @a11ign/<name> package at an exact x.y.z`);
  }
  return { package: layer.package as string, version: layer.version as string };
}

/**
 * One layer's move, for whichever shape it is held in: a clone is fetched (tags too) and put on the pin, a laid tree is judged against
 * it, and anything else is the last branch, which is ONE of two. A layer control holds as a published dependency (ADR 0045) is judged by
 * the package `pnpm install` left under `node_modules/`, because the plane's own checkout never held `packages/<layer>` (#5312 installed it
 * as a plain clone, #5445) and a refusal there stopped every `fleet:provision` before its playbook. A layer that declares no release is
 * refused, because for it the directory is the only place the layer can be. The branches are one `if` so exactly one of them speaks.
 */
function layerMoveShell({ name, sha, path, remote, published }: { name: string; sha: string; path: string; remote: string; published: { package: string; version: string; } | null; }): string {
  const where = `${CONTROL_PLANE_CHECKOUT_PATH}/${path}`;
  const refusal = `echo "REFUSING: layer ${name} is declared at ${path} and ${where} is neither a git checkout nor a laid tree `
    + "(.layer-ref beside src/); the core's tree does not stand in for it.\" >&2; exit 4";
  const last = published ? installedJudgement({ name, published }) : refusal;
  return ` && ( if [ -d ${where}/.git ]; then ${clonedMove({ path, sha })}; `
    + `elif [ -f ${where}/.layer-ref ] && [ -d ${where}/src ]; then ${laidJudgement({ name, sha, where, remote })}; `
    + `else ${last}; fi ) `;
}

/**
 * A published layer is held where `pnpm install --frozen-lockfile` put it, `node_modules/<package>/`, and what the plane can say about it is the
 * release that directory's `package.json` names: accepted when it is the one `deploy-pins.json` declares, refused naming both when it is not
 * or when nothing is installed. `sed`, not `node`, so the judgement needs nothing the sync did not already use. The tarball's integrity was
 * compared where the tarball is fetched (`layer-pins.ts`); this is the plane's own copy answering for itself.
 */
function installedJudgement({ name, published }: { name: string; published: { package: string; version: string; }; }): string {
  const file = `${CONTROL_PLANE_CHECKOUT_PATH}/node_modules/${published.package}/package.json`;
  return `have=$(sed -n 's/^ *"version": *"\\([^"]*\\)".*/\\1/p' ${file} 2>/dev/null | head -n 1); `
    + `[ "$have" = ${published.version} ] || { echo "REFUSING: layer ${name} is the published dependency ${published.package}@${published.version} `
    + `and ${file} holds \${have:-no installed version}: run pnpm install --frozen-lockfile in ${CONTROL_PLANE_CHECKOUT_PATH}" >&2; exit 4; }`;
}

/**
 * ONE READ, BEFORE ANY WRITE: what each published layer is on the plane, beside what the plane's own lockfile resolves for it (#5556). The move's
 * judgement above refuses AFTER `git merge --ff-only` has run, and a pin bump leaves the plane's HEAD on the new lockfile with `node_modules/`
 * one release behind (control#109: 0.13.0 installed, 0.13.1 resolved), so the first write of a covered, once-only run stopped there. This is the same
 * question asked first and only read: one line per published layer, `<name> <held> <locked>`, where `held` is `-` for a layer the move judges
 * another way (a clone, a laid tree), `none` for no installed release, and `locked` is `none` when the lockfile names none. The lockfile's
 * IMPORTER entry answers, not a grep for `<package>@`, because a transitive `screenreader-worker@0.9.0` sits in the same file.
 */
function installedReadFor(manifest: Manifest): string {
  const reads = Object.entries(manifest.layers).flatMap(([name, layer]) => {
    const published = publishedOf(name, layer);
    if (!published || !LAYER_REF.test(layer.path) || layer.path.includes("..")) return [];
    const where = `${CONTROL_PLANE_CHECKOUT_PATH}/${layer.path}`;
    const file = `${CONTROL_PLANE_CHECKOUT_PATH}/node_modules/${published.package}/package.json`;
    const lock = `${CONTROL_PLANE_CHECKOUT_PATH}/pnpm-lock.yaml`;
    return [`( if [ -d ${where}/.git ] || { [ -f ${where}/.layer-ref ] && [ -d ${where}/src ]; }; then held=-; `
      + `else held=$(sed -n 's/^ *"version": *"\\([^"]*\\)".*/\\1/p' ${file} 2>/dev/null | head -n 1); fi; `
      + `locked=$(grep -A2 "^      '${published.package}':" ${lock} 2>/dev/null `
      + `| sed -n 's/^ *version: *\\([0-9][0-9.]*\\).*/\\1/p' | head -n 1); `
      + `printf '%s %s %s\\n' ${name} "\${held:-none}" "\${locked:-none}" )`];
  });
  return reads.join("; ");
}

/**
 * What `installedReadFor`'s output says, as the move will judge it. A REFUSAL only where the plane's HEAD already holds the lockfile that
 * declares the release and `node_modules/` does not: that is the state `pnpm install` repairs and the move cannot, so the run would be spent
 * for nothing. Where the plane's HEAD is itself behind (its lockfile is not the declared release, or names none), the move is what brings it
 * forward and an install before it would install the OLD lockfile, so that is a NOTE and the run proceeds to the move's own judgement.
 * A layer the read gave no line for is refused rather than read as in step: absence is not agreement.
 */
function installedJudged(manifest: Manifest, output: string): { refusal: string | null; notes: string[]; } {
  const rows = new Map(output.split("\n").map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length === 3).map(([name, held, locked]) => [name, { held, locked }]));
  const refusals: string[] = [];
  const notes: string[] = [];
  for (const [name, layer] of Object.entries(manifest.layers)) {
    const published = publishedOf(name, layer);
    if (!published) continue;
    const row = rows.get(name);
    const label = `layer ${name} (${published.package})`;
    if (!row) { refusals.push(`${label}: the read of ${CONTROL_PLANE_CHECKOUT_PATH} returned no line for it, so its installed release is not known`); continue; }
    if (row.held === "-" || row.held === published.version) continue;
    const said = `${label}: ${row.held === "none" ? "no release is installed" : `installed ${row.held}`} under ${CONTROL_PLANE_CHECKOUT_PATH}/node_modules, `
      + `the plane's lockfile resolves ${row.locked === "none" ? "no release" : row.locked}, deploy-pins.json declares ${published.version}`;
    if (row.locked === published.version) refusals.push(said);
    else notes.push(`${said}: the plane's checkout is behind the declaration, so the move comes first and its layer judgement will then refuse until pnpm install --frozen-lockfile is run in ${CONTROL_PLANE_CHECKOUT_PATH}`);
  }
  if (refusals.length === 0) return { refusal: null, notes };
  return { refusal: `REFUSING before the control plane is written to: ${refusals.join("; ")}. `
    + `Run pnpm install --frozen-lockfile in ${CONTROL_PLANE_CHECKOUT_PATH} (a write to the plane that this command does not make), then run again.`, notes };
}

/**
 * A clone is moved to the pin. TAGS ARE FETCHED, because a release's commit can be only a tag: `screenreader-worker` v0.4.0 is a version
 * commit that no branch holds, and `git fetch origin` (heads only) left `git checkout` to die with "reference is not a tree" (#4150).
 */
function clonedMove({ path, sha }: { path: string; sha: string; }): string {
  // `cd` names the checkout's own export, which is the form `control-plane-checkout-is-one-fact.test.ts` reads.
  return `cd ${CONTROL_PLANE_CHECKOUT_PATH}/${path} && git fetch --quiet --tags origin && git checkout --quiet --detach ${sha} `
    + `&& test "$(git rev-parse HEAD)" = ${sha}`;
}

/**
 * A laid tree has no `.git`, so the commit it holds is the one its `.layer-ref` tag names on the layer's remote (the LAST `ls-remote` line, which
 * peels an annotated tag to its commit; `tasks/lab-layer-checkouts.yml` reads it the same way). It is accepted when that is the pin and refused
 * when it is not, naming the layer, the `.layer-ref` and the pin. The tag is held to the lab's pattern before it is asked for.
 */
function laidJudgement({ name, sha, where, remote }: { name: string; sha: string; where: string; remote: string; }): string {
  const refuse = (text: string) => `{ echo "REFUSING: layer ${name} ${text}" >&2; exit 4; }`;
  return `tag=$(cat ${where}/.layer-ref); `
    + `{ printf '%s' "$tag" | grep -Eq '^[A-Za-z0-9@][A-Za-z0-9._/@-]{0,99}$' && case "$tag" in *..*) false;; esac; } `
    + `|| ${refuse(`is laid at ${where} and its .layer-ref does not hold a tag: $tag`)}; `
    + `refs=$(git ls-remote --tags '${remote}' "refs/tags/$tag" "refs/tags/$tag^{}") `
    + `|| ${refuse(`is laid at ${where} and git ls-remote of ${remote} failed`)}; `
    + `have=$(printf '%s\\n' "$refs" | tail -n 1 | cut -f 1); `
    + `[ "$have" = ${sha} ] || ${refuse(`is laid at ${where}: its .layer-ref names the tag $tag, which is `
      + `\${have:-not on ${remote}}, and the pin is ${sha}. Pin the commit that tag names, or lay the layer at the pin's tag.`)}`;
}

function refused(refusal: string): { pins: Record<string, string>; refusal: string; } {
  return { pins: {}, refusal: `refusing ${refusal}` };
}

/**
 * What a layer's ref may look like on the lab and on the control plane: `run-job.yml`'s `lab_ref` pattern, as a
 * value, so a test can hold the two spellings equal. A ref is a plain name or a commit, never a path out.
 */
export const LAYER_REF = /^[A-Za-z0-9._/-]{1,100}$/;

/**
 * The resolver over the real `deploy-pins.json`, built at first use and not at import: a checkout without the file still loads every
 * module that imports this one, and the first thing that asks a layer a question gets the refusal naming the file.
 */
let real: ReturnType<typeof layersFrom> | undefined;
const declared = () => (real ??= layersFrom({ manifest: manifestOf(readDeployPins()), root: REPO_ROOT }));

export const layerDeclaration: ReturnType<typeof layersFrom>["layerDeclaration"] = (name) => declared().layerDeclaration(name);
export const layerRoot: ReturnType<typeof layersFrom>["layerRoot"] = (name) => declared().layerRoot(name);
export const layerSourceDir: ReturnType<typeof layersFrom>["layerSourceDir"] = (name) => declared().layerSourceDir(name);
export const layerCodeVersion: ReturnType<typeof layersFrom>["layerCodeVersion"] = (name) => declared().layerCodeVersion(name);
export const separateLayers: ReturnType<typeof layersFrom>["separateLayers"] = () => declared().separateLayers();
export const layerPins: ReturnType<typeof layersFrom>["layerPins"] = (given) => declared().layerPins(given);
export const layerCheckoutMove: ReturnType<typeof layersFrom>["layerCheckoutMove"] = (pins) => declared().layerCheckoutMove(pins);
export const layerOwning: ReturnType<typeof layersFrom>["layerOwning"] = (path) => declared().layerOwning(path);
export const installedLayersRead: ReturnType<typeof layersFrom>["installedLayersRead"] = () => declared().installedLayersRead();
export const installedLayersJudged: ReturnType<typeof layersFrom>["installedLayersJudged"] = (output) => declared().installedLayersJudged(output);

/**
 * Every `--layer-ref=<name>=<sha>`, in order. REPEATABLE, which `flagValue` (first match only) is not: one
 * layer per flag, so the pair grows by a flag per layer rather than by a packed value.
 */
export function layerRefValues(argv: string[]): string[] {
  const prefix = "--layer-ref=";
  return argv.filter((argument) => argument.startsWith(prefix)).map((argument) => argument.slice(prefix.length));
}

/** The playbooks that move a guest's checkout and so hold a layer's second half of the pair (#3395). */
export const LAYER_PINNED = ["deploy.yml", "provision-role.yml"];

/**
 * The refusal for `--layer-ref` on a playbook that pins no layer, or for a layer left unpinned on one that does;
 * else the pins. Silently dropping a pin the operator typed is the failure `refuseUnknownFlags` exists to end.
 */
export function layerPinsFor({ chosen, given }: { chosen: string; given: string[]; }): { pins: Record<string, string>; refusal: string | null; } {
  if (!LAYER_PINNED.includes(chosen)) {
    return { pins: {}, refusal: given.length
      ? `refusing --layer-ref with --playbook=${chosen}: only ${LAYER_PINNED.join(" and ")} pin a layer.` : null };
  }
  return layerPins(given);
}

/**
 * The one `-e` that carries the layers' half of the commit pair, or "" when no layer has its own repository.
 * Single-quoted for the remote shell that parses this string; `layerPins` has already restricted every name to
 * `[a-z0-9-]` and every sha to 40 hex digits, so nothing that reaches here can close the quote.
 *
 * @param {Record<string, string>} pins a value that has passed `layerPinsFor`
 * @returns {string} the argv fragment, leading space included, or ""
 */
export function layerCommitsExtraVars(pins: Record<string, string>): string {
  if (!Object.keys(pins).length) return "";
  return ` -e '${JSON.stringify({ a11y_layer_commits: pins })}'`;
}
