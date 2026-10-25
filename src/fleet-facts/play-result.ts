/**
 * WHAT `ansible-playbook` SAID ABOUT ONE BOX, from the JSON stdout callback (A11-283). PURE.
 *
 * The callback prints `{ plays: [{ tasks: [{ task: { name }, hosts: { <host>: <result> } }] }], stats: { <host>: { changed, failures, unreachable, ok } } }`.
 * The facts task puts what it read in the result's `result` (`$Ansible.Result`). A box the play never reached has no entry in `stats`: `--limit` on a name
 * that is not in the inventory matches no host and Ansible still exits 0, which is read here as a failure and never as a box with nothing to report.
 */
export const FACTS_TASK = "Read the box's hardware";

export type PlayRead = { changed: number; output: unknown };
export type PlayOutcome = { ok: true; read: PlayRead } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON document in the play's stdout: the whole of it, else from its first line of `{` to its last `}`, so a line a callback printed around it does not hide it. */
export function jsonOf(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch {
    const start = stdout.search(/^\{\s*$/m);
    const end = stdout.lastIndexOf("}");
    if (start < 0 || end < start) return undefined;
    try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return undefined; }
  }
}

const messageOf = (result: Obj): string => {
  const fields = [result.msg, result.error, result.host_err, result.stderr];
  const found = fields.find((field) => typeof field === "string" && field.trim());
  return typeof found === "string" ? found.trim().slice(0, 300) : "no message was given";
};

const hostResults = (document: Obj, box: string): { task: string; result: Obj }[] =>
  (Array.isArray(document.plays) ? document.plays : []).flatMap((play) =>
    (isObject(play) && Array.isArray(play.tasks) ? play.tasks : []).flatMap((entry) => {
      if (!isObject(entry) || !isObject(entry.hosts) || !isObject(entry.hosts[box])) return [];
      const name = isObject(entry.task) && typeof entry.task.name === "string" ? entry.task.name : "";
      return [{ task: name, result: entry.hosts[box] as Obj }];
    }));

/** What the box's facts task output: its `result` when that is an object, else the last item of its `output`, parsed when it is JSON text. */
function outputOf(result: Obj): unknown {
  if (isObject(result.result) && Object.keys(result.result).length) return result.result;
  const items = Array.isArray(result.output) ? result.output : [];
  const last = items[items.length - 1];
  if (typeof last === "string") { try { return JSON.parse(last); } catch { return undefined; } }
  return last;
}

export function playOutcome(stdout: string, box: string): PlayOutcome {
  const document = jsonOf(stdout);
  if (!isObject(document) || !isObject(document.stats)) return { ok: false, error: `the play printed no result for ${box}: ${stdout.trim().slice(0, 200) || "nothing on stdout"}` };
  const stats = document.stats[box];
  if (!isObject(stats)) return { ok: false, error: `the play reached no host named ${box}` };
  const results = hostResults(document, box);
  if (Number(stats.unreachable) > 0) {
    const why = results.find(({ result }) => result.unreachable === true);
    return { ok: false, error: `${box} was unreachable over ssh: ${why ? messageOf(why.result) : "no message was given"}` };
  }
  if (Number(stats.failures) > 0) {
    const why = results.find(({ result }) => result.failed === true);
    return { ok: false, error: `the play failed on ${box}${why ? ` at "${why.task}": ${messageOf(why.result)}` : ""}` };
  }
  const read = results.find(({ task }) => task === FACTS_TASK);
  const changed = Number(stats.changed);
  if (!read || !Number.isFinite(changed)) return { ok: false, error: `the play ran no "${FACTS_TASK}" task on ${box}` };
  return { ok: true, read: { changed, output: outputOf(read.result) } };
}
