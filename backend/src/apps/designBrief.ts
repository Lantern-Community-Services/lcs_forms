import { appBaseUrl } from "../env.js";

/**
 * The brief for design work on Lantern Forms — what Claude Design (or anyone)
 * needs so a design comes back buildable as a code form without translation.
 * Served at /api/apps/design-brief, by the MCP tool get_design_kit, and bundled
 * into the design kit and every design handoff export.
 */
export const DESIGN_BRIEF = () => `# Lantern Forms — design brief

Lantern Community Services runs supportive housing and shelters in New York City. Staff record
services (meals, pantry visits, incidents, attendance) on **iPads at the front desk first**, phones
second, desktops in the office third. Screens are used standing up, mid-shift, often with a resident
waiting: big targets, one clear action per screen, nothing that needs a keyboard if a tap will do.

## How screens are built
A form's screens are React pages inside the Lantern app (${appBaseUrl}), styled with Tailwind using the
app's design tokens and composed from its own components. A design that uses only what is listed here
can be built exactly; anything else has to be invented, so flag it.

- Components: @lcs/ui — Button (primary, secondary, ghost, danger, outlineDanger, success; sm/md/lg/icon),
  Card, Input, Textarea, SearchInput, Select, Field, Label, Checkbox, Switch, Chip, ToneBadge (amber, blue,
  green, red, violet, neutral), Badge, Avatar, Spinner, LoadingState, EmptyState, Page, PageHeader, Modal,
  Sheet (bottom sheet on phones), DropdownMenu, SignaturePad, DateRangeBar, PhotoInput (camera thumbnails),
  FileInput, Photo, FileChip, EntryHistory.
- Charts: @lcs/charts — TrendChart (lines over time), ColumnChart, DonutChart (parts of a whole, up to 6),
  DailyBars (stacked per day), RankedBars (horizontal, with avatar or note), HeatGrid (weekday × hour),
  StatTile, Legend. Categorical colors come from an 8-slot palette checked for
  color blindness in light and dark (slotColor(0-7)); never pick chart colors by hand.
- Icons: lucide-react (any icon, 1.5–2px stroke, 16–20px in UI, 24px+ for touch-first actions).

## Tokens (Tailwind names)
Surfaces: bg-appbg (app background), bg-surface (screens, cards), bg-sidebar (side panels, toolbars),
bg-subtle / bg-subtle2 (quiet fills), bg-navsel (selected row), bg-rowhover.
Text: text-ink (primary), text-muted (secondary), text-accent (links; navy in light, light in dark).
Lines: border-hairline (default), border-strongline (emphasis), divide-hairline.
Brand: bg-navy (primary actions; follows the person's chosen theme color), text-white on it.
Status (bg / text / dot for each): status-amber*, status-blue*, status-green*, status-red*, status-violet*,
status-neutral* — e.g. bg-status-greenBg text-status-greenText. Amber = needs attention, green = done,
red = refused / destructive, blue = info, violet = rules / logic.
Radii: rounded-card (10px), rounded-panel (9px), rounded-input (6px), rounded-pill.
Shadows: shadow-card, shadow-panel, shadow-modal.
Type: Archivo everywhere. font-heading font-extrabold for titles (23–32px), 13–16px body,
text-micro (11px) for small caps labels (uppercase tracking-wide font-bold text-muted).
Every token has a dark-mode value; design both, never hard-code hex.

## Layout rules
- Touch targets at least 44px tall (48–60px for the main action on iPad screens).
- Breakpoints follow the device: phone < 768px, md = iPad portrait (768+), lg = iPad landscape / desktop
  (1024+). tablet: / phone: / desktop: variants exist for device-specific tweaks, and a page can have a
  completely separate phone, tablet or desktop view.
- iPad-first screens: hold to the screen height (no page scroll), one scrolling list, the primary action
  pinned at the bottom. Side panel (bg-sidebar, ~272px) on landscape; steps across the top in portrait;
  a thin progress bar on phones.
- The app's sidebar folds to icons on iPad inside a form; design for ~750px (portrait) and ~1100px
  (landscape) of content width.
- Offline is normal: every save must work without a connection; show upload state as a small pill
  (green All uploaded / amber N uploading / red N need attention).
- Accessibility: 4.5:1 text contrast, color never the only signal, labels on every input.

## Handing a design back
Deliver React + Tailwind using only the components and tokens above (no inline hex colors, no other
UI libraries), with one file per screen and notes on phone / iPad / desktop differences. A developer or
Claude Code (connected to Lantern's MCP server) turns it into a code form's pages directly.
`;
