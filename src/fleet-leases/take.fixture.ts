/**
 * ONE PROCESS TAKING A BOX FROM THE LEDGER, for the mutex test (A11-244): `node take.fixture.ts <ledger path> <id> <box>...` prints the answer as JSON.
 * Test support only; the service never imports it.
 */
import { LeaseLedger } from "./ledger.ts";

const [path, id, ...boxes] = process.argv.slice(2);
const answer = new LeaseLedger(path!).tryTake({ id: id!, holder: `h:${id}`, kind: "capture", label: id!, boxes });
process.stdout.write(`${JSON.stringify({ id, taken: answer.taken })}\n`);
