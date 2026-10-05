# Changesets

A change that should be released carries a changeset: `pnpm exec changeset`, naming `@a11ign/control` and the size of the change.

**Merging one to `main` IS the release.** `.github/workflows/release.yml` waits for `ci.yml`'s `gate` on that sha, builds a release commit on top of the merge (the version bumped, the changeset consumed into `packages/control/CHANGELOG.md`), and pushes it as the tag `v<version>` with a GitHub Release carrying the entry. Nothing is published to a registry, no token is used and nothing is pushed to `main`.
