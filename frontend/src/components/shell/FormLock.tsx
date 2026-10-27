import { useEffect, useState } from "react";
import { Delete, Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { useAuth } from "@/lib/auth";
import { clearFormLock, lockForm, MAX_TRIES, unlockForm, useFormLock, WAIT_MS, type FormLock } from "@/lib/formLock";
import { cn } from "@/lib/utils";

const MIN_DIGITS = 4;
const MAX_DIGITS = 8;

/** Whether this person's device is locked to a form right now (lib/formLock.ts). */
export function useLocked(): FormLock | null {
  const { user } = useAuth();
  return useFormLock(user?.id);
}

/**
 * "Lock for resident", on a form's own screen: staff choose a code, then the
 * device shows only this form until the code is entered again.
 */
export function LockFormButton({ base, title, className }: { base: string; title: string; className?: string }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) return;
    setFirst(null);
    setCode("");
    setError("");
  }, [open]);
  if (!user) return null;

  async function next() {
    if (code.length < MIN_DIGITS) return setError(`Use at least ${MIN_DIGITS} digits.`);
    if (first === null) {
      setFirst(code);
      setCode("");
      setError("");
      return;
    }
    if (code !== first) {
      setFirst(null);
      setCode("");
      setError("Those didn't match. Choose a code again.");
      return;
    }
    await lockForm({ base, title, userId: user!.id, code });
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        data-tour="form-lock"
        onClick={() => setOpen(true)}
        className={cn("inline-flex min-h-[32px] items-center gap-1 text-[12.5px] font-semibold text-accent dark:text-white md:text-[13px]", className)}
        title="Hand this device to a resident: only this form stays open until you unlock it"
      >
        <Lock className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Lock for resident</span>
      </button>
      <ResponsiveDialog open={open} onOpenChange={setOpen} title="Lock for a resident">
        <div className="space-y-4">
          <p className="text-[14px] leading-relaxed text-ink">
            Only <span className="font-semibold">{title}</span> stays open: the menus, other screens and admin links are hidden until someone enters the code.
          </p>
          <CodePad
            label={first === null ? "Choose a staff code" : "Enter the code again"}
            value={code}
            onChange={(v) => {
              setCode(v);
              setError("");
            }}
            onDone={() => void next()}
            error={error}
            doneLabel={first === null ? "Next" : "Lock"}
          />
        </div>
      </ResponsiveDialog>
    </>
  );
}

// Kept outside the bar so closing and reopening the pad doesn't reset the count.
let wrong = 0;
let waitUntil = 0;

/**
 * Along the top of the screen while the device is locked: what it's locked to,
 * and the staff way out.
 */
export function LockedBar({ lock }: { lock: FormLock }) {
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const waiting = waitUntil > now;
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [waiting]);
  useEffect(() => {
    if (open) return;
    setCode("");
    setError("");
  }, [open]);

  async function tryUnlock() {
    if (waitUntil > Date.now() || !code) return;
    if (await unlockForm(code)) {
      wrong = 0;
      setOpen(false);
      return;
    }
    wrong += 1;
    setCode("");
    if (wrong >= MAX_TRIES) {
      wrong = 0;
      waitUntil = Date.now() + WAIT_MS;
      setNow(Date.now());
      setError("Too many wrong codes.");
    } else setError("That's not the code.");
  }

  async function signOut() {
    clearFormLock();
    await logout();
  }

  const seconds = Math.ceil((waitUntil - now) / 1000);
  return (
    <>
      <div className="flex flex-none items-center gap-2 border-b border-hairline bg-sidebar px-4 pb-1.5 pt-[max(6px,var(--safe-top))] text-[13px] md:px-7">
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-muted">
          Locked to <span className="font-semibold text-ink">{lock.title}</span>
        </span>
        <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-[36px] shrink-0 items-center gap-1 px-1 font-semibold text-accent dark:text-white">
          <LockOpen className="h-3.5 w-3.5" /> Staff unlock
        </button>
      </div>
      <ResponsiveDialog open={open} onOpenChange={setOpen} title="Staff unlock">
        <div className="space-y-4">
          <CodePad
            label={waiting ? `Wait ${seconds}s, then try again` : "Enter the staff code"}
            value={code}
            onChange={(v) => {
              setCode(v);
              setError("");
            }}
            onDone={() => void tryUnlock()}
            error={error}
            doneLabel="Unlock"
            disabled={waiting}
            masked
          />
          <p className="text-center text-[12.5px] text-muted">
            Forgot the code?{" "}
            <button type="button" onClick={() => void signOut()} className="font-semibold text-accent dark:text-white">
              Sign out
            </button>{" "}
            instead. Answers not yet submitted may be lost.
          </p>
        </div>
      </ResponsiveDialog>
    </>
  );
}

/** A number pad big enough for a thumb; a hardware keyboard's digits work too. */
function CodePad({ label, value, onChange, onDone, error, doneLabel, disabled, masked }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
  error?: string;
  doneLabel: string;
  disabled?: boolean;
  masked?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key) && value.length < MAX_DIGITS) onChange(value + e.key);
      else if (e.key === "Backspace") onChange(value.slice(0, -1));
      else if (e.key === "Enter") onDone();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [value, onChange, onDone, disabled]);

  const key = "flex h-14 items-center justify-center rounded-input border border-hairline bg-surface font-heading text-[22px] font-bold text-ink active:bg-subtle2 disabled:opacity-45";
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <p className="text-center text-[14px] font-semibold text-ink">{label}</p>
      <div className="mt-3 flex h-10 items-center justify-center gap-2" aria-live="polite">
        {value.length === 0 ? (
          <span className="text-[13px] text-muted">{MIN_DIGITS}–{MAX_DIGITS} digits</span>
        ) : masked ? (
          Array.from(value, (_, i) => <span key={i} className="h-3 w-3 rounded-full bg-ink" />)
        ) : (
          <span className="font-mono text-[24px] font-bold tracking-[0.3em] text-ink">{value}</span>
        )}
      </div>
      <p className={cn("h-5 text-center text-[13px] font-semibold text-status-redText", !error && "invisible")}>{error || "·"}</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className={key} disabled={disabled || value.length >= MAX_DIGITS} onClick={() => onChange(value + d)}>
            {d}
          </button>
        ))}
        <button type="button" className={cn(key, "text-muted")} disabled={disabled || !value} onClick={() => onChange(value.slice(0, -1))} aria-label="Delete a digit">
          <Delete className="h-5 w-5" />
        </button>
        <button type="button" className={key} disabled={disabled || value.length >= MAX_DIGITS} onClick={() => onChange(value + "0")}>
          0
        </button>
        <Button className="h-14 text-[15px]" disabled={disabled || value.length < (masked ? 1 : MIN_DIGITS)} onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
