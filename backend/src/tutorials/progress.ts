import { prisma } from "../prisma.js";
import { roleFor } from "../services/permissions.js";

/** A progress key: the welcome tour on one kind of device, or one form's tutorial. */
export const PROGRESS_KEY_RE = /^(site:(desktop|touch)|form:[A-Za-z0-9_-]{1,64})$/;

export const formKey = (formId: string) => `form:${formId}`;

/**
 * Who has finished or skipped a form's tutorial, and where the skippers left —
 * for whoever builds it (the MCP server's tutorial_progress). Counts, plus the
 * most recent people by name: staff, not residents.
 */
export async function formTutorialProgress(formId: string, opts: { limit?: number } = {}) {
  const rows = await prisma.tutorialProgress.findMany({
    where: { key: formKey(formId) },
    orderBy: { updatedAt: "desc" },
    include: { user: { select: { name: true, roleKey: true } } },
  });
  const byVersion = new Map<number, { completed: number; skipped: number }>();
  const skippedAt = new Map<number, number>();
  for (const r of rows) {
    const v = byVersion.get(r.version) ?? { completed: 0, skipped: 0 };
    if (r.status === "completed") v.completed++;
    else {
      v.skipped++;
      if (r.step !== null) skippedAt.set(r.step, (skippedAt.get(r.step) ?? 0) + 1);
    }
    byVersion.set(r.version, v);
  }
  return {
    people: rows.length,
    completed: rows.filter((r) => r.status === "completed").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    byVersion: [...byVersion.entries()].sort((a, b) => b[0] - a[0]).map(([version, n]) => ({ version, ...n })),
    /** 0-based step → how many people skipped the tutorial there. */
    skippedAtStep: Object.fromEntries([...skippedAt.entries()].sort((a, b) => a[0] - b[0])),
    recent: rows.slice(0, opts.limit ?? 25).map((r) => ({
      name: r.user.name,
      role: roleFor(r.user.roleKey).name,
      status: r.status,
      version: r.version,
      ...(r.status === "skipped" && r.step !== null ? { stoppedAtStep: r.step, of: r.steps } : {}),
      at: r.updatedAt.toISOString(),
    })),
  };
}
