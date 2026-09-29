import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { ADMIN_AREA, useAuth } from "./lib/auth";
import type { PermissionKey } from "./lib/types";
import { AppShell } from "./components/shell/AppShell";
import { ConfigLayout } from "./components/shell/ConfigLayout";
import { SectionTabsLayout } from "./components/shell/SectionTabs";
import { useReviewCount } from "./components/shell/Sidebar";
import { LoadingState } from "./components/ui/misc";

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
import { AdminSites } from "./screens/admin/Sites";
import { AdminImport } from "./screens/admin/Import";
import { AdminPeople } from "./screens/admin/People";
import { AdminSettings, AdminSignInAccess } from "./screens/admin/Settings";
import { AdminApiKeys, AdminWebhooks, AdminWordPress } from "./screens/admin/Integrations";
import { AdminFormsCatalog } from "./screens/admin/FormsCatalog";
import { AdminHotFoods } from "./screens/admin/HotFoods";
import { HotFoodsRecordPage } from "./screens/hotfoods/Record";
import { HotFoodsEntriesPage } from "./screens/hotfoods/Entries";
import { HotFoodsEntryDetailPage } from "./screens/hotfoods/EntryDetail";
import { HotFoodsReportsPage } from "./screens/hotfoods/Reports";
import { AdminBuilderList } from "./screens/builder/BuilderList";
import { FormEditorPage } from "./screens/builder/Editor";
import { AdminAiBuilder } from "./screens/builder/AiBuilder";
import { FillPage } from "./screens/builtforms/FillPage";
import { BuiltFormEntriesPage } from "./screens/builtforms/Entries";
import { BuiltFormEntryPage } from "./screens/builtforms/EntryDetail";
import { BuiltFormPreviewPage } from "./screens/builtforms/PreviewPage";
import { AppHostPage } from "./apps/AppHostPage";
import { CodeFormsList } from "./apps/CodeFormsList";
import { AppEditorPage } from "./apps/AppEditor";

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

/**
 * Hot Foods: Record for anyone who can name a resident at their site; Entries
 * and Reports for roles that may read form submissions back (not Site Staff).
 */
function HotFoodsSection() {
  const { can } = useAuth();
  const tabs = [
    ...(can("roster.edit") ? [{ to: "/forms/hot-foods", label: "Record", end: true }] : []),
    ...(can("entries.view")
      ? [{ to: "/forms/hot-foods/entries", label: "Entries" }, { to: "/forms/hot-foods/reports", label: "Reports" }]
      : []),
  ];
  return <SectionTabsLayout title="Hot Foods" tabs={tabs} />;
}

/** /forms/hot-foods: the Record tab, or Entries for someone who can only read. */
function HotFoodsHome() {
  const { can } = useAuth();
  return can("roster.edit") ? <HotFoodsRecordPage /> : <Navigate to="/forms/hot-foods/entries" replace />;
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
        {/* Built forms. Each screen checks access itself (the form's own settings decide). */}
        <Route path="/f/:slug" element={<FillPage />} />
        <Route path="/f/:slug/entries" element={<BuiltFormEntriesPage />} />
        <Route path="/f/:slug/entries/:id" element={<BuiltFormEntryPage />} />
        <Route element={<RequirePermission anyOf={["forms.manage"]} />}>
          <Route path="/f/:slug/preview" element={<BuiltFormPreviewPage />} />
        </Route>
        {/* Code forms: access comes from each form's own form.json. */}
        <Route path="/apps/:slug/:page?" element={<AppHostPage />} />
        <Route element={<RequirePermission anyOf={["roster.edit", "entries.view"]} />}>
          <Route element={<HotFoodsSection />}>
            <Route path="/forms/hot-foods" element={<HotFoodsHome />} />
            <Route element={<RequirePermission anyOf={["entries.view"]} />}>
              <Route path="/forms/hot-foods/entries" element={<HotFoodsEntriesPage />} />
              <Route path="/forms/hot-foods/reports" element={<HotFoodsReportsPage />} />
            </Route>
          </Route>
          <Route element={<RequirePermission anyOf={["entries.view"]} />}>
            <Route path="/forms/hot-foods/entries/:id" element={<HotFoodsEntryDetailPage />} />
          </Route>
        </Route>
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
              <Route path="/admin/hot-foods" element={<AdminHotFoods />} />
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
          </Route>
        </Route>

        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/more" element={<MorePage />} />
      </Route>

      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}
