import { prisma } from "../prisma.js";

/**
 * Where case management starts: the Case Management board when a site has one
 * (the code form `case-management`, published), otherwise the Caseload screen.
 * The sidebar, the dock and search show one "Case Management" item that goes
 * here, old Caseload links land here, and the daily checklist reminders link
 * here, so staff have one place and never two that show the same paperwork.
 */

export const BOARD_SLUG = "case-management";
export const BOARD_PATH = `/apps/${BOARD_SLUG}`;
export const CASELOAD_PATH = "/caseload";

const TTL_MS = 60_000;
let cached: { at: number; board: boolean } | null = null;

/** Whether this site's Case Management board is published (cached a minute). */
export async function hasCaseBoard(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.board;
  const form = await prisma.builtForm.findUnique({ where: { slug: BOARD_SLUG }, select: { kind: true, status: true } });
  const board = Boolean(form && form.kind === "code" && form.status === "published");
  cached = { at: Date.now(), board };
  return board;
}

/** The path case management starts at: the board, or Caseload without one. */
export async function caseManagementHome(): Promise<string> {
  return (await hasCaseBoard()) ? BOARD_PATH : CASELOAD_PATH;
}

/** A link into case management with the board's filters (lead, status, site), or Caseload's nearest screen without a board. */
export async function caseManagementLink(board: Record<string, string>, fallback: string): Promise<string> {
  if (!(await hasCaseBoard())) return fallback;
  const q = new URLSearchParams(board).toString();
  return q ? `${BOARD_PATH}?${q}` : BOARD_PATH;
}
