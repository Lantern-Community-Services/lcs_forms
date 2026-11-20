/**
 * Checks for putting the device's copy of a form's unfinished answers together
 * with the drafts in the person's account (src/components/formkit/draftReconcile.ts).
 *
 *   node scripts/draft-reconcile-check.mjs
 *
 * Needs Node 22.18+ / 23.6+ (it loads the .ts file with Node's own type stripping).
 * Exits non-zero on the first failed check.
 */
import { draftLabelOf, reconcileDrafts, valuesForAccount } from "../src/components/formkit/draftReconcile.ts";

let passed = 0;
function check(cond, what) {
  if (!cond) {
    console.error(`✗ ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${what}`);
}

let n = 0;
const newId = () => `new-${++n}`;
const T1 = "2026-11-18T15:00:00.000Z";
const T2 = "2026-11-19T15:00:00.000Z";
const T3 = "2026-11-20T15:00:00.000Z";
const server = (id, updatedAt, extra = {}) => ({ id, label: `Label ${id}`, siteCode: null, page: 0, formVersion: 1, writer: "w-server", createdAt: T1, updatedAt, ...extra });
const local = (extra = {}) => ({ values: { notes: "on the device" }, savedAt: Date.parse(T3), startedAt: Date.parse(T1), label: "Pat Example", ...extra });

// Nothing anywhere.
let r = reconcileDrafts(null, [], newId);
check(r.choices.length === 0 && r.push === null && !r.dropLocal, "nothing on the device or the account: nothing to offer");

// Only the account's.
r = reconcileDrafts(null, [server("a", T1), server("b", T2)], newId);
check(r.choices.map((c) => c.id).join() === "b,a", "the account's drafts are offered newest first");
check(r.choices.every((c) => !c.fromDevice) && r.push === null, "…fetched from the account, nothing sent up");

// The device's copy is the account's draft, unchanged since.
r = reconcileDrafts(local({ draftId: "a", base: T2, pending: false }), [server("a", T2), server("b", T1)], newId);
check(r.push === null && r.choices.find((c) => c.id === "a")?.fromDevice === true, "in step with the account: offered from the device (it keeps signatures), nothing sent");

// Changed on this device only.
r = reconcileDrafts(local({ draftId: "a", base: T2, pending: true }), [server("a", T2)], newId);
check(r.push?.id === "a" && r.push.base === T2, "newer on this device: sent up over the account's copy, from the save it last saw");
check(r.choices.length === 1 && r.choices[0].fromDevice && r.choices[0].label === "Pat Example", "…and offered once, from the device");

// Changed elsewhere only.
r = reconcileDrafts(local({ draftId: "a", base: T1, pending: false }), [server("a", T2)], newId);
check(r.push === null && r.choices.length === 1 && !r.choices[0].fromDevice, "changed on another device, not here: the account's copy wins");

// Changed both here and elsewhere.
r = reconcileDrafts(local({ draftId: "a", base: T1, pending: true, writer: "w-this-device" }), [server("a", T2, { writer: "w-other" })], newId);
check(r.choices.length === 2, "changed here and elsewhere: both are offered");
check(r.push && r.push.id !== "a" && r.push.base === null && r.push.draft.draftId === r.push.id, "…this device's goes up as a separate new draft");
check(r.choices.some((c) => c.id === "a" && !c.fromDevice) && r.choices.some((c) => c.id === r.push.id && c.fromDevice), "…the other device's stays as it is");

// The last save was this device's own, sent as the page closed (no answer came back).
r = reconcileDrafts(local({ draftId: "a", base: T1, pending: true, writer: "w-page" }), [server("a", T2, { writer: "w-page" })], newId);
check(r.push?.id === "a" && r.push.base === T2 && r.choices.length === 1, "the account's newer save was this device's own: not a conflict, sent over it");

// Filed or discarded on another device.
r = reconcileDrafts(local({ draftId: "gone", base: T1, pending: true }), [server("b", T2)], newId);
check(r.dropLocal && r.push === null && r.choices.length === 1 && r.choices[0].id === "b", "the account no longer has it (filed or discarded elsewhere): the device's copy is dropped");

// Never got to the account.
r = reconcileDrafts(local({ draftId: "made-offline", base: null, pending: true }), [], newId);
check(r.push?.id === "made-offline" && r.push.base === null && r.choices[0]?.id === "made-offline", "made offline and never saved to the account: sent up under its own id");
r = reconcileDrafts(local(), [server("b", T1)], newId);
check(r.push && r.push.id.startsWith("new-") && r.push.draft.draftId === r.push.id, "kept before account drafts existed (no id): sent up as a new draft");
check(r.choices[0].fromDevice && r.choices[0].id === r.push.id && r.choices[1].id === "b", "…offered first (newest), beside the account's");

// Unusable copies are ignored.
r = reconcileDrafts({ values: { a: 1 }, savedAt: 1 }, [server("b", T1)], newId);
check(r.push === null && r.choices.length === 1, "a device copy without a start time isn't a draft");

// What goes to the account.
const doc = {
  fields: [
    { id: "notes", type: "textarea", label: "Notes" },
    { id: "who", type: "resident", label: "Resident" },
    { id: "sig", type: "signature", label: "Signature" },
    { id: "att", type: "file", label: "File" },
    { id: "rows", type: "repeater", label: "Rows", fields: [{ id: "t", type: "text", label: "T" }] },
  ],
};
const { values: v, dropped } = valuesForAccount(doc, { notes: "n", who: { id: "r1", name: "Jordan Sample" }, sig: "data:image/png;base64,AAA", att: [{ id: "f" }], rows: [{ t: "x" }] });
check(v.notes === "n" && v.who?.name === "Jordan Sample", "answers go to the account");
check(!("sig" in v) && !("att" in v) && v.rows[0].t === "x", "signatures and files stay on the device; repeater rows go");
check(dropped === true && valuesForAccount(doc, { notes: "n", sig: "", att: [] }).dropped === false, "…and it says so only when one was answered");
check(draftLabelOf(doc, { who: { id: "r1", name: "  Jordan Sample " } }) === "Jordan Sample", "a draft is named after the resident picked");
check(draftLabelOf(doc, { notes: "n" }) === "Draft", "…else it's \"Draft\"");

console.log(`\n${passed} checks passed.`);
