import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronDown, Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/input";
import { Tag } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import {
  notificationKeys, useNotificationPrefs,
  type EmailMode, type EmailWhen, type NotificationPrefs, type NotificationTypeRow, type TypePref,
} from "@/lib/notifications";
import { cn, errorMessage } from "@/lib/utils";

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type FormPrefs = NotificationPrefs["forms"][number];
type Change = { emailMode?: EmailMode; digestHour?: number | null; prefs?: ({ key: string } & TypePref)[]; reset?: string[] };
type EmailValue = "default" | EmailWhen | "off";

const whenWords = (w: EmailWhen | null) => (w === "instant" ? "As it arrives" : w === "daily" ? "Daily summary" : "Not emailed");
const same = (a: TypePref, b: TypePref) => a.inApp === b.inApp && a.email === b.email && (a.emailWhen ?? null) === (b.emailWhen ?? null);

/** The email choice a row shows: theirs if they've made one, else "default". */
function emailValue(r: NotificationTypeRow): EmailValue {
  if (!r.own) return "default";
  if (!r.own.email) return "off";
  return r.own.emailWhen ?? (r.base.email ? "default" : r.email ?? "off");
}

/** A row as it would look with this choice, until the server says. */
function applied(r: NotificationTypeRow, next: TypePref | null, mode: EmailMode): NotificationTypeRow {
  if (!next) return { ...r, own: null, custom: false, inApp: r.defaults.inApp, email: r.defaults.email };
  const inApp = next.inApp || r.choice === "required";
  const email = !next.email ? null : next.emailWhen ?? (r.defaults.email ?? (mode === "off" ? null : mode));
  return { ...r, own: next, custom: true, inApp, email };
}

/**
 * Profile → Notifications. Every notification type that could reach this
 * person: the site's own, and each form's (its routes, follow-ups and own
 * messages). For each: in the app or not, and email as it arrives, in the
 * daily summary, or not at all. Some an Admin has made required (always in the
 * app) or set for everyone. Every change saves at once.
 * Backend: services/notificationTypes.ts.
 */
export function NotificationSettings({ delay }: { delay?: string }) {
  const { data, isLoading, isError } = useNotificationPrefs();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testing, setTesting] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();

  // /profile#notifications (the Notifications page's Settings link) lands here.
  useEffect(() => {
    if (hash === "#notifications" && data) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [hash, Boolean(data)]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(change: Change, optimistic: (p: NotificationPrefs) => NotificationPrefs) {
    const before = qc.getQueryData<NotificationPrefs>(notificationKeys.prefs);
    if (before) qc.setQueryData(notificationKeys.prefs, optimistic(before));
    setStatus("saving");
    try {
      qc.setQueryData(notificationKeys.prefs, await api.put<NotificationPrefs>("/notifications/prefs", change));
      setStatus("saved");
    } catch (error) {
      if (before) qc.setQueryData(notificationKeys.prefs, before);
      setStatus("error");
      toast(errorMessage(error, "Couldn't save your notification settings."), "error");
    }
  }

  /** Set (or, null, clear) several types at once. */
  const setRows = (changes: { row: NotificationTypeRow; next: TypePref | null }[]) => {
    const prefs = changes.filter((c) => c.next).map((c) => ({ key: c.row.key, ...c.next! }));
    const reset = changes.filter((c) => !c.next).map((c) => c.row.key);
    const by = new Map(changes.map((c) => [c.row.key, c.next]));
    const patch = (p: NotificationPrefs) => {
      const fix = (r: NotificationTypeRow) => (by.has(r.key) ? applied(r, by.get(r.key)!, p.emailMode) : r);
      return { ...p, types: p.types.map(fix), forms: p.forms.map((f) => ({ ...f, rows: f.rows.map(fix) })) };
    };
    return save({ ...(prefs.length ? { prefs } : {}), ...(reset.length ? { reset } : {}) }, patch);
  };
  /** A choice for one type; back to following its default when it matches. */
  const choose = (row: NotificationTypeRow, next: TypePref) => setRows([{ row, next: same(next, row.base) ? null : next }]);

  const setApp = (row: NotificationTypeRow, inApp: boolean) => choose(row, { ...(row.own ?? row.base), inApp });
  const setEmail = (row: NotificationTypeRow, v: EmailValue) => {
    const now = row.own ?? row.base;
    choose(
      row,
      v === "default"
        ? { ...now, email: row.base.email, emailWhen: row.base.emailWhen }
        : v === "off"
          ? { ...now, email: false, emailWhen: null }
          : { ...now, email: true, emailWhen: v }
    );
  };
  const formOff = (f: FormPrefs) =>
    setRows(f.rows.filter((r) => r.choice !== "locked").map((row) => ({ row, next: { inApp: row.choice === "required", email: false, emailWhen: null } })));
  const formDefaults = (f: FormPrefs) => setRows(f.rows.filter((r) => r.custom).map((row) => ({ row, next: null })));
  const setMode = (emailMode: EmailMode) => save({ emailMode }, (p) => ({ ...p, emailMode }));
  const setHour = (h: number) => save({ digestHour: h === data?.siteDigestHour ? null : h }, (p) => ({ ...p, digestHour: h }));
  const restore = () =>
    data && setRows([...data.types, ...data.forms.flatMap((f) => f.rows)].filter((r) => r.custom).map((row) => ({ row, next: null })));

  async function sendTest() {
    setTesting(true);
    try {
      const r = await api.post<{ sent: number; emailed: number }>("/notifications/test", {});
      await qc.invalidateQueries({ queryKey: notificationKeys.all });
      const account = data?.types.find((t) => t.key === "account");
      toast(
        !r.sent
          ? "Nothing was sent: you've turned off both the app and email for “Your account”."
          : r.emailed
            ? account?.email === "daily" ? "Sent. It's under the bell now, and in your next daily summary." : "Sent. It's under the bell now, and an email is on its way."
            : "Sent. It's under the bell now."
      );
    } catch (error) {
      toast(errorMessage(error, "Couldn't send a test."), "error");
    } finally {
      setTesting(false);
    }
  }

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const forms = (data?.forms ?? []).filter((f) => words.every((w) => `${f.title} ${f.category ?? ""} ${f.rows.map((r) => r.label).join(" ")}`.toLowerCase().includes(w)));
  const usesSummary = Boolean(data && (data.emailMode === "daily" || [...data.types, ...data.forms.flatMap((f) => f.rows)].some((r) => r.email === "daily")));

  return (
    <div id="notifications" ref={ref} className="scroll-mt-4">
      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: delay }}>
        <div className="mb-1 flex min-h-4 items-center justify-between gap-3">
          <p className="kicker">Notifications</p>
          <p className={`text-micro ${status === "error" ? "text-danger" : "text-muted"}`} aria-live="polite">
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Save failed" : "Changes save automatically"}
          </p>
        </div>
        <p className="text-[13px] text-muted">
          Everything that could be sent to you, and how you get each one: under the bell, by email as it arrives, or in one summary a day.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : isError || !data ? (
          <p className="mt-4 text-[13px] text-status-redText">Your notification settings didn't load. Check your connection and try again.</p>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Email me">
                <Select
                  value={data.emailMode}
                  onChange={(e) => void setMode(e.target.value as EmailMode)}
                  options={[
                    { value: "instant", label: "As each one arrives" },
                    { value: "daily", label: "In one daily summary" },
                    { value: "off", label: "Never" },
                  ]}
                />
              </Field>
              <Field label="Daily summary at">
                <Select
                  value={String(data.digestHour)}
                  onChange={(e) => void setHour(Number(e.target.value))}
                  options={HOURS.map((h) => ({ value: String(h), label: `${hourLabel(h)}${h === data.siteDigestHour ? " (usual)" : ""}` }))}
                />
              </Field>
            </div>
            <p className="mt-1.5 text-micro text-muted">
              {data.emailMode === "off"
                ? "Nothing is emailed unless you choose email for a notification below."
                : `That's your default. Change any notification below to come as it arrives or in the summary instead.${usesSummary ? ` The summary lists what you haven't read yet, at ${hourLabel(data.digestHour)} New York time; none is sent on a day with nothing new.` : ""}`}{" "}
              Emails are a title and a link; the details stay in Lantern Forms, behind sign-in.
            </p>
            {!data.mailConfigured && data.emailMode !== "off" && (
              <p className="mt-2 rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">
                Email isn't set up on this server yet, so for now notifications show in the app only.
              </p>
            )}

            <div className="mt-4 border-t border-hairline pt-3">
              <p className="text-[13.5px] font-semibold text-ink">From the site</p>
              <ul className="mt-1" aria-label="Notifications from the site">
                {data.types.map((t) => (
                  <TypeRow key={t.key} row={t} onApp={(v) => void setApp(t, v)} onEmail={(v) => void setEmail(t, v)} />
                ))}
              </ul>
            </div>

            {data.forms.length > 0 && (
              <div className="mt-4 border-t border-hairline pt-4">
                <p className="text-[13.5px] font-semibold text-ink">From forms</p>
                <p className="mt-0.5 text-micro text-muted">
                  Each notification a form could send you, as its Admin set it up. Change any one, or turn a whole form off.
                </p>
                {data.forms.length > 6 && (
                  <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a form or notification" aria-label="Find a form or notification" className="mt-3" />
                )}
                <ul className="mt-3 space-y-2">
                  {forms.map((f) => (
                    <FormRow
                      key={f.id}
                      form={f}
                      onApp={(r, v) => void setApp(r, v)}
                      onEmail={(r, v) => void setEmail(r, v)}
                      onAllOff={() => void formOff(f)}
                      onDefaults={() => void formDefaults(f)}
                    />
                  ))}
                  {forms.length === 0 && <li className="py-2 text-[13px] text-muted">No forms match. Try a shorter word.</li>}
                </ul>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-4">
              <Button variant="ghost" size="sm" onClick={() => void restore()}>Restore defaults</Button>
              <Button variant="secondary" size="sm" onClick={() => void sendTest()} disabled={testing}>
                <Bell className="h-4 w-4" /> {testing ? "Sending…" : "Send me a test"}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** One form, folded to its name and where it stands; open, each of its notifications. */
function FormRow({ form, onApp, onEmail, onAllOff, onDefaults }: {
  form: FormPrefs;
  onApp: (r: NotificationTypeRow, v: boolean) => void;
  onEmail: (r: NotificationTypeRow, v: EmailValue) => void;
  onAllOff: () => void;
  onDefaults: () => void;
}) {
  const [open, setOpen] = useState(false);
  const custom = form.rows.some((r) => r.custom);
  const changeable = form.rows.filter((r) => r.choice !== "locked");
  const off = form.rows.every((r) => !r.inApp && !r.email);
  const allOffAlready = changeable.every((r) => !r.email && (r.choice === "required" || !r.inApp));
  const emailed = form.rows.filter((r) => r.email).length;
  const state = off ? "Off" : !custom ? "As set up" : emailed ? "Your choices · emails you" : "Your choices · in the app";
  const n = form.rows.length;
  const meta = [form.category, `${n} notification${n === 1 ? "" : "s"}`, form.sent ? `${form.sent} sent to you` : null].filter(Boolean).join(" · ");

  return (
    <li className={cn("overflow-hidden rounded-card border transition-colors", open ? "border-strongline" : "border-hairline")}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-rowhover">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{form.title}</span>
          <span className="block truncate text-micro text-muted">{meta}</span>
        </span>
        <Tag tone={off ? "red" : custom ? "accent" : "neutral"} className="shrink-0">{state}</Tag>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-hairline px-3 pb-2">
          <ul aria-label={`${form.title} notifications`}>
            {form.rows.map((r) => (
              <TypeRow key={r.key} row={r} context={form.title} onApp={(v) => onApp(r, v)} onEmail={(v) => onEmail(r, v)} />
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-1 border-t border-hairline pt-2">
            {custom && <Button variant="ghost" size="sm" onClick={onDefaults}>Back to how it's set up</Button>}
            {changeable.length > 0 && !allOffAlready && (
              <Button variant="ghost" size="sm" className="text-status-redText" onClick={onAllOff}>Turn this form off</Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** One notification type: what it is, in the app or not, and how it's emailed. */
function TypeRow({ row, context, onApp, onEmail }: {
  row: NotificationTypeRow;
  /** The form, for screen readers: a route's label alone may be ambiguous. */
  context?: string;
  onApp: (v: boolean) => void;
  onEmail: (v: EmailValue) => void;
}) {
  const name = context ? `${context}, ${row.label}` : row.label;
  const locked = row.choice === "locked";
  const required = row.choice === "required";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline py-3 first:border-t-0">
      <span className="min-w-[200px] flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink">{row.label}</span>
          {row.urgent && <Tag tone="red">Urgent</Tag>}
          {locked && <Tag tone="neutral"><Lock className="mr-1 inline h-3 w-3" />Set by an Admin</Tag>}
          {row.custom && !locked && <Tag tone="accent">Changed</Tag>}
        </span>
        {row.description && <span className="mt-0.5 block text-micro text-muted">{row.description}</span>}
        {locked && (
          <span className="mt-0.5 block text-micro text-muted">
            Everyone it's for gets it {row.inApp ? "in the app" : ""}{row.inApp && row.email ? " and " : ""}{row.email ? `by email ${row.email === "daily" ? "in the daily summary" : "as it arrives"}` : ""}.
          </span>
        )}
        {required && <span className="mt-0.5 block text-micro text-muted">Always shown in the app. You choose the email.</span>}
      </span>
      <span className="flex w-full items-center gap-3 sm:w-auto sm:shrink-0">
        <label className="flex items-center gap-2 text-[12.5px] text-muted" title={required ? "This one is always in the app" : undefined}>
          <Switch
            checked={row.inApp}
            disabled={locked || required}
            onCheckedChange={onApp}
            aria-label={`${name}: in the app`}
            className="disabled:cursor-not-allowed disabled:opacity-45"
          />
          In app
        </label>
        <span className="min-w-0 flex-1 sm:w-[210px] sm:flex-none">
        <Select
          value={locked ? (row.email ?? "off") : emailValue(row)}
          disabled={locked}
          onChange={(e) => onEmail(e.target.value as EmailValue)}
          aria-label={`${name}: email`}
          className="w-full"
          options={
            locked
              ? [{ value: row.email ?? "off", label: whenWords(row.email) }]
              : [
                  { value: "default", label: `Default · ${whenWords(row.defaults.email)}` },
                  { value: "instant", label: "As it arrives" },
                  { value: "daily", label: "Daily summary" },
                  { value: "off", label: "Don't email" },
                ]
          }
        />
        </span>
      </span>
    </li>
  );
}
