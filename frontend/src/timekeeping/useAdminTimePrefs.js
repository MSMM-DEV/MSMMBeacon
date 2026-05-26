// useAdminTimePrefs — React hook wrapping per-admin Time Admin preferences
// with localStorage persistence. Returns [prefs, updatePrefs, resetPrefs].
//
// updatePrefs accepts a partial — fields not in the patch are preserved.
// Every update writes synchronously to localStorage so a reload immediately
// after a change still sees the new value.

import { useCallback, useState } from "react";
import {
  DEFAULT_ADMIN_TIME_PREFS,
  loadAdminTimePrefs,
  saveAdminTimePrefs,
} from "../data";

export function useAdminTimePrefs(adminUserId) {
  const [prefs, setPrefs] = useState(() => loadAdminTimePrefs(adminUserId));

  const updatePrefs = useCallback((patch) => {
    setPrefs(prev => {
      const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
      saveAdminTimePrefs(adminUserId, next);
      return next;
    });
  }, [adminUserId]);

  const resetPrefs = useCallback(() => {
    const fresh = { ...DEFAULT_ADMIN_TIME_PREFS };
    saveAdminTimePrefs(adminUserId, fresh);
    setPrefs(fresh);
  }, [adminUserId]);

  return [prefs, updatePrefs, resetPrefs];
}
