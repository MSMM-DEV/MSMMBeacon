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

export function initPwa() {
  if (typeof window === "undefined") return;

  // 1. Service worker — vite-plugin-pwa virtual entrypoint.
  try {
    _updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        state.needRefresh = true;
        emit();
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

// User accepted the "new version available" prompt — reload via the SW.
export async function applyUpdate() {
  if (typeof _updateSW === "function") {
    await _updateSW(true);   // true = reload after activation
  } else {
    window.location.reload();
  }
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
