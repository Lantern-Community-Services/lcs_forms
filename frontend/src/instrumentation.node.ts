/**
 * Application Insights for the Next server: the requests it serves (the app's
 * pages, and the /api/* calls it passes on to the backend) and those calls to
 * the backend as dependencies (the backend reports its side as
 * "lcs-forms-api"), sent to Azure Monitor through OpenTelemetry. Loaded by
 * instrumentation.ts.
 *
 * Resident data stays out of telemetry: request and response bodies are never
 * recorded, console output isn't collected, and query strings are cut from
 * every URL before a span is exported.
 */
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { createRequire } from "node:module";
import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import { SpanKind, type Attributes, type Span } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Span attributes that hold a URL, or the path and query of one. */
const URL_ATTRIBUTES = ["http.url", "url.full", "http.target"];

/**
 * As each span starts: removes query strings from its attributes, and turns
 * Next's own request span ("GET /[[...slug]]") into a step of the request the
 * http instrumentation already records, so each request is counted once.
 */
const cleanSpans: SpanProcessor = {
  onStart(span) {
    const attributes = (span as unknown as { attributes: Attributes }).attributes;
    const next = span as unknown as { kind: SpanKind; parentSpanContext?: unknown };
    if (attributes["next.span_type"] && next.kind === SpanKind.SERVER && next.parentSpanContext) {
      next.kind = SpanKind.INTERNAL;
      // Or App Insights would list it as an HTTP call.
      delete attributes["http.method"];
    }
    for (const key of URL_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value === "string" && value.includes("?")) span.setAttribute(key, value.slice(0, value.indexOf("?")));
    }
    if (attributes["url.query"]) span.setAttribute("url.query", "");
  },
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/** Hosts the SDK itself calls on start-up (Azure VM metadata, its settings). */
const SDK_HOSTS = new Set(["169.254.169.254", "settings.sdk.monitor.azure.com"]);

const httpOptions = {
  enabled: true,
  // The build's static files, App Service's health check (/api/health, every
  // minute) and the container's (every 30 s).
  ignoreIncomingRequestHook: (req: IncomingMessage) =>
    !!req.url?.startsWith("/_next/static/") ||
    !!req.url?.startsWith("/api/health") ||
    (req.url === "/" && req.headers["user-agent"] === "node"),
  // Named by path ("GET /forms"); the span is otherwise just "GET".
  requestHook: (span: Span, req: IncomingMessage | ClientRequest) => {
    if ("headers" in req && "url" in req && req.url) span.updateName(`${req.method} ${req.url.split("?")[0]}`);
  },
  ignoreOutgoingRequestHook: (req: RequestOptions | ClientRequest) =>
    SDK_HOSTS.has(String(("hostname" in req && req.hostname) || ("host" in req && req.host) || "")),
};

try {
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING!.trim() },
    // The cloud role name App Insights shows for this app.
    resource: resourceFromAttributes({ "service.name": "lcs-forms-web" }),
    instrumentationOptions: {
      http: httpOptions,
      // Log lines can quote what someone typed into a form.
      console: { enabled: false },
    },
    // Every request: the default (about five spans a second, counting each
    // dependency) would thin out a busy minute.
    tracesPerSecond: 0,
    samplingRatio: 1,
    spanProcessors: [cleanSpans],
  });
  // Next's server loaded http before this ran, and the instrumentation patches
  // it on the next require() of it, which would otherwise be the first /api
  // call's. (A bundled import() is served from the bundle's cache.)
  const load = createRequire(`${process.cwd()}/`);
  for (const builtin of ["http", "https"]) load(builtin);
  console.log("[telemetry] sending requests and dependencies to Application Insights");
} catch (err) {
  // Telemetry never keeps the site from starting.
  console.error("[telemetry] could not start Application Insights:", err);
}
