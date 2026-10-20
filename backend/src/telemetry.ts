/**
 * Application Insights: requests and dependencies (Microsoft Graph and other
 * fetch() calls, Azure Blob; Azure SQL comes from src/prisma.ts) sent to Azure
 * Monitor through OpenTelemetry.
 *
 * Loaded ahead of the app with `node --import ./dist/src/telemetry.js` (the
 * Dockerfile's CMD): the backend is ES modules, and their imports can only be
 * instrumented when the loader hook is registered before index.ts's import
 * graph is loaded. Importing this file from index.ts would be too late.
 *
 * Nothing happens without APPLICATIONINSIGHTS_CONNECTION_STRING (local dev).
 * App Service sets it; it is read straight from the environment, not .env.
 *
 * Resident data stays out of telemetry: request and response bodies are never
 * recorded (none of these instrumentations read them), console output isn't
 * collected, query strings are cut from every URL before a span is exported
 * (searches and filters travel in them, and Blob SAS tokens), and queries are
 * recorded by model and operation only.
 */
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { Attributes } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();

/** Span attributes that hold a URL, or the path and query of one. */
const URL_ATTRIBUTES = ["http.url", "url.full", "http.target"];

/**
 * Removes query strings from a span's attributes as it starts, and as it ends
 * repairs the route Express reports for a path registered twice (body parsers
 * set up ahead of the router, see app.ts): "/api/f/:slug/submit/api/f/:slug/submit".
 */
const cleanSpans: SpanProcessor = {
  onStart(span) {
    const attributes = (span as unknown as { attributes: Attributes }).attributes;
    for (const key of URL_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value === "string" && value.includes("?")) span.setAttribute(key, value.slice(0, value.indexOf("?")));
    }
    if (attributes["url.query"]) span.setAttribute("url.query", "");
  },
  onEnd(span) {
    const attributes = span.attributes as Attributes;
    const route = attributes["http.route"];
    if (typeof route === "string" && route.length % 2 === 0 && route.length > 1) {
      const half = route.slice(0, route.length / 2);
      if (route === half + half) attributes["http.route"] = half;
    }
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/** Hosts the SDK itself calls on start-up (Azure VM metadata, its settings). */
const SDK_HOSTS = new Set(["169.254.169.254", "settings.sdk.monitor.azure.com"]);

const httpOptions = {
  enabled: true,
  // Health checks: App Service's (/api/health, every minute, through the web
  // app's proxy) and the container's (/api/health/live, every 30 s).
  ignoreIncomingRequestHook: (req: IncomingMessage) => req.url?.startsWith("/api/health") ?? false,
  ignoreOutgoingRequestHook: (req: RequestOptions | ClientRequest) =>
    SDK_HOSTS.has(String(("hostname" in req && req.hostname) || ("host" in req && req.host) || "")),
};

if (connectionString) {
  try {
    // The ES module loader hook, registered before the app's imports load.
    await import("@azure/monitor-opentelemetry/loader");
    const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { metrics, trace } = await import("@opentelemetry/api");
    const { registerInstrumentations } = await import("@opentelemetry/instrumentation");
    const { ExpressInstrumentation, ExpressLayerType } = await import("@opentelemetry/instrumentation-express");
    const { UndiciInstrumentation } = await import("@opentelemetry/instrumentation-undici");

    useAzureMonitor({
      azureMonitorExporterOptions: { connectionString },
      // The cloud role name App Insights shows for this app.
      resource: resourceFromAttributes({ "service.name": "lcs-forms-api" }),
      instrumentationOptions: {
        http: httpOptions,
        azureSdk: { enabled: true },
        // Log lines can quote what someone typed into a form.
        console: { enabled: false },
      },
      // Every request: the default (about five spans a second, counting each
      // query) would thin out a busy minute.
      tracesPerSecond: 0,
      samplingRatio: 1,
      spanProcessors: [cleanSpans],
    });

    registerInstrumentations({
      tracerProvider: trace.getTracerProvider(),
      meterProvider: metrics.getMeterProvider(),
      instrumentations: [
        // Only for the route ("GET /api/forms/:id") that names each request;
        // a span per middleware would bury the dependencies.
        new ExpressInstrumentation({
          ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER, ExpressLayerType.REQUEST_HANDLER],
        }),
        // fetch(): Microsoft Graph, sign-in, webhooks, GitHub.
        new UndiciInstrumentation(),
      ],
    });

    console.log("[telemetry] sending requests and dependencies to Application Insights");
  } catch (err) {
    // Telemetry never keeps the API from starting.
    console.error("[telemetry] could not start Application Insights:", err);
  }
}
