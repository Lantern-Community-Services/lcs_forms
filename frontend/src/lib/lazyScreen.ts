import { lazy, type ComponentType } from "react";

const RELOADED = "lcs-chunk-reload";

/**
 * A screen downloaded the first time it's opened (React.lazy), by its export
 * name. Render it under a <Suspense>.
 *
 * After a deploy, a page opened before it asks for the old build's file,
 * which is gone: the page reloads itself once to pick up the new build, and
 * only if that doesn't help does the error reach the screen's error boundary.
 */
export function lazyScreen<M extends Record<string, unknown>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => {
    try {
      const mod = await load();
      try {
        sessionStorage.removeItem(RELOADED);
      } catch {
        /* storage blocked: nothing to clear */
      }
      return { default: mod[name] as ComponentType };
    } catch (err) {
      let reloaded = true;
      try {
        reloaded = sessionStorage.getItem(RELOADED) === "1";
        if (!reloaded) sessionStorage.setItem(RELOADED, "1");
      } catch {
        /* storage blocked: don't risk a reload loop */
      }
      if (!reloaded) {
        window.location.reload();
        return new Promise<never>(() => {});
      }
      throw err;
    }
  });
}
