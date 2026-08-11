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

// How long the "New version available" toast counts down before it applies
// itself. The toast used to sit there until someone clicked Refresh — most
// people never did, so they stayed on a stale build and were told to "clear
// your cache". The update now lands on its own; "Later" opts out for that
// build, and the countdown holds while the user is actually typing.
const AUTO_APPLY_MS = 45_000;

// sessionStorage flag shared with App.jsx's export-path handler, so the two
// stale-chunk recovery routes can only ever produce ONE automatic reload.
const CHUNK_RELOAD_KEY = "beacon.chunkReloaded";

// ----------------------------------------------------------------------
// Minimal subscribable store
// ----------------------------------------------------------------------
const state = {
  // Install prompt — present when the browser is ready to install
  installEvent:   null,
  canInstall:     false,
  installed:      isStandalone(),
  // Update flow. `updateIn` is the seconds left on the auto-apply countdown
  // (null when no update is pending or the user chose "Later").
  needRefresh:    false,
  updateIn:       null,
  offlineReady:   false,
  // Network
  online:         typeof navigator === "undefined" ? true : navigator.onLine,
};

const listeners = new Set();

// Subscribers get a fresh SNAPSHOT, never `state` itself. This is load-bearing:
// usePwa() feeds what it receives straight into a useState setter, and React
// bails out of the re-render when the next value is Object.is-equal to the
// current one. Handing out the same mutable object every time therefore made
// every notification a no-op — the update toast, the install chip and the
// offline pill could only ever appear if their flag was already true at mount,
// which is never true for an update that lands seconds into the session. That
// is why "New version available" was effectively invisible and clearing the
// cache by hand looked like the only way to get a new build.
const snapshot = () => ({ ...state });
function emit() {
  const snap = snapshot();
  for (const l of listeners) l(snap);
}
function subscribe(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}
function getState() { return snapshot(); }

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

// Auto-apply bookkeeping.
//   _remoteBuildId — newest buildId /version.json has reported this session.
//   _snoozedBuildId — the build the user pressed "Later" on; suppressed until
//                     a *different* build ships, so we nag once per release.
//   _countdown      — the 1 Hz interval driving state.updateIn.
let _remoteBuildId  = null;
let _snoozedBuildId = null;
let _countdown      = null;

// Don't reload out from under someone mid-sentence. The countdown parks at 0
// while focus is in a text control and fires the moment they click away — the
// tables save optimistically, but a half-typed cell has nothing behind it yet.
function userIsTyping() {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

// Single entry point for "a newer build exists" — reached from the service
// worker's onNeedRefresh AND from the /version.json heartbeat. Hidden tab →
// apply immediately (the reload happens off-screen). Visible tab → raise the
// toast and start the countdown.
function raiseUpdate() {
  const build = _remoteBuildId;
  if (build && build === _snoozedBuildId) return;   // user chose "Later" for this release
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    applyUpdate();
    return;
  }
  if (_countdown) return;                            // already counting down
  state.needRefresh = true;
  state.updateIn    = Math.round(AUTO_APPLY_MS / 1000);
  emit();
  _countdown = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      applyUpdate();
      return;
    }
    if (state.updateIn > 0) { state.updateIn -= 1; emit(); return; }
    if (userIsTyping()) return;                      // hold at 0 until they stop
    applyUpdate();
  }, 1000);
}

function stopCountdown() {
  if (_countdown) { clearInterval(_countdown); _countdown = null; }
}

// A dynamic import() that 404s means this tab is running a build whose chunks
// the server has already replaced — Vite fires `vite:preloadError` for it.
// That is a stale-build signal, not an app failure: reload once (guarded, so a
// genuinely broken chunk can't put us in a reload loop) and the NetworkFirst
// shell hands back the current build.
function reloadForStaleChunk() {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1") return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
  } catch { /* storage disabled — the once-per-page guard below still holds */ }
  window.location.reload();
}

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
    if (!buildId) return;
    _remoteBuildId = buildId;
    if (BUILD_ID && buildId !== BUILD_ID) {
      if (reg) reg.update().catch(() => {});
      raiseUpdate();
    }
  } catch { /* offline / parse error — ignore, the next tick retries */ }
}

export function initPwa() {
  if (typeof window === "undefined") return;

  // 1. Service worker — vite-plugin-pwa virtual entrypoint.
  try {
    _updateSW = registerSW({
      immediate: true,
      // A new worker installed. With `skipWaiting: true` it has already taken
      // control, so the precache is the new build and this tab is the only
      // stale thing left — raiseUpdate() reloads it silently when backgrounded
      // and on a visible countdown otherwise.
      onNeedRefresh() { raiseUpdate(); },
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

  // 1b. Stale-chunk self-heal. Vite fires `vite:preloadError` when a lazily
  //     imported chunk fails to load — which, in production, almost always
  //     means this tab is running a build whose chunks the deploy replaced.
  //     Recover automatically instead of leaving a dead button (or a blank
  //     screen) that the user can only fix with a hard refresh.
  window.addEventListener("vite:preloadError", (e) => {
    e.preventDefault?.();          // stop Vite's default "throw" behaviour
    reloadForStaleChunk();
  });

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

// Load the newest build, escalating only as far as it has to. Three tiers,
// because the cheap path is right almost every time and the expensive one
// throws away the offline precache:
//
//   1st attempt — a worker is WAITING → activate it, then reload. With
//     `skipWaiting: true` that is rare; usually there is nothing waiting and
//     the plain reload is enough, because the navigation is NetworkFirst and
//     the active worker's precache is already the new build.
//   2nd attempt — we reloaded for this exact build and came back *still* on
//     the old one. Something upstream is serving a stale shell (an edge-cached
//     sw.js is the classic cause). Unregister the worker and wipe every cache
//     so the reload has to go to the network. This is the "clear your cache"
//     step, performed for the user instead of explained to them.
//   4th+ — stop reloading. A deploy that never converges would otherwise put
//     the tab in a reload loop, which is far worse than a stale build; the
//     toast stays up and the Refresh button still works by hand.
const UPDATE_ATTEMPT_KEY = "beacon.updateAttempt";
const MAX_AUTO_ATTEMPTS  = 3;

function readAttempt() {
  try { return JSON.parse(sessionStorage.getItem(UPDATE_ATTEMPT_KEY) || "null"); }
  catch { return null; }
}
function writeAttempt(v) {
  try { sessionStorage.setItem(UPDATE_ATTEMPT_KEY, JSON.stringify(v)); } catch { /* storage off */ }
}

export async function applyUpdate() {
  stopCountdown();
  state.needRefresh = false;
  state.updateIn    = null;
  emit();

  const target = _remoteBuildId || "sw";
  const prev   = readAttempt();
  const tries  = (prev && prev.build === target ? prev.tries : 0) + 1;
  writeAttempt({ build: target, tries });

  if (tries > MAX_AUTO_ATTEMPTS) {
    // Reloading demonstrably isn't converging — surface it rather than loop.
    state.needRefresh = true;
    emit();
    return;
  }

  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (tries >= 2) {
        // Escalate: nothing short of a network-fresh shell has worked.
        await Promise.all(regs.map(r => r.unregister().catch(() => {})));
        if (typeof caches !== "undefined" && caches.keys) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
        }
      } else if (regs.some(r => r.waiting) && typeof _updateSW === "function") {
        _updateSW(true);                                    // reloads on controllerchange
        setTimeout(() => window.location.reload(), 1500);   // backstop if it doesn't
        return;
      }
    }
  } catch { /* fall through to a plain reload */ }
  window.location.reload();
}

// User chose "Later". Cancel the countdown and stay quiet about THIS release —
// the next deploy raises the toast again. The new worker is already active, so
// their next ordinary reload picks the build up regardless.
export function dismissUpdate() {
  stopCountdown();
  _snoozedBuildId  = _remoteBuildId;
  state.needRefresh = false;
  state.updateIn    = null;
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
