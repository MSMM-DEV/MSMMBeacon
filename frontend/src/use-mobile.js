// useIsMobile — viewport-width media query as a React hook.
//
// Used by Timesheet + Time Admin components to swap between desktop (absolute
// hour rail) and mobile (list view) without a flicker. Reads the current
// match on first render so SSR / hydration boundaries don't briefly show
// the wrong layout, and subscribes to `change` so rotation works live.

import { useEffect, useState } from "react";

export function useIsMobile(breakpoint = 640) {
  const query = `(max-width: ${breakpoint}px)`;
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);            // Safari < 14
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

// Convenience for non-hook contexts (e.g. useState init in App.jsx).
export function isMobileNow(breakpoint = 640) {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(max-width: ${breakpoint}px)`).matches;
}
