import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// A fresh build stamp baked into the client bundle (via `define` below) and
// emitted to /version.json (via the emit-version-json plugin). The running app
// compares the two at runtime through a UNIQUE cache-busted fetch — immune to
// Cloudflare edge-caching the stable-named sw.js — so a new deploy is detected
// even when reg.update() keeps seeing an unchanged (edge-cached) worker.
const BUILD_ID = String(Date.now());

// PWA notes ----------------------------------------------------------------
//
// `registerType: 'prompt'` — we surface an "Update available" toast in
// App.jsx and call updateSW() manually. Avoids the "user hard-reloads and
// loses unsaved state without warning" trap. src/pwa.js auto-applies the
// update on a countdown so nobody has to know what a hard refresh is.
//
// Caching strategy:
//   • index.html / SPA navigations — NETWORK FIRST (runtimeCaching below),
//     NOT precached. This is what makes a plain refresh land on the newest
//     deploy; a precached shell is served cache-first and is exactly why
//     users used to have to clear their cache after every release.
//   • Static build assets (JS/CSS/PNG/SVG/WOFF2) — precached on install,
//     served cache-first forever (Vite hashes them, so a new build = new URL).
//   • Google Fonts CSS / files — stale-while-revalidate / cache-first so the
//     warm-font experience survives offline reloads once fetched.
//   • Supabase REST + functions + Realtime — explicitly NOT cached. We never
//     want to serve stale timesheet / project data, and a cached punch
//     response would lie about the user's IN/OUT state.
//
// Offline still works: the NetworkFirst shell falls back to the last-seen
// index.html, and every asset it references is in the precache.

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    // Emit a tiny /version.json carrying the same BUILD_ID baked into the
    // client. NOT precached (globPatterns below excludes json), so a
    // cache-busted fetch of it always reaches the network and reflects the
    // live deploy — the heartbeat in src/pwa.js polls it.
    {
      name: "emit-version-json",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ buildId: BUILD_ID }),
        });
      },
    },
    VitePWA({
      registerType: "prompt",
      injectRegister: false,          // we register manually in src/pwa.js
      includeAssets: [
        "favicon.ico",
        "favicon-16.png",
        "favicon-32.png",
        "apple-touch-icon.png",
        "icon-source.svg",
      ],
      manifest: {
        id:               "/?source=pwa",
        name:             "MSMM Beacon",
        short_name:       "Beacon",
        description:      "MSMM's project pipeline, invoice tracker, and timekeeping system.",
        lang:             "en-US",
        dir:              "ltr",
        start_url:        "/",
        scope:            "/",
        display:          "standalone",
        display_override: ["standalone", "minimal-ui"],
        orientation:      "any",
        theme_color:      "#C8823B",
        background_color: "#F7F3EC",
        categories:       ["business", "productivity"],
        icons: [
          { src: "/icon-192.png",          sizes: "192x192", type: "image/png", purpose: "any"      },
          { src: "/icon-512.png",          sizes: "512x512", type: "image/png", purpose: "any"      },
          { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          {
            name:        "Punch in / out",
            short_name:  "Timesheet",
            description: "Open the Timesheet tab to punch in or out.",
            url:         "/?tab=timesheet",
            icons:       [{ src: "/icon-192.png", sizes: "192x192" }],
          },
          {
            name:        "Quad Sheet",
            short_name:  "Quad",
            description: "Open the executive dashboard.",
            url:         "/?tab=invoice",
            icons:       [{ src: "/icon-192.png", sizes: "192x192" }],
          },
        ],
      },
      workbox: {
        // index.html is deliberately NOT precached (no `html` in globPatterns,
        // no navigateFallback). A precached shell is served cache-first, which
        // is what made a plain refresh keep showing the OLD build — the user's
        // only escape was a hard reload / "clear cache". Navigations now go
        // through the NetworkFirst route below: online you always get the live
        // index.html (and therefore the live hashed bundle), offline you get
        // the last-seen copy from the runtime cache.
        //
        // `navigateFallback: null` MUST be explicit. vite-plugin-pwa defaults it
        // to "index.html"; leaving it unset injects a NavigationRoute bound to
        // the *precache* — registered ahead of our runtimeCaching, so it would
        // win every navigation and silently re-create the cache-first shell we
        // just removed (pointing at a URL that is no longer precached).
        navigateFallback:            null,
        globPatterns:                ["**/*.{js,css,ico,png,svg,webmanifest,woff,woff2}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,   // 5 MB ceiling
        cleanupOutdatedCaches:        true,
        clientsClaim:                 true,
        // A new worker ACTIVATES as soon as it installs instead of parking in
        // `waiting`. A waiting worker is only released when every tab of the
        // app closes — a normal reload keeps the old worker in control, so
        // "just refresh" provably could not pick up a deploy. src/pwa.js still
        // owns *when* the page reloads, so nobody is yanked mid-edit.
        skipWaiting:                  true,
        runtimeCaching: [
          // App shell / SPA navigations — NETWORK FIRST. This is the rule that
          // makes an ordinary refresh enough to land on the newest build.
          // `ignoreSearch` lets the offline fallback answer `/?tab=projects`
          // from the single cached `/` document.
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler:    "NetworkFirst",
            options: {
              cacheName:             "beacon-app-shell",
              networkTimeoutSeconds: 3,
              expiration:            { maxEntries: 8 },
              matchOptions:          { ignoreSearch: true },
              cacheableResponse:     { statuses: [200] },
            },
          },
          // Google Fonts CSS — stale-while-revalidate
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com",
            handler:    "StaleWhileRevalidate",
            options: {
              cacheName: "beacon-google-fonts-css",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          // Google Fonts files — cache-first for a year (versioned URLs)
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.gstatic.com",
            handler:    "CacheFirst",
            options: {
              cacheName: "beacon-google-fonts-files",
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Supabase — explicit NETWORK-ONLY for every HTTP verb. Never
          // serve cached data; if offline, the request fails and the UI
          // shows the offline indicator.
          { urlPattern: supabaseUrl, handler: "NetworkOnly", method: "GET"    },
          { urlPattern: supabaseUrl, handler: "NetworkOnly", method: "POST"   },
          { urlPattern: supabaseUrl, handler: "NetworkOnly", method: "PATCH"  },
          { urlPattern: supabaseUrl, handler: "NetworkOnly", method: "PUT"    },
          { urlPattern: supabaseUrl, handler: "NetworkOnly", method: "DELETE" },
        ],
      },
      devOptions: {
        enabled: false,             // keep dev fast; turn on locally to test SW
        type:    "module",
      },
    }),
  ],
  server: { port: 5173, strictPort: true },
});

function supabaseUrl({ url }) {
  return url.hostname.endsWith(".supabase.co")
      || url.hostname.endsWith(".supabase.in");
}
