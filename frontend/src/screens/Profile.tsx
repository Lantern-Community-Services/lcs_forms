import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Compass, LogOut, Moon, RotateCcw, SquarePlus, Sun } from "lucide-react";
import { resetTours } from "@/lib/tour/progress";
import { MobileBackLink, Page, PageHeader } from "@/components/shell/AppShell";
import { SnapshotSummary } from "@/components/shell/OfflineBar";
import { canAddToHomeScreen, openHomeScreenHelp } from "@/components/shell/HomeScreenPrompt";
import { NotificationSettings } from "@/components/NotificationSettings";
import { ClaudeProfileCard } from "@/components/ClaudeConnections";
import { ViewAsCard } from "@/components/shell/ViewAs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { usePrefs, type ThemeName } from "@/lib/prefs";
import type { LandingPage } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const AVATAR_COLORS = [
  "#1d4ed8", "#7c3aed", "#be123c", "#c2410c",
  "#a16207", "#15803d", "#0f766e", "#6b4f3b",
];

/** Each theme's thumbnail colours, light and dark (the dark ones match index.css). */
const THEMES: { id: ThemeName; label: string; color: string; sidebar: string; darkColor: string; darkSidebar: string }[] = [
  { id: "lantern", label: "Lantern", color: "#2c3453", sidebar: "#fbfcfd", darkColor: "#bccfff", darkSidebar: "#050505" },
  { id: "ocean", label: "Ocean", color: "#0e7490", sidebar: "#eff9fc", darkColor: "#7dc8de", darkSidebar: "#061418" },
  { id: "plum", label: "Plum", color: "#6d2873", sidebar: "#fbf7fc", darkColor: "#d6aadc", darkSidebar: "#120813" },
  { id: "forest", label: "Forest", color: "#166534", sidebar: "#f5faf6", darkColor: "#86cd9c", darkSidebar: "#07120b" },
];

/** A landing page saved before the roster screens became tabs, in today's terms. */
function currentLanding(saved: string | undefined): LandingPage {
  const legacy: Record<string, LandingPage> = { "/review": "/roster/review", "/dashboard": "/roster/overview", "/forms": "/home" };
  return legacy[saved ?? ""] ?? (saved as LandingPage | undefined) ?? "/home";
}

export function ProfilePage() {
  const { user, logout, refresh, can } = useAuth();
  const { dark, setDark, theme, setTheme, customThemeColor, setCustomThemeColor } = usePrefs();
  const toast = useToast();
  const [avatarColor, setAvatarColor] = useState(user?.avatarColor ?? "#2c3453");
  const [landing, setLanding] = useState<LandingPage>(currentLanding(user?.defaultLandingPage));
  const [preferenceStatus, setPreferenceStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    // Only the avatar colour is this app's to own — see the note under the
    // read-only identity fields.
    try {
      await api.patch("/users/me/profile", { avatarColor });
      await refresh();
      toast("Profile color saved.");
    } catch (error) {
      toast(errorMessage(error, "Could not save your profile color."), "error");
    }
  }

  async function savePreferences(
    patch: { defaultLandingPage?: LandingPage },
    rollback: () => void
  ) {
    setPreferenceStatus("saving");
    try {
      await api.patch("/users/me/profile", patch);
      await refresh();
      setPreferenceStatus("saved");
    } catch (error) {
      rollback();
      setPreferenceStatus("error");
      toast(errorMessage(error, "Could not save preferences."), "error");
    }
  }

  const navigate = useNavigate();
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  /** Forget which forms' tutorials they've seen, so each runs again next time they open it. */
  async function showFormTutorialsAgain() {
    if (!user) return;
    setResetting(true);
    try {
      await resetTours(qc, user.id, "forms");
      toast("Done. Each form's tutorial will run again the next time you open it.");
    } catch (error) {
      toast(errorMessage(error, "Couldn't reset the tutorials. Try again."), "error");
    } finally {
      setResetting(false);
    }
  }

  function changeLanding(value: string) {
    const next = value as LandingPage;
    const previous = landing;
    setLanding(next);
    void savePreferences({ defaultLandingPage: next }, () => setLanding(previous));
  }

  const themeSwatch = (option: (typeof THEMES)[number]) => (
    <ThemeSwatch
      key={option.id}
      label={option.label}
      color={dark ? option.darkColor : option.color}
      sidebar={dark ? option.darkSidebar : option.sidebar}
      dark={dark}
      selected={theme === option.id}
      onSelect={() => setTheme(option.id)}
    />
  );

  const landingOptions = [
    { value: "/home", label: "Home" },
    { value: "/forms/all", label: "All forms" },
    { value: "/calendar", label: "Calendar" },
    ...(can("roster.view")
      ? [
          { value: "/roster", label: "Roster · Residents" },
          ...(can("roster.archive") ? [{ value: "/roster/review", label: "Roster · Review" }] : []),
          { value: "/roster/attendance", label: "Roster · Attendance" },
          { value: "/roster/activity", label: "Roster · Activity" },
          { value: "/roster/overview", label: "Roster · Overview" },
        ]
      : []),
  ];

  return (
    <Page className="max-w-[720px]">
      {/* Artboard 1i. Reached through More on a phone, so it carries the way
          back; the desktop sidebar is always on screen and needs none. */}
      <div className="page-list-item-enter">
        <MobileBackLink to="/home" label="Home" />
        <PageHeader title="Profile &amp; settings" help={{ article: "your-notifications", text: "Your details, how the site looks, what you're told and how, and the tour." }} />
      </div>

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "35ms" }}>
        <p className="kicker mb-4">Account</p>
        <div className="flex items-center gap-4">
          <Avatar name={user?.name || "?"} color={avatarColor} size={56} />
          <div>
            <p className="text-[16px] font-heading font-extrabold text-ink">{user?.name}</p>
            <p className="text-label text-muted">{user?.role?.name} · {user?.allSites ? "all sites" : (user?.sites ?? []).map((x) => x.name).join(", ") || "no sites yet"}</p>
          </div>
        </div>

        {/* Read-only on purpose. All three are read from your Microsoft account on
            every sign-in, so anything typed here was saved and then quietly
            reverted the next time you signed in. Shown as text, not as fields,
            so nothing looks as if it can be edited. */}
        <div className="mt-4 border-t border-hairline pt-4">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><dt className="text-caption font-semibold text-muted">Name</dt><dd className="mt-0.5 text-body font-semibold text-ink">{user?.name ?? ""}</dd></div>
            <div><dt className="text-caption font-semibold text-muted">Title</dt><dd className="mt-0.5 text-body font-semibold text-ink">{user?.title || "Not set"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-caption font-semibold text-muted">Email</dt><dd className="mt-0.5 truncate text-body font-semibold text-ink">{user?.email ?? ""}</dd></div>
          </dl>
          <p className="mt-3 text-caption text-muted">From your Microsoft account. To change them, ask the IT Team to update the directory.</p>
        </div>

        <div className="mt-4 border-t border-hairline pt-4">
          <p className="text-label font-semibold text-ink">Profile color</p>
          <p className="mt-0.5 text-caption text-muted">Choose the background color for your initials.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {AVATAR_COLORS.map((color) => (
              <button key={color} type="button" onClick={() => setAvatarColor(color)} title={`Use ${color}`}
                className={`flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 touch:h-11 touch:w-11 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy ${avatarColor === color ? "ring-2 ring-navy" : ""}`}
                style={{ backgroundColor: color }} aria-label={`Use profile color ${color}`}>
                {avatarColor === color && <span className="text-sm font-bold leading-none text-white">✓</span>}
              </button>
            ))}
            <label
              title="Choose a custom profile color"
              className={`relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full ring-offset-2 touch:h-11 touch:w-11 transition focus-within:outline focus-within:outline-2 focus-within:outline-navy ${AVATAR_COLORS.includes(avatarColor) ? "" : "ring-2 ring-navy"}`}
              style={{ background: `linear-gradient(135deg, #ef4444, #f59e0b 30%, #22c55e 50%, #3b82f6 70%, #a855f7)` }}
            >
              <input type="color" value={avatarColor} onChange={(event) => setAvatarColor(event.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="Choose a custom profile color" />
              <span className="h-4 w-4 rounded-full border border-white/80" style={{ backgroundColor: avatarColor }} />
            </label>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={save}>Save</Button>
        </div>
      </Card>

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "52ms" }}>
        <p className="kicker">Appearance</p>
        <p className="mt-1 text-label text-muted">Themes change the application chrome and accent colors only. Your profile color stays personal.</p>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-card border border-hairline p-3">
          <label htmlFor="dark-mode" className="cursor-pointer">
            <span className="flex items-center gap-2 text-label font-semibold text-ink">
              {dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              Dark mode
            </span>
            <span className="block text-caption text-muted">Works with any theme below.</span>
          </label>
          <Switch id="dark-mode" checked={dark} onCheckedChange={setDark} aria-label="Dark mode" />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {THEMES.map(themeSwatch)}
        </div>
        <div
          className={`mt-3 flex items-center justify-between rounded-card border p-3 ${theme === "custom" ? "border-accent ring-1 ring-accent" : "border-hairline"}`}
          role="button"
          tabIndex={0}
          onClick={() => setTheme("custom")}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setTheme("custom"); } }}
        >
          <div className="cursor-pointer">
            <p className="text-label font-semibold text-ink">Custom theme</p>
            <p className="text-caption text-muted">Choose the navigation and accent color.</p>
          </div>
          <label className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-input border border-hairline touch:h-11 touch:w-11" style={{ backgroundColor: customThemeColor }} title="Choose custom theme color">
            <input type="color" value={customThemeColor} onChange={(event) => { setCustomThemeColor(event.target.value); setTheme("custom"); }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="Choose custom theme color" />
            <span className="sr-only">Choose custom theme color</span>
          </label>
        </div>
      </Card>

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "70ms" }}>
        <div className="flex min-h-4 items-center justify-between gap-3">
          <p className="kicker">Default landing page</p>
          <p className={`text-caption ${preferenceStatus === "error" ? "text-danger" : "text-muted"}`} aria-live="polite">
            {preferenceStatus === "saving" ? "Saving…" : preferenceStatus === "saved" ? "Saved" : preferenceStatus === "error" ? "Save failed" : "Changes save automatically"}
          </p>
        </div>
        <p className="mt-1 text-label text-muted">The page Lantern Forms opens on.</p>
        <div className="mt-3">
          <Select value={landing} onChange={(e) => changeLanding(e.target.value)} options={landingOptions} disabled={preferenceStatus === "saving"} aria-label="Default landing page" />
        </div>
      </Card>

      <NotificationSettings delay="80ms" />

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "82ms" }}>
        <p className="kicker">Tutorials</p>
        <p className="mt-1 text-label text-muted">
          The welcome tour shows you around the site. Forms can have their own tutorial too, the first time you open them.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => navigate("/home?tour=site")}>
            <Compass className="h-4 w-4" /> Take the tour
          </Button>
          <Button variant="secondary" onClick={() => void showFormTutorialsAgain()} disabled={resetting}>
            <RotateCcw className="h-4 w-4" /> Show form tutorials again
          </Button>
        </div>
      </Card>

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "84ms" }}>
        <p className="kicker">Offline</p>
        <SnapshotSummary className="mt-2" />
        {canAddToHomeScreen() && (
          <div className="mt-4">
            <p className="mb-3 text-label text-muted">You're using Lantern Forms in a browser tab. Added to your Home Screen, it keeps offline work safer.</p>
            <Button variant="secondary" onClick={openHomeScreenHelp}>
              <SquarePlus className="h-4 w-4" /> Add to Home Screen
            </Button>
          </div>
        )}
      </Card>

      <ClaudeProfileCard delay="86ms" />

      <ViewAsCard delay="88ms" />

      {/* Phone: the button takes the full width above its explanation, because
          side by side at 402px the sentence gets two words a line. Desktop keeps
          the sentence and the button on one row. */}
      <div
        className="page-list-item-enter flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-between md:gap-4"
        style={{ animationDelay: "140ms" }}
      >
        {/* No password to change — identity is managed in Microsoft Entra ID. */}
        <p className="text-caption text-muted">
          Signed in as {user?.email}
          {user?.identityProvider && user.identityProvider !== "microsoft" ? ` through your organisation's sign-in (${user.identityProvider}), via Lantern's Microsoft Entra` : " with your Microsoft account"}.
          Passwords are managed by your organisation, not by Lantern Forms.
        </p>
        <Button variant="outlineDanger" onClick={() => logout()} className="min-h-[48px] w-full md:h-9 md:min-h-0 md:w-auto">
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </div>

    </Page>
  );
}

/** One theme to pick: a thumbnail of its sidebar, accent and page, and its name. */
function ThemeSwatch({ label, color, sidebar, dark = false, selected, onSelect }: {
  label: string;
  color: string;
  sidebar: string;
  /** Drawn on a dark page with a light hairline, instead of a white page. */
  dark?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-card border p-2.5 text-left transition hover:border-strongline ${selected ? "border-accent ring-1 ring-accent" : "border-hairline"}`}
      aria-pressed={selected}
    >
      <span className={`mb-2 flex h-7 overflow-hidden rounded-input border ${dark ? "border-white/10" : "border-black/5"}`} style={{ backgroundColor: sidebar }}>
        <span className="w-2/5" style={{ backgroundColor: color }} />
        <span className={`flex-1 ${dark ? "bg-[#0f0f0f]" : "bg-white"}`} />
      </span>
      <span className="block text-label font-semibold text-ink">{label}</span>
    </button>
  );
}
