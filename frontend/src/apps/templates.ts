import { DASHBOARD_TEMPLATE } from "./templates/dashboard";

/** Starting points for New code form. `files` null = the server's starter project. */
export const CODE_TEMPLATES: { key: string; name: string; blurb: string; files: ((title: string) => Record<string, string>) | null }[] = [
  { key: "starter", name: "Starter", blurb: "A record page, an entries page and a server rule — the smallest complete code form.", files: null },
  { key: "dashboard", name: "Dashboard", blurb: "A reporting page over another form's entries: date range, stat tiles, charts, CSV export.", files: DASHBOARD_TEMPLATE },
];
