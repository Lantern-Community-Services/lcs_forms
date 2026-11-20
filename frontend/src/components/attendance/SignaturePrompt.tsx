import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignaturePad, type SignaturePadHandle } from "./SignaturePad";

/**
 * "Sign here" — shown inside the roll call itself, crossfading in over the
 * card deck the moment someone is marked present, so the signature reads as
 * the next step of the same card rather than a separate screen. The parent
 * owns the fade; this fills whatever height it is given.
 */
export function SignaturePanel({
  tenantName,
  alreadyPresent,
  alreadySigned,
  onClose,
  onSign,
  onSkip,
  onRemove,
}: {
  tenantName: string;
  /** Reopening an existing entry (to redo/clear/remove) vs. the first "just marked present" prompt. */
  alreadyPresent: boolean;
  alreadySigned: boolean;
  onClose: () => void;
  onSign: (signature: string) => void;
  onSkip: () => void;
  onRemove: () => void;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [empty, setEmpty] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  // Bring the whole panel — pad and buttons — into view as it fades in.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  return (
    <div ref={rootRef} className="flex scroll-mt-2 flex-col">
      <div className="flex flex-none items-start gap-2 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-title-sm font-heading font-extrabold text-ink">{tenantName}</h2>
          <p className="mt-0.5 text-label text-muted">
            {alreadySigned ? "Already signed — sign again to replace it." : "Sign here to confirm they're present."}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-input p-2 text-muted hover:bg-rowhover" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <SignaturePad ref={padRef} onChangeEmpty={setEmpty} className="h-[min(230px,34vh)] w-full" />

      <div className="flex flex-none flex-col gap-2 pt-3">
        <div className="flex gap-2">
          <Button variant="secondary" className="min-h-[48px] flex-1" onClick={() => padRef.current?.clear()}>
            Clear
          </Button>
          <Button
            className="min-h-[48px] flex-1"
            disabled={empty}
            onClick={() => {
              const data = padRef.current?.toDataURL();
              if (data) onSign(data);
            }}
          >
            Sign & save
          </Button>
        </div>
        <Button variant="ghost" className="min-h-[44px]" onClick={onSkip}>
          {alreadySigned ? "Remove signature — keep marked present" : "Skip signature — just mark present"}
        </Button>
        {alreadyPresent && (
          <Button variant="outlineDanger" className="min-h-[44px]" onClick={onRemove}>
            Remove from attendance
          </Button>
        )}
      </div>
    </div>
  );
}
