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

  /** The layer's code hash, computed by the layer's own hasher. */
  async function layerCodeVersion(name: string) {
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

  /**
   * The layer whose directory holds `path` (repo-relative): a separate layer, or null when it is the core's.
   * A file of a layer's is not tracked by this repository, so "does `git ls-files` list it" cannot be the question asked of it (#3845).
   */
  function layerOwning(path: string): string | null {
    const separate = separateLayers().map((name) => ({ name, path: manifest.layers[name].path }));
    return owningLayer(path, separate);
  }

  return { layerDeclaration, layerRoot, layerSourceDir, layerCodeVersion, separateLayers, layerPins, layerCheckoutMove, layerOwning };
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
    return layerMoveShell({ name, sha, path: layer.path, remote: layer.remote });
  }).join("");
}

/**
 * What a layer's `remote` may look like once it is inside the single quotes of `git ls-remote`: no quote, space, `$` or backtick, and
 * not an option. `deploy-pins.json` declares an https URL; a path is let through so a test can stand a local repository in for it.
 */
const REMOTE_URL = /^[A-Za-z0-9/][A-Za-z0-9._:/@-]*$/;

/**
 * One layer's move, for whichever shape it is held in: a clone is fetched (tags too) and put on the pin, a laid tree is judged against
 * it, anything else refuses. The three are one `if` so exactly one of them speaks.
 */
function layerMoveShell({ name, sha, path, remote }: { name: string; sha: string; path: string; remote: string; }): string {
  const where = `${CONTROL_PLANE_CHECKOUT_PATH}/${path}`;
  const refusal = `echo "REFUSING: layer ${name} is declared at ${path} and ${where} is neither a git checkout nor a laid tree `
    + "(.layer-ref beside src/); the core's tree does not stand in for it.\" >&2; exit 4";
  return ` && ( if [ -d ${where}/.git ]; then ${clonedMove({ path, sha })}; `
    + `elif [ -f ${where}/.layer-ref ] && [ -d ${where}/src ]; then ${laidJudgement({ name, sha, where, remote })}; `
    + `else ${refusal}; fi ) `;
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
