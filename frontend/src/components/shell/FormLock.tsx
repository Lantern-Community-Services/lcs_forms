import { Lock, LockOpen } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { lockForm, unlockForm, useFormLock, type FormLock } from "@/lib/formLock";
import { cn } from "@/lib/utils";

/** Whether this person's device is locked to a form right now (lib/formLock.ts). */
export function useLocked(): FormLock | null {
  const { user } = useAuth();
  return useFormLock(user?.id);
}

/** "Lock for resident", on a form's own screen: the device shows only this form until Unlock. */
export function LockFormButton({ base, title, className }: { base: string; title: string; className?: string }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <button
      type="button"
      data-tour="form-lock"
      onClick={() => lockForm({ base, title, userId: user.id })}
      className={cn("inline-flex min-h-[32px] items-center gap-1 text-[12.5px] font-semibold text-accent dark:text-white md:text-[13px]", className)}
      title="Hand this device to a resident: only this form stays open until you unlock it"
    >
      <Lock className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Lock for resident</span>
    </button>
  );
}

/** Along the top of the screen while the device is locked: what it's locked to, and the way out. */
export function LockedBar({ lock }: { lock: FormLock }) {
  return (
    <div className="flex flex-none items-center gap-2 border-b border-hairline bg-sidebar px-4 pb-1.5 pt-[max(6px,var(--safe-top))] text-[13px] md:px-7">
      <Lock className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-muted">
        Locked to <span className="font-semibold text-ink">{lock.title}</span>
      </span>
      <button type="button" onClick={unlockForm} className="inline-flex min-h-[36px] shrink-0 items-center gap-1 px-1 font-semibold text-accent dark:text-white">
        <LockOpen className="h-3.5 w-3.5" /> Unlock
      </button>
    </div>
  );
}
