/** The longest wait `fleet job wait` accepts. There is no unbounded form: a number above this is refused, not clamped. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `90s`, `30m`, `2h`: a whole number and one unit. Anything else (`0`, `1.5h`, `30`, `forever`) is a refusal naming the shape. */
export function parseDuration(text: string): { ms: number } | { refusal: string } {
  const match = /^([0-9]+)([smh])$/.exec(text);
  if (!match) return { refusal: `a duration is a whole number and a unit, such as 90s, 30m or 2h: ${JSON.stringify(text)} is not one` };
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (ms < 1000) return { refusal: `a duration must be at least 1s: ${text}` };
  if (ms > MAX_WAIT_MS) return { refusal: `a wait is at most 24h, and there is no way to wait without a limit: ${text}` };
  return { ms };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
