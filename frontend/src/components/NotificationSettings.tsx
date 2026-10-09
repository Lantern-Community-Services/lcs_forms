import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronDown } from "lucide-react";
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
import { notificationKeys, useNotificationPrefs, type EmailMode, type NotificationPrefs } from "@/lib/notifications";
import { cn, errorMessage } from "@/lib/utils";

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const formKey = (formId: string, kind: string) => `form:${formId}:${kind}`;

type Choice = { inApp: boolean; email: boolean };
type FormPrefs = NotificationPrefs["forms"][number];
type Change = { emailMode?: EmailMode; prefs?: ({ key: string } & Choice)[]; reset?: string[] };

/** Every kind a form hasn't been given its own setting for takes the person's choice for that kind. */
function follow(p: NotificationPrefs): NotificationPrefs {
  const byType = new Map(p.types.map((t) => [t.key, t]));
  return {
    ...p,
    forms: p.forms.map((f) => ({
      ...f,
      kinds: f.kinds.map((k) => (k.custom || !byType.has(k.key) ? k : { ...k, inApp: byType.get(k.key)!.inApp, email: byType.get(k.key)!.email })),
    })),
  };
}

/**
 * Profile → Notifications: how email reaches this person; per kind, whether it
 * shows in the app and is emailed; and the same per form, where each form
 * follows the kinds until they set it. Every change saves at once.
 * Backend: services/notifications.ts.
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

  const setType = (key: string, next: Choice) =>
    save({ prefs: [{ key, ...next }] }, (p) => follow({ ...p, types: p.types.map((t) => (t.key === key ? { ...t, ...next } : t)) }));
  const setFormKind = (formId: string, kind: string, next: Choice) =>
    save({ prefs: [{ key: formKey(formId, kind), ...next }] }, (p) => ({
      ...p,
      forms: p.forms.map((f) => (f.id === formId ? { ...f, kinds: f.kinds.map((k) => (k.key === kind ? { ...k, ...next, custom: true } : k)) } : f)),
    }));
  const formAllOff = (f: FormPrefs) =>
    save({ prefs: f.kinds.map((k) => ({ key: formKey(f.id, k.key), inApp: false, email: false })) }, (p) => ({
      ...p,
      forms: p.forms.map((x) => (x.id === f.id ? { ...x, kinds: x.kinds.map((k) => ({ ...k, inApp: false, email: false, custom: true })) } : x)),
    }));
  const formFollow = (f: FormPrefs) =>
    save({ reset: f.kinds.filter((k) => k.custom).map((k) => formKey(f.id, k.key)) }, (p) =>
      follow({ ...p, forms: p.forms.map((x) => (x.id === f.id ? { ...x, kinds: x.kinds.map((k) => ({ ...k, custom: false })) } : x)) })
    );
  const setMode = (emailMode: EmailMode) => save({ emailMode }, (p) => ({ ...p, emailMode }));
  const restore = () =>
    data &&
    save(
      { reset: [...data.types.map((t) => t.key), ...data.forms.flatMap((f) => f.kinds.filter((k) => k.custom).map((k) => formKey(f.id, k.key)))] },
      (p) =>
        follow({
          ...p,
          types: p.types.map((t) => ({ ...t, ...t.defaults })),
          forms: p.forms.map((f) => ({ ...f, kinds: f.kinds.map((k) => ({ ...k, custom: false })) })),
        })
    );

  async function sendTest() {
    setTesting(true);
    try {
      const r = await api.post<{ sent: number; emailed: number }>("/notifications/test", {});
      await qc.invalidateQueries({ queryKey: notificationKeys.all });
      toast(
        !r.sent
          ? "Nothing was sent: you've turned off both the app and email for “Your account”."
          : r.emailed
            ? data?.emailMode === "daily" ? "Sent. It's under the bell now, and in tomorrow morning's email." : "Sent. It's under the bell now, and an email is on its way."
            : "Sent. It's under the bell now."
      );
    } catch (error) {
      toast(errorMessage(error, "Couldn't send a test."), "error");
    } finally {
      setTesting(false);
    }
  }

  const emailOff = data?.emailMode === "off";
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const forms = (data?.forms ?? []).filter((f) => words.every((w) => `${f.title} ${f.category ?? ""}`.toLowerCase().includes(w)));

  return (
    <div id="notifications" ref={ref} className="scroll-mt-4">
      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: delay }}>
        <div className="mb-1 flex min-h-4 items-center justify-between gap-3">
          <p className="kicker">Notifications</p>
          <p className={`text-micro ${status === "error" ? "text-danger" : "text-muted"}`} aria-live="polite">
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Save failed" : "Changes save automatically"}
          </p>
        </div>
        <p className="text-[13px] text-muted">What shows under the bell, and what's emailed to you as well.</p>

        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : isError || !data ? (
          <p className="mt-4 text-[13px] text-status-redText">Your notification settings didn't load. Check your connection and try again.</p>
        ) : (
          <>
            <Field label="Email" className="mt-4">
              <Select
                value={data.emailMode}
                onChange={(e) => void setMode(e.target.value as EmailMode)}
                options={[
                  { value: "instant", label: "As each one arrives" },
                  { value: "daily", label: `One summary each morning (${hourLabel(data.digestHour)})` },
                  { value: "off", label: "Never email me" },
                ]}
              />
            </Field>
            <p className="mt-1.5 text-micro text-muted">
              {data.emailMode === "daily"
                ? "One email a morning listing how many you haven't read yet. Nothing is sent on a day with none."
                : "Emails are a title and a link back here. The details stay in Lantern Forms, behind sign-in."}
            </p>
            {!data.mailConfigured && !emailOff && (
              <p className="mt-2 rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">
                Email isn't set up on this server yet, so for now notifications show in the app only.
              </p>
            )}

            <div className="mt-4 border-t border-hairline pt-1" role="table" aria-label="Notification types">
              <ColumnHeads first="Kind" />
              {data.types.map((t) => (
                <PrefRow
                  key={t.key}
                  label={t.label}
                  hint={t.description}
                  inApp={t.inApp}
                  email={t.email}
                  emailOff={emailOff}
                  onChange={(next) => void setType(t.key, next)}
                />
              ))}
            </div>

            {data.forms.length > 0 && (
              <div className="mt-4 border-t border-hairline pt-4">
                <p className="text-[13.5px] font-semibold text-ink">Form by form</p>
                <p className="mt-0.5 text-micro text-muted">
                  Each form follows your choices above until you change it here. Set one to tell you everything by email, or turn one off altogether.
                </p>
                {data.forms.length > 6 && (
                  <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a form" aria-label="Find a form" className="mt-3" />
                )}
                <ul className="mt-3 space-y-2">
                  {forms.map((f) => (
                    <FormRow
                      key={f.id}
                      form={f}
                      emailOff={emailOff}
                      onKind={(kind, next) => void setFormKind(f.id, kind, next)}
                      onAllOff={() => void formAllOff(f)}
                      onFollow={() => void formFollow(f)}
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

function ColumnHeads({ first }: { first: string }) {
  return (
    <div role="row" className="grid grid-cols-[1fr_56px_56px] items-end gap-2 py-2 text-micro font-bold uppercase tracking-[0.04em] text-muted">
      <span role="columnheader">{first}</span>
      <span role="columnheader" className="text-center">In app</span>
      <span role="columnheader" className="text-center">Email</span>
    </div>
  );
}

/** One form, folded to its name and where it stands; open, its kinds with their own switches. */
function FormRow({ form, emailOff, onKind, onAllOff, onFollow }: {
  form: FormPrefs;
  emailOff: boolean;
  onKind: (kind: string, next: Choice) => void;
  onAllOff: () => void;
  onFollow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const custom = form.kinds.some((k) => k.custom);
  const off = form.kinds.every((k) => !k.inApp && (!k.email || emailOff));
  const emailed = !emailOff && form.kinds.some((k) => k.email);
  const state = off ? "Off" : !custom ? "Your defaults" : emailed ? "Custom · emails you" : "Custom · in the app only";
  const meta = [form.category, form.sent ? `${form.sent} sent to you` : null].filter(Boolean).join(" · ");

  return (
    <li className={cn("overflow-hidden rounded-card border transition-colors", open ? "border-strongline" : "border-hairline")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-rowhover"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{form.title}</span>
          {meta && <span className="block truncate text-micro text-muted">{meta}</span>}
        </span>
        <Tag tone={off ? "red" : custom ? "accent" : "neutral"} className="shrink-0">{state}</Tag>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-hairline px-3 pb-2" role="table" aria-label={`${form.title} notifications`}>
          <ColumnHeads first="From this form" />
          {form.kinds.map((k) => (
            <PrefRow
              key={k.key}
              label={k.label}
              ariaLabel={`${form.title}, ${k.label}`}
              hint={k.custom ? undefined : "Same as your choice above"}
              inApp={k.inApp}
              email={k.email}
              emailOff={emailOff}
              onChange={(next) => onKind(k.key, next)}
            />
          ))}
          <div className="flex flex-wrap justify-end gap-1 border-t border-hairline pt-2">
            {custom && <Button variant="ghost" size="sm" onClick={onFollow}>Use my choices above</Button>}
            {!off && <Button variant="ghost" size="sm" className="text-status-redText" onClick={onAllOff}>Turn this form off</Button>}
          </div>
        </div>
      )}
    </li>
  );
}

function PrefRow({ label, ariaLabel, hint, inApp, email, emailOff, onChange }: {
  label: string;
  /** Spoken name, when the label alone is ambiguous (a form's "Messages"). */
  ariaLabel?: string;
  hint?: string;
  inApp: boolean;
  email: boolean;
  emailOff: boolean;
  onChange: (next: Choice) => void;
}) {
  const name = ariaLabel ?? label;
  return (
    <div role="row" className="grid grid-cols-[1fr_56px_56px] items-center gap-2 border-t border-hairline py-2.5 first:border-t-0">
      <span role="cell" className="min-w-0">
        <span className="block text-[13.5px] font-semibold text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-micro text-muted">{hint}</span>}
      </span>
      <span role="cell" className="flex justify-center">
        <Switch checked={inApp} onCheckedChange={(v) => onChange({ inApp: v, email })} aria-label={`${name}: in the app`} />
      </span>
      <span role="cell" className="flex justify-center" title={emailOff ? "Email is off for everything (above)" : undefined}>
        <Switch checked={email && !emailOff} disabled={emailOff} onCheckedChange={(v) => onChange({ inApp, email: v })} aria-label={`${name}: by email`} className="disabled:cursor-not-allowed disabled:opacity-45" />
      </span>
    </div>
  );
}
