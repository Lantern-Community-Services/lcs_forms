import { env } from "../env.js";
import { currentLook, type EmailLook } from "./emailLook.js";

/**
 * The one layout every email from the site uses, modelled on the Lantern
 * Power Automate emails (the weekly Unit Inspection report): a navy band with
 * "Lantern Community Services" and what it's about, a thin light-blue stripe,
 * a heading, what the reader needs to do, a short table of answers, a button
 * into the site, and a footer saying it's automated.
 *
 * The name in the band, the colors, a logo and the footer are the organization's
 * (services/emailLook.ts, Admin → Notifications → Look).
 *
 * Inline styles and tables only, so Outlook (desktop and phone) shows it as
 * drawn. Everything given is escaped: nothing here is HTML from a person.
 *
 * Answers (fields, table) are only ever passed for a Lantern address: callers
 * check with isInternalAddress, and the field rules in services/emailFields.ts
 * keep resident, contact, signature and file answers out altogether.
 */

export interface EmailParts {
  /** What it's about, under "Lantern Community Services" in the band: usually the form's title. */
  kicker?: string | null;
  heading: string;
  /** A plain line under the heading, e.g. "A new entry for Clover Hall LP." */
  intro?: string | null;
  /** What the reader has to do, written by an admin on the route or report. */
  whatToDo?: string | null;
  /** Chosen answers, as label and value. */
  fields?: { label: string; value: string }[];
  /** A table, for summary reports. `more` rows weren't shown. */
  table?: { columns: string[]; rows: string[][]; more?: number } | null;
  button?: { label: string; url: string } | null;
  /** A small line under the button. */
  note?: string | null;
  urgent?: boolean;
}

const PAGE = "#f4f6f9";
const LINE = "#e5e7eb";
const INK = "#1f2937";
const MUTED = "#4b5563";
const FAINT = "#6b7280";
const RED = "#b42318";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Escaped, with the line breaks someone typed kept. */
const text = (s: string) => esc(s).replace(/\r?\n/g, "<br />");

/** Whether an address is at Lantern (SSO_ALLOWED_DOMAINS), so it may be sent chosen answers. */
export function isInternalAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return Boolean(domain) && env.ssoAllowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function brandedEmail(p: EmailParts, look: EmailLook = currentLook()): string {
  const NAVY = look.bandColor;
  const ACCENT = look.accentColor;
  const out: string[] = [];
  out.push(`<div style="background:${PAGE};padding:24px 0;font-family:'Segoe UI',Arial,Helvetica,sans-serif">`);
  out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">`);
  out.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border:1px solid #dfe3ea;border-radius:8px;overflow:hidden">`);

  // The band and its stripe.
  out.push(
    `<tr><td style="background:${NAVY};padding:16px 24px;color:#ffffff;font-size:13px;letter-spacing:1px;text-transform:uppercase">` +
      (look.logoUrl ? `<img src="${esc(look.logoUrl)}" alt="${esc(look.orgName)}" height="28" style="display:block;height:28px;margin:0 0 8px;border:0" />` : "") +
      `${esc(look.orgName)}${p.kicker ? `<br />${esc(p.kicker)}` : ""}</td></tr>`
  );
  out.push(`<tr><td style="height:4px;line-height:4px;font-size:0;background:${p.urgent ? RED : ACCENT}">&nbsp;</td></tr>`);

  out.push(`<tr><td style="padding:24px 28px;color:${INK};font-size:14px;line-height:1.5">`);
  if (p.urgent) {
    out.push(`<p style="margin:0 0 8px;color:${RED};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Urgent: needs attention now</p>`);
  }
  out.push(`<h2 style="margin:0 0 6px;color:${NAVY};font-size:20px">${esc(p.heading)}</h2>`);
  if (p.intro) out.push(`<p style="margin:0 0 16px;color:${MUTED}">${text(p.intro)}</p>`);

  if (p.whatToDo) {
    out.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr>` +
        `<td style="border-left:4px solid ${ACCENT};background:#f1f7fa;padding:10px 14px;font-size:14px;color:${INK}">` +
        `<strong style="color:${NAVY}">What to do:</strong> ${text(p.whatToDo)}</td></tr></table>`
    );
  }

  if (p.fields?.length) {
    out.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;width:100%">`);
    for (const f of p.fields) {
      out.push(
        `<tr><td style="padding:6px 12px 6px 0;color:${FAINT};font-size:13px;white-space:nowrap;vertical-align:top;border-bottom:1px solid ${LINE}">${esc(f.label)}</td>` +
          `<td style="padding:6px 0;font-size:14px;color:${INK};vertical-align:top;border-bottom:1px solid ${LINE}">${text(f.value)}</td></tr>`
      );
    }
    out.push(`</table>`);
  }

  if (p.table) {
    out.push(`<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${LINE};margin:0 0 12px;width:100%">`);
    out.push(`<thead><tr>${p.table.columns.map((c) => `<th style="background:${NAVY};color:#ffffff;padding:8px 9px;text-align:left;font-size:13px">${esc(c)}</th>`).join("")}</tr></thead><tbody>`);
    for (const row of p.table.rows) {
      out.push(`<tr>${row.map((v) => `<td style="padding:7px 9px;border-bottom:1px solid ${LINE};font-size:13px">${esc(v)}</td>`).join("")}</tr>`);
    }
    out.push(`</tbody></table>`);
    if (p.table.more) out.push(`<p style="margin:0 0 16px;color:${FAINT};font-size:12px">And ${p.table.more} more in Lantern Forms.</p>`);
  }

  if (p.button) {
    out.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 10px"><tr>` +
        `<td style="background:${look.buttonColor};border-radius:6px"><a href="${esc(p.button.url)}" style="display:inline-block;padding:10px 18px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none">${esc(p.button.label)}</a></td>` +
        `</tr></table>`
    );
  }
  if (p.note) out.push(`<p style="margin:8px 0 0;color:${FAINT};font-size:12px">${text(p.note)}</p>`);
  out.push(`</td></tr>`);

  out.push(
    `<tr><td style="background:${PAGE};padding:14px 28px;color:${FAINT};font-size:12px;border-top:1px solid ${LINE}">` +
      `${text(look.footer)}</td></tr>`
  );
  out.push(`</table></td></tr></table></div>`);
  return out.join("");
}
