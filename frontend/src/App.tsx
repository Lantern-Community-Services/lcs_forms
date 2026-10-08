import { Suspense } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { Monitor } from "lucide-react";
import { ADMIN_AREA, useAuth } from "./lib/auth";
import type { PermissionKey } from "./lib/types";
import { AppShell } from "./components/shell/AppShell";
import { SectionTabsLayout } from "./components/shell/SectionTabs";
import { useReviewCount } from "./components/shell/navData";
import { Button } from "./components/ui/button";
import { EmptyState, LoadingState } from "./components/ui/misc";
import { currentDeviceKind, useDeviceKind } from "./lib/device";
import { lazyScreen } from "./lib/lazyScreen";

import { SignInPage } from "./screens/SignIn";
import { FormsPage } from "./screens/Forms";
import { DashboardPage } from "./screens/Dashboard";
import { RosterPage } from "./screens/Roster";
import { ReviewPage } from "./screens/Review";
import { TenantDetailPage } from "./screens/TenantDetail";
import { ActivityPage } from "./screens/Activity";
import { AttendancePage } from "./screens/Attendance";
import { AttendanceDetailPage } from "./screens/AttendanceDetail";
import { ProfilePage } from "./screens/Profile";
import { MorePage } from "./screens/More";
import { FillPage } from "./screens/builtforms/FillPage";
import { BuiltFormEntriesPage } from "./screens/builtforms/Entries";
import { BuiltFormEntryPage } from "./screens/builtforms/EntryDetail";
import { BuiltFormPreviewPage } from "./screens/builtforms/PreviewPage";
import { AppHostPage } from "./apps/AppHostPage";
import { CalendarPage } from "./screens/calendar/CalendarPage";

/*
 * Admin's screens are their own downloads, fetched the first time an Admin
 * opens one on a computer. A phone, an iPad, or anyone without an admin
 * permission never downloads them (the form builder and code editor are most
 * of the app's weight): DesktopOnly and RequirePermission decide before any
 * of these is rendered, and nothing outside admin imports them.
 */
const ConfigLayout = lazyScreen(() => import("./components/shell/ConfigLayout"), "ConfigLayout");
const AdminSites = lazyScreen(() => import("./screens/admin/Sites"), "AdminSites");
const AdminImport = lazyScreen(() => import("./screens/admin/Import"), "AdminImport");
const AdminPeople = lazyScreen(() => import("./screens/admin/People"), "AdminPeople");
const AdminSettings = lazyScreen(() => import("./screens/admin/Settings"), "AdminSettings");
const AdminSignInAccess = lazyScreen(() => import("./screens/admin/Settings"), "AdminSignInAccess");
const AdminApiKeys = lazyScreen(() => import("./screens/admin/Integrations"), "AdminApiKeys");
const AdminWebhooks = lazyScreen(() => import("./screens/admin/Integrations"), "AdminWebhooks");
const AdminWordPress = lazyScreen(() => import("./screens/admin/Integrations"), "AdminWordPress");
const AdminFormsCatalog = lazyScreen(() => import("./screens/admin/FormsCatalog"), "AdminFormsCatalog");
const AdminDevLog = lazyScreen(() => import("./screens/admin/DevLog"), "AdminDevLog");
const AdminBuilderList = lazyScreen(() => import("./screens/builder/BuilderList"), "AdminBuilderList");
const FormEditorPage = lazyScreen(() => import("./screens/builder/Editor"), "FormEditorPage");
const AdminAiBuilder = lazyScreen(() => import("./screens/builder/AiBuilder"), "AdminAiBuilder");
const CodeFormsList = lazyScreen(() => import("./apps/CodeFormsList"), "CodeFormsList");
const AppEditorPage = lazyScreen(() => import("./apps/AppEditor"), "AppEditorPage");

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="app-height grid place-items-center bg-appbg"><LoadingState /></div>;
  // Carry the requested path through sign-in so a shared link lands where it pointed.
  if (!user) {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/signin?returnTo=${returnTo}`} replace />;
  }
  return <>{children}</>;
}

/**
 * Route-level permission gate. Hiding a nav item isn't access control; the API
 * enforces the same permissions — this only avoids rendering a screen of 403s.
 */
function RequirePermission({ anyOf }: { anyOf: PermissionKey[] }) {
  const { can, loading } = useAuth();
  if (loading) return <div className="grid h-full place-items-center"><LoadingState /></div>;
  if (!anyOf.some((p) => can(p))) return <Navigate to="/" replace />;
  return <Outlet />;
}

/**
 * Admin is a desktop feature: the builder, the catalog, people and sites need a
 * keyboard, a pointer and room. On a phone or an iPad the screens are not
 * offered, and a typed or bookmarked address lands here instead of on them.
 */
function DesktopOnly() {
  // The hook re-renders on a resize or rotation; its first answer is always
  // "desktop", so the browser is asked directly as well (lib/device.ts).
  const device = useDeviceKind();
  if (device === "desktop" && currentDeviceKind() === "desktop") {
    return (
      <Suspense fallback={<div className="grid h-full place-items-center"><LoadingState /></div>}>
        <Outlet />
      </Suspense>
    );
  }
  return (
    <div className="flex flex-col items-center px-6 py-10">
      <EmptyState
        icon={<Monitor className="h-8 w-8" />}
        title="Admin is desktop only"
        hint="Open the app on a computer to change settings, forms, people or sites."
      />
      <Link to="/forms"><Button>Back to forms</Button></Link>
    </div>
  );
}

/**
 * Where "/" goes: the person's chosen landing page, or Forms. A roster page is
 * only honoured while they can still see the roster, otherwise a demoted
 * person would bounce between "/" and a screen that sends them back to "/".
 */
function HomeRedirect() {
  const { user, can } = useAuth();
  const chosen = user?.defaultLandingPage ?? "/forms";
  return <Navigate to={chosen === "/forms" || can("roster.view") ? chosen : "/forms"} replace />;
}

/** The Roster: one sidebar entry, its screens as tabs. */
function RosterSection() {
  const reviewCount = useReviewCount();
  return (
    <SectionTabsLayout
      title="Roster"
      tabs={[
        { to: "/roster", label: "Residents", end: true },
        { to: "/roster/review", label: "Review", count: reviewCount },
        { to: "/roster/attendance", label: "Attendance" },
        { to: "/roster/activity", label: "Activity" },
        { to: "/roster/overview", label: "Overview" },
      ]}
    />
  );
}

/** A retired path: same query string (the site selection), new home. */
function Moved({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

function MovedAttendanceEntry() {
  const { id } = useParams();
  return <Navigate to={`/roster/attendance/${id}`} replace />;
}

/** First admin screen this person can actually open. */
function AdminHome() {
  const { can } = useAuth();
  if (can("forms.manage")) return <Navigate to="/admin/forms" replace />;
  if (can("apps.develop")) return <Navigate to="/admin/apps" replace />;
  if (can("sites.manage")) return <Navigate to="/admin/sites" replace />;
  if (can("users.manage") || can("users.manageSite")) return <Navigate to="/admin/people" replace />;
  if (can("integrations.manage")) return <Navigate to="/admin/api-keys" replace />;
  if (can("devlog.view")) return <Navigate to="/admin/devlog" replace />;
  return <Navigate to="/admin/settings" replace />;
}

export function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route path="/signin" element={user && !loading ? <HomeRedirect /> : <SignInPage />} />
      {/* Public built forms: no sign-in, no app chrome. */}
      <Route path="/p/:slug" element={<FillPage publicView />} />

      <Route element={<Protected><AppShell /></Protected>}>
        <Route index element={<HomeRedirect />} />
        <Route path="/forms" element={<FormsPage />} />
        {/* Everyone reads the calendar; the screen offers changes to calendar.manage only. */}
        <Route path="/calendar" element={<CalendarPage />} />
        {/* Built forms. Each screen checks access itself (the form's own settings decide). */}
        <Route path="/f/:slug" element={<FillPage />} />
        <Route path="/f/:slug/entries" element={<BuiltFormEntriesPage />} />
        <Route path="/f/:slug/entries/:id" element={<BuiltFormEntryPage />} />
        <Route element={<RequirePermission anyOf={["forms.manage"]} />}>
          <Route path="/f/:slug/preview" element={<BuiltFormPreviewPage />} />
        </Route>
        {/* Code forms: access comes from each form's own form.json. */}
        <Route path="/apps/:slug/:page?" element={<AppHostPage />} />
        <Route element={<RequirePermission anyOf={["roster.view"]} />}>
          <Route element={<RosterSection />}>
            <Route path="/roster" element={<RosterPage />} />
            <Route path="/roster/review" element={<ReviewPage />} />
            <Route path="/roster/attendance" element={<AttendancePage />} />
            <Route path="/roster/activity" element={<ActivityPage />} />
            <Route path="/roster/overview" element={<DashboardPage />} />
          </Route>
          {/* Detail screens sit outside the tabs: they carry their own way back. */}
          <Route path="/roster/attendance/:id" element={<AttendanceDetailPage />} />
          <Route path="/tenants/:id" element={<TenantDetailPage />} />

          {/* Where these screens lived before they became Roster tabs — kept so
              bookmarks and saved landing pages still land somewhere. */}
          <Route path="/review" element={<Moved to="/roster/review" />} />
          <Route path="/dashboard" element={<Moved to="/roster/overview" />} />
          <Route path="/activity" element={<Moved to="/roster/activity" />} />
          <Route path="/attendance" element={<Moved to="/roster/attendance" />} />
          <Route path="/attendance/:id" element={<MovedAttendanceEntry />} />
        </Route>

        <Route element={<DesktopOnly />}>
        <Route element={<RequirePermission anyOf={ADMIN_AREA} />}>
          <Route path="/admin" element={<AdminHome />} />
          {/* The editor takes the whole screen, outside the admin rail. */}
          <Route element={<RequirePermission anyOf={["forms.manage"]} />}>
            <Route path="/admin/builder/:id" element={<FormEditorPage />} />
          </Route>
          <Route element={<RequirePermission anyOf={["apps.develop", "forms.manage"]} />}>
            <Route path="/admin/apps/:id" element={<AppEditorPage />} />
          </Route>
          <Route element={<ConfigLayout />}>
            <Route element={<RequirePermission anyOf={["forms.manage"]} />}>
              <Route path="/admin/forms" element={<AdminFormsCatalog />} />
              <Route path="/admin/builder" element={<AdminBuilderList />} />
              <Route path="/admin/ai" element={<AdminAiBuilder />} />
            </Route>
            <Route element={<RequirePermission anyOf={["apps.develop", "forms.manage"]} />}>
              <Route path="/admin/apps" element={<CodeFormsList />} />
            </Route>
            <Route element={<RequirePermission anyOf={["sites.manage"]} />}>
              <Route path="/admin/sites" element={<AdminSites />} />
              <Route path="/admin/import" element={<AdminImport />} />
            </Route>
            <Route element={<RequirePermission anyOf={["users.manage", "users.manageSite"]} />}>
              <Route path="/admin/people" element={<AdminPeople />} />
            </Route>
            <Route element={<RequirePermission anyOf={["settings.manage"]} />}>
              <Route path="/admin/sign-in" element={<AdminSignInAccess />} />
            </Route>
            <Route element={<RequirePermission anyOf={["settings.manage", "sites.manageRules"]} />}>
              <Route path="/admin/settings" element={<AdminSettings />} />
            </Route>
            <Route element={<RequirePermission anyOf={["integrations.manage"]} />}>
              <Route path="/admin/api-keys" element={<AdminApiKeys />} />
              <Route path="/admin/webhooks" element={<AdminWebhooks />} />
              <Route path="/admin/wordpress" element={<AdminWordPress />} />
            </Route>
            <Route element={<RequirePermission anyOf={["devlog.view"]} />}>
              <Route path="/admin/devlog" element={<AdminDevLog />} />
            </Route>
          </Route>
        </Route>
        </Route>

        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/more" element={<MorePage />} />
      </Route>

      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}
