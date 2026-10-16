import { z } from "zod";
import { calendarRouter } from "../routes/calendar.js";
import { categoryBody, eventInput, scopeSchema } from "../services/calendar.js";
import { defineOp } from "./registry.js";

/**
 * The calendar, through the routes the Calendar screen uses. Reading needs only
 * an active creator; changing events needs calendar.manage (every event and the
 * categories: Admin) or calendar.edit (events at the creator's own sites: the
 * per-person "Can edit the calendar" switch). Outlook invites follow the
 * creator's own sync settings, as when they edit in the app.
 */

const enc = (v: string) => encodeURIComponent(v);
const day = z.string().describe("YYYY-MM-DD");
const which = {
  scope: scopeSchema.optional().describe("For a repeating event: all (default), this occurrence, or this and following"),
  date: day.optional().describe("The occurrence's day, for scope this / following"),
};

export const calendarOps = [
  defineOp({
    name: "list_calendar_categories",
    description: "Calendar categories (name, colour slot 0-7, order) with how many events each has.",
    scope: "calendar:read",
    as: "creator",
    http: { method: "GET", path: "/calendar/categories" },
    shape: {},
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.route(calendarRouter, { method: "GET", path: "/categories" }),
  }),

  defineOp({
    name: "list_calendar_events",
    description: "Calendar occurrences between two days (repeating events expanded, at most 400 days), optionally for one site.",
    scope: "calendar:read",
    as: "creator",
    http: { method: "GET", path: "/calendar/events" },
    shape: { from: day, to: day, site: z.string().optional().describe("Site code or id") },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(calendarRouter, { method: "GET", path: "/", query: { from: a.from, to: a.to, site: a.site } }),
  }),

  defineOp({
    name: "get_calendar_event",
    description: "One event (the whole series for a repeating one): its details, repeat rule and the days changed or cancelled.",
    scope: "calendar:read",
    as: "creator",
    http: { method: "GET", path: "/calendar/events/:id" },
    shape: { id: z.string() },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.route(calendarRouter, { method: "GET", path: `/events/${enc(a.id)}` }),
  }),

  defineOp({
    name: "create_calendar_event",
    description:
      "Add a calendar event. allSites: true is for every site (calendar.manage only); otherwise list siteIds. Times are HH:MM (omit for allDay). recurrence: { freq: daily|weekly|monthly|yearly, interval, weekdays?, monthDay?, months?, end: { kind: never | count | until } }.",
    scope: "calendar:write",
    as: "creator",
    http: { method: "POST", path: "/calendar/events" },
    shape: eventInput.shape,
    run: (ctx, a) => ctx.route(calendarRouter, { method: "POST", path: "/events", body: a }),
  }),

  defineOp({
    name: "update_calendar_event",
    description: "Change an event: pass the whole event as it should be (get_calendar_event, then edit). For a repeating event, scope says which occurrences. Answers the id of the series that now holds the change.",
    scope: "calendar:write",
    as: "creator",
    http: { method: "PATCH", path: "/calendar/events/:id" },
    shape: { id: z.string(), ...which, event: eventInput },
    run: (ctx, { id, ...body }) => ctx.route(calendarRouter, { method: "PATCH", path: `/events/${enc(id)}`, body }),
  }),

  defineOp({
    name: "delete_calendar_event",
    description: "Remove an event, or for a repeating one this occurrence / this and following (scope + date). One cancelled day can be put back with restore_calendar_occurrence.",
    scope: "calendar:write",
    as: "creator",
    http: { method: "DELETE", path: "/calendar/events/:id" },
    shape: { id: z.string(), ...which },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, a) => ctx.route(calendarRouter, { method: "DELETE", path: `/events/${enc(a.id)}`, query: { scope: a.scope, date: a.date } }),
  }),

  defineOp({
    name: "restore_calendar_occurrence",
    description: "Put back one cancelled day of a repeating event.",
    scope: "calendar:write",
    as: "creator",
    http: { method: "POST", path: "/calendar/events/:id/restore" },
    shape: { id: z.string(), date: day },
    run: (ctx, { id, date }) => ctx.route(calendarRouter, { method: "POST", path: `/events/${enc(id)}/restore`, body: { date } }),
  }),

  defineOp({
    name: "create_calendar_category",
    description: "Add a calendar category (calendar.manage).",
    scope: "calendar:write",
    as: "creator",
    http: { method: "POST", path: "/calendar/categories" },
    shape: categoryBody.shape,
    run: (ctx, a) => ctx.route(calendarRouter, { method: "POST", path: "/categories", body: a }),
  }),

  defineOp({
    name: "update_calendar_category",
    description: "Rename a calendar category or change its colour (calendar.manage).",
    scope: "calendar:write",
    as: "creator",
    http: { method: "PATCH", path: "/calendar/categories/:id" },
    shape: { id: z.string(), name: categoryBody.shape.name.optional(), colorSlot: categoryBody.shape.colorSlot.optional() },
    run: (ctx, { id, ...body }) => ctx.route(calendarRouter, { method: "PATCH", path: `/categories/${enc(id)}`, body }),
  }),

  defineOp({
    name: "delete_calendar_category",
    description: "Delete a calendar category (calendar.manage). Its events stay, uncategorized.",
    scope: "calendar:write",
    as: "creator",
    http: { method: "DELETE", path: "/calendar/categories/:id" },
    shape: { id: z.string() },
    confirm: true,
    annotations: { destructiveHint: true },
    run: (ctx, a) => ctx.route(calendarRouter, { method: "DELETE", path: `/categories/${enc(a.id)}` }),
  }),
];
