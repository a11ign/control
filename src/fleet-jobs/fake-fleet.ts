/**
 * A FLEET FOR THE JOB SERVICE'S TESTS: workers that answer as the real one does, and a resolver over them. Test support only; the service never
 * imports it. The fake worker speaks the worker's own routes (`/health`, `POST /capture` with `async: true`, `GET /capture/<id>`), refuses a second
 * capture with `429 a capture is already in progress` as the real one does, and counts the most captures it ever held at once, which is how a test
 * shows that two jobs never shared a box.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { BoxResolver } from "./boxes.ts";
import type { Box } from "./types.ts";

export type FakeWorker = Box & {
  /** The pages this worker was asked to capture, in order, and how many captures it ever held at once. */
  asked: string[];
  /** The body each capture was asked with, in order, as the worker received it, without the `captureId` and `async` the capture client adds. */
  bodies: Record<string, unknown>[];
  peak: number;
  close(): Promise<void>;
};

export type FakeWorkerOptions = {
  /** How long a capture takes before its answer is ready. */
  durationMs?: number;
  /** The HTTP status for a page, or undefined for 200. */
  statusOf?: (page: string) => number | undefined;
  /** `/health.environment`, so a test can make two boxes disagree. */
  environment?: Record<string, unknown>;
};

export async function fakeWorker(name: string, { durationMs = 0, statusOf, environment }: FakeWorkerOptions = {}): Promise<FakeWorker> {
  const results = new Map<string, { status: number; body: unknown }>();
  let running = 0;
  const worker: { asked: string[]; bodies: Record<string, unknown>[]; peak: number } = { asked: [], bodies: [], peak: 0 };
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { busy: running > 0, ready: true, code: `code-${name}`, environment: { windowsBuild: "26300.1", browserVersion: "156.0", screenReaderVersion: "2026.1", ...environment }, policy: {} });
    }
    if (req.method === "GET" && req.url?.startsWith("/capture/")) {
      const found = results.get(req.url.slice("/capture/".length));
      return found === undefined ? send(404, { error: "unknown capture" }) : found.status === 0 ? send(202, { state: "running" }) : send(found.status, found.body);
    }
    if (req.method === "POST" && req.url === "/capture") {
      let text = "";
      req.on("data", (chunk) => { text += chunk; });
      req.on("end", () => {
        const body = JSON.parse(text) as { url: string; captureId: string };
        if (running > 0) return send(429, { error: "a capture is already in progress" });
        running += 1;
        worker.peak = Math.max(worker.peak, running);
        worker.asked.push(body.url);
        const { captureId: _id, async: _async, ...asked } = body as Record<string, unknown>;
        worker.bodies.push(asked);
        results.set(body.captureId, { status: 0, body: null });
        setTimeout(() => {
          const status = statusOf?.(body.url) ?? 200;
          results.set(body.captureId, { status, body: status === 200 ? { transcript: [`spoke ${body.url}`], worker: name } : { error: `fault on ${body.url}` } });
          running -= 1;
        }, durationMs);
        send(202, { accepted: body.captureId });
      });
      return;
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return Object.assign(worker, {
    name, url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  });
}

/** A resolver over a fixed fleet: a count takes the first free boxes, `ready` every free one, a name its box. */
export function staticResolver(fleet: Box[]): BoxResolver {
  return {
    async known() { return fleet.map((box) => box.name); },
    async locate(names) {
      const found = fleet.filter((box) => names.includes(box.name));
      return { found, missing: names.filter((name) => !found.some((box) => box.name === name)) };
    },
    async choose(request, claimed) {
      const free = fleet.filter((box) => !claimed.has(box.name));
      if (request.kind === "named") {
        const boxes = request.names.map((name) => free.find((box) => box.name === name));
        return boxes.every(Boolean) ? { chosen: { boxes: boxes as Box[], short: false, notes: [] } } : { refusal: "a named box is not free" };
      }
      if (!free.length) return { refusal: "no box is free" };
      const boxes = request.kind === "ready" ? free : free.slice(0, request.count);
      return { chosen: { boxes, short: request.kind === "count" && boxes.length < request.count, notes: [] } };
    },
  };
}
