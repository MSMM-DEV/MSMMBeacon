// pwa.js — service-worker registration + a tiny store for the PWA UI bits.
//
// The store is a hand-rolled subscribable so we don't pull a state library
// just for three booleans. App.jsx subscribes via `usePwa()` and renders:
//   • Install button   — when the browser fired `beforeinstallprompt`
//   • Update toast     — when a new SW is waiting to take over
//   • Offline pill     — when `navigator.onLine` flips to false
//
// vite-plugin-pwa generates the virtual module 'virtual:pwa-register' that
// exports `registerSW({ onNeedRefresh, onOfflineReady })`. We call into it
// once at boot.

import { registerSW } from "virtual:pwa-register";

// How often (ms) an *open* app re-asks the server whether a newer service
// worker has shipped. A registered SW is otherwise only re-checked by the
// browser on a hard navigation (which a standalone installed PWA basically
// never does) or its own ~24h background timer — that's why a freshly deployed
// build used to take *hours* to surface the "New version available" toast.
// Combined with the focus / visibility / online checks in initPwa(), this caps
// the wait at ~1 min while you're staring at the app, and makes it ~instant
// the moment you switch back to a backgrounded window.
const SW_UPDATE_POLL_MS = 60_000;

// Build stamp baked into this bundle at compile time (see vite.config.js
// `define` + the emit-version-json plugin). The heartbeat below fetches
// /version.json with a unique cache-busted URL and compares its buildId to
// this — a mismatch means a newer build has shipped. This path is immune to
// Cloudflare edge-caching the stable-named sw.js, so it detects deploys even
// when reg.update() keeps re-fetching an unchanged (edge-cached) worker.
const BUILD_ID = (typeof __BUILD_ID__ !== "undefined") ? __BUILD_ID__ : null;

// ----------------------------------------------------------------------
// Minimal subscribable store
// ----------------------------------------------------------------------
const state = {
  // Install prompt — present when the browser is ready to install
  installEvent:   null,
  canInstall:     false,
  installed:      isStandalone(),
  // Update flow
  needRefresh:    false,
  offlineReady:   false,
  // Network
  online:         typeof navigator === "undefined" ? true : navigator.onLine,
};

const listeners = new Set();
function emit() { for (const l of listeners) l(state); }
function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}
function getState() { return state; }

// Detect "running as installed app" so the install button can hide itself.
function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches ||
    window.navigator.standalone === true   // iOS
  );
}

// ----------------------------------------------------------------------
// Wire the lifecycle on first import (main.jsx imports this module)
// ----------------------------------------------------------------------
let _updateSW = null;
let _versionHeartbeat = null;

// Build-version heartbeat. Fetch /version.json through a UNIQUE cache-busted
// URL (so no HTTP/edge cache can mask it) and, if its buildId differs from the
// one compiled into this bundle, treat it exactly like an SW update: nudge the
// worker to update, raise the toast, and — if the app is backgrounded — apply
// silently. `reg` may be null (the SW never became ready) — the version check
// still works without it.
async function checkVersion(reg) {
  try {
    const res = await fetch("/version.json?_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const { buildId } = await res.json();
    if (BUILD_ID && buildId && buildId !== BUILD_ID) {
      if (reg) reg.update().catch(() => {});
      state.needRefresh = true;
      emit();
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        applyUpdate();
      }
    }
  } catch { /* offline / parse error — ignore, the next tick retries */ }
}

export function initPwa() {
  if (typeof window === "undefined") return;

  // 1. Service worker — vite-plugin-pwa virtual entrypoint.
  try {
    _updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        state.needRefresh = true;
        emit();
        // If the update lands while the app is backgrounded, apply it silently
        // now: the reload happens off-screen and the user returns to the fresh
        // build + fresh data (loadBeacon re-runs on reload) with zero clicks.
        // While the app is VISIBLE we leave the toast up instead, so an active
        // editor isn't yanked mid-task — they click Refresh when ready.
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          applyUpdate();
        }
      },
      onOfflineReady() {
        state.offlineReady = true;
        emit();
      },
      onRegisterError(err) {
        // SW unsupported in dev; don't spam the console.
        if (import.meta.env.PROD) console.warn("[pwa] SW register failed:", err);
      },
    });
  } catch (e) {
    // virtual module unavailable (e.g. SSR or older browser) — silently skip.
    if (import.meta.env.PROD) console.warn("[pwa] registerSW unavailable:", e);
  }

  // 2. beforeinstallprompt — Chrome/Edge/Android-WebView. iOS Safari does
  //    NOT fire this; users have to use Share → Add to Home Screen.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installEvent = e;
    state.canInstall   = true;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    state.installEvent = null;
    state.canInstall   = false;
    state.installed    = true;
    emit();
  });

  // 3. Network status. Two listeners + a short revalidation tick so transient
  //    flaps are caught (some browsers don't fire `online` when a captive
  //    portal returns).
  const onOnline  = () => { state.online = true;  emit(); };
  const onOffline = () => { state.online = false; emit(); };
  window.addEventListener("online",  onOnline);
  window.addEventListener("offline", onOffline);

  // 4. Active update detection. Without this the browser only re-checks sw.js
  //    on a hard navigation or its own ~24h timer, so an installed desktop PWA
  //    that just stays open can lag a deploy by hours. Force the check:
  //    poll on an interval AND whenever the user comes back to the app (window
  //    focus / tab becomes visible) or the network returns. Each reg.update()
  //    re-fetches sw.js (Vercel serves it must-revalidate); a byte change
  //    installs the new worker and fires onNeedRefresh above.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((reg) => {
      if (!reg) return;
      const check = () => {
        if (reg.installing) return;              // an update is already landing
        if (navigator.onLine === false) return;  // offline → update() just errors
        reg.update().catch(() => { /* transient; the next tick retries */ });
      };
      check(); checkVersion(reg);                // catch a build shipped before this launch
      setInterval(() => { check(); checkVersion(reg); }, SW_UPDATE_POLL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") { check(); checkVersion(reg); }
      });
      window.addEventListener("focus",  () => { check(); checkVersion(reg); });
      window.addEventListener("online", () => { check(); checkVersion(reg); });
    }).catch(() => { /* SW never became ready (unsupported / blocked) */ });
  }

  // 5. Build-version heartbeat, independent of the service worker. If the SW
  //    never reaches `ready` (unsupported / blocked / stuck), the reg-based
  //    checks above never run — but a new deploy must still be detectable. Poll
  //    /version.json directly, exactly once (guarded so a repeat initPwa() call
  //    can't stack intervals).
  checkVersion(null);
  if (!_versionHeartbeat) {
    _versionHeartbeat = setInterval(() => checkVersion(null), SW_UPDATE_POLL_MS);
  }
}

// ----------------------------------------------------------------------
// Actions invoked by the UI
// ----------------------------------------------------------------------

// Show the native install prompt. Returns the user's choice.
export async function promptInstall() {
  const evt = state.installEvent;
  if (!evt || typeof evt.prompt !== "function") return { outcome: "unavailable" };
  state.canInstall   = false;
  state.installEvent = null;
  emit();
  evt.prompt();
  const choice = await evt.userChoice;
  if (choice?.outcome === "accepted") {
    state.installed = true;
    emit();
  }
  return choice;
}

// User accepted the "new version available" prompt. Reliably load the newest
// build regardless of service-worker state:
//   • If a new worker is WAITING → activate it (skipWaiting); the plugin reloads
//     on controllerchange, with a hard-reload backstop in case it doesn't.
//   • If NO worker is waiting → the toast came from the version heartbeat while
//     the SW couldn't install a new one (e.g. an edge-cached sw.js). Unregister
//     the SW + clear the caches so the reload fetches a fresh shell from the
//     network instead of the stale precache. This is why the button used to look
//     dead: _updateSW(true) is a silent no-op when nothing is waiting.
export async function applyUpdate() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      const hasWaiting = regs.some(r => r.waiting);
      if (hasWaiting && typeof _updateSW === "function") {
        _updateSW(true);                                    // reloads on controllerchange
        setTimeout(() => window.location.reload(), 1500);   // backstop if it doesn't
        return;
      }
      // No waiting worker → force a network-fresh load.
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
      if (typeof caches !== "undefined" && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
      }
    }
  } catch { /* fall through to a plain reload */ }
  window.location.reload();
}

// User dismissed the update — keep the SW waiting; the next reload picks it up.
export function dismissUpdate() {
  state.needRefresh = false;
  emit();
}

export function dismissOfflineReady() {
  state.offlineReady = false;
  emit();
}

// ----------------------------------------------------------------------
// React hook
// ----------------------------------------------------------------------
import { useEffect, useState } from "react";
export function usePwa() {
  const [snap, setSnap] = useState(getState());
  useEffect(() => subscribe(setSnap), []);
  return snap;
}
