import { appBaseUrl } from "../env.js";
import { APP_TUTORIAL_TARGETS, FORM_TUTORIAL_TARGETS, TUTORIAL_MAX_STEPS } from "../forms/engine.js";

/** The MCP server's get_tutorial_reference: how to write a form's tutorial. */
export const TUTORIAL_GUIDE = () => `# Form tutorials

A tutorial walks someone through a form the first time they open it. One thing is highlighted at a
time; the rest of the screen is dimmed and locked, so they can only look at, tap or fill in what the
step points at. They can always press Skip (or Esc). The app records who finished or skipped it, on
every device they use, so it starts once per person (tutorial_progress shows who).

The site has its own welcome tour (built in, by role and device). This is about a form's own.

## Where it lives
- Basic forms: the "tutorial" key of the lcs-form document.
- Code forms: the "tutorial" key of form.json.
Both are part of the DRAFT: publish (publish_form / publish_code_form) to make it live.
set_tutorial / remove_tutorial edit only that key; get_tutorial shows what a step can point at.

## Shape
{
  "version": 1,              // raise it (or set_tutorial showAgain: true) to show it again to people who saw an older one
  "title": "How to record a meal",   // optional; default "How to use <form title>"
  "autoStart": true,         // false: only runs from the form's "Show me how" button
  "roles": ["site_staff"],   // optional: who it starts by itself for (role keys). "Show me how" works for anyone
  "steps": [ Step, … ]       // 1–${TUTORIAL_MAX_STEPS}, in order
}
Step:
{
  "id": "meal",              // optional, unique; names the step in progress reports
  "title": "Pick the meal",  // ≤ 80 characters
  "body": "…",               // ≤ 600; plain text, a blank line = new paragraph, **bold**, {user:first} {user:name}
  "field": "<field id>",     // basic forms: highlight this field
  "target": "<name>",        // or a named spot (below); neither = a card in the middle of the screen
  "page": "<page id>",       // code forms: the tab the step is on (the tutorial opens it); default the previous step's
  "action": "next",          // next (default) | click | fill
  "placement": "auto",       // auto | top | bottom | left | right — where the card sits beside the spot (phones use top/bottom)
  "roles": ["site_manager"], // optional: only these roles get the step (admins see every step)
  "devices": ["phone"]       // optional: phone | tablet | desktop
}

## Actions
- next: they read it and press Next. Everything is locked, the highlighted spot too.
- click: they must tap the highlighted thing, and that moves the tutorial on. Use it to teach a move:
  "Tap Next" on a multi-page form, "Open the Entries tab", "Tap a meal".
- fill: they must answer the highlighted field; Next unlocks once it has a value. Only the field works.
Their answers are real: a tutorial runs on the live form, so fill steps fill in the form they're about to send.
Never make them send it inside the tutorial: end on the submit button with action next ("When you're done, tap
Submit"). A basic form refuses click on "submit"; on a code form, don't use click on a button that saves.

## What a step can point at
Basic forms — "field": any top-level field id (not inside a repeater). Only the current page's fields are on
screen: to reach page 2, put a step on the Next button first (target "next", action "click").
A field hidden by a rule, or a target that isn't showing, is skipped.
"target":
${Object.entries(FORM_TUTORIAL_TARGETS).map(([k, v]) => `  - ${k}: ${v}`).join("\n")}

Code forms — "target": the value of a data-tour attribute on an element in a page:
  <Card data-tour="meal-picker">…</Card>   →   { "target": "meal-picker", "page": "record" }
Add the attribute with edit_file, then publish. The build warns about a target that isn't written in the page
(or the files it shares). The app's own spots:
${Object.entries(APP_TUTORIAL_TARGETS).map(([k, v]) => `  - ${k}: ${v}`).join("\n")}
A page can also run the tutorial itself: import { tutorial } from "@lcs/sdk"; tutorial.start() (e.g. a Help
button), and tutorial.next() to move a click step on from code (a custom picker that isn't one element).

## Writing it — who reads it
Site staff, often on a phone or an iPad, between other things. Most will read one line per step.
- 3–8 steps. One idea each. Title ≤ 6 words, body one or two short sentences.
- Say what to do, with the word they'll see on the screen: "Tap **Sign**", "Pick the resident".
- Start with a card (no target): what the form is for and when to use it. End with a card or the submit
  button: what happens after (who is told, where to find it again).
- Spend steps on what's easy to get wrong or new: the site picker, an override reason, a signature, offline saving.
  Skip the obvious ("Type your name in Name").
- fill only for the one or two answers that matter; the rest next.
- Managers see different tabs: give their steps "roles", rather than a second tutorial.
- Phone and desktop differ (a tab row, a side panel): use "devices" on the steps that differ.

## Try it
Basic form draft: ${appBaseUrl}/f/<slug>/preview?tour=1 (admins). Live: ${appBaseUrl}/f/<slug>?tour=1
Code form draft: ${appBaseUrl}/apps/<slug>?draft=1&tour=1 (developers). Live: ${appBaseUrl}/apps/<slug>?tour=1
?tour=1 runs it whatever the person has seen, and records nothing.

## Examples
Basic form:
${JSON.stringify(
  {
    title: "How to report maintenance",
    steps: [
      { title: "Report something broken", body: "Use this when anything in a unit or a common area needs fixing. It takes about a minute." },
      { field: "site", action: "fill", title: "Which site?", body: "Pick the site the problem is at. Facilities sees it straight away." },
      { field: "urgent", title: "Is it urgent?", body: "**Yes** pages the on-call team. Use it for leaks, no heat, or anything unsafe." },
      { field: "photos", title: "Add a photo", body: "A photo saves a trip. Tap to use the camera." },
      { target: "submit", title: "Send it", body: "When you're done, tap **Send request**. You'll get a notification when it's fixed." },
    ],
  },
  null,
  2
)}

Code form (form.json):
${JSON.stringify(
  {
    title: "How to record a meal",
    roles: ["site_staff", "site_manager"],
    steps: [
      { title: "Hot Foods", body: "Record each meal as you hand it out. It works without Wi-Fi: entries upload by themselves." },
      { page: "record", target: "meal-picker", action: "click", title: "Pick the meal", body: "Tap the meal you're serving. You only pick it once per shift." },
      { target: "resident-search", action: "fill", title: "Find the resident", body: "Start typing their name. Regulars are at the top." },
      { target: "sign", title: "They sign", body: "Hand them the device to sign, then tap **Save**." },
      { target: "tab:entries", roles: ["site_manager"], title: "Entries", body: "Everything recorded at your sites, with export and void." },
    ],
  },
  null,
  2
)}
`;
