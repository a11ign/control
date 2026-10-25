/**
 * WHO HOLDS A BOX, behind one small interface (A11-243). Two jobs of this service never run on the same box, because the worker refuses a second
 * capture (`429 a capture is already in progress`). This is the only place that is decided: A11-244 replaces `memoryClaims` with fleet-wide leases
 * that also cover `fleet:deploy`, `fleet:provision` and the drift check, and the runner does not change.
 */
export interface BoxClaims {
  /** Take every box for the job, or none: the answer names who holds the ones that are taken. */
  tryClaim(jobId: string, boxes: string[]): { claimed: true } | { claimed: false; heldBy: Record<string, string> };
  release(jobId: string): void;
  /** Box -> the job that holds it. */
  held(): Record<string, string>;
}

export function memoryClaims(): BoxClaims {
  const holders = new Map<string, string>();
  return {
    tryClaim(jobId, boxes) {
      const heldBy = Object.fromEntries(boxes.flatMap((box) => {
        const holder = holders.get(box);
        return holder !== undefined && holder !== jobId ? [[box, holder]] : [];
      }));
      if (Object.keys(heldBy).length) return { claimed: false, heldBy };
      for (const box of boxes) holders.set(box, jobId);
      return { claimed: true };
    },
    release(jobId) {
      for (const [box, holder] of holders) if (holder === jobId) holders.delete(box);
    },
    held: () => Object.fromEntries(holders),
  };
}
