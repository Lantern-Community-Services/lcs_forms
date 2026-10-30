import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, BookOpen, Compass, Search } from "lucide-react";
import { DesktopBackLink, Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { AREAS, ARTICLES, ROLE_GUIDES, allowed, articleById, guideFor, type HelpArticle, type HelpLinkTo, type RoleGuide } from "@/lib/help/content";
import { cn } from "@/lib/utils";

/**
 * Help (/help): your role's guide first (what you can do and where to start),
 * then an article for each feature you can use, and search. Articles open at
 * /help/<id>, role guides at /help/role/<key>. The words are in
 * lib/help/content.ts, written with the features.
 */

function useHelp() {
  const { user, can } = useAuth();
  const mine = ARTICLES.filter((a) => allowed(a.needs, can));
  return { user, can, mine, guide: guideFor(user) };
}

/** "Show me": the welcome tour, from Home (lib/tour/SiteTourStarter.tsx). */
function ShowMe({ className }: { className?: string }) {
  const navigate = useNavigate();
  return (
    <Button variant="secondary" className={className} onClick={() => navigate("/home?tour=site")}>
      <Compass className="h-4 w-4" /> Show me around
    </Button>
  );
}

function GoButtons({ links }: { links: HelpLinkTo[] }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const shown = links.filter((l) => allowed(l.needs, can));
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map((l) => (
        <Button key={l.to} variant="secondary" size="sm" onClick={() => navigate(l.to)}>
          {l.label} <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      ))}
    </div>
  );
}

function ArticleRow({ a }: { a: HelpArticle }) {
  return (
    <li>
      <Link to={`/help/${a.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-rowhover md:px-5">
        <BookOpen className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-ink">{a.title}</span>
          <span className="block text-[12.5px] text-muted">{a.summary}</span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </Link>
    </li>
  );
}

const matchesAll = (text: string, words: string[]) => words.every((w) => text.includes(w));

export function HelpPage() {
  const { mine, guide } = useHelp();
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = useMemo(
    () => (words.length ? mine.filter((a) => matchesAll(`${a.title} ${a.summary} ${a.words ?? ""} ${a.sections.map((s) => `${s.heading} ${s.points.join(" ")}`).join(" ")}`.toLowerCase(), words)) : []),
    [mine, q] // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <Page className="max-w-[880px]">
      <PageHeader title="Help" subtitle="What you can do in Lantern Forms, and where to go to do it." />
      <div className="relative mb-5">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the help, e.g. “share link” or “follow-up”" aria-label="Search the help" className="pl-9" />
      </div>

      {words.length ? (
        <Card className="p-0">
          {hits.length ? <ul className="divide-y divide-hairline">{hits.map((a) => <ArticleRow key={a.id} a={a} />)}</ul> : <EmptyState title="Nothing matches" hint="Try fewer or other words." />}
        </Card>
      ) : (
        <div className="space-y-6">
          <GuideCard guide={guide} mine={mine} />
          {AREAS.map((area) => {
            const list = mine.filter((a) => a.area === area.id);
            if (!list.length) return null;
            return (
              <section key={area.id} aria-labelledby={`help-${area.id}`}>
                <h2 id={`help-${area.id}`} className="mb-2 px-1 font-heading text-[15px] font-extrabold text-ink">{area.title}</h2>
                <Card className="p-0"><ul className="divide-y divide-hairline">{list.map((a) => <ArticleRow key={a.id} a={a} />)}</ul></Card>
              </section>
            );
          })}
          <OtherRoles current={guide.key} />
        </div>
      )}
    </Page>
  );
}

function GuideCard({ guide, mine, yours = true }: { guide: RoleGuide; mine: HelpArticle[]; yours?: boolean }) {
  const read = guide.read.map(articleById).filter((a): a is HelpArticle => Boolean(a && mine.includes(a)));
  return (
    <Card className="space-y-4 p-5">
      <div>
        <p className="kicker">Guide</p>
        <h2 className="mt-1 font-heading text-[19px] font-extrabold text-ink">{yours ? "Your role: " : ""}{guide.name}</h2>
        <p className="mt-1 text-[13.5px] text-muted">{guide.intro}</p>
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-semibold text-ink">You can</p>
        <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-ink">{guide.can.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-semibold text-ink">Start here</p>
        <div className="flex flex-wrap gap-2">
          <GoButtons links={guide.startHere} />
          <ShowMe className="h-9" />
        </div>
      </div>
      {read.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink">Read first</p>
          <ol className="list-decimal space-y-1 pl-5 text-[13.5px]">
            {read.map((a) => <li key={a.id}><Link to={`/help/${a.id}`} className="font-semibold text-accent dark:text-white">{a.title}</Link> <span className="text-muted">{a.summary}</span></li>)}
          </ol>
        </div>
      )}
    </Card>
  );
}

function OtherRoles({ current }: { current: string }) {
  return (
    <section aria-labelledby="help-roles">
      <h2 id="help-roles" className="mb-2 px-1 font-heading text-[15px] font-extrabold text-ink">What each role can do</h2>
      <Card className="p-0">
        <ul className="divide-y divide-hairline">
          {ROLE_GUIDES.map((g) => (
            <li key={g.key}>
              <Link to={`/help/role/${g.key}`} className="flex items-center gap-3 px-4 py-3 hover:bg-rowhover md:px-5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-ink">{g.name}{g.key === current ? " (you)" : ""}</span>
                  <span className="block text-[12.5px] text-muted">{g.intro}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** /help/role/<key>: one role's guide. */
export function HelpRolePage() {
  const { key = "" } = useParams();
  const { mine, guide: yours } = useHelp();
  const guide = ROLE_GUIDES.find((g) => g.key === key);
  if (!guide) return <Page><DesktopBackLink to="/help">Help</DesktopBackLink><Card><EmptyState title="There's no guide for that role." /></Card></Page>;
  return (
    <Page className="max-w-[880px]">
      <DesktopBackLink to="/help">Help</DesktopBackLink>
      <PageHeader title={guide.name} subtitle={guide.key === yours.key ? "Your role." : "What this role can do. Ask an Admin if you need it."} />
      <GuideCard guide={guide} mine={mine} yours={guide.key === yours.key} />
    </Page>
  );
}

/** /help/<id>: one article. */
export function HelpArticlePage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const a = articleById(id);
  if (!a) return <Page><DesktopBackLink to="/help">Help</DesktopBackLink><Card><EmptyState title="There's no help page there." hint="It may have moved: search the help." /></Card></Page>;
  const ok = allowed(a.needs, can);
  const related = ARTICLES.filter((x) => x.area === a.area && x.id !== a.id && allowed(x.needs, can));
  return (
    <Page className="max-w-[760px]">
      <DesktopBackLink to="/help">Help</DesktopBackLink>
      <PageHeader title={a.title} subtitle={a.summary} />
      {!ok && (
        <Card className="mb-4 border-status-amberText/40 p-4 text-[13px] text-muted">
          This is for people who can use this part of the site, which your role can't. Ask an Admin if you need it.
        </Card>
      )}
      {ok && (a.where.length > 0 || a.showMe) && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-semibold text-muted">Go there:</span>
          <GoButtons links={a.where} />
          {a.showMe && <ShowMe className="h-8" />}
        </div>
      )}
      <article className="space-y-5">
        {a.sections.map((s) => (
          <Card key={s.heading} className="p-5">
            <h2 className="font-heading text-[16px] font-extrabold text-ink">{s.heading}</h2>
            <ul className={cn("mt-2 space-y-1.5 text-[14px] leading-relaxed text-ink", s.points.length > 1 && "list-disc pl-5")}>
              {s.points.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </Card>
        ))}
      </article>
      {related.length > 0 && (
        <section className="mt-8" aria-labelledby="help-related">
          <h2 id="help-related" className="mb-2 px-1 font-heading text-[15px] font-extrabold text-ink">Also about {AREAS.find((x) => x.id === a.area)?.title.toLowerCase()}</h2>
          <Card className="p-0"><ul className="divide-y divide-hairline">{related.map((x) => <ArticleRow key={x.id} a={x} />)}</ul></Card>
        </section>
      )}
    </Page>
  );
}
