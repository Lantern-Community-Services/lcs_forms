import { useSearchParams } from "react-router-dom";

/**
 * One query-string value as state — a screen's tab, a category filter — so a
 * link or a refresh opens the same view. Setting it replaces the history entry
 * rather than adding one, so flipping between tabs doesn't fill up Back; `null`
 * removes it. Every other parameter (the site selection) is left alone.
 */
export function useSearchParam(key: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams();
  function set(value: string | null) {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }
  return [params.get(key), set];
}
