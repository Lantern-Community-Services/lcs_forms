/**
 * "Back" for a page another screen opened (?back=/apps/case-management&backLabel=Case Management):
 * a form opened for a resident from a case manager's board, or an entry opened to sign. A path in
 * this app only, never another site; the label is plain text.
 */
export function backFrom(search: URLSearchParams | string): { to: string; label: string } | null {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const to = q.get("back") ?? "";
  if (!/^\/(?!\/)[^\s\\]*$/.test(to)) return null;
  const label = (q.get("backLabel") ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return { to, label: label ? `Back to ${label}` : "Back" };
}
