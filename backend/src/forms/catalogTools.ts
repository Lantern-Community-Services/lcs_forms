import { z } from "zod";
import { prisma } from "../prisma.js";
import { HttpError } from "../http.js";
import { audit, type Actor } from "../services/audit.js";
import { categoryBody, formBody, FORM_ICONS } from "../routes/forms.js";
import { builtSlugOf, linkCatalogCard, unlinkCatalogCard } from "./service.js";
import type { ToolRegistrar } from "./mcp.js";

/**
 * MCP tools for the Forms catalog (the Forms screen and the sidebar): list it,
 * add or change a card — a link to a form on another site, an app path, or a
 * form built here — and manage categories. The same rules as Admin → Forms
 * catalog: https or app-path links only, known icons and roles. Needs forms:build.
 */
export function registerCatalogTools(tool: ToolRegistrar, need: (scope: string) => void, actor: Actor) {
  const kindOf = (url: string) => (url.startsWith("/") ? (builtSlugOf(url) ? "built" : "app") : "external");

  tool(
    "list_catalog",
    "The whole Forms catalog: categories in order, each with its cards (id, title, url, kind: external | app | built, icon, roles, active). Also lists the icon keys a card or category can use.",
    { includeHidden: z.boolean().optional().describe("Include cards turned off (active: false)") },
    async ({ includeHidden }) => {
      need("forms:build");
      const cats = await prisma.formCategory.findMany({
        orderBy: { sortOrder: "asc" },
        include: { forms: { where: includeHidden ? {} : { active: true }, orderBy: { sortOrder: "asc" } } },
      });
      return {
        icons: FORM_ICONS,
        categories: cats.map((c) => ({
          id: c.id,
          name: c.name,
          icon: c.icon,
          cards: c.forms.map((f) => ({
            id: f.id, title: f.title, description: f.description, url: f.url, kind: kindOf(f.url), icon: f.icon, keywords: f.keywords, badge: f.badge,
            roles: f.roles ? f.roles.split(",") : [], active: f.active,
          })),
        })),
      };
    },
    { readOnlyHint: true }
  );

  tool(
    "save_catalog_card",
    "Add a card to the Forms catalog, or change one (pass id). url is a full https:// link to a form on another site (Microsoft Forms, WordPress, a vendor's portal — it opens in a new tab), an app path such as /apps/<slug> or /calendar, or /f/<slug>. For a form built here, add_to_catalog is simpler. roles limits who sees it (role keys; empty = everyone).",
    {
      id: z.string().optional().describe("The card to change; omit to add one"),
      categoryId: z.string().optional().describe("Required when adding"),
      title: z.string().optional().describe("Required when adding"),
      url: z.string().optional().describe("Required when adding"),
      description: z.string().nullable().optional(),
      keywords: z.string().nullable().optional().describe("Extra search words, comma-separated"),
      badge: z.string().nullable().optional().describe('Short tag on the card, e.g. "New"'),
      icon: z.string().nullable().optional().describe("An icon key from list_catalog; null = the category's"),
      roles: z.array(z.string()).nullable().optional(),
      active: z.boolean().optional().describe("false hides it from staff"),
    },
    async ({ id, ...input }) => {
      need("forms:build");
      const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      if (!id) {
        const body = formBody.parse(given);
        if (!(await prisma.formCategory.findUnique({ where: { id: body.categoryId } }))) throw new HttpError(400, "No such category (see list_catalog).");
        const last = await prisma.formLink.aggregate({ where: { categoryId: body.categoryId }, _max: { sortOrder: true } });
        const row = await prisma.formLink.create({ data: { ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
        await linkCatalogCard(row.id, row.url);
        await audit({ actor, action: "forms.created", summary: `Added form “${row.title}”`, changes: { url: row.url, roles: row.roles } });
        return { id: row.id, title: row.title, url: row.url, kind: kindOf(row.url), added: true };
      }
      const before = await prisma.formLink.findUnique({ where: { id } });
      if (!before) throw new HttpError(404, "No such card.");
      const body = formBody.partial().parse(given);
      let sortOrder: number | undefined;
      if (body.categoryId && body.categoryId !== before.categoryId) {
        if (!(await prisma.formCategory.findUnique({ where: { id: body.categoryId } }))) throw new HttpError(400, "No such category (see list_catalog).");
        const last = await prisma.formLink.aggregate({ where: { categoryId: body.categoryId }, _max: { sortOrder: true } });
        sortOrder = (last._max.sortOrder ?? -1) + 1;
      }
      const row = await prisma.formLink.update({ where: { id }, data: { ...body, ...(sortOrder !== undefined ? { sortOrder } : {}) } });
      if (body.url !== undefined) await linkCatalogCard(row.id, row.url);
      await audit({ actor, action: "forms.updated", summary: `Updated form “${row.title}”`, changes: { before: { url: before.url, title: before.title }, after: { url: row.url, title: row.title } } });
      return { id: row.id, title: row.title, url: row.url, kind: kindOf(row.url), updated: true };
    }
  );

  tool(
    "delete_catalog_card",
    "Remove a card from the Forms catalog (people's favorites of it go too). A form built here keeps working at its own URL; only the card goes.",
    { id: z.string() },
    async ({ id }) => {
      need("forms:build");
      const row = await prisma.formLink.findUnique({ where: { id } });
      if (!row) throw new HttpError(404, "No such card.");
      await unlinkCatalogCard(row.id);
      await prisma.formLink.delete({ where: { id: row.id } });
      await audit({ actor, action: "forms.deleted", summary: `Deleted form “${row.title}”`, changes: { url: row.url } });
      return { deleted: true };
    },
    { destructiveHint: true }
  );

  tool(
    "save_catalog_category",
    "Add a catalog category (a group on the Forms screen and in the sidebar), or rename one / change its icon (pass id).",
    { id: z.string().optional(), name: z.string().optional(), icon: z.string().optional() },
    async ({ id, name, icon }) => {
      need("forms:build");
      const given = Object.fromEntries(Object.entries({ name, icon }).filter(([, v]) => v !== undefined));
      if (!id) {
        const body = categoryBody.parse(given);
        const last = await prisma.formCategory.aggregate({ _max: { sortOrder: true } });
        const row = await prisma.formCategory.create({ data: { ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
        await audit({ actor, action: "forms.category_created", summary: `Added form category “${row.name}”` });
        return row;
      }
      if (!(await prisma.formCategory.findUnique({ where: { id } }))) throw new HttpError(404, "No such category.");
      const row = await prisma.formCategory.update({ where: { id }, data: categoryBody.partial().parse(given) });
      await audit({ actor, action: "forms.category_updated", summary: `Updated form category “${row.name}”` });
      return row;
    }
  );
}
