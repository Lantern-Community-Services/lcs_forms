import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Eye, RotateCcw } from "lucide-react";
import { Page } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/misc";
import { FormRenderer } from "@/components/formkit/FormRenderer";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { BuiltFormDetail } from "@/lib/builder";
import { cleanValues, validateValues, type FormDoc, type Values } from "@/lib/formEngine";

/**
 * /f/<slug>/preview — the form exactly as staff will see it, inside the app,
 * for the builder's device previews. The editor (its parent window) sends the
 * working document on every change, so unsaved edits show straight away;
 * opened on its own it shows the saved draft. Nothing is ever submitted.
 *
 * Messages (same origin only):
 *   parent → preview  { lcsPreview: "doc", doc }  { lcsPreview: "reset" }
 *   preview → parent  { lcsPreview: "ready" }  { lcsPreview: "values", values }
 *                     { lcsPreview: "submitted", values, errors }
 */
export function BuiltFormPreviewPage() {
  const { slug = "" } = useParams();
  const { user } = useAuth();
  const [doc, setDoc] = useState<FormDoc | null>(null);
  const [round, setRound] = useState(0);
  const [done, setDone] = useState(false);
  const embedded = window.parent !== window;
  const toParent = useRef((msg: Record<string, unknown>) => {
    if (embedded) window.parent.postMessage(msg, window.location.origin);
  });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent || !e.data?.lcsPreview) return;
      if (e.data.lcsPreview === "doc") setDoc(e.data.doc as FormDoc);
      if (e.data.lcsPreview === "reset") {
        setRound((r) => r + 1);
        setDone(false);
      }
    };
    window.addEventListener("message", onMessage);
    toParent.current({ lcsPreview: "ready" });
    // Opened on its own (a new tab): show the saved draft.
    if (!embedded) void api.get<BuiltFormDetail>(`/builder/forms/${slug}`).then((f) => setDoc(f.draft));
    return () => window.removeEventListener("message", onMessage);
  }, [slug, embedded]);

  if (!doc) return <LoadingState label="Waiting for the form…" />;
  return (
    <Page className="max-w-[820px]">
      <div className="mb-3 flex items-center gap-2 rounded-input border border-hairline bg-subtle px-3 py-2 text-[12.5px] text-muted">
        <Eye className="h-3.5 w-3.5" /> Preview — nothing is saved.
        <div className="flex-1" />
        <button type="button" onClick={() => { setRound((r) => r + 1); setDone(false); }} className="inline-flex items-center gap-1 font-semibold text-accent dark:text-white">
          <RotateCcw className="h-3.5 w-3.5" /> Start over
        </button>
      </div>
      <Card className="p-5 md:p-8">
        <h1 className="font-heading text-[24px] font-extrabold leading-tight text-ink md:text-[27px]">{doc.title}</h1>
        {doc.description && <div className="prose-form mt-2 text-[14px] text-muted" dangerouslySetInnerHTML={{ __html: doc.description }} />}
        <div className="mt-6">
          {done ? (
            <div className="rounded-card border border-status-greenDot/40 bg-status-greenBg p-4 text-[14px] text-ink">
              This is where the confirmation shows. In Preview nothing was saved.
              <button type="button" className="ml-2 font-semibold text-accent underline" onClick={() => { setRound((r) => r + 1); setDone(false); }}>Fill in again</button>
            </div>
          ) : (
            <FormRenderer
              key={round}
              doc={doc}
              mode="preview"
              user={user ? { name: user.name, email: user.email } : null}
              onValuesChange={(values) => toParent.current({ lcsPreview: "values", values })}
              onSubmit={(values: Values) => {
                toParent.current({ lcsPreview: "submitted", values: cleanValues(doc, values), errors: validateValues(doc, values) });
                setDone(true);
              }}
              submitLabel={`${doc.settings.submitLabel || "Submit"} (preview)`}
            />
          )}
        </div>
      </Card>
    </Page>
  );
}
