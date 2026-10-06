import { prisma } from "../prisma.js";
import type { CurrentUser } from "../auth/middleware.js";
import { access, loadApp, runAction, type LoadedApp } from "./runtime.js";
import { roleAllowed } from "./project.js";

/**
 * Code forms on the Forms home. A form that sets form.json "home": { "action": "home" }
 * has that server action run as the person whenever the home screen loads; what it
 * returns becomes "Needs your attention" items and stat tiles that open the form.
 *
 *   { attention: [{ title, detail, action, page, params, tone }], tiles: [{ label, value, hint, page, params }] }
 *
 * Each answer is kept a minute per person, and a form that's slow or fails is
 * simply left out, so one broken form can't hold up the home screen.
 */

export interface AppAttentionItem {
  id: string;
  kind: "app";
  icon: string | null;
  formTitle: string;
  tone: "warn" | "info";
  title: string;
  detail: string;
  action: string;
  href: string;
}

export interface AppTile {
  id: string;
  icon: string | null;
  formTitle: string;
  label: string;
  value: string;
  hint: string | null;
  href: string;
}

const MAX_FORMS = 12;
const PER_FORM_MS = 4000;
const TTL_MS = 60_000;

/** Published builds don't change without a new version, so keep each one parsed. */
const apps = new Map<string, { version: number; app: LoadedApp }>();
const answers = new Map<string, { at: number; value: { attention: AppAttentionItem[]; tiles: AppTile[] } }>();

const text = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "");

function hrefFor(slug: string, page: unknown, params: unknown) {
  const p = typeof page === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(page) ? `/${page}` : "";
  const q = new URLSearchParams();
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>).slice(0, 10)) if (v !== null && v !== undefined) q.set(k.slice(0, 40), String(v).slice(0, 200));
  }
  const qs = q.toString();
  return `/apps/${slug}${p}${qs ? `?${qs}` : ""}`;
}

function shape(app: LoadedApp, value: unknown) {
  const v = (value && typeof value === "object" ? value : {}) as { attention?: unknown; tiles?: unknown };
  const slug = app.form.slug;
  const formTitle = app.manifest.title;
  const icon = app.manifest.icon ?? null;
  const attention: AppAttentionItem[] = (Array.isArray(v.attention) ? v.attention : []).slice(0, 5).flatMap((raw, i) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const title = text(a.title, 140);
    if (!title) return [];
    return [{
      id: `app:${slug}:${i}`,
      kind: "app" as const,
      icon,
      formTitle,
      tone: a.tone === "warn" ? ("warn" as const) : ("info" as const),
      title,
      detail: text(a.detail, 240) || formTitle,
      action: text(a.action, 30) || "Open",
      href: hrefFor(slug, a.page, a.params),
    }];
  });
  const tiles: AppTile[] = (Array.isArray(v.tiles) ? v.tiles : []).slice(0, 3).flatMap((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const label = text(t.label, 40);
    const value = text(t.value, 20);
    if (!label || !value) return [];
    return [{ id: `app:${slug}:tile:${i}`, icon, formTitle, label, value, hint: text(t.hint, 60) || null, href: hrefFor(slug, t.page, t.params) }];
  });
  return { attention, tiles };
}

async function cardsFor(formId: string, version: number, user: CurrentUser) {
  const key = `${user.userId}:${formId}:${version}`;
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let cached = apps.get(formId);
  if (!cached || cached.version !== version) {
    const form = await prisma.builtForm.findUnique({ where: { id: formId } });
    if (!form) return null;
    cached = { version, app: await loadApp(form, false) };
    apps.set(formId, cached);
  }
  const app = cached.app;
  const home = app.manifest.home;
  if (!home) return null;
  const isDev = user.permissions.includes("apps.develop" as never) || user.permissions.includes("forms.manage" as never);
  if (!access(app, user).canOpen || !roleAllowed(home.roles, user.roleKey, isDev)) return null;

  const r = await Promise.race([
    runAction(app, user, home.action, { home: true }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PER_FORM_MS)),
  ]);
  if (!r || !r.ok) {
    if (r && !r.ok) console.warn(`[apps] ${app.form.slug} home action failed: ${r.error}`);
    return null;
  }
  const value = shape(app, r.value);
  answers.set(key, { at: Date.now(), value });
  if (answers.size > 5000) answers.clear();
  return value;
}

/** Every code form's home cards for this person. */
export async function appHomeCards(user: CurrentUser) {
  const forms = await prisma.builtForm.findMany({
    where: { kind: "code", status: { in: ["published", "closed"] }, liveVersion: { gt: 0 }, homeAction: true },
    select: { id: true, liveVersion: true },
    orderBy: { title: "asc" },
    take: MAX_FORMS,
  });
  const results = await Promise.all(forms.map((f) => cardsFor(f.id, f.liveVersion, user).catch((err) => {
    console.warn(`[apps] home cards for ${f.id} failed:`, err);
    return null;
  })));
  return {
    attention: results.flatMap((r) => r?.attention ?? []),
    tiles: results.flatMap((r) => r?.tiles ?? []),
  };
}
