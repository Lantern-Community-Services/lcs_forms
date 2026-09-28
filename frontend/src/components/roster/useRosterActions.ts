import { useQueryClient } from "@tanstack/react-query";
import { rosterApi } from "@/lib/queries";
import { useToast } from "@/components/ui/toast";
import type { Tenant } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

/**
 * Remove / keep / restore with the toasts that go with them, shared by the
 * review queue, the roster and a resident's page so all three behave the same.
 * Every removal toast carries Undo.
 */
export function useRosterActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ["roster"] });

  async function restore(t: Tenant, quiet = false) {
    try {
      await rosterApi.restore(t.id);
      if (!quiet) toast(`${t.displayName} is back on the roster.`);
    } catch (e) {
      toast(errorMessage(e, "Could not restore."), "error");
    } finally {
      await refresh();
    }
  }

  /** `onUndo` replaces the toast's default Undo (a plain restore) — the Review screen uses its own. */
  async function remove(t: Tenant, reason: string, note?: string, opts: { onUndo?: () => void } = {}): Promise<boolean> {
    try {
      await rosterApi.archive(t.id, { reason, note: note || undefined });
      toast(`Removed ${t.displayName}.`, "success", {
        action: { label: "Undo", onClick: opts.onUndo ?? (() => void restore(t, false)) },
      });
      return true;
    } catch (e) {
      toast(errorMessage(e, "Could not remove."), "error");
      return false;
    } finally {
      await refresh();
    }
  }

  async function keep(t: Tenant, opts: { onUndo?: () => void } = {}): Promise<boolean> {
    try {
      await rosterApi.keep(t.id);
      toast(`Kept ${t.displayName}.`, "info", opts.onUndo ? { action: { label: "Undo", onClick: opts.onUndo }, duration: 5000 } : {});
      return true;
    } catch (e) {
      toast(errorMessage(e, "Could not update."), "error");
      return false;
    } finally {
      await refresh();
    }
  }

  return { remove, keep, restore };
}
