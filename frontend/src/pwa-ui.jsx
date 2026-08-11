// pwa-ui.jsx — visual pieces that consume the pwa.js store.
//
//   <PwaInstallChip/>   topbar button: "Install Beacon" → native install prompt
//   <PwaOfflineChip/>   topbar pill:   "Offline" when navigator.onLine===false
//   <PwaUpdateToast/>   floating toast at bottom: "Update available · Refresh"
//   <PwaOfflineBanner/> optional inline banner — currently unused, kept for
//                       feature parity with existing toast patterns.
//
// All three are entirely self-contained — they subscribe to the pwa store
// via usePwa() and render nothing when their state is inert. App.jsx mounts
// <PwaInstallChip/> + <PwaOfflineChip/> in the topbar and <PwaUpdateToast/>
// at the root.

import React, { useState } from "react";
import { Icon } from "./icons";
import { usePwa, promptInstall, applyUpdate, dismissUpdate } from "./pwa";

// Browser-specific "how to install" steps for when no native prompt is
// available (iOS Safari never fires beforeinstallprompt; Chrome/Edge suppress
// it once the app is already installed or before the engagement heuristic
// trips). Lets the button always give the user a working path.
function installSteps() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const isIOS = /iphone|ipad|ipod/i.test(ua) ||
    (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
  const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  if (isIOS || isSafari) {
    return {
      title: "Install on Safari / iOS",
      steps: ["Tap the Share button", "Choose “Add to Home Screen”", "Tap “Add”"],
    };
  }
  return {
    title: "Install Beacon",
    steps: [
      "Click the install icon in the address bar",
      "… or open the browser ⋮ menu → “Install Beacon”",
      "Confirm to add it as an app",
    ],
  };
}

// ---------------------------------------------------------------------
// Install chip — shown whenever Beacon is NOT already running as the
// installed standalone app. If the browser offered a native install prompt
// (beforeinstallprompt captured), clicking fires it; otherwise clicking opens
// a short instructions popover so there's always a path to install (iOS
// Safari, already-installed-elsewhere, or the heuristic hasn't tripped yet).
// ---------------------------------------------------------------------
export function PwaInstallChip() {
  const { canInstall, installed } = usePwa();
  const [showHelp, setShowHelp] = useState(false);
  // Running as the installed standalone app → nothing to install.
  if (installed) return null;

  const onClick = async () => {
    if (canInstall) {
      const res = await promptInstall();
      if (res?.outcome === "unavailable") setShowHelp(true);
      return;
    }
    setShowHelp(v => !v);
  };

  const help = installSteps();
  return (
    <div className="pwa-install-wrap">
      <button
        type="button"
        className="pwa-install-chip"
        onClick={onClick}
        aria-expanded={showHelp}
        title="Install Beacon as an app"
      >
        <Icon name="plus" size={12}/>
        <span className="pwa-install-chip-label">Install</span>
      </button>
      {showHelp && (
        <>
          <div className="pwa-install-help-scrim" onClick={() => setShowHelp(false)}/>
          <div className="pwa-install-help" role="dialog" aria-label="How to install Beacon">
            <div className="pwa-install-help-head">
              <Icon name="plus" size={13}/>
              <span>{help.title}</span>
              <button
                type="button"
                className="pwa-install-help-x"
                onClick={() => setShowHelp(false)}
                aria-label="Close"
              >
                <Icon name="x" size={12}/>
              </button>
            </div>
            <ol className="pwa-install-help-steps">
              {help.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            <div className="pwa-install-help-note">
              Already installed? Open Beacon from your apps / home screen.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Offline pill — shows when the browser thinks we're offline.
// ---------------------------------------------------------------------
export function PwaOfflineChip() {
  const { online } = usePwa();
  if (online) return null;
  return (
    <span className="pwa-offline-chip" role="status" aria-live="polite">
      <span className="pwa-offline-dot"/>
      <span>Offline</span>
    </span>
  );
}

// ---------------------------------------------------------------------
// Update toast — bottom-right corner, "New version available · Refresh".
// "Later" dismisses (the SW keeps waiting; next reload picks it up).
// ---------------------------------------------------------------------
export function PwaUpdateToast() {
  const { needRefresh, updateIn } = usePwa();
  if (!needRefresh) return null;

  // `updateIn` is null once the countdown has run out (or been exhausted after
  // repeated failed attempts) — say so plainly rather than showing "in 0s".
  const counting = typeof updateIn === "number" && updateIn > 0;
  const sub = counting
    ? `Updating automatically in ${updateIn}s — no need to clear anything.`
    : "Updating now…";

  return (
    <div className="pwa-toast" role="alertdialog" aria-labelledby="pwa-toast-title">
      <div className="pwa-toast-body">
        <div className="pwa-toast-icon" aria-hidden="true">
          <Icon name="sparkles" size={14}/>
        </div>
        <div className="pwa-toast-text">
          <div id="pwa-toast-title" className="pwa-toast-title">New version available</div>
          {/* Polite, not assertive: the countdown re-renders every second and
              an assertive region would make a screen reader interrupt on each
              tick. The buttons carry the actual choice. */}
          <div className="pwa-toast-sub" aria-live="polite">{sub}</div>
        </div>
      </div>
      <div className="pwa-toast-actions">
        <button type="button" className="pwa-toast-btn pwa-toast-btn-ghost" onClick={dismissUpdate}>
          Later
        </button>
        <button type="button" className="pwa-toast-btn pwa-toast-btn-primary" onClick={applyUpdate}>
          Update now
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Banner version of offline — useful if the topbar chip is invisible
// because the user has scrolled. Mounts inline above the page. (Unused
// by default; export kept for App.jsx to opt in if desired.)
// ---------------------------------------------------------------------
export function PwaOfflineBanner() {
  const { online } = usePwa();
  if (online) return null;
  return (
    <div className="pwa-offline-banner" role="status">
      <Icon name="ban" size={12}/>
      You're offline. Existing data is visible but saves will fail until you reconnect.
    </div>
  );
}
