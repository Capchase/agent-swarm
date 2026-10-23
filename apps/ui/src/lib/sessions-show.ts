// Sessions v2 "Mine / All" view. Mine (the default) lists the sessions the
// picked user started from a human channel, plus the ones shared with them.
// All adds the workflow, schedule, and system runs attributed to them. The
// server applies it (`show` on `GET /api/sessions?scope=tree` and
// `GET /api/session-tree`), so totals and pages stay right. It never changes
// who can open a session: a direct link to a hidden session still works.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { useSyncExternalStore } from "react";

export type SessionsShow = "mine" | "all";

const STORAGE_KEY = "swarm:v1:sessions-v2:show";

// One store for every hook instance in this tab, plus the `storage` event for
// other tabs. Query options read it outside React, so the list keys and the
// tree key always agree.
const listeners = new Set<() => void>();
let memory: SessionsShow = "mine";

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The current view: what the stored preference says, else Mine. */
export function getSessionsShow(): SessionsShow {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "all" || stored === "mine") return stored;
  } catch {
    // Storage unavailable: the in-memory value below still works.
  }
  return memory;
}

export function setSessionsShow(next: SessionsShow) {
  memory = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable: the in-memory value still flips.
  }
  for (const listener of listeners) listener();
}

/** The view, re-rendering on a change from any tab. */
export function useSessionsShow(): [SessionsShow, (next: SessionsShow) => void] {
  const show = useSyncExternalStore(subscribe, getSessionsShow, () => "mine" as const);
  return [show, setSessionsShow];
}

/** The `show` query param: sent for All only, since Mine is the server default. */
export function sessionsShowParam(show: SessionsShow): { show?: "all" } {
  return show === "all" ? { show } : {};
}
