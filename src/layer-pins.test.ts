/**
 * `deploy-pins.json` AND ITS READER (ADR 0045 cut 7, a11ign/a11ign#5085): what control deploys, declared by control, and a pin that is
 * COMPARED before anything is unpacked.
 *
 * The row's Acceptance runs this file with rstest's own API and no config (`pnpm exec rstest run src/layer-pins.test.ts`), which is why it
 * imports `@rstest/core` and not `node:test`: control's default run carries no `node:test` shim.
 *
 * The tarballs here are small ones built in a scratch directory with the system `tar`, and `pack` is injected, so no registry is asked: the
 * REAL release's digest is checked by hand and quoted in the pull request, not by a test that fails when a network does.
 */
import { afterAll, describe, expect, test } from "@rstest/core";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commitOfTag, integrityOf, integrityRefusal, parseDeployPins, playbookLayerListName, pinnedTag, publishedCommits, readDeployPins,
  releaseTag, resolvePublished, stagePublished, type DeployPins, type Extract, type Pack,
} from "./layer-pins.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REAL_TEXT = readFileSync(join(ROOT, "deploy-pins.json"), "utf8");

const scratch: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "layer-pins-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

/** A package as the registry serves it: one `package/` directory in a gzipped tar. `files` are written under it. */
function tarballOf(name: string, files: Record<string, string>): string {
  const dir = newDir();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, "package", path, ".."), { recursive: true });
    writeFileSync(join(dir, "package", path), text);
  }
  const out = join(dir, `${name}.tgz`);
  const made = spawnSync("tar", ["-czf", out, "-C", dir, "package"], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`tar could not build the fixture: ${made.stderr}`);
  return out;
}

const WORKER_FILES = {
  "package.json": JSON.stringify({ name: "@a11ign/screenreader-worker", version: "1.0.0", type: "module", exports: { "./code-version": "./dist/code-version.mjs" } }),
  "dist/code-version.mjs": "export const codeVersion = () => 'fixture-code-version';\n",
};
const FLEET_FILES = {
  "package.json": JSON.stringify({ name: "@a11ign/screenreader-fleet", version: "2.0.0", type: "module" }),
  "dist/doctor.mjs": "import { codeVersion } from '@a11ign/screenreader-worker/code-version';\nprocess.stdout.write(codeVersion());\n",
};

const REMOTE = "https://example.invalid/layer.git";
const pinsFor = (tarballs: { worker: string; fleet: string; }, integrity?: { worker?: string; fleet?: string; }): DeployPins => ({
  layers: {
    "nvda-worker": { package: "@a11ign/screenreader-worker", version: "1.0.0", integrity: integrity?.worker ?? integrityOf(readFileSync(tarballs.worker)), path: "packages/nvda-worker", remote: REMOTE },
    "screenreader-fleet": { package: "@a11ign/screenreader-fleet", version: "2.0.0", integrity: integrity?.fleet ?? integrityOf(readFileSync(tarballs.fleet)), path: "packages/worker-fleet", remote: REMOTE },
  },
});

/** A `pack` that hands back the fixture tarballs by spec, and records what it was asked for. */
function packFrom(tarballs: Record<string, string>): { pack: Pack; asked: string[]; } {
  const asked: string[] = [];
  return { asked, pack: (spec) => { asked.push(spec); return spec in tarballs ? { tarball: tarballs[spec] } : { failed: `E404 ${spec}` }; } };
}

const fixture = () => {
  const worker = tarballOf("worker", WORKER_FILES);
  const fleet = tarballOf("fleet", FLEET_FILES);
  return { worker, fleet, byName: { "@a11ign/screenreader-worker@1.0.0": worker, "@a11ign/screenreader-fleet@2.0.0": fleet } };
};

describe("the pins are compared before anything is unpacked", () => {
  test("POSITIVE CONTROL: a pins file whose integrity matches unpacks, and the packages sit as node_modules/@a11ign/<name>", () => {
    const made = fixture();
    const into = newDir();
    const staged = stagePublished({ pins: pinsFor(made), into, pack: packFrom(made.byName).pack });
    expect("refusal" in staged).toBe(false);
    if ("refusal" in staged) return;
    expect(staged.dirs["nvda-worker"]).toBe(join(into, "node_modules/@a11ign/screenreader-worker"));
    expect(readFileSync(join(staged.dirs["nvda-worker"], "dist/code-version.mjs"), "utf8")).toContain("fixture-code-version");
    expect(existsSync(join(staged.dirs["screenreader-fleet"], "package.json"))).toBe(true);
    expect(existsSync(join(staged.dirs["nvda-worker"], "package"))).toBe(false); // the tarball's own `package/` directory is stripped
  });

  test("NEGATIVE CONTROL: a tarball whose integrity differs is refused BY NAME and nothing is unpacked", () => {
    const made = fixture();
    const into = newDir();
    const unpacked: string[] = [];
    const extract: Extract = (tarball) => { unpacked.push(tarball); return null; };
    const wrong = integrityOf(Buffer.from("not the release"));
    const staged = stagePublished({ pins: pinsFor(made, { fleet: wrong }), into, pack: packFrom(made.byName).pack, extract });
    expect("refusal" in staged).toBe(true);
    if (!("refusal" in staged)) return;
    expect(staged.refusal).toContain("layer screenreader-fleet");
    expect(staged.refusal).toContain("@a11ign/screenreader-fleet@2.0.0");
    expect(staged.refusal).toContain(wrong);
    expect(staged.refusal).toContain(integrityOf(readFileSync(made.fleet)));
    expect(staged.refusal).not.toContain("layer nvda-worker");
    expect(unpacked).toEqual([]); // the worker verified, and still was not unpacked: the pair lands or neither does
    expect(existsSync(join(into, "node_modules"))).toBe(false);
  });

  test("every layer that does not match is named in the one refusal", () => {
    const made = fixture();
    const wrong = integrityOf(Buffer.from("x"));
    const staged = stagePublished({ pins: pinsFor(made, { worker: wrong, fleet: wrong }), into: newDir(), pack: packFrom(made.byName).pack });
    expect("refusal" in staged && staged.refusal.includes("layer nvda-worker") && staged.refusal.includes("layer screenreader-fleet")).toBe(true);
  });

  test("a registry that cannot serve the version is a refusal naming the layer, not a pass", () => {
    const made = fixture();
    const staged = stagePublished({ pins: pinsFor(made), into: newDir(), pack: packFrom({ "@a11ign/screenreader-worker@1.0.0": made.worker }).pack });
    expect("refusal" in staged).toBe(true);
    if (!("refusal" in staged)) return;
    expect(staged.refusal).toContain("layer screenreader-fleet");
    expect(staged.refusal).toContain("could not be fetched");
  });

  test("a verified tarball that cannot be unpacked is a refusal that says so", () => {
    const made = fixture();
    const staged = stagePublished({ pins: pinsFor(made), into: newDir(), pack: packFrom(made.byName).pack, extract: () => "tar: short read" });
    expect("refusal" in staged && staged.refusal.includes("could not be unpacked") && staged.refusal.includes("short read")).toBe(true);
  });

  test("integrityRefusal compares the whole digest: one changed byte, and a digest of another length, are both refusals", () => {
    const bytes = Buffer.from("release");
    const good = integrityOf(bytes);
    expect(integrityRefusal({ layer: "x", spec: "p@1.0.0", bytes, integrity: good })).toBeNull();
    expect(integrityRefusal({ layer: "x", spec: "p@1.0.0", bytes, integrity: good.slice(0, -4) })).not.toBeNull();
    expect(integrityRefusal({ layer: "x", spec: "p@1.0.0", bytes: Buffer.from("releasf"), integrity: good })).not.toBeNull();
  });

  test("the fleet's own bare-name import of the worker resolves from the unpacked pair, with nothing installed", () => {
    const made = fixture();
    const into = newDir();
    const staged = stagePublished({ pins: pinsFor(made), into, pack: packFrom(made.byName).pack });
    expect("dirs" in staged).toBe(true);
    if (!("dirs" in staged)) return;
    const ran = spawnSync(process.execPath, [join(staged.dirs["screenreader-fleet"], "dist/doctor.mjs")], { encoding: "utf8" });
    expect(ran.stderr).toBe("");
    expect(ran.stdout).toBe("fixture-code-version");
  });
});

describe("resolvePublished: the commits are offered only for pins that verified", () => {
  const git = (calls: string[][]) => (args: string[]) => {
    calls.push(args);
    const tag = args.find((arg) => arg.startsWith("refs/tags/") && !arg.endsWith("^{}"))?.slice("refs/tags/".length) ?? "";
    return { status: 0, stdout: `${"a".repeat(40)}\trefs/tags/${tag}\n`, stderr: "" };
  };

  test("a verified pair answers the commits and the directories", () => {
    const made = fixture();
    const calls: string[][] = [];
    const resolved = resolvePublished({ pins: pinsFor(made), into: newDir(), git: git(calls), pack: packFrom(made.byName).pack });
    expect("commits" in resolved).toBe(true);
    if (!("commits" in resolved)) return;
    expect(resolved.commits).toEqual({ "nvda-worker": "a".repeat(40), "screenreader-fleet": "a".repeat(40) });
    expect(Object.keys(resolved.dirs)).toEqual(["nvda-worker", "screenreader-fleet"]);
    expect(calls.length).toBe(2);
  });

  test("a pin that does not verify asks git nothing and returns no commit", () => {
    const made = fixture();
    const calls: string[][] = [];
    const resolved = resolvePublished({ pins: pinsFor(made, { worker: integrityOf(Buffer.from("x")) }), into: newDir(), git: git(calls), pack: packFrom(made.byName).pack });
    expect("refusal" in resolved).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a tag the remote holds no commit for is a refusal naming the layer, the tag and the remote", () => {
    const made = fixture();
    const empty = () => ({ status: 0, stdout: "", stderr: "" });
    const resolved = publishedCommits({ pins: pinsFor(made), git: empty });
    expect("refusal" in resolved && resolved.refusal.includes("layer nvda-worker") && resolved.refusal.includes("holds no tag v1.0.0")).toBe(true);
    expect("refusal" in resolved && resolved.refusal.includes(REMOTE)).toBe(true);
    expect(commitOfTag({ remote: REMOTE, tag: "v1.0.0", git: () => ({ status: 128, stdout: "", stderr: "fatal" }) })).toEqual({ failed: "fatal" });
  });
});

describe("the declaration", () => {
  test("the real file parses, declares the worker and the fleet, and every integrity is a sha512", () => {
    const pins = readDeployPins();
    expect(Object.keys(pins.layers)).toEqual(["nvda-worker", "screenreader-fleet"]);
    for (const layer of Object.values(pins.layers)) expect(layer.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(pinnedTag(pins, "screenreader-fleet")).toEqual({ tag: `v${pins.layers["screenreader-fleet"].version}` });
    expect(pins.lab?.tag).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test("a declaration that cannot be read is refused by name, never defaulted", () => {
    const real = JSON.parse(REAL_TEXT) as { layers: Record<string, Record<string, unknown>>; lab: Record<string, unknown>; };
    const worker = real.layers["nvda-worker"];
    const refused = (mutate: (copy: typeof real) => void): string => {
      const copy = JSON.parse(REAL_TEXT) as typeof real;
      mutate(copy);
      const read = parseDeployPins(JSON.stringify(copy));
      return "refusal" in read ? read.refusal : "ACCEPTED";
    };
    expect("refusal" in parseDeployPins("[")).toBe(true);
    expect(refused((copy) => { copy.layers = {}; })).toMatch(/declares no layers/);
    expect(refused((copy) => { copy.layers["nvda-worker"].version = "^0.13.0"; })).toMatch(/exact x\.y\.z/);
    expect(refused((copy) => { copy.layers["nvda-worker"].integrity = `sha1-${"A".repeat(27)}=`; })).toMatch(/not a sha512 digest/);
    expect(refused((copy) => { copy.layers["nvda-worker"].path = "../elsewhere"; })).toMatch(/plain relative path/);
    expect(refused((copy) => { copy.layers["nvda-worker"].package = "left-pad"; })).toMatch(/@a11ign/);
    expect(refused((copy) => { copy.layers["nvda-worker"].remote = ""; })).toMatch(/remote is missing/);
    expect(refused((copy) => { copy.lab.tag = "main"; })).toMatch(/not a v<semver> tag/);
    expect(refused(() => {})).toBe("ACCEPTED"); // positive control: the unmutated copy is read
    expect(worker.package).toBe("@a11ign/screenreader-worker");
  });

  test("releaseTag names the tag a repository really made: v<semver> from its first flat release, the scoped form before", () => {
    expect(releaseTag("@a11ign/screenreader-worker", "0.13.0")).toBe("v0.13.0");
    expect(releaseTag("@a11ign/screenreader-worker", "0.2.0")).toBe("@a11ign/screenreader-worker@0.2.0");
    expect(releaseTag("@a11ign/screenreader-fleet", "0.5.2")).toBe("@a11ign/screenreader-fleet@0.5.2");
    expect(releaseTag("@a11ign/screenreader-fleet", "0.5.3")).toBe("v0.5.3");
    expect(releaseTag("@a11ign/scorer", "0.5.0")).toBe("@a11ign/scorer@0.5.0");
  });

  test("the playbooks' own layer list, which the old path still reads, names the same layers at the same paths and remotes", () => {
    const task = readFileSync(join(ROOT, "ansible/tasks/read-layer-checkouts.yml"), "utf8");
    const list = JSON.parse(readFileSync(join(ROOT, playbookLayerListName(task)), "utf8")) as { layers: Record<string, { path: string; remote?: string; }>; };
    const pins = readDeployPins();
    expect(Object.keys(list.layers).sort()).toEqual(Object.keys(pins.layers).sort());
    for (const [name, layer] of Object.entries(pins.layers)) {
      expect({ path: list.layers[name].path, remote: list.layers[name].remote }).toEqual({ path: layer.path, remote: layer.remote });
    }
  });

  test("playbookLayerListName reads the name off the task and refuses a task that names none", () => {
    expect(playbookLayerListName("x: \"{{ (lookup('file', playbook_dir ~ '/../some-list.json') | from_json) }}\"")).toBe("some-list.json");
    expect(() => playbookLayerListName("nothing here")).toThrow(/names no file/);
  });
});

describe("control stays dependency-free", () => {
  // The manifest CI lays at `packages/control` keeps `dependencies` and drops `scripts` (`ci.yml`), so this is the half that holds there and here;
  // the commands are pinned against the real manifest in `scripts/control-commands.test.ts`, which runs in this repository's own `pnpm test`.
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name?: string; dependencies?: Record<string, string>; };

  test("`dependencies` is still empty (ADR 0012): pinning the worker and the fleet did not declare them", () => {
    expect(manifest.name).toBe("@a11ign/control"); // positive control: this is the package's manifest
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
