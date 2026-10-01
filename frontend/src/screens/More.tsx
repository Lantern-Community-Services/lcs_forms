import { NavLink } from "react-router-dom";
import { ChevronRight, FileText, KeyRound, Layers, LogIn, Plug, Settings2, Upload, UserRound, Users, UtensilsCrossed, Webhook } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/badge";
import { ADMIN_AREA, useAuth } from "@/lib/auth";
import { useDeviceKind } from "@/lib/device";
import { useSites, useUsers } from "@/lib/queries";

/**
 * The phone's last tab: Admin and Profile, which the bottom bar has no room
 * for. A directory of routes that already exist, never a second navigation
 * system. (The roster's screens are tabs inside Roster, not rows here.)
 */
export function MorePage() {
  const { user, can, logout } = useAuth();
  // Admin is desktop only; this page is reached from touch screens, so it rarely shows.
  const isAdmin = ADMIN_AREA.some(can) && useDeviceKind() === "desktop";

  return (
    <div className="pb-4">
      <NavLink to="/profile" className="flex items-center gap-3 border-b border-hairline bg-sidebar px-4 pb-3 pt-safe-top">
        <Avatar name={user?.name ?? "?"} color={user?.avatarColor} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-bold text-ink">{user?.name}</span>
          <span className="block truncate text-meta text-muted">{user?.role?.name}</span>
        </span>
        <ChevronRight className="h-[17px] w-[17px] shrink-0 text-muted" />
      </NavLink>

      {isAdmin && <AdminSection />}
      <Section title="You">
        <Row to="/profile" icon={UserRound} label="Profile & settings" />
        <button onClick={() => void logout()} className="flex min-h-[50px] w-full items-center gap-3 border-b border-hairline px-4 text-left active:bg-rowhover">
          <LogIn className="h-[18px] w-[18px] shrink-0 rotate-180 text-muted" />
          <span className="flex-1 text-[14px] font-semibold text-status-redText">Sign out</span>
        </button>
      </Section>
    </div>
  );
}

function AdminSection() {
  const { can } = useAuth();
  const { data: sites } = useSites(false, can("sites.manage"));
  const people = can("users.manage") || can("users.manageSite");
  const { data: users } = useUsers(people);
  const waiting = (users ?? []).filter((u) => u.status === "requested").length;
  return (
    <Section title="Admin">
      {can("forms.manage") && <Row to="/admin/forms" icon={FileText} label="Forms catalog" />}
      {can("forms.manage") && <Row to="/admin/hot-foods" icon={UtensilsCrossed} label="Hot Foods" />}
      {can("sites.manage") && <Row to="/admin/sites" icon={Layers} label="Sites" meta={sites?.length} />}
      {can("sites.manage") && <Row to="/admin/import" icon={Upload} label="Import tenant list" />}
      {people && (
        <Row to="/admin/people" icon={Users} label="People & roles" badge={waiting ? `${waiting} waiting` : undefined} />
      )}
      {can("settings.manage") && <Row to="/admin/sign-in" icon={KeyRound} label="Sign-in access" />}
      {can("integrations.manage") && <Row to="/admin/api-keys" icon={Plug} label="API keys" />}
      {can("integrations.manage") && <Row to="/admin/webhooks" icon={Webhook} label="Webhooks" />}
      {(can("settings.manage") || can("sites.manageRules")) && <Row to="/admin/settings" icon={Settings2} label="Roster rules" />}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <p className="kicker px-4 pb-1.5 pt-3.5">{title}</p>
      <div className="border-t border-hairline">{children}</div>
    </>
  );
}

function Row({ to, icon: Icon, label, meta, badge }: { to: string; icon: typeof Users; label: string; meta?: number; badge?: string }) {
  return (
    <NavLink to={to} className="flex min-h-[50px] items-center gap-3 border-b border-hairline px-4 active:bg-rowhover">
      <Icon className="h-[18px] w-[18px] shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{label}</span>
      {meta !== undefined && <span className="shrink-0 text-[12px] tabular text-muted">{meta}</span>}
      {badge && <Tag className="shrink-0">{badge}</Tag>}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
    </NavLink>
  );
}
