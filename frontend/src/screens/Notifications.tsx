import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle, Bell, CheckCheck, FileText, Megaphone, MessageSquare, MoreHorizontal, Settings2, Trash2, UserPlus, UserRound,
} from "lucide-react";
import { Page, PageHeader, DesktopBackLink } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, LoadMore, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useSearchParam } from "@/lib/useSearchParam";
import {
  useNotification, useNotificationActions, useNotificationList, useUnreadCount, type AppNotification,
} from "@/lib/notifications";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

const TYPE_ICONS: Record<string, React.ElementType> = {
  "forms.message": MessageSquare,
  "forms.entry": FileText,
  "forms.problem": AlertTriangle,
  "people.request": UserPlus,
  account: UserRound,
  announcement: Megaphone,
};

/** "Today", "Yesterday", or the day, for grouping the list. */
function dayLabel(iso: string) {
  const d = new Date(iso);
  const day = (x: Date) => x.toDateString();
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(d) === day(now)) return "Today";
  if (day(d) === day(yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/**
 * Everything the site has told this person, newest first. Opening one marks it
 * read and goes to its page; each can be marked unread again or deleted.
 * What arrives, and whether it's emailed too, is set on Profile → Notifications.
 */
export function NotificationsPage() {
  const [filterParam, setFilterParam] = useSearchParam("show");
  const filter = filterParam === "unread" ? "unread" : "all";
  const list = useNotificationList(filter);
  const unread = useUnreadCount();
  const { readAll, clearRead } = useNotificationActions();
  const toast = useToast();

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const subtitle = unread ? `${unread} unread` : "You're all caught up";

  const markAll = () =>
    readAll.mutate(undefined, { onError: (e) => toast(errorMessage(e, "Couldn't mark them read."), "error") });
  const clear = () =>
    clearRead.mutate(undefined, {
      onSuccess: (r) => toast(r.count ? `Cleared ${r.count} read notification${r.count === 1 ? "" : "s"}.` : "Nothing read to clear."),
      onError: (e) => toast(errorMessage(e, "Couldn't clear them."), "error"),
    });

  const filters = (
    <div className="flex gap-1.5">
      <Chip active={filter === "all"} onClick={() => setFilterParam(null)}>All</Chip>
      <Chip active={filter === "unread"} onClick={() => setFilterParam("unread")}>Unread{unread ? ` · ${unread}` : ""}</Chip>
    </div>
  );

  const groups: { label: string; items: AppNotification[] }[] = [];
  for (const n of items) {
    const label = dayLabel(n.createdAt);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(n);
  }

  const body = list.isLoading ? (
    <LoadingState />
  ) : list.isError ? (
    <EmptyState title="Your notifications didn't load" hint="Check your connection and try again." />
  ) : items.length === 0 ? (
    <EmptyState
      icon={<Bell className="h-8 w-8" />}
      title={filter === "unread" ? "Nothing unread" : "No notifications"}
      hint={filter === "unread" ? "You've read everything." : "When a form or an admin has something for you, it shows up here."}
    />
  ) : (
    <>
      {groups.map((g) => (
        <section key={g.label} className="mb-4 md:mb-5">
          <p className="kicker mb-1.5 px-4 md:px-0">{g.label}</p>
          <Card className="overflow-hidden rounded-none border-x-0 md:rounded-card md:border-x">
            <ul>
              {g.items.map((n) => <NotificationRow key={n.id} n={n} />)}
            </ul>
          </Card>
        </section>
      ))}
      {list.hasNextPage && <LoadMore loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} />}
    </>
  );

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader
        title="Notifications"
        subtitle={subtitle}
        back={{ to: "/forms", label: "Home" }}
        actions={
          <Button variant="ghost" size="icon" onClick={markAll} disabled={!unread || readAll.isPending} aria-label="Mark all read">
            <CheckCheck className="h-[18px] w-[18px]" />
          </Button>
        }
      >
        <div className="mt-3 flex items-center justify-between gap-2">
          {filters}
          <Link to="/profile#notifications" className="inline-flex min-h-[36px] items-center gap-1.5 text-[13px] font-semibold text-accent dark:text-white">
            <Settings2 className="h-4 w-4" /> Settings
          </Link>
        </div>
      </PhoneHeader>

      <div className="md:hidden">
        <div className="py-3">{body}</div>
      </div>

      <Page className="hidden max-w-[820px] md:block">
        <PageHeader
          title="Notifications"
          subtitle={subtitle}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={markAll} disabled={!unread || readAll.isPending}>
                <CheckCheck className="h-4 w-4" /> Mark all read
              </Button>
              <Button variant="secondary" size="sm" onClick={clear} disabled={clearRead.isPending}>
                <Trash2 className="h-4 w-4" /> Clear read
              </Button>
              <Link to="/profile#notifications" className="inline-flex h-8 items-center gap-1.5 rounded-input px-3 font-heading text-[13px] font-semibold text-accent hover:bg-subtle2 dark:text-white">
                <Settings2 className="h-4 w-4" /> Settings
              </Link>
            </>
          }
        />
        <div className="mb-4">{filters}</div>
        {body}
      </Page>
    </div>
  );
}

function NotificationRow({ n }: { n: AppNotification }) {
  const navigate = useNavigate();
  const { setRead, remove } = useNotificationActions();
  const toast = useToast();
  const Icon = TYPE_ICONS[n.type] ?? Bell;

  const open = () => {
    if (!n.read) setRead.mutate({ id: n.id, read: true });
    if (n.link) navigate(n.link);
  };

  return (
    <li className={cn("group relative flex items-start gap-3 border-b border-hairline px-4 py-3 last:border-b-0 transition-colors", n.link && "hover:bg-rowhover", !n.read && "bg-navsel/40")}>
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy"
        aria-label={`${n.read ? "" : "Unread: "}${n.title}`}
      >
        <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", n.type === "forms.problem" ? "bg-status-amberBg text-status-amberText" : "bg-subtle text-muted")}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[14px] leading-snug text-ink", n.read ? "font-semibold" : "font-bold")}>{n.title}</span>
          {n.body && <span className="mt-0.5 line-clamp-3 block whitespace-pre-line text-[13px] text-muted">{n.body}</span>}
          <span className="mt-1 block text-micro text-muted">
            {[n.sourceLabel, relativeTime(n.createdAt)].filter(Boolean).join(" · ")}
          </span>
        </span>
        {!n.read && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-navy dark:bg-white" aria-hidden />}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="-mr-2 h-8 w-8 shrink-0 text-muted" aria-label={`Actions for ${n.title}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRead.mutate({ id: n.id, read: !n.read })}>
            {n.read ? "Mark as unread" : "Mark as read"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-status-redText"
            onSelect={() => remove.mutate(n.id, { onError: (e) => toast(errorMessage(e, "Couldn't delete it."), "error") })}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * /notifications/:id — where a notification email's link lands: mark it read,
 * then go to its page (or the list, when it has none).
 */
export function NotificationOpenPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isError } = useNotification(id);
  const { setRead } = useNotificationActions();
  useEffect(() => {
    if (!data) return;
    if (!data.read) setRead.mutate({ id: data.id, read: true });
    navigate(data.link ?? "/notifications", { replace: true });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Page className="max-w-[720px]">
      <DesktopBackLink to="/notifications">Notifications</DesktopBackLink>
      {isError ? (
        <EmptyState
          icon={<Bell className="h-8 w-8" />}
          title="That notification isn't here"
          hint="It may have been cleared, or it was sent to someone else. Your other notifications are on the Notifications page."
        />
      ) : (
        <LoadingState label="Opening…" />
      )}
      {isError && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => navigate("/notifications")}>See your notifications</Button>
        </div>
      )}
    </Page>
  );
}
