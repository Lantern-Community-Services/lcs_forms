import { useState } from "react";
import { LogOut } from "lucide-react";
import { MobileBackLink, Page, PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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

const THEMES: { id: ThemeName; label: string; color: string; sidebar: string }[] = [
  { id: "lantern", label: "Lantern", color: "#2c3453", sidebar: "#fbfcfd" },
  { id: "ocean", label: "Ocean", color: "#0e7490", sidebar: "#eff9fc" },
  { id: "plum", label: "Plum", color: "#6d2873", sidebar: "#fbf7fc" },
  { id: "forest", label: "Forest", color: "#166534", sidebar: "#f5faf6" },
];
const DARK_THEME = { label: "Dark", color: "#8aa6e0", sidebar: "#121723" };

/** A landing page saved before the roster screens became tabs, in today's terms. */
function currentLanding(saved: string | undefined): LandingPage {
  const legacy: Record<string, LandingPage> = { "/review": "/roster/review", "/dashboard": "/roster/overview" };
  return legacy[saved ?? ""] ?? (saved as LandingPage | undefined) ?? "/forms";
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

  function changeLanding(value: string) {
    const next = value as LandingPage;
    const previous = landing;
    setLanding(next);
    void savePreferences({ defaultLandingPage: next }, () => setLanding(previous));
  }

  const lightSwatch = (option: (typeof THEMES)[number]) => (
    <ThemeSwatch
      key={option.id}
      {...option}
      selected={!dark && theme === option.id}
      onSelect={() => { setTheme(option.id); setDark(false); }}
    />
  );

  const landingOptions = [
    { value: "/forms", label: "Forms" },
    ...(can("roster.view")
      ? [
          { value: "/roster", label: "Roster · Residents" },
          { value: "/roster/review", label: "Roster · Review" },
          { value: "/roster/overview", label: "Roster · Overview" },
        ]
      : []),
  ];

  return (
    <Page className="max-w-[720px]">
      {/* Artboard 1i. Reached through More on a phone, so it carries the way
          back; the desktop sidebar is always on screen and needs none. */}
      <div className="page-list-item-enter">
        <MobileBackLink to="/forms" label="Home" />
        <PageHeader title="Profile &amp; settings" />
      </div>

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "35ms" }}>
        <p className="kicker mb-4">Account</p>
        <div className="flex items-center gap-4">
          <Avatar name={user?.name || "?"} color={avatarColor} size={56} />
          <div>
            <p className="text-[16px] font-heading font-extrabold text-ink">{user?.name}</p>
            <p className="text-[13px] text-muted">{user?.role?.name} · {user?.allSites ? "all sites" : (user?.sites ?? []).map((x) => x.name).join(", ") || "no sites yet"}</p>
          </div>
        </div>

        {/* Read-only on purpose. All three are read from your Microsoft account on
            every sign-in, so anything typed here was saved and then quietly
            reverted the next time you signed in. */}
        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-hairline pt-4 sm:grid-cols-2">
          <Field label="Name"><Input value={user?.name ?? ""} readOnly className="bg-subtle" /></Field>
          <Field label="Title"><Input value={user?.title ?? "—"} readOnly className="bg-subtle" /></Field>
          <Field label="Email" className="sm:col-span-2"><Input value={user?.email ?? ""} readOnly className="truncate bg-subtle" /></Field>
          <p className="text-micro text-muted sm:col-span-2">
            Your name, job title and email come from your sign-in account. To change them, ask the IT
            Team to update the directory — editing them here wouldn't stick.
          </p>
        </div>

        <div className="mt-4 border-t border-hairline pt-4">
          <p className="text-[13px] font-semibold text-ink">Profile color</p>
          <p className="mt-0.5 text-micro text-muted">Choose the background color for your initials.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {AVATAR_COLORS.map((color) => (
              <button key={color} type="button" onClick={() => setAvatarColor(color)} title={`Use ${color}`}
                className={`flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy ${avatarColor === color ? "ring-2 ring-navy" : ""}`}
                style={{ backgroundColor: color }} aria-label={`Use profile color ${color}`}>
                {avatarColor === color && <span className="text-sm font-bold leading-none text-white">✓</span>}
              </button>
            ))}
            <label
              title="Choose a custom profile color"
              className={`relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full ring-offset-2 transition focus-within:outline focus-within:outline-2 focus-within:outline-navy ${AVATAR_COLORS.includes(avatarColor) ? "" : "ring-2 ring-navy"}`}
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

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "70ms" }}>
        <div className="mb-4 flex min-h-4 items-center justify-between gap-3">
          <p className="kicker">Preferences</p>
          <p className={`text-micro ${preferenceStatus === "error" ? "text-danger" : "text-muted"}`} aria-live="polite">
            {preferenceStatus === "saving" ? "Saving…" : preferenceStatus === "saved" ? "Saved" : preferenceStatus === "error" ? "Save failed" : "Changes save automatically"}
          </p>
        </div>
        <Field label="Default landing page" className="mt-2">
          <Select value={landing} onChange={(e) => changeLanding(e.target.value)} options={landingOptions} disabled={preferenceStatus === "saving"} />
        </Field>
      </Card>

      <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "105ms" }}>
        <p className="kicker">Appearance</p>
        <p className="mt-1 text-[13px] text-muted">Themes change the application chrome and accent colors only. Your profile color stays personal.</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {THEMES.slice(0, 1).map(lightSwatch)}
          <ThemeSwatch {...DARK_THEME} dark selected={dark} onSelect={() => setDark(true)} />
          {THEMES.slice(1).map(lightSwatch)}
        </div>
        <div
          className={`mt-3 flex items-center justify-between rounded-card border p-3 ${!dark && theme === "custom" ? "border-navy ring-1 ring-navy" : "border-hairline"}`}
          role="button"
          tabIndex={0}
          onClick={() => { setTheme("custom"); setDark(false); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setTheme("custom"); setDark(false); } }}
        >
          <div className="cursor-pointer">
            <p className="text-[13px] font-semibold text-ink">Custom theme</p>
            <p className="text-micro text-muted">Choose the navigation and accent color.</p>
          </div>
          <label className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-input border border-hairline" style={{ backgroundColor: customThemeColor }} title="Choose custom theme color">
            <input type="color" value={customThemeColor} onChange={(event) => { setCustomThemeColor(event.target.value); setTheme("custom"); setDark(false); }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="Choose custom theme color" />
            <span className="sr-only">Choose custom theme color</span>
          </label>
        </div>
      </Card>

      {/* Phone: the button takes the full width above its explanation, because
          side by side at 402px the sentence gets two words a line. Desktop keeps
          the sentence and the button on one row. */}
      <div
        className="page-list-item-enter flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-between md:gap-4"
        style={{ animationDelay: "140ms" }}
      >
        {/* No password to change — identity is managed in Microsoft Entra ID. */}
        <p className="text-micro text-muted">
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
      className={`rounded-card border p-2.5 text-left transition hover:border-strongline ${selected ? "border-navy ring-1 ring-navy" : "border-hairline"}`}
      aria-pressed={selected}
    >
      <span className={`mb-2 flex h-7 overflow-hidden rounded-input border ${dark ? "border-white/10" : "border-black/5"}`} style={{ backgroundColor: sidebar }}>
        <span className="w-2/5" style={{ backgroundColor: color }} />
        <span className={`flex-1 ${dark ? "bg-[#0f0f0f]" : "bg-white"}`} />
      </span>
      <span className="block text-[12.5px] font-semibold text-ink">{label}</span>
    </button>
  );
}
