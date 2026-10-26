import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";

const WIDTH = 260;
const GUTTER = 16;

/**
 * A "?" that explains the thing beside it. Hover shows it on a desktop; a click
 * or tap pins it open (phones and iPads have no hover) until a tap elsewhere,
 * Escape, or another tap on the "?".
 *
 * The bubble is portalled to <body> and placed from the button's position, so a
 * sheet or dialog that scrolls doesn't clip it, and it's kept on screen.
 */
export function HelpTip({ children, label = "What's this?", className }: {
  children: React.ReactNode;
  /** Spoken name of the button. */
  label?: string;
  className?: string;
}) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const open = pinned || hovered;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(WIDTH, window.innerWidth - GUTTER * 2);
      const left = Math.max(GUTTER, Math.min(r.left - 12, window.innerWidth - width - GUTTER));
      // Below the "?" when there isn't room above it.
      const below = r.top < 150;
      setPos({ left, top: below ? r.bottom + 8 : r.top - 8, below });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [pinned]);

  return (
    <span className={cn("inline-flex align-middle", className)}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(false)}
        onClick={(e) => {
          // Inside a <label>, a click would also toggle the control it names.
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        className="-m-2 inline-flex items-center justify-center rounded-full p-2 text-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy"
      >
        <CircleHelp className="h-4 w-4" />
      </button>
      {open &&
        pos &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            style={{ left: pos.left, top: pos.top, width: Math.min(WIDTH, window.innerWidth - GUTTER * 2) }}
            className={cn(
              // Not clickable: inside a modal dialog, a press on it would count as outside the dialog.
              "pointer-events-none fixed z-[1000] rounded-card bg-ink px-3 py-2 text-left text-[12.5px] font-normal leading-snug text-surface shadow-lg",
              !pos.below && "-translate-y-full"
            )}
          >
            {children}
          </span>,
          document.body
        )}
    </span>
  );
}
