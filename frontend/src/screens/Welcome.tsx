import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { LoadingState } from "@/components/ui/misc";
import { errorMessage } from "@/lib/utils";

/**
 * A first sign-in by someone nobody made an account for: one button to ask
 * for access. It opens with the onboarding cookie the sign-in sets (not a
 * session). An Admin approves it in People & roles → Requests and chooses
 * their role and sites. Signing in again before then comes back here, to
 * "Request sent".
 *
 * Like the sign-in screen it always wears the Lantern brand (fixed navy, the
 * unmodified logo): it's seen before anyone's preferences exist.
 */

const BRAND_NAVY =
  "bg-[#2c3453] hover:bg-[#232945] active:bg-[#1a2038] focus-visible:outline-[#2c3453]";

interface Onboarding {
  name: string;
  email: string;
  submitted: boolean;
}

export function WelcomePage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<Onboarding>("/onboarding"),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (isLoading) return <Frame><LoadingState /></Frame>;
  if (error || !data) {
    return (
      <Frame>
        <h1 className="text-center font-heading text-[23px] font-extrabold text-ink">Sign in again to continue</h1>
        <p className="mt-2 text-center text-[13px] text-muted">This page needs a fresh sign-in. It only works for a couple of hours after you sign in.</p>
        <Link to="/signin" className={`mt-7 inline-flex h-11 w-full items-center justify-center rounded-input font-heading text-[15px] font-semibold text-white ${BRAND_NAVY}`}>
          Back to sign in
        </Link>
      </Frame>
    );
  }

  const first = data.name.split(" ")[0] || data.name;

  if (data.submitted) {
    return (
      <Frame>
        <CheckCircle2 className="mx-auto h-10 w-10 text-status-greenDot" />
        <h1 className="mt-4 text-center font-heading text-[23px] font-extrabold text-ink">Request sent</h1>
        <p className="mt-2 text-center text-[13px] text-muted">
          An admin will look at your request and set up your access. We'll let you know, and then you can sign in.
        </p>
        <Link to="/signin" className="mt-7 block text-center text-[13px] text-muted underline-offset-2 hover:underline">Back to sign in</Link>
      </Frame>
    );
  }

  async function send() {
    setProblem(null);
    setBusy(true);
    try {
      await api.post("/onboarding");
      await qc.invalidateQueries({ queryKey: ["onboarding"] });
    } catch (e) {
      setProblem(errorMessage(e, "Could not send your request."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <h1 className="text-center font-heading text-[23px] font-extrabold text-ink">Welcome, {first}</h1>
      <p className="mt-2 text-center text-[13px] text-muted">
        You don't have access to Lantern Forms yet. Request it, and an admin will set it up for you.
      </p>

      {problem && (
        <div className="mt-4 rounded-card border border-status-redDot/30 bg-status-redBg px-3.5 py-3 text-[13px] text-status-redText">{problem}</div>
      )}

      <button
        type="button"
        onClick={() => void send()}
        disabled={busy}
        className={`mt-6 inline-flex h-[52px] w-full items-center justify-center rounded-input font-heading text-[15.5px] font-semibold text-white focus-visible:outline focus-visible:outline-2 disabled:opacity-45 md:h-11 md:text-[15px] ${BRAND_NAVY}`}
      >
        {busy ? "Sending…" : "Request access"}
      </button>
      <p className="mt-3 text-center text-micro text-muted">Signed in as {data.email}</p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-surface px-4 py-8 md:justify-center md:py-12">
      <div className="w-full max-w-[400px] bg-surface md:rounded-card md:border md:border-hairline md:px-8 md:py-9 md:shadow-card">
        <img src="/lcs_logo_color.svg" alt="Lantern Community Services" className="mx-auto mb-5 h-16 w-auto dark:hidden" />
        <img src="/lcs_logo_white.svg" alt="Lantern Community Services" className="mx-auto mb-5 hidden h-16 w-auto dark:block" />
        {children}
      </div>
    </div>
  );
}
