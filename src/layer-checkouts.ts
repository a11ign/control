// @ts-check
/**
 * WHERE A LAYER'S CODE LIVES ON THIS HOST, asked of one place (ADR 0039 item 6, #3394).
 *
 * The control plane reads the worker's code version to decide whether the fleet runs the right build, and it
 * used to find the worker by a relative path into its source directory. Control runs from a raw checkout
 * with no `node_modules` (ADR 0012), so it cannot use the package name; and once the layer leaves this
 * repository, a reader that guessed the monorepo path would compare the fleet against the WRONG tree and
 * still print a hash. `layers.json` declares each layer and its path, and this module is the only reader.
 *
 * REFUSES rather than falls back. An undeclared layer, or a declared one whose directory is not there, throws
 * naming the layer and the path: answering with the monorepo path instead is the silent wrong answer this
 * exists to remove.
 *
 * Imports only `node:` modules, so `control-has-no-dependencies.test.ts` holds. `layerCodeVersion` therefore
 * imports the layer's own `code-version.mjs` DYNAMICALLY, from the resolved directory: still the one hasher,
 * and a static import would name the path this module exists to hide.
 *
 * A layer that lives in its OWN repository declares a `remote`, and a guest then holds a second checkout of it
 * pinned to its own commit (ADR 0039 item 6, row 6b, #3395): `separateLayers` names those, and `layerPins`
 * turns the operator's `--layer-ref=<name>=<sha>` flags into the pair's second half, refusing a missing pin, a
 * short sha and a layer that has no repository of its own. The guest plays read the SAME manifest themselves
 * (`ansible/tasks/read-layer-checkouts.yml`), so the two cannot name different layers.
 *
 * THE CONTROL PLANE AND THE LAB MOVE THE LAYER'S CHECKOUT BESIDE THE CORE'S (row 6c, #3396). `layerCheckoutMove`
 * is the control plane's half: the shell that puts each separate layer's checkout on its pinned commit and reads
 * the commit back, REFUSING (exit 4) where the checkout is not there rather than leaving the core's tree to
 * answer for it. The lab's half is `ansible/tasks/run-job.yml` and `lab-reset.yml`, which read the same
 * manifest and validate a layer's ref with `LAYER_REF`, which is `lab_ref`'s own pattern. With no layer that
 * declares a `remote`, every one of them is a no-op, which is the state today.
 *
 * A HOST THAT HAS INSTALLED HOLDS A SEPARATE LAYER LAID, NOT CLONED (#3819): `scripts/lay-layer.mjs` replaces the clone with `src/`
 * and `.layer-ref`. The lab's and the guests' tasks accept that shape, and so does `layerCheckoutMove` (#4150): the control plane's
 * checkout DOES install now (it holds `packages/worker-fleet` laid), and the comment that said it never would stopped the first
 * `fleet:deploy --layer-ref` at the pre-flight, before the playbook. A laid layer has no history to move, so it is not moved: it is
 * ACCEPTED when the commit its `.layer-ref` tag names on the layer's remote is the pin, and refused, naming both, when it is not.
 * A directory with neither a `.git` nor a `.layer-ref` beside `src/` is the core's own tree at that path and still refuses.
 *
 * `worker-fleet` does NOT use this: it is published and `control` never is
 * (`worker-fleet-does-not-read-control.test.ts`), so its readers ask the worker package by name instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("../layers.json", import.meta.url), "utf8"));

/**
 * Where the control plane's own code is laid, when `layers.json` declares `pinned.control` (#3914): `packages/control` is then a laid
 * copy of `a11ign/control` at a tag and no part of this repository's tree (#3506). Null while it declares none, which is every
 * checkout until that lands, so nothing that reads it changes before then.
 */
function laidControlOf({ manifest, root }: { manifest: { pinned?: Record<string, { path: string; }>; }; root: string; }): { name: string; path: string; dir: string; } | null {
  const declared = manifest.pinned && Object.hasOwn(manifest.pinned, CONTROL_LAYER) ? manifest.pinned[CONTROL_LAYER] : undefined;
  return declared ? { name: CONTROL_LAYER, path: declared.path, dir: resolve(root, declared.path) } : null;
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
export function layersFrom({ manifest, root }: { manifest: { layers: Record<string, { path: string; remote?: string; branch?: string; package?: string; }>; pinned?: Record<string, { path: string; tag?: string; }>; }; root: string; }) {
  /**
   * What `layers.json` declares for a layer, WITHOUT asking whether its directory is there: the refusal for a
   * missing clone has to name where the clone goes, and `layerRoot` throws before it can.
   */
  function layerDeclaration(name: string): { name: string; path: string; remote: string | undefined; package: string | undefined; dir: string; } {
    const layer = Object.hasOwn(manifest.layers, name) ? manifest.layers[name] : undefined;
    if (!layer) {
      throw new Error(`layer "${name}" is not declared in packages/control/layers.json `
        + `(declared: ${Object.keys(manifest.layers).join(", ") || "none"})`);
    }
    return { name, path: layer.path, remote: layer.remote, package: layer.package, dir: resolve(root, layer.path) };
  }

  /** The layer's directory: where its `package.json` and its `src/` are. */
  function layerRoot(name: string) {
    const { path, dir } = layerDeclaration(name);
    if (!existsSync(dir)) {
      throw new Error(`layer "${name}" is declared at ${path}, and ${dir} does not exist: `
        + "check it out there, or correct its path in packages/control/layers.json");
    }
    return dir;
  }

  /** The layer's source directory, the one `codeVersion` hashes. Trailing slash, as `workerSourceDir()`. */
  const layerSourceDir = (name: string) => `${join(layerRoot(name), "src")}/`;

  /** The layer's code hash, computed by the layer's own hasher. */
  async function layerCodeVersion(name: string) {
    const hasher = await import(pathToFileURL(join(layerSourceDir(name), "code-version.mjs")).href);
    return hasher.codeVersion(layerSourceDir(name));
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

  /** The laid control, or null while `layers.json` declares none (`laidControlOf`). */
  const laidControl = () => laidControlOf({ manifest, root });

  /**
   * The layer whose directory holds `path` (repo-relative): a separate layer, or the laid control, or null when it is the core's.
   * A file of a layer's is not tracked by this repository, so "does `git ls-files` list it" cannot be the question asked of it (#3845).
   */
  function layerOwning(path: string): string | null {
    const separate = separateLayers().map((name) => ({ name, path: manifest.layers[name].path }));
    return owningLayer(path, [...separate, laidControl()]);
  }

  return { layerDeclaration, layerRoot, layerSourceDir, layerCodeVersion, separateLayers, layerPins, layerCheckoutMove, layerOwning, laidControl };
}

/** The key of the control plane's own code in `layers.json`'s `pinned` section: the one pinned layer the closure of `fleet:auto-off` runs from (#3914). */
export const CONTROL_LAYER = "control";

/** What a declared tag looks like: `scripts/lay-layer.mjs`'s `DECLARED_TAG`, which this directory cannot import (ADR 0012). A branch or a sha is not a pin. */
const DECLARED_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * The tag a `pinned` layer is laid at, read from the text of a `layers.json` (`origin/main`'s, for the stale-checkout guard): the
 * declaration's own `tag`, which is what `scripts/lay-layer.mjs`'s `tagToLay` lays. A manifest that is not JSON, a layer it does
 * not pin, or a tag that is not `v<semver>` is a refusal, never a default.
 *
 *
 * @param {string} layer a key of `layers.json`'s `pinned`
 */
export function pinnedLayerTag(manifestText: string, layer: string): { tag: string; } | { refusal: string; } {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (cause) {
    return { refusal: `layers.json is not JSON (${cause instanceof Error ? cause.message : cause})` };
  }
  const pinned = manifest?.pinned;
  const declared = pinned && typeof pinned === "object" && Object.hasOwn(pinned, layer) ? pinned[layer] : undefined;
  if (declared === undefined) return { refusal: `layers.json declares no pinned layer ${layer}` };
  if (typeof declared.tag !== "string" || !DECLARED_TAG.test(declared.tag)) {
    return { refusal: `layers.json pins ${layer} at ${JSON.stringify(declared.tag)}, which is not a v<semver> tag: a branch or a sha is not a pin` };
  }
  return { tag: declared.tag };
}

/**
 * THE FIRST VERSION AT WHICH A LAYER'S REPOSITORY TAGS `v<semver>` rather than `<package>@<version>`: a SECOND COPY of `BARE_TAGS_FROM` in
 * `scripts/lay-layer.mjs`, because `control` imports nothing outside its own directory (ADR 0012). `layer-checkouts.test.ts` fails when
 * the two disagree, wherever the core's file is reachable. The table is the REPOSITORY's, not the version's: `screenreader-worker` moved
 * to `v<semver>` at 0.3.0 and `screenreader-fleet` at 0.5.3, so a rule on the version alone would break one of them (#4363).
 */
const BARE_TAGS_FROM: Record<string, [number, number, number]> = { "@a11ign/screenreader-worker": [0, 3, 0], "@a11ign/screenreader-fleet": [0, 5, 3] };

/** `scripts/lay-layer.mjs`'s `releaseTag` over again: `v<version>` once the package's repository tags that way, `<package>@<version>` before. */
export function releaseTag(name: string, version: string): string {
  const from = Object.hasOwn(BARE_TAGS_FROM, name) ? BARE_TAGS_FROM[name] : undefined;
  if (from === undefined) return `${name}@${version}`;
  const [major, minor, patch] = version.split(".").slice(0, 3).map(Number);
  const atOrAfter = major !== from[0] ? major > from[0] : minor !== from[1] ? minor > from[1] : patch >= from[2];
  return atOrAfter ? `v${version}` : `${name}@${version}`;
}

/**
 * The tag a layer is laid at, read from the text of the core's `pnpm-lock.yaml`: `scripts/lay-layer.mjs`'s `pinnedVersion` and
 * `layingPlan` over again, because `control` imports nothing outside its own directory (ADR 0012) and that script imports the guards.
 * `fleet-auto-off.test.ts` holds the two readings equal on the real lockfile, so they cannot name two builds (#3845).
 * The tag is the one the layer's repository really made (`releaseTag`), not always `<package>@<version>` (#4363).
 * A lockfile with no registry entry for the layer is a refusal, never a default.
 *
 *
 * @param {string} layer a key of `layers.json`
 */
export function layerPinTag(lockfile: string, layer: string): { tag: string; } | { refusal: string; } {
  const name = `@a11ign/${layer}`;
  const entry = new RegExp(`^ {6}'${name.replace(/[/.]/g, "\\$&")}':\\r?\\n {8}specifier: [^\\r\\n]+\\r?\\n {8}version: ([^\\r\\n]+)$`, "m");
  const block = lockfile.match(entry);
  if (!block) return { refusal: `pnpm-lock.yaml has no importer entry for ${name}` };
  const version = block[1].replace(/\(.*$/, "");
  if (!/^\d+\.\d+\.\d+/.test(version)) return { refusal: `${name} is "${version}" in pnpm-lock.yaml, not a registry release: there is no tag to lay` };
  return { tag: releaseTag(name, version) };
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
function checkoutMoveFor(manifest: { layers: Record<string, { path: string; remote?: string; branch?: string; }>; }, pins: Record<string, string>): string {
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
 * not an option. `layers.json` declares an https URL; a path is let through so a test can stand a local repository in for it.
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

const declared = layersFrom({ manifest: MANIFEST, root: REPO_ROOT });
export const layerDeclaration = declared.layerDeclaration;
export const layerRoot = declared.layerRoot;
export const layerSourceDir = declared.layerSourceDir;
export const layerCodeVersion = declared.layerCodeVersion;
export const separateLayers = declared.separateLayers;
export const layerPins = declared.layerPins;
export const layerCheckoutMove = declared.layerCheckoutMove;
export const layerOwning = declared.layerOwning;
export const laidControl = declared.laidControl;

/**
 * Every `--layer-ref=<name>=<sha>`, in order. REPEATABLE, which `flagValue` (first match only) is not: one
 * layer per flag, so the pair grows by a flag per layer rather than by a packed value.
 */
export function layerRefValues(argv: string[]): string[] {
  const prefix = "--layer-ref=";
  return argv.filter((argument) => argument.startsWith(prefix)).map((argument) => argument.slice(prefix.length));
}

/** The playbooks that move a guest's checkout and so hold a layer's second half of the pair (#3395). */
const LAYER_PINNED = ["deploy.yml", "provision-role.yml"];

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
