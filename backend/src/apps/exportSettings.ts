import { z } from "zod";

/**
 * form.json "export": what a code form's Export dialog offers (frontend/src/apps/ExportEntries.tsx) and the
 * filters the server applies (apps/entryExport.ts). Everything is optional; left out, the dialog has dates
 * (last 30 days), sites, "Only entries I filed", PDF / Excel / CSV and Print.
 */

/** A dot path into an entry's saved data: "priority", "client.site". */
const fieldPath = z.string().regex(/^[A-Za-z_]\w{0,39}(\.[A-Za-z_]\w{0,39}){0,4}$/, 'A field is a dot path into the entry\'s data, e.g. "priority" or "client.site".');
const option = z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(100) }).strict();

export const exportFilter = z
  .object({
    /** Its name in app.exportEntries({ filters }) and the export link. */
    id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,29}$/, "A filter id is a short camelCase name."),
    label: z.string().min(1).max(60),
    /** Where the value is in the entry's data. An array there matches when any of its items does. */
    field: fieldPath,
    /** select: one of the options (or any); multi: any number ticked; check: one tick box, the field is true. */
    type: z.enum(["select", "multi", "check"]),
    options: z.array(option).min(1).max(60).optional(),
    /** Where it starts when the page doesn't say: an option's value (select), values (multi), true (check). */
    default: z.union([z.string().max(100), z.array(z.string().max(100)).max(60), z.boolean()]).optional(),
  })
  .strict()
  .refine((f) => f.type === "check" || (f.options?.length ?? 0) > 0, { message: "A select or multi filter needs options." });

export const DATE_PRESETS = ["7d", "30d", "90d", "month", "year", "all"] as const;

export const exportSettings = z
  .object({
    /** The dialog's title. Default "Export <form title>". */
    title: z.string().min(1).max(80).optional(),
    /** A line under the options (what's in the file, who it's for). */
    note: z.string().max(300).optional(),
    /** The file types offered, in this order. Default all three. */
    formats: z.array(z.enum(["pdf", "xlsx", "csv"])).min(1).max(3).optional(),
    /** The Print button (the PDF in the browser's print dialog). Default true. */
    print: z.boolean().optional(),
    /** The date range, or false for none (every date). default: where it starts when the page doesn't say. */
    dates: z.union([z.literal(false), z.object({ label: z.string().max(40).optional(), default: z.enum(DATE_PRESETS).optional() }).strict()]).optional(),
    /** The site picker. Default true (hidden anyway for someone with one site). */
    sites: z.boolean().optional(),
    /** "Only entries I filed". Default true. */
    mine: z.boolean().optional(),
    /** A text box: only entries containing it. Default false. */
    search: z.boolean().optional(),
    /** "Include voided entries". Default false (voided entries are left out). */
    voided: z.boolean().optional(),
    /** The form's own filters, on its saved data. */
    filters: z.array(exportFilter).max(8).optional(),
  })
  .strict()
  .refine((s) => new Set((s.filters ?? []).map((f) => f.id)).size === (s.filters ?? []).length, { message: "Each export filter needs its own id." });

export type ExportSettings = z.infer<typeof exportSettings>;
export type ExportFilterSetting = z.infer<typeof exportFilter>;
