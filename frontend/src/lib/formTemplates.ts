import { emptyForm, type Choice, type FormDoc } from "./formEngine";

/** Starting points for New form. Each is an ordinary lcs-form document. */

const ch = (...labels: string[]): Choice[] => labels.map((l) => ({ label: l, value: l.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") }));

function base(title: string, description: string): FormDoc {
  return { ...emptyForm(title), description };
}

export const FORM_TEMPLATES: { key: string; name: string; blurb: string; build: () => FormDoc }[] = [
  { key: "blank", name: "Blank form", blurb: "Start from nothing.", build: () => emptyForm("Untitled form") },
  {
    key: "incident",
    name: "Incident report",
    blurb: "Site, residents involved, what happened, follow-up, signature.",
    build: () => ({
      ...base("Incident report", "<p>Report anything unusual that happened on site. Fill it in as soon as you can.</p>"),
      fields: [
        { id: "site", type: "site", label: "Site", required: true, width: "half" },
        { id: "occurred_on", type: "date", label: "Date of incident", required: true, maxDate: "today", defaultValue: "{date:today}", width: "half" },
        { id: "occurred_at", type: "time", label: "Time", width: "half" },
        { id: "location", type: "text", label: "Where on site?", width: "half" },
        { id: "incident_type", type: "checkbox", label: "Type of incident", required: true, columns: 2, allowOther: true, choices: ch("Medical", "Altercation", "Property damage", "Police called", "EMS called", "Fire / alarm") },
        { id: "resident", type: "resident", label: "Resident involved", siteField: "site" },
        { id: "what_happened", type: "textarea", label: "What happened?", required: true, rows: 6 },
        { id: "injuries", type: "radio", label: "Was anyone hurt?", required: true, choices: ch("Yes", "No") },
        { id: "injury_details", type: "textarea", label: "Describe the injuries", required: true, conditional: { action: "show", match: "all", rules: [{ field: "injuries", op: "is", value: "yes" }] } },
        { id: "photos", type: "file", label: "Photos", accept: "image/*", maxFiles: 5 },
        { id: "follow_up", type: "section", label: "Follow-up" },
        { id: "follow_up_needed", type: "consent", label: "Follow-up needed", consentText: "A manager needs to follow up on this." },
        { id: "staff_signature", type: "signature", label: "Your signature", required: true },
      ],
      settings: { ...emptyForm().settings, submitLabel: "Submit report", entriesRoles: ["site_admin", "site_manager"] },
    }),
  },
  {
    key: "event",
    name: "Event sign-up",
    blurb: "Name, contact, guests, dietary needs, with a cap on entries.",
    build: () => ({
      ...base("Event sign-up", "<p>Save your spot.</p>"),
      fields: [
        { id: "name", type: "name", label: "Your name", required: true, nameParts: ["first", "last"] },
        { id: "email", type: "email", label: "Email", width: "half" },
        { id: "phone", type: "phone", label: "Phone", width: "half" },
        { id: "guests", type: "number", label: "Guests coming with you", min: 0, max: 5, defaultValue: 0, width: "half" },
        { id: "seats", type: "calculation", label: "Seats you're taking", expression: "{guests} + 1", decimals: 0, width: "half" },
        { id: "dietary", type: "checkbox", label: "Dietary needs", columns: 2, allowOther: true, choices: ch("Vegetarian", "Vegan", "Halal", "Kosher", "Nut allergy", "Gluten free") },
      ],
      settings: { ...emptyForm().settings, submitLabel: "Sign me up", limits: { maxEntries: 50, closedMessage: "This event is full." }, confirmation: { type: "message", message: "<p>You're on the list, {name.first}! We saved {seats} seat(s).</p>" } },
    }),
  },
  {
    key: "survey",
    name: "Feedback survey",
    blurb: "Rating, a matrix of statements, and open comments.",
    build: () => ({
      ...base("Feedback survey", "<p>Tell us how we're doing. It takes two minutes.</p>"),
      fields: [
        { id: "overall", type: "rating", label: "Overall, how would you rate our services?", max: 5, required: true },
        { id: "statements", type: "likert", label: "How much do you agree?", choices: ch("Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"), statements: [{ label: "Staff treat me with respect", value: "respect" }, { label: "I feel safe here", value: "safe" }, { label: "I know who to ask for help", value: "help" }] },
        { id: "recommend", type: "slider", label: "How likely are you to recommend us? (0–10)", min: 0, max: 10, step: 1 },
        { id: "comments", type: "textarea", label: "Anything else?", rows: 4 },
      ],
      settings: { ...emptyForm().settings, access: { mode: "public" }, submitLabel: "Send feedback" },
    }),
  },
  {
    key: "request",
    name: "Supply request",
    blurb: "A repeater of items and quantities with a running total.",
    build: () => ({
      ...base("Supply request", ""),
      fields: [
        { id: "site", type: "site", label: "Site", required: true },
        { id: "needed_by", type: "date", label: "Needed by", minDate: "today", width: "half" },
        { id: "priority", type: "select", label: "Priority", choices: ch("Low", "Normal", "Urgent"), defaultValue: "normal", width: "half" },
        { id: "items", type: "repeater", label: "Items", minRows: 1, addLabel: "Add item", fields: [{ id: "item", type: "text", label: "Item", required: true, width: "half" }, { id: "qty", type: "number", label: "Quantity", min: 1, width: "third" }] },
        { id: "notes", type: "textarea", label: "Notes", rows: 3 },
      ],
      settings: { ...emptyForm().settings, notifications: [{ id: "urgent", name: "Urgent requests", enabled: false, kind: "email", to: "", subject: "URGENT supply request: {site:name}", body: "{all_fields}", conditional: { action: "show", match: "all", rules: [{ field: "priority", op: "is", value: "urgent" }] } }] },
    }),
  },
];
