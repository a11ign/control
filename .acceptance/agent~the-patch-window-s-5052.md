Closes a11ign/a11ign#5052's Done-when 1 on merge; `.layer-ref` is not moved (a11ign#5051's).

Acceptance:

```bash
cd /home/agent/repos/wt-5052-control && pnpm exec rstest run src/fleet-layer/patch-playbook.test.ts
```

**As run (2026-10-11):** 17 tests in the file print `✔`, none `✖` (the trailing rstest summary reports 0 suites for this `node:test` file, as it does for the row's own command). Both controls are in `a11ign#4979 POSITIVE`.

## What changed

- `ansible/patch.yml`: `patch_safeos_pattern` is `\$WINDOWS\.~BT` alone.
- `src/fleet-layer/patch-playbook.test.ts`: `BCD_WITHOUT` carries the recovery entry (`description Windows Recovery Environment`, `device ramdisk=[C:]\Recovery\WindowsRE\Winre.wim`, `winpe Yes`). POSITIVE refuses it as before. NEGATIVE-control assertion added: recovery entry plus `BCD_WITH_SAFEOS` passes. `BCD_WITH_SAFEOS` unchanged.
- `.changeset/the-patch-window-s-staged-5052.md`: outside the Region; `ci.yml` requires a changeset.

## Mutation (`cp` before, `cp` after, restored)

- Restoring `|SafeOS|winpe\s+Yes` to the pattern: `✖ a11ign#4979 POSITIVE: an Upgrades item staged with no SafeOS entry fails the box...`; the NEGATIVE test stays green. Unmutated: all pass.

## Not done here

- Nothing live was read (resource ban). Making the box switch is a11ign#5051.

Closes a11ign/a11ign#5052
