// The published `sandboxGitEnv`, under a name the git-spawn rule recognises. `packages/guards/src/git-spawn-scrubbed.ts` matches an
// import by the tail of its specifier, and `@a11ign/screenreader-fleet/git-safe-env` ends in none of its names, so a file importing the
// subpath directly was reported at every spawn it made (#5312, CI `local/git-spawn-scrubbed`). The helper is the same one; each spawn
// still calls `sandboxGitEnv()`.
export { sandboxGitEnv } from "@a11ign/screenreader-fleet/git-safe-env";
