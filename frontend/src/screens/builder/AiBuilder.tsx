import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Copy, KeyRound, Palette, Terminal } from "lucide-react";
import { designBrief, designKitHtml, download } from "@/apps/design";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApiKeys } from "@/lib/queries";
import { errorMessage } from "@/lib/utils";

const TOOLS: [string, string][] = [
  ["get_code_reference", "Code forms: layout, SDK types, patterns"],
  ["create_code_form / list_files / read_files", "Start or explore a code form project"],
  ["write_files / edit_file", "Change code; the build result comes back each time"],
  ["run_action / test_entry", "Try server code and rules against the draft"],
  ["publish_code_form", "Make a code form's draft live"],
  ["get_reference", "The full format guide — read first"],
  ["list_forms / get_form", "What exists, and any form as JSON"],
  ["create_form", "A new form from a full document"],
  ["patch_form", "Add, change, move or remove fields and settings"],
  ["update_form", "Replace a draft wholesale"],
  ["validate_form", "Check a document without saving"],
  ["publish_form / set_form_status", "Go live, close, archive"],
  ["list_versions / restore_version", "Version history"],
  ["import_forms / export_forms", "Bundles and Gravity Forms exports"],
  ["add_to_catalog", "Put it on the Forms screen"],
  ["list_entries / get_entry", "Read answers (entries:read)"],
  ["submit_entry", "Submit test entries (entries:write)"],
];

const PROMPTS = [
  "Build a Resident Intake form: site and resident pickers, move-in date, emergency contact (name, phone, relationship), benefits checkboxes, and a signature. Publish it and put it under Resident Services.",
  "Import this Gravity Forms export and tell me what didn't convert cleanly.",
  "In the incident report, add a 'Police report number' text field that only shows when 'Police called' is ticked.",
  "Add an email notification to facilities@lanterncommunity.org whenever priority is Urgent.",
  "Look at last month's entries for the supply request form and summarize what sites ask for most.",
  "Build a Pantry code form like Hot Foods: pick the site, pick the resident, choose items from a list admins manage, limit one visit a week unless a manager overrides, and a Reports tab.",
  "In the hot-foods form, add a 'Dietary note' shown on the sign step when the resident has one saved in a collection.",
];

/** Admin → AI form builder: connect Claude (or any MCP client) to build forms. */
export function AdminAiBuilder() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { data: keys } = useApiKeys(can("integrations.manage"));
  const [name, setName] = useState("Claude — form builder");
  const [entries, setEntries] = useState(true);
  const [code, setCode] = useState(true);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: guide } = useQuery({ queryKey: ["builder", "guide"], queryFn: () => api.get<string>("/builder/guide") });

  const url = `${typeof window !== "undefined" ? window.location.origin : ""}/api/mcp`;
  const shown = key ?? "lrk_YOUR_KEY";
  const buildKeys = (keys ?? []).filter((k) => !k.revokedAt && k.scopes.includes("forms:build"));
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied."), () => toast("Copy failed.", "error"));

  async function createKey() {
    setBusy(true);
    try {
      const res = await api.post<{ key: string }>("/admin/api-keys", { name, scopes: ["forms:build", ...(code ? ["apps:build"] : []), ...(entries ? ["entries:read", "entries:write"] : [])] });
      setKey(res.key);
      await qc.invalidateQueries({ queryKey: ["admin", "api-keys"] });
    } catch (e) {
      toast(errorMessage(e, "Couldn't create the key."), "error");
    } finally {
      setBusy(false);
    }
  }

  const claudeCode = `claude mcp add --transport http lantern-forms ${url} --header "Authorization: Bearer ${shown}"`;
  const desktop = JSON.stringify({ mcpServers: { "lantern-forms": { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${shown}`] } } }, null, 2);
  const vscode = JSON.stringify({ servers: { "lantern-forms": { type: "http", url, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2);

  return (
    <Page className="max-w-[900px]">
      <PageHeader title="AI form builder" subtitle="Let Claude — or any assistant that speaks MCP — build and edit forms here. Everything it makes lands as a draft for you to check before publishing." />

      <Card className="mb-4 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel bg-navsel text-accent"><KeyRound className="h-[18px] w-[18px]" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-[15px] font-extrabold text-ink">1. Make a key</p>
            <p className="mt-0.5 text-[13px] text-muted">The assistant signs in with an API key that has the <code>forms:build</code> scope. It acts as that key — the audit log names it — never as you.</p>
            {key ? (
              <div className="mt-3 rounded-input border border-status-greenDot/50 bg-status-greenBg p-3">
                <p className="text-[12.5px] font-semibold text-status-greenText">Copy it now — it won't be shown again. The commands below already include it.</p>
                <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-[12.5px] text-ink">{key}</code><Button size="sm" variant="secondary" onClick={() => copy(key)}><Copy className="h-3.5 w-3.5" /></Button></div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="min-w-[220px] flex-1 text-micro font-semibold text-muted">Key name<Input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5" /></label>
                <label className="flex items-center gap-2 pb-2 text-[13px] text-ink"><input type="checkbox" checked={code} onChange={(e) => setCode(e.target.checked)} /> Can build code forms</label>
                <label className="flex items-center gap-2 pb-2 text-[13px] text-ink"><input type="checkbox" checked={entries} onChange={(e) => setEntries(e.target.checked)} /> Can also read and submit entries</label>
                <Button onClick={createKey} disabled={busy || !name.trim()}>Create key</Button>
              </div>
            )}
            {buildKeys.length > 0 && !key && <p className="mt-2 text-micro text-muted">Existing form-builder keys: {buildKeys.map((k) => `${k.name} (${k.prefix}…)`).join(", ")}. Manage them in <Link to="/admin/api-keys" className="font-semibold text-accent">API keys</Link>.</p>}
          </div>
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel bg-navsel text-accent"><Terminal className="h-[18px] w-[18px]" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-[15px] font-extrabold text-ink">2. Connect your assistant</p>
            <p className="mt-0.5 text-[13px] text-muted">MCP server: <code className="text-ink">{url}</code> (Streamable HTTP).</p>
            <Snippet title="Claude Code" text={claudeCode} onCopy={copy} />
            <Snippet title="Claude Desktop — claude_desktop_config.json" text={desktop} onCopy={copy} />
            <Snippet title="VS Code / Cursor — .vscode/mcp.json" text={vscode} onCopy={copy} />
          </div>
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel bg-navsel text-accent"><Bot className="h-[18px] w-[18px]" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-[15px] font-extrabold text-ink">3. Ask for a form</p>
            <ul className="mt-2 space-y-1.5">
              {PROMPTS.map((p) => (
                <li key={p} className="flex items-start gap-2 rounded-input bg-subtle px-3 py-2 text-[13px] text-ink">
                  <span className="flex-1">“{p}”</span>
                  <button onClick={() => copy(p)} className="text-muted hover:text-ink" aria-label="Copy prompt"><Copy className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[12px] font-semibold text-muted">Tools it gets</p>
            <div className="mt-1 grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-2">
              {TOOLS.map(([t, d]) => <p key={t}><code className="text-ink">{t}</code> <span className="text-muted">— {d}</span></p>)}
            </div>
          </div>
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel bg-navsel text-accent"><Palette className="h-[18px] w-[18px]" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-[15px] font-extrabold text-ink">Claude Design</p>
            <p className="mt-0.5 text-[13px] text-muted">Design screens in Claude Design with Lantern's own components, then have them built as code forms.</p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] text-ink">
              <li><strong>Give it the design system.</strong> Download the design kit — the app's real components and tokens in light and dark, with the rules — and add it to Claude Design as your design system (or as a reference file on a project).
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={async () => { try { download("lantern-design-kit.html", await designKitHtml()); } catch (e) { toast(errorMessage(e, "Couldn't build it."), "error"); } }}>Download design kit</Button>
                  <Button size="sm" variant="secondary" onClick={async () => download("lantern-design-brief.md", await designBrief(), "text/markdown")}>Download the brief (.md)</Button>
                </div>
              </li>
              <li><strong>Redesign a form.</strong> In a code form's editor, <em>Export for Claude Design</em> gives one HTML file with every page on phone, iPad and desktop (clickable, sample data only — never real residents), the brief and the source. Upload it to Claude Design and ask for the redesign.</li>
              <li><strong>Bring it back.</strong> Use Claude Design's hand-off to Claude Code. With this MCP server connected (key with <code>apps:build</code>), Claude Code reads the brief (<code>get_design_kit</code>) and writes the design into the form's pages as a draft for you to preview and publish.</li>
            </ol>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <p className="font-heading text-[15px] font-extrabold text-ink">The form format</p>
        <p className="mt-0.5 text-[13px] text-muted">What the assistant reads from <code>get_reference</code> — also the reference for writing forms in code (builder → Code tab, or <code>npm run forms -- push</code>).</p>
        <pre className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-input bg-subtle p-3 font-mono text-[11.5px] leading-relaxed text-ink">{guide ?? "Loading…"}</pre>
      </Card>
    </Page>
  );
}

function Snippet({ title, text, onCopy }: { title: string; text: string; onCopy: (t: string) => void }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-muted">{title}</span>
        <button onClick={() => onCopy(text)} className="inline-flex items-center gap-1 text-micro font-semibold text-accent"><Copy className="h-3 w-3" /> Copy</button>
      </div>
      <pre className="overflow-x-auto rounded-input bg-[#1f2430] p-3 font-mono text-[11.5px] text-[#e6e6e6]">{text}</pre>
    </div>
  );
}
