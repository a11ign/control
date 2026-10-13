Row a11ign/a11ign#5335: control's `CORE_REF` lays a core whose lockfile exports screenreader-fleet's `git-safe-env`. Names no workflow's behaviour beyond the pin, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c 'cd /home/agent/repos/wt-5335-control && sha=$(sed -n "s/^  CORE_REF: //p" .github/workflows/ci.yml) && printf "%s\n" "$sha" | grep -Eq "^[0-9a-f]{40}$" && gh api "repos/a11ign/a11ign/contents/pnpm-lock.yaml?ref=$sha" -H "Accept: application/vnd.github.raw" | grep -q "screenreader-fleet@0\.1[0-9]" && echo "OK $sha"'
```

The row's own command reads `origin/main`'s `ci.yml`, so it can only pass once this merges; this one reads the PR's file, which is what the merge will make `origin/main`'s. Same lockfile read, same regex, plus the full-sha shape `scripts/ci-composition.test.ts` holds.

## Before / after (measured 2026-10-13)

- `origin/main`'s `ci.yml` (`CORE_REF: b6d3cbd7616dd68d52726a5c63201f453d0ead62`, a11ign#4820's merge): the core's lockfile at that sha has `'@a11ign/screenreader-fleet@0.7.3'`; the check exits `1`.
- This head (`CORE_REF: c5dddb33d622e547945289b690510fa223ebcb79`, a11ign#5334's merge, which closed a11ign#5330): the core's lockfile has `'@a11ign/screenreader-fleet@0.11.0'`; the check prints `OK c5dddb33…` and exits `0`.
- `node --test scripts/ci-composition.test.ts`: 11 tests, 11 pass, 0 fail (the pin is a full sha and the checkout uses it).

## Mutation (the pin put back, then restored)

The edit is one value, so the mutation is the old value: with `CORE_REF` reset to `b6d3cbd7…` the check fails (exit `1`, shown above as the "before" reading); with it at `c5dddb33…` it passes. Neither direction trips the composition test, which holds the shape and not the sha.

## What changed

- `.github/workflows/ci.yml`: `CORE_REF` moves to `c5dddb33d622e547945289b690510fa223ebcb79`, with its comment line in the file's style.
- This file.

## Not done here

- control#79 is not rebased: that is a11ign#5312's, which waits on this row.
- No changeset: `.github/workflows/` is not among the `releasable-paths` (`src/ ansible/ layers.json deploy-pins.json`).
- The core's own CI at that sha was not run here; the lockfile is read, not installed.
