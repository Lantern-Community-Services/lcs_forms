import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/**
 * /connect/claude — "Allow Claude to read Lantern Forms as you?"
 *
 * Claude sends people here when they connect the Lantern Forms connector
 * (backend oauth/provider.ts). They're signed in first (Protected), see what
 * Claude will be able to do, and Allow or Cancel; either way the browser goes
 * back to Claude. A full page of its own, like sign-in: no sidebar to wander
 * off into halfway through connecting.
 */

interface ConnectRequest {
  client: string;
  returnsTo: string;
  scope: string;
  user: { name: string; email: string; role: string };
}

const CAN = [
  "See the forms on your Forms screen and the entries you're allowed to read",
  "See residents and attendance at your sites",
  "See the calendar",
];

export function ConnectClaudePage() {
  const [params] = useSearchParams();
  const req = params.get("req") ?? "";
  const { data, isLoading, error } = useQuery({
    queryKey: ["oauth", "request", req],
    queryFn: () => api.get<ConnectRequest>(`/oauth/request?req=${encodeURIComponent(req)}`),
    enabled: Boolean(req),
    retry: false,
  });
  const [busy, setBusy] = useState<"allow" | "cancel" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function answer(allow: boolean) {
    setBusy(allow ? "allow" : "cancel");
    setFailed(null);
    try {
      const { redirect } = await api.post<{ redirect: string }>("/oauth/consent", { req, allow });
      window.location.assign(redirect);
    } catch (e) {
      setBusy(null);
      setFailed(errorMessage(e, "Couldn't finish connecting. Start again from Claude."));
    }
  }

  const problem = !req ? "This link is missing its connection details. Start again from Claude." : error ? errorMessage(error, "This connection link didn't work. Start again from Claude.") : failed;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 md:py-12">
      <div className="flex w-full max-w-[420px] flex-1 flex-col justify-center bg-surface pt-safe-top md:flex-none md:rounded-card md:border md:border-hairline md:px-8 md:py-10 md:shadow-card md:pt-10">
        <img src="/lcs_logo_color.svg" alt="Lantern Community Services" className="mx-auto h-20 w-auto dark:hidden" />
        <img src="/lcs_logo_white.svg" alt="Lantern Community Services" className="mx-auto hidden h-20 w-auto dark:block" />

        {isLoading ? (
          <div className="mt-8"><LoadingState /></div>
        ) : data ? (
          <>
            <h1 className="mt-6 text-center font-heading text-[22px] font-extrabold text-ink">
              Allow {data.client} to read Lantern Forms as you?
            </h1>
            <p className="mt-2 text-center text-[13px] text-muted">
              Signed in as <strong className="text-ink">{data.user.name}</strong> ({data.user.role}) · {data.user.email}
            </p>

            <div className="mt-6 rounded-card border border-hairline p-4">
              <p className="kicker mb-2">{data.client} will be able to</p>
              <ul className="grid gap-2 text-[13.5px] text-ink">
                {CAN.map((c) => (
                  <li key={c} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-status-greenDot" /> {c}</li>
                ))}
                <li className="flex gap-2"><X className="mt-0.5 h-4 w-4 shrink-0 text-status-redText" /> Change anything: it can only read</li>
              </ul>
              <p className="mt-3 text-micro text-muted">
                Only what you can see on the site yourself. You can disconnect it any time on your Profile.
              </p>
            </div>

            {problem ? <Problem text={problem} /> : null}

            <div className="mt-6 grid gap-2">
              <Button size="lg" onClick={() => void answer(true)} disabled={busy !== null}>
                {busy === "allow" ? "Connecting…" : "Allow"}
              </Button>
              <Button size="lg" variant="secondary" onClick={() => void answer(false)} disabled={busy !== null}>
                Cancel
              </Button>
            </div>
            <p className="mt-4 text-center text-micro text-muted">You'll go back to {data.returnsTo === "this computer" ? "Claude on this computer" : data.returnsTo}.</p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-center font-heading text-[22px] font-extrabold text-ink">Connect Claude</h1>
            <Problem text={problem ?? "This connection link didn't work. Start again from Claude."} />
          </>
        )}
      </div>
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <div className="mt-6 rounded-card border border-status-redDot/30 bg-status-redBg px-3.5 py-3 text-[13px] text-status-redText">{text}</div>
  );
}
