/**
 * Runs once as the Next server starts, before it handles a request (Next's
 * instrumentation hook). Application Insights for the web server: see
 * instrumentation.node.ts. Nothing happens without
 * APPLICATIONINSIGHTS_CONNECTION_STRING (local dev).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()) {
    await import("./instrumentation.node");
  }
}
