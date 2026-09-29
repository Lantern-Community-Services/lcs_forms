import { api } from "@/lib/api";
import type { AppRuntime } from "./api";

/**
 * Design work with Claude Design (or any designer), in two exports:
 *
 *   Design kit      one HTML file: the app's real components and tokens, rendered
 *                   live in light and dark, plus the design brief. Upload it to
 *                   Claude Design as the design system to design with.
 *   Design handoff  one HTML file per code form: every page, clickable, on phone /
 *                   iPad portrait / iPad landscape / desktop, running the form's real
 *                   code against SAMPLE data (design/fixtures.json, or made-up
 *                   defaults — never real residents), with the brief and the source.
 *
 * Both are self-contained (no network), so they can be shared as files.
 */

interface Assets {
  js: string;
  css: string;
}

async function assets(): Promise<Assets> {
  const [js, css] = await Promise.all([fetch("/app-runtime/runtime.js").then((r) => r.text()), fetch("/app-runtime/runtime.css").then((r) => r.text())]);
  return { js, css };
}

const noClose = (s: string, tag: "script" | "style") => s.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&display=swap">`;

export function download(filename: string, html: string, mime = "text/html") {
  const url = URL.createObjectURL(new Blob([html], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const designBrief = () => api.get<string>("/apps/design-brief");

// ───────────────────────── Design kit ─────────────────────────

/** The gallery, as plain JS against the runtime's modules (h = React.createElement). */
const KIT_SCRIPT = String.raw`
(function () {
  var M = window.LCS.modules, React = M.react, h = React.createElement, ui = M["@lcs/ui"], ch = M["@lcs/charts"], I = M["lucide-react"];
  var useState = React.useState;
  document.documentElement.setAttribute("data-bp", "sm md lg xl");
  document.documentElement.setAttribute("data-device", "desktop");
  document.documentElement.setAttribute("data-orientation", "landscape");

  function Card(props) {
    return h("section", { className: "mb-6 rounded-card border border-hairline bg-surface p-5", id: props.id },
      h("div", { className: "mb-4" },
        h("p", { className: "text-micro font-bold uppercase tracking-[0.04em] text-muted" }, props.group),
        h("h2", { className: "font-heading text-[19px] font-extrabold text-ink" }, props.title),
        props.note ? h("p", { className: "mt-0.5 text-[13px] text-muted" }, props.note) : null),
      props.children);
  }
  function Swatch(p) {
    return h("div", { className: "w-[132px]" },
      h("div", { className: "h-12 rounded-input border border-hairline", style: { background: "rgb(var(" + p.v + "))" } }),
      h("p", { className: "mt-1 text-[12px] font-semibold text-ink" }, p.name),
      h("p", { className: "font-mono text-[10.5px] text-muted" }, p.cls));
  }
  var surfaces = [["App background", "--c-appbg", "bg-appbg"], ["Surface", "--c-surface", "bg-surface"], ["Side panel", "--c-sidebar", "bg-sidebar"], ["Subtle", "--c-subtle", "bg-subtle"], ["Subtle 2", "--c-subtle2", "bg-subtle2"], ["Selected", "--c-navsel", "bg-navsel"], ["Hairline", "--c-hairline", "border-hairline"], ["Strong line", "--c-strongline", "border-strongline"], ["Ink", "--c-ink", "text-ink"], ["Muted", "--c-muted", "text-muted"], ["Accent", "--c-accent", "text-accent"], ["Brand", "--c-brand", "bg-navy"]];
  var tones = ["amber", "blue", "green", "red", "violet"];

  function DateDemo() {
    var r = useState(ui.presetRange("30d"));
    return h(ui.DateRangeBar, { from: r[0].from, to: r[0].to, onChange: r[1] });
  }
  function SigDemo() {
    return h("div", { className: "relative h-40 max-w-[520px]" }, h(ui.SignaturePad, { className: "absolute inset-0 h-full w-full" }));
  }
  function ToggleDemo() {
    var a = useState(true), b = useState(false), c = useState(true);
    return h("div", { className: "flex flex-wrap items-center gap-5" },
      h("label", { className: "flex items-center gap-2 text-[14px] text-ink" }, h(ui.Checkbox, { checked: a[0], onCheckedChange: a[1] }), "Checkbox"),
      h("label", { className: "flex items-center gap-2 text-[14px] text-ink" }, h(ui.Switch, { checked: b[0], onCheckedChange: b[1] }), "Switch"),
      h(ui.Chip, { active: c[0], onClick: function () { c[1](!c[0]); } }, "Chip (filter)"),
      h(ui.Chip, { active: false, onClick: function () {} }, "Chip off"));
  }

  var days = []; for (var i = 0; i < 21; i++) { var d = new Date(Date.UTC(2026, 8, 1 + i)); var a1 = 20 + Math.round(12 * Math.sin(i / 2)) + (i % 7 === 5 ? -10 : 0), b1 = 4 + (i % 3), c1 = i % 7 === 3 ? 6 : 0; days.push({ day: d.toISOString().slice(0, 10), meals: a1 + b1 + c1, entries: a1 + b1, parts: { a: a1, b: b1, c: c1 } }); }
  var heat = []; for (var w = 0; w < 7; w++) { var row = []; for (var hr = 0; hr < 24; hr++) row.push(hr >= 11 && hr <= 13 ? 8 + w : hr >= 17 && hr <= 19 ? 10 - w : hr > 8 && hr < 21 ? 2 : 0); heat.push(row); }

  function StepRail() {
    var steps = [["Meal", "Individual Meals", "done"], ["Resident", "Inez Ortiz", "current"], ["Sign", "Last", "todo"]];
    return h("ol", { className: "flex gap-2" }, steps.map(function (s, i) {
      var done = s[2] === "done", cur = s[2] === "current";
      return h("li", { key: i, className: "min-w-0 flex-1" }, h("div", { className: "flex min-h-[64px] items-center gap-3 rounded-card border-[1.5px] px-3 py-2 " + (cur ? "border-navy bg-surface dark:border-white" : done ? "border-hairline" : "border-transparent") },
        h("span", { className: "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-2 text-[15px] font-extrabold " + (done ? "border-status-greenDot bg-status-greenDot text-white" : cur ? "border-navy bg-navy text-white dark:border-white dark:bg-white dark:text-[#111]" : "border-strongline bg-surface text-muted") }, done ? h(I.Check, { className: "h-4 w-4", strokeWidth: 3.4 }) : i + 1),
        h("span", { className: "min-w-0" }, h("span", { className: "block text-[12px] font-bold uppercase tracking-wide text-muted" }, s[0]), h("span", { className: "block truncate text-[15px] font-bold " + (done || cur ? "text-ink" : "text-muted") }, s[1]))));
    }));
  }
  function PersonRow(p) {
    return h("div", { className: "flex min-h-[84px] items-center gap-3 rounded-card border-[1.5px] px-3.5 py-2 " + (p.served ? "border-status-greenDot/30 bg-status-greenBg/40" : "border-hairline") },
      h("span", { className: "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-white " + (p.served ? "bg-muted" : ""), style: p.served ? undefined : { background: ui.tintFor(p.name) } }, ui.initials(p.name)),
      h("span", { className: "min-w-0 flex-1" }, h("span", { className: "block truncate text-[16.5px] font-semibold " + (p.served ? "text-muted" : "text-ink") }, p.name), h("span", { className: "block text-[13px] text-muted" }, "Room " + p.room + " · " + p.note)),
      p.served ? h("span", { className: "rounded-pill px-2.5 py-1 text-[12px] font-bold " + (p.warn ? "bg-status-amberBg text-status-amberText" : "bg-status-greenBg text-status-greenText") }, p.served) : null);
  }
  function Pills() {
    return h("div", { className: "flex flex-wrap gap-2" },
      h("span", { className: "flex min-h-[36px] items-center gap-1.5 rounded-pill bg-status-greenBg px-3 text-[12.5px] font-bold text-status-greenText" }, h(I.CheckCircle2, { className: "h-4 w-4" }), "All uploaded"),
      h("span", { className: "flex min-h-[36px] items-center gap-1.5 rounded-pill bg-status-amberBg px-3 text-[12.5px] font-bold text-status-amberText" }, h(I.UploadCloud, { className: "h-4 w-4" }), "3 uploading"),
      h("span", { className: "flex min-h-[36px] items-center gap-1.5 rounded-pill bg-status-redBg px-3 text-[12.5px] font-bold text-status-redText" }, h(I.AlertTriangle, { className: "h-4 w-4" }), "1 needs attention"));
  }

  function Kit() {
    var dark = useState(document.documentElement.classList.contains("dark"));
    React.useEffect(function () { document.documentElement.classList.toggle("dark", dark[0]); }, [dark[0]]);
    return h("div", { className: "mx-auto max-w-[1100px] px-6 py-8" },
      h("div", { className: "mb-6 flex flex-wrap items-end justify-between gap-3" },
        h("div", null, h("h1", { className: "font-heading text-[30px] font-extrabold text-ink" }, "Lantern Forms — design kit"), h("p", { className: "mt-1 text-[14px] text-muted" }, "The app's real components and tokens. Every screen is built from these; the brief at the bottom has the rules.")),
        h(ui.Button, { variant: "secondary", onClick: function () { dark[1](!dark[0]); } }, dark[0] ? "Light mode" : "Dark mode")),
      h(Card, { id: "colors", group: "Foundations", title: "Colors", note: "Every token has a light and a dark value — toggle dark mode to see both. Never hard-code hex." },
        h("div", { className: "flex flex-wrap gap-4" }, surfaces.map(function (s) { return h(Swatch, { key: s[1], name: s[0], v: s[1], cls: s[2] }); })),
        h("div", { className: "mt-5 flex flex-wrap gap-4" }, tones.map(function (t) {
          return h("div", { key: t, className: "w-[132px]" }, h("div", { className: "flex h-12 items-center justify-center rounded-input text-[13px] font-bold", style: { background: "rgb(var(--st-" + t + "-bg))", color: "rgb(var(--st-" + t + "-text))" } }, t), h("p", { className: "mt-1 font-mono text-[10.5px] text-muted" }, "status-" + t + "Bg / Text / Dot"));
        })),
        h("div", { className: "mt-5 flex flex-wrap gap-2" }, [0, 1, 2, 3, 4, 5, 6, 7, null].map(function (s, i) { return h("div", { key: i, className: "flex items-center gap-1.5 text-[12px] text-muted" }, h("span", { className: "h-4 w-4 rounded-[4px]", style: { background: ch.slotColor(s) } }), s === null ? "Other" : "Chart " + (s + 1)); }))),
      h(Card, { id: "type", group: "Foundations", title: "Type", note: "Archivo. Titles are font-heading font-extrabold." },
        h("p", { className: "font-heading text-[32px] font-extrabold text-ink" }, "Saved"),
        h("p", { className: "font-heading text-[24px] font-extrabold text-ink" }, "What are you serving this shift?"),
        h("p", { className: "font-heading text-[17px] font-extrabold text-ink" }, "Section heading"),
        h("p", { className: "text-[15px] text-ink" }, "Body text 15px — one clear instruction per screen."),
        h("p", { className: "text-[13px] text-muted" }, "Secondary text 13px, text-muted."),
        h("p", { className: "text-micro font-bold uppercase tracking-[0.04em] text-muted" }, "Small caps label")),
      h(Card, { id: "buttons", group: "Components", title: "Buttons", note: "Button — variant × size. Main iPad actions are size lg with min-h-[58px]." },
        h("div", { className: "flex flex-wrap items-center gap-2" }, ["primary", "secondary", "ghost", "success", "outlineDanger", "danger"].map(function (v) { return h(ui.Button, { key: v, variant: v }, v); })),
        h("div", { className: "mt-3 flex flex-wrap items-center gap-2" }, h(ui.Button, { size: "sm" }, "Small"), h(ui.Button, null, "Medium"), h(ui.Button, { size: "lg" }, "Large"), h(ui.Button, { size: "icon", variant: "secondary", "aria-label": "Add" }, h(I.Plus, { className: "h-4 w-4" })), h(ui.Button, { className: "min-h-[58px] px-8 text-[17px] font-extrabold" }, "Start serving Individual Meals"))),
      h(Card, { id: "inputs", group: "Components", title: "Inputs" },
        h("div", { className: "grid gap-4 md:grid-cols-2" },
          h(ui.Field, { label: "Name", hint: "Help text sits under the control." }, h(ui.Input, { placeholder: "Inez Ortiz" })),
          h(ui.Field, { label: "Site" }, h(ui.Select, { value: "", onChange: function () {}, placeholder: "Choose a site", options: [{ value: "a", label: "Amber Hall" }, { value: "b", label: "Stardom Hall · 0.6 mi" }] })),
          h(ui.Field, { label: "Search" }, h(ui.SearchInput, { placeholder: "Search name or room" })),
          h(ui.Field, { label: "Note" }, h(ui.Textarea, { placeholder: "Note (optional)" })))),
      h(Card, { id: "toggles", group: "Components", title: "Checkbox, switch, chip" }, h(ToggleDemo)),
      h(Card, { id: "badges", group: "Components", title: "Badges and status pills" },
        h("div", { className: "flex flex-wrap gap-2" }, ["amber", "blue", "green", "red", "violet", "neutral"].map(function (t) { return h(ui.ToneBadge, { key: t, tone: t }, t); })),
        h("div", { className: "mt-4" }, h(Pills))),
      h(Card, { id: "states", group: "Components", title: "Empty and loading" },
        h("div", { className: "grid gap-4 md:grid-cols-2" }, h("div", { className: "rounded-card border border-hairline" }, h(ui.EmptyState, { title: "Everyone has been served", hint: "Try Everyone to see the whole roster." })), h("div", { className: "rounded-card border border-hairline" }, h(ui.LoadingState, { label: "Loading residents…" })))),
      h(Card, { id: "avatars", group: "Components", title: "Avatars" }, h("div", { className: "flex gap-3" }, ["Inez Ortiz", "Marcus Bell", "Ana Lima", "Collin Falkowski"].map(function (n) { return h(ui.Avatar, { key: n, name: n, size: 40 }); }))),
      h(Card, { id: "stats", group: "Charts", title: "Stat tiles" },
        h("div", { className: "grid grid-cols-2 gap-3 md:grid-cols-4" }, h(ch.StatTile, { label: "Meals served", value: "2,534" }), h(ch.StatTile, { label: "Residents served", value: "1,128" }), h(ch.StatTile, { label: "Meals per day", value: "84.5", hint: "over 30 days" }), h(ch.StatTile, { label: "Over-limit", value: "12", accent: "rgb(var(--st-amber-dot))", icon: h(I.AlertTriangle, { className: "h-3.5 w-3.5 text-status-amberText" }) }))),
      h(Card, { id: "charts", group: "Charts", title: "Charts", note: "Colors come from the checked palette slots; a meal type keeps its slot on every chart." },
        h(ch.DailyBars, { data: days, series: [{ key: "a", name: "Individual Meals", slot: 0 }, { key: "b", name: "Family Style", slot: 1 }, { key: "c", name: "Holiday Meals", slot: 3 }] }),
        h("div", { className: "mt-6 grid gap-6 md:grid-cols-2" },
          h(ch.RankedBars, { unit: "meals", rows: [{ name: "Rockaway Terrace", value: 812, note: "Shelter · 240 residents", color: ch.SITE_TYPE.shelter.color }, { name: "Amber Hall", value: 604, note: "Supportive housing · 68 residents", color: ch.SITE_TYPE.supportive.color }, { name: "Laurel Hall", value: 422, note: "Shelter", color: ch.SITE_TYPE.shelter.color }] }),
          h(ch.HeatGrid, { heat: heat }))),
      h(Card, { id: "dates", group: "Components", title: "Date range" }, h(DateDemo)),
      h(Card, { id: "signature", group: "Components", title: "Signature pad", note: "Draw on it." }, h(SigDemo)),
      h(Card, { id: "patterns", group: "Patterns (iPad)", title: "Guided steps, resident rows, upload state", note: "From the Hot Foods Record screen: steps across the top in portrait, a side panel in landscape." },
        h(StepRail),
        h("div", { className: "mt-4 grid gap-3 md:grid-cols-2" }, h(PersonRow, { name: "Inez Ortiz", room: "4B", note: "12 in 30 days" }), h(PersonRow, { name: "Marcus Bell", room: "2A", note: "9 in 30 days", served: "1 of 1", warn: true }), h(PersonRow, { name: "Ana Lima", room: "7C", note: "New here" }), h(PersonRow, { name: "Tom Reyes", room: "3F", note: "4 in 30 days", served: "Served" }))),
      h(Card, { id: "brief", group: "Rules", title: "Design brief" }, h("pre", { className: "whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink" }, window.__BRIEF__)));
  }
  M["react-dom/client"].createRoot(document.getElementById("root")).render(h(Kit));
})();
`;

export async function designKitHtml(): Promise<string> {
  const [a, brief] = await Promise.all([assets(), designBrief()]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lantern Forms — design kit</title>
${FONTS}
<style>${noClose(a.css, "style")}</style>
<style>body{margin:0;background:rgb(var(--c-appbg));font-family:Archivo,system-ui,sans-serif}</style>
</head><body><div id="root"></div>
<script>window.__BRIEF__ = ${noClose(JSON.stringify(brief), "script")};</script>
<script>${noClose(a.js, "script")}</script>
<script>${noClose(KIT_SCRIPT, "script")}</script>
</body></html>`;
}

// ───────────────────────── Design handoff (one code form) ─────────────────────────

/** Made-up sample data, used where the form's design/fixtures.json has nothing. Never real residents. */
const DEFAULT_FIXTURES: Record<string, unknown> = {
  "roster.sites": [
    { id: "s1", code: "maple-court", name: "Maple Court", siteType: "supportive", latitude: null, longitude: null, geofenceMeters: null },
    { id: "s2", code: "harbor-house", name: "Harbor House", siteType: "shelter", latitude: null, longitude: null, geofenceMeters: null },
  ],
  "roster.residents": ["Inez Ortiz|4B", "Marcus Bell|2A", "Ana Lima|7C", "Tom Reyes|3F", "Grace Kim|1D", "Dev Patel|5A", "Rosa Diaz|6E", "Sam Okafor|2C", "Lena Novak|8B", "Omar Haddad|3A", "Ruth Cole|4D", "Victor Wu|7A"].map((s, i) => {
    const [name, unit] = s.split("|");
    const [firstName, lastName] = name.split(" ");
    return { id: `r${i + 1}`, siteId: "s1", name, firstName, lastName, preferredName: null, unit };
  }),
};

const HANDOFF_SCRIPT = String.raw`
(function () {
  var F = window.__FIXTURES__, P = window.__PROJECT__, store = {}, frames = [];
  var DEVICES = { phone: { w: 390, h: 844, kind: "phone", label: "Phone" }, ipadP: { w: 820, h: 1180, kind: "tablet", label: "iPad portrait" }, ipadL: { w: 1180, h: 820, kind: "tablet", label: "iPad landscape" }, desktop: { w: 1280, h: 800, kind: "desktop", label: "Desktop" } };
  var BP = [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];
  var state = { page: P.pages[0].id, device: "ipadP", dark: false };
  function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
  function device() { var d = DEVICES[state.device]; return { kind: d.kind, orientation: d.h >= d.w ? "portrait" : "landscape", width: d.w, height: d.h, touch: d.kind !== "desktop", breakpoints: BP.filter(function (b) { return d.w >= b[1]; }).map(function (b) { return b[0]; }) }; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function context() { return { user: { id: "demo", name: "Demo Staff", email: "demo@example.org", roleKey: "admin", roleName: "Admin", permissions: ["forms.manage", "entries.view", "entries.void", "roster.view", "roster.edit"], siteIds: null }, form: { id: "demo", slug: P.slug, title: P.title, version: 1, draft: true }, page: state.page, params: {}, pages: P.pages.filter(function (p) { return !p.hidden; }).map(function (p) { return { id: p.id, label: p.label }; }), online: true, today: today(), device: device() }; }
  function answer(m, args) {
    var k = m + ":" + (typeof args[0] === "string" ? args[0] : "");
    if (Object.prototype.hasOwnProperty.call(F, k)) return clone(F[k]);
    if (Object.prototype.hasOwnProperty.call(F, m)) return clone(F[m]);
    var now = new Date().toISOString();
    switch (m) {
      case "local.get": return store[args[0]] === undefined ? null : store[args[0]];
      case "local.set": store[args[0]] = args[1]; return null;
      case "local.remove": delete store[args[0]]; return null;
      case "entries.create":
        if (args[1] && args[1].offline) return { status: "queued", clientId: args[0].clientId || "demo" };
        return { status: "saved", entry: { id: "demo-" + Date.now(), data: args[0].data, site: null, tenantId: args[0].tenantId || null, occurredAt: now, createdAt: now, createdById: "demo", createdByName: "Demo Staff", status: "active", overrideReason: args[0].override || null, voidReason: null, voidedByName: null, voidedAt: null, source: "demo", clientId: args[0].clientId || null } };
      case "entries.list": return { items: [], total: 0 };
      case "entries.get": throw new Error("No sample entry " + args[0]);
      case "collections.list": return [];
      case "collections.get": return null;
      case "collections.put": return { id: args[1] || "demo", data: args[2], updatedAt: now, updatedByName: "Demo Staff" };
      case "queue.status": return { pending: 0, pendingIds: [], failed: [], online: true, syncing: false, lastSyncedAt: null };
      case "app.toast": toast(String(args[0])); return null;
      case "app.navigate": state.page = args[0]; render(); return null;
      default: return null;
    }
  }
  function toast(msg) { var t = document.getElementById("toast"); t.textContent = msg; t.style.opacity = "1"; clearTimeout(toast.t); toast.t = setTimeout(function () { t.style.opacity = "0"; }, 2200); }
  function send(win, msg) { msg.__lcsHost = 1; win.postMessage(msg, "*"); }
  window.addEventListener("message", function (e) {
    var d = e.data; if (!d || d.__lcsApp !== 1) return;
    var f = frames.filter(function (x) { return x.contentWindow === e.source; })[0]; if (!f) return;
    if (d.t === "hello" || d.t === "ready") return send(f.contentWindow, { t: "context", context: context() });
    if (d.t === "call") { try { send(f.contentWindow, { t: "result", id: d.id, ok: true, value: answer(d.method, d.args || []) }); } catch (err) { send(f.contentWindow, { t: "result", id: d.id, ok: false, error: String(err.message || err) }); } }
  });
  function srcdoc(code) {
    var dv = device();
    return "<!doctype html><html class=\"" + (state.dark ? "dark" : "") + "\" data-device=\"" + dv.kind + "\" data-orientation=\"" + dv.orientation + "\" data-bp=\"" + dv.breakpoints.join(" ") + "\"><head><meta charset=\"utf-8\">" + window.__FONTS__ +
      "<style>" + window.__CSS__ + "</style><style>html,body{height:100%;margin:0}body{background:rgb(var(--c-surface));color:rgb(var(--c-ink));font-family:Archivo,system-ui,sans-serif}#root{min-height:100%}" + P.css + "</style>" +
      "<script>" + window.__JS__ + "<\/script></head><body><div id=\"root\"></div><script>" + code + "<\/script></body></html>";
  }
  function render() {
    document.querySelectorAll("[data-page]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-page") === state.page)); });
    document.querySelectorAll("[data-device]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-device") === state.device)); });
    var d = DEVICES[state.device], stage = document.getElementById("stage");
    var code = P.code[state.page + "@" + d.kind] || P.code[state.page] || "";
    stage.innerHTML = "";
    var wrap = document.createElement("div"); wrap.className = "frame"; wrap.style.width = d.w + "px"; wrap.style.height = d.h + "px";
    var scale = Math.min(1, (stage.clientWidth - 32) / d.w); wrap.style.transform = "scale(" + scale + ")"; stage.style.height = (d.h * scale + 32) + "px";
    var f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts allow-forms allow-modals"); f.srcdoc = srcdoc(code);
    wrap.appendChild(f); stage.appendChild(wrap); frames = [f];
    document.getElementById("which").textContent = d.label + " · " + d.w + "×" + d.h + (P.code[state.page + "@" + d.kind] ? " · its own " + d.kind + " view" : "");
  }
  var tabs = document.getElementById("pages");
  P.pages.forEach(function (p) { var b = document.createElement("button"); b.textContent = p.label + (p.hidden ? " (hidden)" : ""); b.setAttribute("data-page", p.id); b.onclick = function () { state.page = p.id; render(); }; tabs.appendChild(b); });
  var devs = document.getElementById("devices");
  Object.keys(DEVICES).forEach(function (k) { var b = document.createElement("button"); b.textContent = DEVICES[k].label; b.setAttribute("data-device", k); b.onclick = function () { state.device = k; render(); }; devs.appendChild(b); });
  document.getElementById("dark").onclick = function () { state.dark = !state.dark; document.documentElement.classList.toggle("dark", state.dark); render(); };
  window.addEventListener("resize", render);
  render();
})();
`;

export async function handoffHtml(opts: { title: string; slug: string; runtime: AppRuntime; files: Record<string, string> }): Promise<{ html: string; usedFixtures: boolean }> {
  const [a, brief] = await Promise.all([assets(), designBrief()]);
  let own: Record<string, unknown> = {};
  const fx = opts.files["design/fixtures.json"];
  if (fx) {
    try {
      own = JSON.parse(fx);
    } catch {
      own = {};
    }
  }
  const fixtures = { ...DEFAULT_FIXTURES, ...own };
  const project = {
    slug: opts.slug,
    title: opts.title,
    pages: opts.runtime.pages.map((p) => ({ id: p.id, label: p.label, hidden: p.hidden })),
    code: Object.fromEntries(Object.entries(opts.runtime.code).map(([k, v]) => [k, noClose(v, "script")])),
    css: noClose(opts.runtime.css, "style"),
  };
  const sources = Object.entries(opts.files)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([path, src]) => `<details><summary>${esc(path)}</summary><pre>${esc(src)}</pre></details>`)
    .join("\n");
  const json = (v: unknown) => noClose(JSON.stringify(v), "script");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} — design handoff</title>
${FONTS}
<style>${noClose(a.css, "style")}</style>
<style>
  body{margin:0;background:rgb(var(--c-appbg));color:rgb(var(--c-ink));font-family:Archivo,system-ui,sans-serif}
  header{position:sticky;top:0;z-index:5;background:rgb(var(--c-surface));border-bottom:1px solid rgb(var(--c-hairline));padding:14px 24px}
  h1{margin:0;font-size:22px;font-weight:800}
  .row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px}
  .row button{font:600 13px Archivo,system-ui;border:1px solid rgb(var(--c-hairline));background:rgb(var(--c-surface));color:rgb(var(--c-ink));border-radius:100px;padding:6px 12px;cursor:pointer}
  .row button[aria-pressed=true]{background:rgb(var(--c-brand));border-color:rgb(var(--c-brand));color:#fff}
  .note{font-size:12.5px;color:rgb(var(--c-muted))}
  #stage{position:relative;padding:16px;overflow:hidden}
  .frame{transform-origin:top left;border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(35,42,58,.25);border:8px solid #1b1f2a;background:#1b1f2a}
  .frame iframe{width:100%;height:100%;border:0;display:block;border-radius:10px}
  section.doc{max-width:1100px;margin:0 auto;padding:8px 24px 48px}
  section.doc h2{font-size:17px;font-weight:800;margin:24px 0 8px}
  pre{white-space:pre-wrap;font:12px/1.55 ui-monospace,Consolas,monospace;background:rgb(var(--c-surface));border:1px solid rgb(var(--c-hairline));border-radius:8px;padding:12px}
  details{margin:6px 0}summary{cursor:pointer;font-weight:600;font-size:13.5px}
  #toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#232a3a;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;opacity:0;transition:opacity .2s;z-index:10}
</style>
</head><body>
<header>
  <h1>${esc(opts.title)} <span class="note">— design handoff</span></h1>
  <p class="note">The form's real screens, running on made-up sample data (no real residents), for redesign in Claude Design. Pick a page and a device; the screens are clickable.</p>
  <div class="row" id="pages"></div>
  <div class="row" id="devices"></div>
  <div class="row"><button id="dark">Light / dark</button><span class="note" id="which"></span></div>
</header>
<div id="stage"></div>
<section class="doc">
  <h2>How to hand a design back</h2>
  <p class="note">Keep to the components and tokens in the brief below (and the design kit), one file per screen, with notes on phone / iPad / desktop differences. Claude Code, connected to Lantern's MCP server, can then apply it to this code form (${esc(opts.slug)}) directly.</p>
  <h2>Design brief</h2>
  <pre>${esc(brief)}</pre>
  <h2>Source of this form</h2>
  ${sources}
</section>
<div id="toast"></div>
<script>window.__FIXTURES__=${json(fixtures)};window.__PROJECT__=${json(project)};window.__CSS__=${json(noClose(a.css, "style"))};window.__JS__=${json(noClose(a.js, "script"))};window.__FONTS__=${json(FONTS)};</script>
<script>${noClose(HANDOFF_SCRIPT, "script")}</script>
</body></html>`;
  return { html, usedFixtures: Boolean(fx) };
}
