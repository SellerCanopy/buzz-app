import { useEffect, useMemo, useRef, useState } from "react";
import type { Navigation } from "../../navigation/controller";
import type { OpenTarget } from "../../navigation/targets";
import type { PageProps } from "../../pages/service";
import { PAGE_ID, PLUGIN_ID } from "../routes";

type Entry = { id: string; target: OpenTarget };
// A counter, not `crypto.randomUUID`, which a page served over plain http does not have.
let entries = 0;
const entry = (target: OpenTarget): Entry => ({
  id: `visit-${++entries}`,
  target,
});

const BOARD: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: PLUGIN_ID,
  pageId: PAGE_ID,
};

/**
 * The page's own visits, in place of the host's navigation controller: enough for a card to
 * open, and for Close to return to the board. The host does not exist on the standalone page.
 */
export function useHistory() {
  const [history, setHistory] = useState(() => ({
    entries: [entry(BOARD)],
    index: 0,
  }));
  const current = history.entries[history.index] as Entry;
  // A visit's signal ends when the page moves off it. Render must not abort anything, so the
  // controller is made here and aborted in the cleanup of the effect that follows the entry.
  const visit = useRef<{ id: string; abort: AbortController } | undefined>(
    undefined,
  );
  if (visit.current?.id !== current.id)
    visit.current = { id: current.id, abort: new AbortController() };
  const abort = visit.current.abort;
  const ending = useRef<{ abort: AbortController; timer: number } | undefined>(
    undefined,
  );
  useEffect(() => {
    // Strict Mode unmounts and remounts a new visit at once. Ending is a step later, so the
    // remount of the same visit keeps it, while a move to another visit still ends this one.
    if (ending.current?.abort === abort) clearTimeout(ending.current.timer);
    return () => {
      ending.current = {
        abort,
        timer: window.setTimeout(() => abort.abort(), 0),
      };
    };
  }, [abort]);
  const navigator = useMemo(
    () =>
      ({
        open: async (target: OpenTarget) => {
          setHistory((h) => ({
            entries: [...h.entries.slice(0, h.index + 1), entry(target)],
            index: h.index + 1,
          }));
          return { status: "opened" };
        },
        back: () =>
          setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) })),
        forward: () =>
          setHistory((h) => ({
            ...h,
            index: Math.min(h.entries.length - 1, h.index + 1),
          })),
        dismiss: (
          retire: (target: OpenTarget) => boolean,
          fallback: OpenTarget,
        ) =>
          setHistory((h) => {
            const shown = h.entries[h.index] as Entry;
            const kept = h.entries.filter((e) => !retire(e.target));
            if (!kept.length) return { entries: [entry(fallback)], index: 0 };
            const at = kept.indexOf(shown);
            if (at >= 0) return { entries: kept, index: at };
            const before = h.entries
              .slice(0, h.index)
              .filter((e) => kept.includes(e));
            return { entries: kept, index: Math.max(0, before.length - 1) };
          }),
      }) as unknown as Navigation,
    [],
  );
  const navigation = {
    entryId: current.id,
    target: current.target,
    signal: abort.signal,
  } as unknown as PageProps["navigation"];
  return { navigator, navigation };
}
