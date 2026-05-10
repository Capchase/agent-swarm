/**
 * Phase 3: Current-user identity context.
 *
 * Tracks "who is using this UI tab right now" by `userId`, persisted in
 * `localStorage` and namespaced per-deployment (mirrors `useDismissibleCard`).
 *
 * State machine:
 *   - "pending"     while `useUsers()` is still loading (don't auto-pop modal)
 *   - "needs-pick"  no userId stored OR stored userId doesn't match any row
 *                   in `useUsers()` (defensive: covers a deleted/renamed user)
 *   - "ready"       userId resolved + matches a row from `useUsers()`
 *
 * Multi-tab semantics: the provider attaches a `storage` event listener so
 * `setUserId`/`clearUser` calls in another tab propagate without a reload.
 *
 * Per-deployment: storage key is `swarm:v1:${apiUrl}:current-user` — pointing
 * the UI at a different swarm via `?apiUrl=…` recomputes the key and may
 * re-enter `needs-pick`.
 *
 * Storage failures (privacy mode, etc.) degrade to in-memory state.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useUsers } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { useConfig } from "@/hooks/use-config";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";

const CARD_KEY = "current-user";

export type CurrentUserState = "pending" | "needs-pick" | "ready";

export interface CurrentUserContextValue {
  state: CurrentUserState;
  userId: string | null;
  user: User | null;
  setUserId: (id: string) => void;
  clearUser: () => void;
}

const CurrentUserContext = createContext<CurrentUserContextValue | null>(null);

function readStoredUserId(storageKey: string): string | null {
  try {
    const v = localStorage.getItem(storageKey);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig();
  const storageKey = useMemo(() => deriveStorageKey(config.apiUrl, CARD_KEY), [config.apiUrl]);

  const usersQuery = useUsers();
  const [storedUserId, setStoredUserId] = useState<string | null>(() =>
    readStoredUserId(storageKey),
  );

  // Re-sync when storageKey changes (apiUrl switch). Mirrors
  // use-dismissible-card.ts:50-52.
  useEffect(() => {
    setStoredUserId(readStoredUserId(storageKey));
  }, [storageKey]);

  // Cross-tab sync via the `storage` event. Mirrors
  // use-dismissible-card.ts:75-83.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== storageKey) return;
      // newValue === null means another tab cleared the key.
      setStoredUserId(e.newValue && e.newValue.length > 0 ? e.newValue : null);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey]);

  const setUserId = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(storageKey, id);
      } catch {
        // Storage unavailable — in-memory update below still drives the UI
        // for this session.
      }
      setStoredUserId(id);
    },
    [storageKey],
  );

  const clearUser = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // See setUserId comment.
    }
    setStoredUserId(null);
  }, [storageKey]);

  // Derive state + matched user from (storedUserId, users list).
  const { state, user } = useMemo<{ state: CurrentUserState; user: User | null }>(() => {
    if (usersQuery.isLoading) return { state: "pending", user: null };
    const users = usersQuery.data ?? [];
    if (!storedUserId) return { state: "needs-pick", user: null };
    const match = users.find((u) => u.id === storedUserId) ?? null;
    if (!match) return { state: "needs-pick", user: null };
    return { state: "ready", user: match };
  }, [usersQuery.isLoading, usersQuery.data, storedUserId]);

  const value: CurrentUserContextValue = {
    state,
    userId: state === "ready" ? storedUserId : null,
    user,
    setUserId,
    clearUser,
  };

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserContextValue {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error("useCurrentUser must be used within a CurrentUserProvider");
  }
  return ctx;
}
