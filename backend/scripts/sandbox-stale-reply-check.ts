/**
 * Checks that a host call's late reply never answers another call (security audit
 * run-1, lead 19). Job A's first call takes longer than the worker waits (10 s);
 * A gives up and ends. Job B then runs on the same pooled worker and makes a call
 * that's still waiting when A's late reply arrives. B must get its own answer.
 *
 *   npx tsx scripts/sandbox-stale-reply-check.ts      (about 15 seconds)
 */
import { runInSandbox } from "../src/apps/sandbox.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const callTwice = `
  const a = JSON.parse(__hostCall("first", "null"));
  const b = JSON.parse(__hostCall("second", "null"));
  globalThis.__out = JSON.stringify({ ok: true, value: [a, b] });
`;
const callOnce = `
  const a = JSON.parse(__hostCall("only", "null"));
  globalThis.__out = JSON.stringify({ ok: true, value: a });
`;

async function main() {
  const t0 = Date.now();
  // Job A: "first" answers after 11 s (the worker waits 10 s), "second" at once.
  const a = await runInSandbox({
    bundle: "",
    call: callTwice,
    timeoutMs: 30_000,
    onHost: async (name) => {
      if (name === "first") {
        await sleep(11_000);
        return "A-SECRET";
      }
      return "A-second";
    },
  });
  console.log(`job A done after ${Date.now() - t0} ms:`, JSON.stringify(a.ok ? (a as { value: unknown }).value : a));
  const aValue = (a as { value: unknown[] }).value;
  const sameJobOk = Array.isArray(aValue) && JSON.stringify(aValue[1]).includes("A-second") && !JSON.stringify(aValue[1]).includes("A-SECRET");

  // Job B, on the slot A just freed: its call is answered after 3 s, so A's late reply (at 11 s) lands while B waits.
  const b = await runInSandbox({
    bundle: "",
    call: callOnce,
    timeoutMs: 30_000,
    onHost: async () => {
      await sleep(3000);
      return "B-own";
    },
  });
  const bText = JSON.stringify(b.ok ? (b as { value: unknown }).value : b);
  console.log(`job B done after ${Date.now() - t0} ms:`, bText);
  const crossJobOk = bText.includes("B-own") && !bText.includes("A-SECRET");

  console.log(sameJobOk ? "PASS same job: A's second call got its own answer" : "FAIL same job");
  console.log(crossJobOk ? "PASS other job: B got its own answer, not A's late one" : "FAIL other job");
  process.exit(sameJobOk && crossJobOk ? 0 : 1);
}

void main();
