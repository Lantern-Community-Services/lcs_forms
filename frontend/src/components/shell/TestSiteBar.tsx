import { FlaskConical } from "lucide-react";
import { useAuthConfig } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Is this a test site (made-up residents only)? The server says so at /auth/config. */
export function useTestSite() {
  return Boolean(useAuthConfig().data?.testSite);
}

/**
 * Above every screen on a test site (the Azure dev app, a copy on a computer):
 * its residents are made up (backend services/testData.ts), so nobody types a
 * real resident's details into it. `top`: nothing above it, so it clears the
 * status bar itself, as the form lock's bar does.
 */
export function TestSiteBar({ top }: { top: boolean }) {
  if (!useTestSite()) return null;
  return (
    <div
      role="note"
      className={cn(
        "flex flex-none items-center justify-center gap-2 border-b border-status-amberDot/40 bg-status-amberBg px-4 pb-1.5 text-[12.5px] text-status-amberText md:px-7",
        top ? "pt-[max(6px,var(--safe-top))]" : "pt-1.5"
      )}
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">Test site.</strong> The residents here are made up. Don't enter real residents' information.
      </span>
    </div>
  );
}
