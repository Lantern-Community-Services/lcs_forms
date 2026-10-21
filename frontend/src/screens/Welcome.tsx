import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { CheckboxList } from "@/components/ui/checkbox";
import { LoadingState } from "@/components/ui/misc";
import { errorMessage } from "@/lib/utils";

/**
 * A new person's first sign-in: where they work, and which sites they want
 * to see. It opens with the onboarding cookie the sign-in sets (not a
 * session), sends a request, and each chosen site's Site Manager or an Admin
 * approves it in People & roles. Signing in again before then comes back
 * here, with their choices, to change them.
 *
 * Like the sign-in screen it always wears the Lantern brand (fixed navy, the
 * unmodified logo): it's seen before anyone's preferences exist.
 */

const BRAND_NAVY =
  "bg-[#2c3453] hover:bg-[#232945] active:bg-[#1a2038] focus-visible:outline-[#2c3453]";

/** "Where do you work?"'s choice for the main office, which has no roster of its own. */
const MAIN_OFFICE = "main_office";

interface Onboarding {
  name: string;
  email: string;
  sites: { id: string; name: string; siteType: "supportive" | "shelter" | "other" }[];
  locations: string[];
  siteIds: string[];
  submitted: boolean;
}

export function WelcomePage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<Onboarding>("/onboarding"),
    retry: false,
  });
  const [locations, setLocations] = useState<string[] | null>(null);
  const [siteIds, setSiteIds] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
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

  const work = locations ?? data.locations;
  // Until they choose for themselves, the sites they see follow where they work.
  const see = siteIds ?? (data.submitted ? data.siteIds : work.filter((l) => l !== MAIN_OFFICE));
  const first = data.name.split(" ")[0] || data.name;

  if (data.submitted && !editing) {
    const names = data.sites.filter((s) => data.siteIds.includes(s.id)).map((s) => s.name);
    return (
      <Frame>
        <CheckCircle2 className="mx-auto h-10 w-10 text-status-greenDot" />
        <h1 className="mt-4 text-center font-heading text-[23px] font-extrabold text-ink">Request sent</h1>
        <p className="mt-2 text-center text-[13px] text-muted">
          You asked to see {names.join(", ")}. Each site's manager, or an admin, will approve it. We'll let you know, and then you can sign in.
        </p>
        <button type="button" onClick={() => setEditing(true)} className="mt-7 h-11 w-full rounded-input border border-hairline text-[14px] font-semibold text-ink hover:bg-rowhover">
          Change my request
        </button>
        <Link to="/signin" className="mt-3 block text-center text-[13px] text-muted underline-offset-2 hover:underline">Back to sign in</Link>
      </Frame>
    );
  }

  async function send() {
    setProblem(null);
    if (work.length === 0) return setProblem("Choose where you work.");
    if (see.length === 0) return setProblem("Choose at least one site to see.");
    setBusy(true);
    try {
      await api.post("/onboarding", { locations: work, siteIds: see });
      setEditing(false);
      setLocations(null);
      setSiteIds(null);
      await qc.invalidateQueries({ queryKey: ["onboarding"] });
    } catch (e) {
      setProblem(errorMessage(e, "Could not send your request."));
    } finally {
      setBusy(false);
    }
  }

  const siteOptions = data.sites.map((s) => ({ value: s.id, label: s.name }));
  return (
    <Frame wide>
      <h1 className="text-center font-heading text-[23px] font-extrabold text-ink">Welcome, {first}</h1>
      <p className="mt-2 text-center text-[13px] text-muted">
        Tell us where you work and which sites you need. Your site's manager or an admin will approve it.
      </p>

      <section className="mt-6">
        <h2 className="mb-1.5 text-[14px] font-semibold text-ink">Where do you work?</h2>
        <CheckboxList
          options={[{ value: MAIN_OFFICE, label: "Main Office" }, ...siteOptions]}
          value={work}
          onChange={setLocations}
          className="max-h-[260px] overflow-y-auto"
        />
      </section>

      <section className="mt-5">
        <h2 className="mb-0.5 text-[14px] font-semibold text-ink">Which sites do you want to see?</h2>
        <p className="mb-1.5 text-micro text-muted">Their rosters, forms and calendar. Pick only the ones you need for your work.</p>
        <CheckboxList options={siteOptions} value={see} onChange={setSiteIds} className="max-h-[260px] overflow-y-auto" />
      </section>

      {problem && (
        <div className="mt-4 rounded-card border border-status-redDot/30 bg-status-redBg px-3.5 py-3 text-[13px] text-status-redText">{problem}</div>
      )}

      <button
        type="button"
        onClick={() => void send()}
        disabled={busy}
        className={`mt-6 inline-flex h-[52px] w-full items-center justify-center rounded-input font-heading text-[15.5px] font-semibold text-white focus-visible:outline focus-visible:outline-2 disabled:opacity-45 md:h-11 md:text-[15px] ${BRAND_NAVY}`}
      >
        {busy ? "Sending…" : data.submitted ? "Update my request" : "Send request"}
      </button>
      <p className="mt-3 text-center text-micro text-muted">Signed in as {data.email}</p>
    </Frame>
  );
}

function Frame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-surface px-4 py-8 md:justify-center md:py-12">
      <div className={`w-full ${wide ? "max-w-[560px]" : "max-w-[400px]"} bg-surface md:rounded-card md:border md:border-hairline md:px-8 md:py-9 md:shadow-card`}>
        <img src="/lcs_logo_color.svg" alt="Lantern Community Services" className="mx-auto mb-5 h-16 w-auto dark:hidden" />
        <img src="/lcs_logo_white.svg" alt="Lantern Community Services" className="mx-auto mb-5 hidden h-16 w-auto dark:block" />
        {children}
      </div>
    </div>
  );
}
