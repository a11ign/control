import { caseRecordFile, groupOf } from "./cases.ts";
import { recordFile } from "./pages.ts";
import { FACTS_PAGE } from "./types.ts";
import type { CaptureEntry, CaseSpec, GroupSpec } from "./types.ts";

/** A pass needs a box of its own: two passes of a page on one box would be one measurement taken twice. */
export function passesRefusal(boxes: number, passes: number): string | null {
  return passes > boxes
    ? `${passes} passes need ${passes} different boxes and only ${boxes} ${boxes === 1 ? "is" : "are"} given: the passes of a page never share a box`
    : null;
}

/**
 * Pass `k` of page `i` goes to box `(i + k - 1) mod n`, as `capture_fleet.py`'s `plan()` does: every box gets the same share, and the passes of
 * a page fall on different boxes whenever `passes <= n`. PURE.
 */
export function planCaptures(pages: string[], boxes: string[], passes: number): CaptureEntry[] {
  return pages.flatMap((page, i) => Array.from({ length: passes }, (_, k) => ({
    page, pass: k + 1, file: recordFile(page, k + 1), box: boxes[(i + k) % boxes.length]!, status: "pending" as const,
  })));
}

/**
 * Give a dropped box's unfinished captures to the boxes that are left. A capture goes to the box with the fewest unfinished captures that holds no
 * other pass of the same page; where no such box is left it goes to the least loaded one, because a finished job with two passes on one box is
 * better than a job that does not finish. PURE: returns the captures it moved.
 */
export function reassign(captures: CaptureEntry[], from: string, live: string[]): CaptureEntry[] {
  const moved: CaptureEntry[] = [];
  if (!live.length) return moved;
  const unfinished = (box: string) => captures.filter((c) => c.box === box && (c.status === "pending" || c.status === "dispatched")).length;
  for (const capture of captures.filter((c) => c.box === from && c.status === "pending")) {
    const rivals = new Set(captures.filter((c) => c.page === capture.page && c !== capture).map((c) => c.box));
    const apart = live.filter((box) => !rivals.has(box));
    const pool = apart.length ? apart : live;
    capture.box = pool.reduce((best, box) => unfinished(box) < unfinished(best) ? box : best);
    moved.push(capture);
  }
  return moved;
}

/**
 * Place a job of cases. A group is held to ONE box, so whole groups are placed: pinned ones on their box first, then the rest largest first, each on
 * the box with the fewest cases so far (the first such box on a tie). A box's entries are emitted group by group, in file order, so the runner's "next
 * pending capture on this box" finishes one group before it starts the next. PURE.
 */
export function planCases(cases: CaseSpec[], groups: Record<string, GroupSpec>, boxes: string[]): CaptureEntry[] {
  const byGroup = new Map<string, CaseSpec[]>();
  for (const entry of cases) byGroup.set(groupOf(entry), [...(byGroup.get(groupOf(entry)) ?? []), entry]);
  const placed = new Map<string, string[]>(boxes.map((box) => [box, []]));
  const load = (box: string): number => placed.get(box)!.reduce((sum, group) => sum + byGroup.get(group)!.length, 0);
  const pinned = [...byGroup.keys()].filter((group) => groups[group]?.box !== undefined);
  const free = [...byGroup.keys()].filter((group) => groups[group]?.box === undefined).sort((a, b) => byGroup.get(b)!.length - byGroup.get(a)!.length);
  for (const group of pinned) {
    const box = groups[group]!.box!;
    if (!placed.has(box)) throw new Error(`group ${group} is pinned to ${box}, which the job does not have`);
    placed.get(box)!.push(group);
  }
  for (const group of free) {
    const box = boxes.reduce((best, candidate) => load(candidate) < load(best) ? candidate : best);
    placed.get(box)!.push(group);
  }
  return boxes.flatMap((box) => placed.get(box)!.flatMap((group) => byGroup.get(group)!.map((entry) => ({
    page: entry.url, pass: 1, case: entry.id, group, attempt: entry.attempt ?? 1, file: caseRecordFile(entry.id, entry.attempt ?? 1), box, status: "pending" as const,
  }))));
}

/** A facts job reads each box once, on that box: one entry per box, whose record is `<box>.facts.json`. PURE. */
export const planFacts = (boxes: string[]): CaptureEntry[] =>
  boxes.map((box) => ({ page: FACTS_PAGE, pass: 1, file: `${box}.facts.json`, box, status: "pending" as const }));
