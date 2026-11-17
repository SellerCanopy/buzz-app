import { useMemo, useRef, useState } from "react";
import type { Navigation } from "../../navigation/controller";
import type { OpenTarget } from "../../navigation/targets";
import type { PageProps } from "../../pages/service";
import { PAGE_ID, PLUGIN_ID } from "../routes";

type Entry = { id: string; target: OpenTarget };
const entry = (target: OpenTarget): Entry => ({
  id: crypto.randomUUID(),
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
  const [history, setHistory] = useState({
    entries: [entry(BOARD)],
    index: 0,
  });
  const current = history.entries[history.index] as Entry;
  // A visit's signal aborts when the page moves off it.
  const visit = useRef<{ id: string; abort: AbortController } | undefined>(
    undefined,
  );
  if (visit.current?.id !== current.id) {
    visit.current?.abort.abort();
    visit.current = { id: current.id, abort: new AbortController() };
  }
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
    signal: (visit.current as { abort: AbortController }).abort.signal,
  } as unknown as PageProps["navigation"];
  return { navigator, navigation };
}
