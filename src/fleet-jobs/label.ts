/**
 * THE LABEL A FLEET JOB IS BOOKED UNDER (A11-244, A11-263): the ticket key it is for. One spelling, because the service, `lab:job`, `lab:pipeline` and the qualified-run poster
 * each refuse a label that is not this, and a fact stated four times is the one whose copies drift. `lab-job.yml` states it once more in Jinja, which `lab-job.test.ts` pins equal.
 */
export const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
export const validLabel = (label: unknown): boolean => LABEL.test(String(label ?? ""));
export const LABEL_WORDS = "letters, digits, '.', '_' and '-', at most 64";
