import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { CheckCircle2, ClipboardList, CloudOff, Lock, PencilRuler } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { enqueueFill, hasLocalFiles, startFillQueue } from "@/lib/fillQueue";
import { isOnline } from "@/lib/offline";
import { Page } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/misc";
import { ToneBadge } from "@/components/ui/badge";
import { ThemedLogo } from "@/components/shell/ThemedLogo";
import { useToast } from "@/components/ui/toast";
import { FormRenderer, AnswerList, type SubmitExtra } from "@/components/formkit/FormRenderer";
import { fillApi, submitErrors, useFillForm } from "@/lib/builder";
import { ApiError } from "@/lib/api";
import { renderTemplate, type Errors, type Values } from "@/lib/formEngine";
import { useDeviceKind } from "@/lib/device";
import { errorMessage } from "@/lib/utils";

const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Filling in a built form: /f/<slug> inside the app, /p/<slug> for public
 * forms (no sign-in, no app chrome).
 */
export function FillPage({ publicView = false }: { publicView?: boolean }) {
  const { slug = "" } = useParams();
  const location = useLocation();
  const { data, isLoading, error } = useFillForm(slug);
  // The builder is desktop only, so no way into it elsewhere.
  const canOpenBuilder = useDeviceKind() === "desktop";
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<Errors | undefined>();
  /** queued: kept on this device to upload later — there's no entry id yet. */
  const [done, setDone] = useState<{ id: string | null; values: Values; queued?: boolean } | null>(null);
  const { user } = useAuth();
  // Uploads run from AppShell when signed in; a public form has no shell.
  useEffect(() => {
    if (publicView) startFillQueue(undefined);
  }, [publicView]);
  const [clientId, setClientId] = useState(newClientId);
  const [round, setRound] = useState(0);
  const draftKey = `lcs-form-draft:${slug}`;

  const Shell = publicView ? PublicShell : InAppShell;

  if (isLoading) return <Shell><LoadingState /></Shell>;
  if (error || !data) {
    if (error instanceof ApiError && error.status === 401 && !publicView) {
      return <Navigate to={`/signin?returnTo=${encodeURIComponent(location.pathname)}`} replace />;
    }
    return (
      <Shell>
        <Card className="p-8 text-center">
          <Lock className="mx-auto h-8 w-8 text-muted" />
          <p className="mt-3 font-heading text-[17px] font-extrabold text-ink">{errorMessage(error, "This form isn't available.")}</p>
          {error instanceof ApiError && error.status === 401 && <Link to={`/signin?returnTo=${encodeURIComponent(`/f/${slug}`)}`} className="mt-3 inline-block font-semibold text-accent">Sign in</Link>}
        </Card>
      </Shell>
    );
  }

  const { doc, form } = data;

  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  };

  /** No connection: keep it on the device; lib/fillQueue.ts uploads it later. */
  async function saveOnDevice(values: Values, extra: SubmitExtra) {
    try {
      await enqueueFill({ clientId, slug, title: doc.title, userId: publicView ? null : (user?.id ?? null), values, siteCode: extra.siteCode, codeErrors: extra.codeErrors, formVersion: form.version });
    } catch {
      toast("No connection, and this device couldn't keep the entry. Try again once the internet is back.", "error");
      return;
    }
    clearDraft();
    setDone({ id: null, values, queued: true });
    window.scrollTo({ top: 0 });
  }

  async function submit(values: Values, extra: SubmitExtra) {
    setSubmitting(true);
    setServerErrors(undefined);
    // Honeypot filled: a bot. Never queued; the server deals with it.
    const canQueue = !extra.honeypot;
    try {
      // A file attached offline is only on the device, so the queue (which uploads it first) has to send this.
      if (canQueue && (!isOnline() || hasLocalFiles(values))) return await saveOnDevice(values, extra);
      const res = await fillApi.submit(slug, { values, siteCode: extra.siteCode, clientId, codeErrors: extra.codeErrors, formVersion: form.version, website_hp: extra.honeypot || undefined });
      clearDraft();
      const conf = doc.settings.confirmation;
      if (conf?.type === "redirect" && conf.url) {
        window.location.assign(renderTemplate(conf.url, { values: res.values, doc, user: data!.user, entry: { id: res.id } }));
        return;
      }
      setDone({ id: res.id, values: res.values ?? values });
      window.scrollTo({ top: 0 });
    } catch (e) {
      // The connection dropped (or the server is down) mid-send. The clientId
      // makes it safe even if the server did save it.
      if (canQueue && (!(e instanceof ApiError) || e.status >= 500)) return await saveOnDevice(values, extra);
      const errs = submitErrors(e);
      if (Object.keys(errs).length) setServerErrors(errs);
      toast(errorMessage(e, "Couldn't save your answers. Try again."), "error");
    } finally {
      setSubmitting(false);
    }
  }

  function another() {
    setDone(null);
    setClientId(newClientId());
    setRound((r) => r + 1);
  }

  return (
    <Shell>
      {data.isAdmin && !publicView && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-input border border-hairline bg-subtle px-3 py-2 text-[13px]">
          <ToneBadge tone={form.isDraft ? "amber" : form.status === "published" ? "green" : "neutral"}>{form.isDraft ? "Draft" : form.status === "published" ? `Live · v${form.version}` : form.status}</ToneBadge>
          <span className="text-muted">You're an admin.</span>
          <div className="flex-1" />
          {canOpenBuilder && <Link to={`/admin/builder/${form.id}`} className="inline-flex items-center gap-1 font-semibold text-accent"><PencilRuler className="h-3.5 w-3.5" /> Edit form</Link>}
        </div>
      )}
      {data.canReadEntries && !publicView && (
        <div className="mb-3 flex justify-end">
          <Link to={`/f/${slug}/entries`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent"><ClipboardList className="h-3.5 w-3.5" /> Entries</Link>
        </div>
      )}

      <Card className="p-5 md:p-8">
        <h1 className="font-heading text-[24px] font-extrabold leading-tight text-ink md:text-[27px]">{doc.title}</h1>
        {doc.description && !done && <div className="prose-form mt-2 text-[14px] text-muted" dangerouslySetInnerHTML={{ __html: doc.description }} />}
        <div className="mt-6">
          {done ? (
            <Confirmation data={data} values={done.values} entryId={done.id} queued={done.queued} onAnother={another} slug={slug} />
          ) : data.closed ? (
            <div className="rounded-input border border-hairline bg-subtle px-4 py-6 text-center text-[14px] text-ink">{data.closed}</div>
          ) : (
            <FormRenderer
              key={round}
              doc={doc}
              slug={slug}
              user={data.user}
              draftKey={draftKey}
              onSubmit={submit}
              submitting={submitting}
              serverErrors={serverErrors}
            />
          )}
        </div>
      </Card>
    </Shell>
  );
}

function Confirmation({ data, values, entryId, queued, onAnother, slug }: { data: NonNullable<ReturnType<typeof useFillForm>["data"]>; values: Values; entryId: string | null; queued?: boolean; onAnother: () => void; slug: string }) {
  const conf = data.doc.settings.confirmation;
  const html = useMemo(
    () => renderTemplate(conf?.message || "<p>Thanks — your response has been saved.</p>", { values, doc: data.doc, user: data.user, entry: { id: entryId ?? "" }, html: true }),
    [conf?.message, values, data, entryId]
  );
  return (
    <div>
      {queued ? (
        // The form's own message can promise things (an email, a reference
        // number) that only happen once the server has it, so it isn't shown.
        <div className="flex items-start gap-3 rounded-card border border-status-amberDot/40 bg-status-amberBg p-4">
          <CloudOff className="mt-0.5 h-6 w-6 shrink-0 text-status-amberText" />
          <div className="text-[14.5px] text-ink">
            <p className="font-semibold">Saved on this device.</p>
            <p className="mt-1 text-muted">There's no connection right now. It uploads by itself as soon as the internet is back. You can fill in another or leave this screen.</p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-card border border-status-greenDot/40 bg-status-greenBg p-4">
          <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-status-greenText" />
          <div className="prose-form text-[14.5px] text-ink" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
      {conf?.showSummary && (
        <div className="mt-5">
          <p className="mb-1 text-micro font-bold uppercase tracking-[0.04em] text-muted">Your answers</p>
          <AnswerList doc={data.doc} values={values} />
        </div>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onAnother}>Fill in another</Button>
        {data.canReadEntries && entryId && <Link to={`/f/${slug}/entries/${entryId}`}><Button variant="ghost">View this entry</Button></Link>}
      </div>
    </div>
  );
}

function InAppShell({ children }: { children: React.ReactNode }) {
  return <Page className="max-w-[820px]">{children}</Page>;
}

/** Public forms: no sidebar, no sign-in — just the Lantern logo and the form. */
function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-height overflow-y-auto bg-appbg">
      <div className="mx-auto max-w-[780px] px-4 py-6 md:py-10">
        <div className="mb-5 flex h-10 justify-center [&_svg]:h-10 [&_svg]:w-auto"><ThemedLogo /></div>
        {children}
        <p className="mt-6 text-center text-micro text-muted">Lantern Community Services</p>
      </div>
    </div>
  );
}
