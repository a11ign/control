import { readFileSync } from "node:fs";

/** A workflow with its comment lines dropped: the files explain WHY they lack a thing in words that would match it. */
export function codeOf(workflow: string): string {
  return workflow
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

export const workflowCode = (name: string): string => codeOf(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
