import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Avatar } from "@/components/ui/avatar";
import { useSearchParams } from "react-router-dom";
import { Check } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useIsPhone } from "@/lib/useMediaQuery";
import { readStorage, writeStorage } from "@/lib/storage";

/**
 * Sign-in is Microsoft Entra ID only — one button, no form. The backend owns
 * the OAuth round trip; a failed attempt comes back here as ?error=<reason>.
 *
 * Deliberately theme-independent: this screen is the front door, seen before
 * anyone's preferences are loaded, so it always wears the Lantern brand rather
 * than the signed-in user's chosen accent. That means the fixed brand navy and
 * the unmodified logo — never `bg-navy`/`text-accent`/`<ThemedLogo>`, all of
 * which follow the Ocean/Plum/Forest/custom themes. Dark mode still applies:
 * the surface/ink/muted tokens used here react to `.dark` only.
 *
 * Phone: artboard 1a. Edge to edge with no card, a 140px logo, a 52px button
 * and the support line held against the bottom edge — the design replaces the
 * desktop card rather than resizing it.
 */

/** Lantern brand navy — pinned, not the themeable `--c-brand` token. */
const BRAND_NAVY =
  "bg-[#2c3453] hover:bg-[#232945] active:bg-[#1a2038] focus-visible:outline-[#2c3453]";

/** Where "stay signed in on this phone" is remembered between visits. */
const STAY_SIGNED_IN_KEY = "ln.staySignedIn";

export function SignInPage() {
  const { signInWithMicrosoft, devSignIn } = useAuth();
  const { data: config } = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => api.get<{ microsoft: boolean; dev: boolean }>("/auth/config"),
  });
  const { data: devUsers } = useQuery({
    queryKey: ["dev-users"],
    queryFn: () => api.get<{ id: string; name: string; email: string; roleName: string; avatarColor: string | null }[]>("/auth/dev-users"),
    enabled: Boolean(config?.dev),
  });
  const [params, setParams] = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "error" | "notice" } | null>(null);
  const phone = useIsPhone();
  /*
   * Whether the session should outlive the browser.
   *
   * On by default — what the artboard shows, and what somebody reaching for a
   * phone away from a desk wants. Unticking it makes the backend issue a
   * cookie with no expiry, so quitting the browser ends the session; that is
   * the whole of what this box does, and it is why it is offered on the phone
   * screen only. Face ID is the handset's own unlock on top of that, which is
   * the OS's to offer and not something the app can ask for.
   */
  const [staySignedIn, setStaySignedIn] = useState(true);

  useEffect(() => {
    const stored = readStorage(STAY_SIGNED_IN_KEY);
    if (stored !== null) setStaySignedIn(stored === "1");
  }, []);

  // The backend bounces outcomes back here: ?error= for something that went
  // wrong, ?notice= for a normal answer like "an admin has to approve you".
  // Held in state and stripped from the URL, so the message stays on screen
  // but a refresh (or a second attempt) doesn't resurrect a stale one.
  useEffect(() => {
    const error = params.get("error");
    const notice = params.get("notice");
    if (!error && !notice) return;
    setMessage(error ? { text: error, tone: "error" } : { text: notice!, tone: "notice" });
    const next = new URLSearchParams(params);
    next.delete("error");
    next.delete("notice");
    setParams(next, { replace: true });
  }, [params, setParams]);

  // The app shell paints <body> the gray app background. This screen is pure
  // surface edge to edge, so match the body while it is mounted — otherwise
  // overscroll (trackpad rubber-banding, mobile Safari) reveals a gray band.
  useEffect(() => {
    const previous = document.body.style.background;
    document.body.style.background = "rgb(var(--c-surface))";
    return () => {
      document.body.style.background = previous;
    };
  }, []);

  function toggleStaySignedIn() {
    const next = !staySignedIn;
    setStaySignedIn(next);
    writeStorage(STAY_SIGNED_IN_KEY, next ? "1" : "0");
  }

  function start(selectAccount = false) {
    setMessage(null);
    setRedirecting(true);
    signInWithMicrosoft(params.get("returnTo") ?? undefined, {
      selectAccount,
      // Only the screen that offers the choice gets to make it.
      staySignedIn: phone ? staySignedIn : undefined,
    });
  }

  return (
    /* Phone: the front door is the whole screen — 24px gutters and a column
       that centres the lockup between the status bar and the support line. */
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 md:py-12">
      {/* Same fill as the page behind it — the hairline and a 1px shadow are all
          that separate them, so the box reads as an outline, not a raised card.
          Matches the app's <Card> so the front door speaks the same language. */}
      <div className="flex w-full max-w-[400px] flex-1 flex-col bg-surface md:flex-none md:rounded-card md:border md:border-hairline md:px-8 md:py-10 md:shadow-card">
        {/* Phone: this group takes the free height and centres itself in it, so
            the support line below can hold the bottom edge. `pt-safe-top`
            lands the lockup at the artboard's 54px on a device that reports a
            42px status bar, and at 12px in a browser without one. */}
        <div className="flex flex-1 flex-col justify-center pt-safe-top md:block md:flex-none md:pt-0">
          <img
            src="/lcs_logo_color.svg"
            alt="Lantern Community Services"
            className="mx-auto h-[140px] w-auto dark:hidden md:h-48"
          />
          <img
            src="/lcs_logo_white.svg"
            alt="Lantern Community Services"
            className="mx-auto hidden h-[140px] w-auto dark:block md:h-48"
          />

          <h1 className="mt-[26px] text-center text-[23px] font-heading font-extrabold text-ink md:mt-6">
            Sign in to Lantern Forms
          </h1>
          {/* There is no Lantern Forms password to have forgotten. Google
              Workspace partners come through the same button: Entra federates
              their address to Google. */}
          <p className="mt-2 text-center text-[13px] text-muted">
            Use your work account. Partner staff on Google Workspace: enter your work email and
            Microsoft will send you on to Google.
          </p>

          {message ? (
            <div
              className={
                message.tone === "error"
                  ? "mt-6 rounded-card border border-status-redDot/30 bg-status-redBg px-3.5 py-3 text-[13px] text-status-redText"
                  : "mt-6 rounded-card border border-status-blueDot/30 bg-status-blueBg px-3.5 py-3 text-[13px] text-status-blueText"
              }
            >
              {message.text}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => start()}
            disabled={redirecting || config?.microsoft === false}
            title={config?.microsoft === false ? "Microsoft sign-in isn't configured on this server yet" : undefined}
            className={`mt-7 inline-flex h-[52px] w-full items-center justify-center gap-[9px] rounded-input font-heading text-[15.5px] font-semibold text-white transition-colors focus-visible:outline focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-45 md:h-11 md:gap-2 md:text-[15px] ${BRAND_NAVY}`}
          >
            <MicrosoftLogo /> {redirecting ? "Redirecting to Microsoft…" : "Continue with Microsoft"}
          </button>

          {config?.dev && (
            <div className="mt-5 rounded-card border border-dashed border-strongline p-3">
              <p className="kicker mb-1">Prototype sign-in</p>
              <p className="mb-2 text-micro text-muted">
                Local only — pick a demo account. Off in production, and whenever DEV_AUTH=false.
              </p>
              <div className="flex flex-col">
                {(devUsers ?? []).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => void devSignIn(u.id).catch((e) => setMessage({ text: String(e?.message ?? e), tone: "error" }))}
                    className="flex min-h-[44px] items-center gap-2.5 rounded-input px-2 text-left hover:bg-rowhover"
                  >
                    <Avatar name={u.name} color={u.avatarColor} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-ink">{u.name}</span>
                      <span className="block truncate text-micro text-muted">{u.roleName} · {u.email}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Phone only. On a shared desktop the safe default is the opposite,
              and a box that has to be un-ticked every time is worse than none. */}
          <label className="mt-4 flex min-h-[44px] cursor-pointer items-center gap-[11px] px-0.5 md:hidden">
            <input type="checkbox" checked={staySignedIn} onChange={toggleStaySignedIn} className="peer sr-only" />
            <span
              aria-hidden="true"
              className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[4px] transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#2c3453] ${
                staySignedIn ? "bg-[#2c3453] dark:bg-[#bccfff]" : "border border-strongline"
              }`}
            >
              {staySignedIn && <Check className="h-3.5 w-3.5 text-white dark:text-[#232a3a]" strokeWidth={3.2} />}
            </span>
            <span className="text-[13.5px] text-ink">
              Stay signed in on this phone <span className="text-muted">· unlock with Face ID</span>
            </span>
          </label>

          {/* For the few people signed into more than one work account. */}
          <button
            type="button"
            onClick={() => start(true)}
            disabled={redirecting}
            className="mt-2.5 min-h-[44px] w-full text-center text-[13.5px] font-semibold text-[#2c3453] hover:underline disabled:opacity-50 dark:text-[#bccfff] md:mt-3 md:min-h-0 md:text-[13px]"
          >
            Use a different account
          </button>
        </div>

        {/* On a phone this holds the bottom edge instead of trailing the button,
            so the two things you might tap are not adjacent. */}
        <p className="flex-none pb-11 text-center text-micro text-muted md:mt-8 md:pb-0">
          Trouble signing in?{" "}
          <a
            href="mailto:helpdesk@progressny.com"
            className="font-semibold text-[#2c3453] hover:underline dark:text-[#bccfff]"
          >
            Contact the IT Team
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="h-[17px] w-[17px] md:h-4 md:w-4" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
