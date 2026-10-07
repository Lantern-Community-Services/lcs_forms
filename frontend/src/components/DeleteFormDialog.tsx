import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";

const WORD = "delete";

/**
 * Confirms deleting a built form or code form for good. With no entries it's
 * one click; with entries, which go with it, you type "delete" first, and the
 * dialog points at Export with entries as the way to keep a copy.
 */
export function DeleteFormDialog({ form, noun, onCancel, onConfirm }: {
  /** The form to delete; null keeps the dialog closed. */
  form: { title: string; entryCount: number } | null;
  /** "form" or "code form". */
  noun: string;
  onCancel: () => void;
  /** Runs the delete; the dialog stays open, busy, until it settles. */
  onConfirm: () => Promise<unknown>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTyped("");
    setBusy(false);
  }, [form]);

  const n = form?.entryCount ?? 0;
  const entries = `${n.toLocaleString()} entr${n === 1 ? "y" : "ies"}`;
  const ready = n === 0 || typed.trim().toLowerCase() === WORD;

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <>
      <Button variant="secondary" onClick={onCancel} disabled={busy} className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none">
        Cancel
      </Button>
      <Button variant="danger" disabled={!ready || busy} onClick={confirm} className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none">
        {busy ? "Deleting…" : n > 0 ? `Delete form and ${entries}` : "Delete for good"}
      </Button>
    </>
  );

  return (
    <ResponsiveDialog open={Boolean(form)} onOpenChange={(o) => !o && !busy && onCancel()} title={`Delete “${form?.title ?? ""}”?`} footer={actions}>
      <div className="space-y-3 text-[14px] leading-relaxed text-ink">
        {n > 0 ? (
          <>
            <p>
              This deletes the {noun} and all <span className="font-semibold">{entries}</span>, with their notes and uploaded files
              {noun === "code form" ? ", and the form's saved data" : ""}. It can't be undone.
            </p>
            <p className="text-muted">To keep a copy, cancel and use Export with entries first. To hide the form but keep everything, use Archive instead.</p>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold">Type <span className="font-mono">{WORD}</span> to confirm</span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ready && !busy && void confirm()}
                autoComplete="off"
                autoCapitalize="none"
                className="min-h-[44px] font-mono"
              />
            </label>
          </>
        ) : (
          <p>Nobody has filled this {noun} in. Deleting it removes it and its versions for good.</p>
        )}
      </div>
    </ResponsiveDialog>
  );
}
