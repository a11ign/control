import { fleetConsistency, describeMismatches, describeReportedOnly } from "@a11ign/screenreader-fleet/fleet-consistency";
import type { JobRequest, JobStateFile } from "./types.ts";

/** What `deploy-pins.json` says the fleet should be, as far as it could be read. A pin that cannot be read is stated, not defaulted. */
export type PinsReading = { pins: unknown } | { unreadable: string };

/**
 * `results/manifest.json`: written when the job starts and rewritten when it ends, so a job that dies between has still said what it was
 * going to do. It names each box with what its `/health` reported when the job began, the pinned versions the fleet is held to, whether the
 * boxes agree with each other (recorded; it does not refuse the job), and each capture. Boxes are named, never addressed.
 */
export function buildManifest({ request, state, pins }: { request: JobRequest; state: JobStateFile; pins: PinsReading }) {
  const guests = state.boxes.map((worker) => ({
    worker,
    ...(state.readings[worker]?.environment ? { environment: state.readings[worker]!.environment! } : {}),
    ...(state.readings[worker]?.policy ? { policy: state.readings[worker]!.policy! } : {}),
  }));
  const agreement = fleetConsistency(guests);
  return {
    version: 1,
    job: request.id,
    label: request.label,
    state: state.state,
    reason: state.reason ?? null,
    submittedAt: request.submittedAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? null,
    pages: request.pages,
    passes: request.passes,
    body: request.body,
    freeze: request.freeze ? { commit: request.freeze.commit, namedAt: request.freeze.namedAt } : null,
    pins,
    boxes: state.boxes.map((name) => {
      const reading = state.readings[name];
      const environment = reading?.environment ?? {};
      return {
        name,
        workerCode: reading?.code ?? null,
        windowsBuild: environment.windowsBuild ?? null,
        edge: environment.browserVersion ?? null,
        nvda: environment.screenReaderVersion ?? null,
        read: reading !== null && reading !== undefined,
      };
    }),
    dropped: state.dropped,
    agreement: { consistent: agreement.consistent, mismatches: describeMismatches(agreement.mismatches), reportedOnly: describeReportedOnly(agreement.reportedOnly), compared: agreement.compared },
    notes: state.notes,
    captures: state.captures.map(({ page, pass, file, box, status, startedAt, finishedAt, httpStatus, error, note }) =>
      ({ page, pass, file, box, status, startedAt: startedAt ?? null, finishedAt: finishedAt ?? null, httpStatus: httpStatus ?? null, error: error ?? null, note: note ?? null })),
  };
}
