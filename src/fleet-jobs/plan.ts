import { recordFile } from "./pages.ts";
import type { CaptureEntry } from "./types.ts";

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
