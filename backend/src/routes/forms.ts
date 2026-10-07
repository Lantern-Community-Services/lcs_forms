import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler, badRequest, notFound } from "../http.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { actorOf, audit } from "../services/audit.js";
import { isRoleKey } from "../services/permissions.js";
import { builtFormsForCatalog, linkCatalogCard, unlinkCatalogCard } from "../forms/service.js";
import { FORM_ICON_KEYS } from "../forms/iconKeys.js";

export const formsRouter = Router();
formsRouter.use(requireAuth);

/**
 * The Forms screen and its admin editor.
 *
 * Reading the catalog needs only a session. A form can be limited to some
 * roles (`roles`); everyone else never receives it, so a restricted form
 * doesn't exist for them at all. Editors (forms.manage) see every form.
 * Editing needs forms.manage. Favourites are per person and need nothing extra.
 */

type FormRow = { roles: string | null };

function rolesOf(form: FormRow): string[] {
  return form.roles ? form.roles.split(",").filter(Boolean) : [];
}

function canSeeForm(req: Request, form: FormRow): boolean {
  if (req.user!.permissions.includes("forms.manage")) return true;
  const roles = rolesOf(form);
  return roles.length === 0 || roles.includes(req.user!.roleKey);
}

/** The API speaks role lists; the column stores them comma-separated. */
function toClient<T extends FormRow>(form: T): Omit<T, "roles"> & { roles: string[] } {
  return { ...form, roles: rolesOf(form) };
}

/**
 * Icon keys the frontend can draw: every Lucide icon bar brand logos. Generated
 * together with frontend/src/lib/formIconSet.ts by frontend/scripts/gen-form-icons.mjs.
 * Categories and forms share the set.
 */
export const FORM_ICONS = FORM_ICON_KEYS;

/**
 * A WordPress (or any https) page, or a path inside this app. Anything else —
 * `javascript:`, `data:`, a protocol-relative `//host` — is refused, because
 * this string ends up as an href every member of staff clicks.
 */
const formUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((u) => {
    if (u.startsWith("/")) return !u.startsWith("//");
    try {
      const parsed = new URL(u);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }, "Use a full https:// link, or an app path such as /roster.");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const formBody = z.object({
  categoryId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  description: optionalText(300),
  url: formUrl,
  keywords: optionalText(255),
  badge: optionalText(30),
  /** Null = use the category's icon. */
  icon: z.enum(FORM_ICONS).nullable().optional(),
  active: z.boolean().optional(),
  /** Roles that may see the form. Empty or null = everyone. */
  roles: z
    .array(z.string().refine(isRoleKey, "Unknown role"))
    .nullable()
    .optional()
    .transform((v) => (v && v.length ? [...new Set(v)].join(",") : null)),
});

export const categoryBody = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.enum(FORM_ICONS).default("folder"),
});

/**
 * The catalog, grouped. `?all=1` (forms.manage only) includes hidden forms and
 * empty categories for the editor; everyone else gets active forms only, and
 * categories with nothing in them are dropped.
 */
formsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const editing = req.query.all === "1" && req.user!.permissions.includes("forms.manage");
    const [categories, favourites] = await Promise.all([
      prisma.formCategory.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: {
          forms: {
            where: editing ? {} : { active: true },
            orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
          },
        },
      }),
      prisma.formFavorite.findMany({ where: { userId: req.user!.userId }, select: { formId: true }, orderBy: { createdAt: "asc" } }),
    ]);
    const visible = categories.map((c) => ({ ...c, forms: c.forms.filter((f) => canSeeForm(req, f)).map(toClient) }));
    const visibleIds = new Set(visible.flatMap((c) => c.forms.map((f) => f.id)));
    res.json({
      categories: editing ? visible : visible.filter((c) => c.forms.length > 0),
      // A favourite whose form was later restricted away stays in the table
      // (it comes back if the restriction is lifted) but isn't sent.
      favorites: favourites.map((f) => f.formId).filter((id) => visibleIds.has(id)),
    });
  })
);

/** Forms built in this app (Form builder and Code forms) that a catalog card can open. */
formsRouter.get(
  "/built",
  requirePermission("forms.manage"),
  asyncHandler(async (_req, res) => res.json(await builtFormsForCatalog()))
);

// ── Favourites ───────────────────────────────────────────────────────────

formsRouter.put(
  "/:id/favorite",
  asyncHandler(async (req, res) => {
    const form = await prisma.formLink.findUnique({ where: { id: req.params.id } });
    if (!form || !form.active || !canSeeForm(req, form)) throw notFound("That form isn't in the catalog any more.");
    const key = { userId: req.user!.userId, formId: form.id };
    await prisma.formFavorite.upsert({ where: { userId_formId: key }, create: key, update: {} });
    res.json({ ok: true });
  })
);

formsRouter.delete(
  "/:id/favorite",
  asyncHandler(async (req, res) => {
    await prisma.formFavorite.deleteMany({ where: { userId: req.user!.userId, formId: req.params.id } });
    res.json({ ok: true });
  })
);

// ── Catalog editing (forms.manage) ───────────────────────────────────────

formsRouter.post(
  "/categories",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const body = categoryBody.parse(req.body);
    const last = await prisma.formCategory.aggregate({ _max: { sortOrder: true } });
    const row = await prisma.formCategory.create({ data: { ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    await audit({ actor: actorOf(req), action: "forms.category_created", summary: `Added form category “${row.name}”` });
    res.status(201).json(row);
  })
);

/** Categories in the order given. Every existing category must be listed. */
formsRouter.post(
  "/categories/reorder",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    const existing = await prisma.formCategory.findMany({ select: { id: true } });
    if (existing.length !== ids.length || !existing.every((c) => ids.includes(c.id))) {
      throw badRequest("The catalog changed while you were editing. Reload and try again.");
    }
    await prisma.$transaction(ids.map((id, i) => prisma.formCategory.update({ where: { id }, data: { sortOrder: i } })));
    await audit({ actor: actorOf(req), action: "forms.reordered", summary: "Reordered form categories" });
    res.json({ ok: true });
  })
);

formsRouter.patch(
  "/categories/:id",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const body = categoryBody.partial().parse(req.body);
    const before = await prisma.formCategory.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    const row = await prisma.formCategory.update({ where: { id: before.id }, data: body });
    await audit({ actor: actorOf(req), action: "forms.category_updated", summary: `Updated form category “${row.name}”` });
    res.json(row);
  })
);

formsRouter.delete(
  "/categories/:id",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const cat = await prisma.formCategory.findUnique({ where: { id: req.params.id }, include: { _count: { select: { forms: true } } } });
    if (!cat) throw notFound();
    if (cat._count.forms > 0) throw badRequest("Move or delete the forms in this category first.");
    await prisma.formCategory.delete({ where: { id: cat.id } });
    await audit({ actor: actorOf(req), action: "forms.category_deleted", summary: `Deleted form category “${cat.name}”` });
    res.json({ ok: true });
  })
);

formsRouter.post(
  "/",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const body = formBody.parse(req.body);
    if (!(await prisma.formCategory.findUnique({ where: { id: body.categoryId } }))) throw badRequest("Pick a category.");
    const last = await prisma.formLink.aggregate({ where: { categoryId: body.categoryId }, _max: { sortOrder: true } });
    const row = await prisma.formLink.create({ data: { ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    await linkCatalogCard(row.id, row.url);
    await audit({ actor: actorOf(req), action: "forms.created", summary: `Added form “${row.title}”`, changes: { url: row.url, roles: row.roles } });
    res.status(201).json(toClient(row));
  })
);

/** Forms within one category, in the order given. */
formsRouter.post(
  "/reorder",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const { categoryId, ids } = z.object({ categoryId: z.string(), ids: z.array(z.string()).min(1) }).parse(req.body);
    const existing = await prisma.formLink.findMany({ where: { categoryId }, select: { id: true } });
    if (existing.length !== ids.length || !existing.every((f) => ids.includes(f.id))) {
      throw badRequest("The catalog changed while you were editing. Reload and try again.");
    }
    await prisma.$transaction(ids.map((id, i) => prisma.formLink.update({ where: { id }, data: { sortOrder: i } })));
    res.json({ ok: true });
  })
);

formsRouter.patch(
  "/:id",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const body = formBody.partial().parse(req.body);
    const before = await prisma.formLink.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    let sortOrder: number | undefined;
    if (body.categoryId && body.categoryId !== before.categoryId) {
      if (!(await prisma.formCategory.findUnique({ where: { id: body.categoryId } }))) throw badRequest("Pick a category.");
      // Moving category: land at the end of the new one.
      const last = await prisma.formLink.aggregate({ where: { categoryId: body.categoryId }, _max: { sortOrder: true } });
      sortOrder = (last._max.sortOrder ?? -1) + 1;
    }
    const row = await prisma.formLink.update({ where: { id: before.id }, data: { ...body, ...(sortOrder !== undefined ? { sortOrder } : {}) } });
    if (body.url !== undefined) await linkCatalogCard(row.id, row.url);
    const changed = (Object.keys(body) as (keyof typeof body)[]).filter((k) => body[k] !== undefined && body[k] !== before[k]);
    await audit({
      actor: actorOf(req),
      action: "forms.updated",
      summary: `Updated form “${row.title}”${changed.length ? `: ${changed.join(", ")}` : ""}`,
      changes: Object.fromEntries(changed.map((k) => [k, [before[k], row[k]]])),
    });
    res.json(toClient(row));
  })
);

formsRouter.delete(
  "/:id",
  requirePermission("forms.manage"),
  asyncHandler(async (req, res) => {
    const form = await prisma.formLink.findUnique({ where: { id: req.params.id } });
    if (!form) throw notFound();
    // Favourites go with it (cascade); a built form it opened just loses its card.
    await unlinkCatalogCard(form.id);
    await prisma.formLink.delete({ where: { id: form.id } });
    await audit({ actor: actorOf(req), action: "forms.deleted", summary: `Deleted form “${form.title}”`, changes: { url: form.url } });
    res.json({ ok: true });
  })
);
