Refs A11-253

Step 2 of 2 (control): `.github/dependabot.yml` is now the output of `dependabot-config --write` from `@a11ign/toolchain` 0.12.0 (^0.1.7 before), not a hand-written file. Every ecosystem runs weekly on Monday at 05:23 UTC, patch and minor updates share one `<ecosystem>-minor-and-patch` group so a major is its own pull request, and the packages frozen by policy are ignored in the npm entry. Toolchain is bumped from `^0.1.7` to `^0.12.0`. `scripts/dependabot-config.test.ts` fails when the committed file drifts, and when a layer of `deploy-pins.json` is not in the toolchain's frozen list.

Acceptance:

```bash
pnpm install --frozen-lockfile
# the committed file is exactly the template's output (exit 1 and a diff on drift)
pnpm exec dependabot-config --check
node --test scripts/dependabot-config.test.ts   # also: every layers.*.package of deploy-pins.json is in the toolchain's FROZEN list
# weekly at one fixed time, one group per ecosystem
grep -q 'interval: weekly' .github/dependabot.yml
grep -q 'time: "05:23"' .github/dependabot.yml
grep -q 'npm-minor-and-patch:' .github/dependabot.yml
grep -q 'github-actions-minor-and-patch:' .github/dependabot.yml
# every package frozen by policy is ignored
grep -qF 'dependency-name: "@a11ign/screenreader-worker"' .github/dependabot.yml
grep -qF 'dependency-name: "@a11ign/screenreader-fleet"' .github/dependabot.yml
grep -qF 'dependency-name: "@guidepup/guidepup"' .github/dependabot.yml
grep -qF 'dependency-name: "@guidepup/setup"' .github/dependabot.yml
```
