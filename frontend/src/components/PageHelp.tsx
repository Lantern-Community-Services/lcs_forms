import { useNavigate } from "react-router-dom";
import { BookOpen, CircleHelp, Compass } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { articleById } from "@/lib/help/content";

/**
 * The "?" beside a page's title: a line on what the page is for, then "Learn
 * more" (its help article, lib/help/content.ts) and "Show me around" (the
 * welcome tour). A menu rather than a tooltip, so it opens with a tap or the
 * keyboard and its links can be followed.
 */
export function PageHelp({ article, children }: { article: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  const a = articleById(article);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Help: ${a?.title ?? "about this page"}`}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-rowhover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy"
        >
          <CircleHelp className="h-[18px] w-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[300px] max-w-[calc(100vw-2rem)]">
        <div className="px-3 py-2 text-[13px] leading-snug text-ink">{children}</div>
        <DropdownMenuSeparator />
        {a && (
          <DropdownMenuItem onSelect={() => navigate(`/help/${a.id}`)}>
            <BookOpen className="h-4 w-4" /> Learn more: {a.title}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => navigate("/home?tour=site")}>
          <Compass className="h-4 w-4" /> Show me around
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/help")}>
          <CircleHelp className="h-4 w-4" /> All help
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
