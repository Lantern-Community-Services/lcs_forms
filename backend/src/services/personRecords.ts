import { prisma } from "../prisma.js";
import { notFound } from "../http.js";
import { currentUserById } from "../auth/middleware.js";
import { entryReachOf, fillBlocker } from "../forms/entries.js";
import { readDoc } from "../forms/service.js";
import { DEFAULT_ENTRY_READERS, roleAllowed } from "../apps/project.js";
import { manifestOf } from "./routing.js";
import { allGroups, canUseBuiltForm, entryReach } from "./staffGroups.js";
import { isFollowUpDoer, loadFollowUp } from "./followUp.js";
import { roleFor, roleNameFor } from "./permissions.js";

/**
 * People & roles → a person → Records (Super Admins, people.records): what
 * they filed on every form, the follow-ups they did and the ones waiting on
 * them, what they were told and emailed, what they changed, and which forms
 * they can open and how many of each form's entries they see.
 *
 * Read only. Entries are listed (form, when, site, status), not opened here:
 * each links to its own page, where the entry's own rules apply.
 */

const LIMIT = 50;

export async function personRecords(idOrEmail: string, opts: { form?: string; before?: string } = {}) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ id: idOrEmail }, { email: idOrEmail.toLowerCase() }] },
    include: { sites: { include: { site: { select: { name: true } } } } },
  });
  if (!user) throw notFound("No such person.");
  const viewer = await currentUserById(user.id);
  const role = roleFor(user.roleKey);

  const entryWhere = {
    createdById: user.id,
    ...(opts.form ? { formId: opts.form } : {}),
    ...(opts.before ? { createdAt: { lt: new Date(opts.before) } } : {}),
  };
  const [entries, perForm, done, notifications, emails, activity] = await Promise.all([
    prisma.formEntry.findMany({
      where: entryWhere,
      orderBy: { createdAt: "desc" },
      take: LIMIT + 1,
      select: { id: true, createdAt: true, siteId: true, status: true, followUp: true, form: { select: { id: true, slug: true, title: true, kind: true } } },
    }),
    prisma.formEntry.groupBy({ by: ["formId"], where: { createdById: user.id }, _count: { _all: true } }),
    // Done follow-ups are recorded by name.
    prisma.formEntry.findMany({
      where: { followUp: "done", followUpDoneByName: user.name },
      orderBy: { followUpDoneAt: "desc" },
      take: LIMIT,
      select: { id: true, followUpDoneAt: true, followUpNote: true, createdByName: true, form: { select: { slug: true, title: true, kind: true } } },
    }),
    prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, title: true, sourceLabel: true, createdAt: true, readAt: true, urgent: true, emailStatus: true, link: true },
    }),
    prisma.emailLog.findMany({ where: { to: user.email }, orderBy: { createdAt: "desc" }, take: LIMIT }),
    prisma.auditEvent.findMany({ where: { actorId: user.id }, orderBy: { createdAt: "desc" }, take: LIMIT, select: { id: true, action: true, summary: true, createdAt: true } }),
  ]);

  const sites = await prisma.site.findMany({ select: { id: true, name: true } });
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const forms = await prisma.builtForm.findMany({ where: { status: { not: "archived" } }, orderBy: { title: "asc" } });
  const formTitle = new Map(forms.map((f) => [f.id, f.title]));

  // Open follow-ups this person is one of the people for.
  const waiting: { id: string; form: { slug: string; title: string }; createdAt: Date; createdByName: string }[] = [];
  for (const f of forms.filter((x) => x.kind === "basic")) {
    const s = await loadFollowUp(f);
    if (!s.enabled) continue;
    const open = await prisma.formEntry.findMany({ where: { formId: f.id, status: "active", followUp: "open" }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true, siteId: true, createdAt: true, createdByName: true } });
    for (const e of open) if (await isFollowUpDoer(f, user.id, e, s)) waiting.push({ id: e.id, form: { slug: f.slug, title: f.title }, createdAt: e.createdAt, createdByName: e.createdByName });
  }

  // Which forms they can open, and how much of each one's entries they see.
  const access = viewer
    ? forms
        .filter((f) => f.status === "published" || f.status === "closed")
        .map((f) => {
          if (f.kind === "code") {
            const m = manifestOf(f);
            const dev = viewer.permissions.includes("apps.develop") || viewer.permissions.includes("forms.manage");
            const canOpen = Boolean(m) && roleAllowed(m!.access?.roles, viewer.roleKey, dev) && canUseBuiltForm(viewer, f.id);
            return { id: f.id, slug: f.slug, title: f.title, kind: f.kind, canOpen, entries: canOpen ? (dev ? "all" : entryReach(f.id, m!.entries?.read ?? DEFAULT_ENTRY_READERS, viewer)) : null };
          }
          const doc = readDoc(f.liveSchema ?? f.draftSchema);
          const canOpen = !fillBlocker(f, doc, viewer) && canUseBuiltForm(viewer, f.id);
          return { id: f.id, slug: f.slug, title: f.title, kind: f.kind, canOpen, entries: canOpen ? entryReachOf(f, doc, viewer) : null };
        })
    : [];

  const groupNames = new Map(allGroups().map((g) => [g.id, g.name]));
  const more = entries.length > LIMIT;
  const shown = entries.slice(0, LIMIT);
  return {
    person: {
      id: user.id,
      name: user.name,
      email: user.email,
      title: user.title,
      role: roleNameFor(role, user),
      status: user.status,
      sites: role.allSites ? ["Every site"] : user.sites.filter((s) => s.approved).map((s) => s.site.name),
      groups: (viewer?.groupIds ?? []).map((g) => groupNames.get(g) ?? g),
      lastSignInAt: user.lastSignInAt,
      createdAt: user.createdAt,
      active: Boolean(viewer),
    },
    entries: {
      items: shown.map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        site: e.siteId ? siteName.get(e.siteId) ?? null : null,
        status: e.status,
        followUp: e.followUp,
        form: e.form,
        url: e.form.kind === "code" ? `/apps/${e.form.slug}` : `/f/${e.form.slug}/entries/${e.id}`,
      })),
      nextBefore: more ? shown[shown.length - 1].createdAt.toISOString() : null,
      perForm: perForm.map((p) => ({ formId: p.formId, title: formTitle.get(p.formId) ?? "A deleted form", count: p._count._all })).sort((a, b) => b.count - a.count),
    },
    followUps: {
      done: done.map((d) => ({ id: d.id, doneAt: d.followUpDoneAt, note: d.followUpNote, filedBy: d.createdByName, form: d.form, url: `/f/${d.form.slug}/entries/${d.id}` })),
      waiting: waiting.map((w) => ({ ...w, url: `/f/${w.form.slug}/entries/${w.id}` })),
    },
    notifications,
    emails,
    activity,
    access,
  };
}
