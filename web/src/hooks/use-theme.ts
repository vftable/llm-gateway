import { useCallback, useSyncExternalStore } from "react";

const THEME_KEY = "theme";
// Matches .theme-transition's 200ms CSS duration (index.css) + a small buffer
// so the class is never removed mid-transition — that would cancel the
// animation and snap the last few ms instead of easing out smoothly.
const TRANSITION_MS = 220;

type Theme = "dark" | "light";

function readTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  // Keep the <meta name="color-scheme"> in sync so native Chromium form controls
  // (scrollbars, <select> popups, date/number spinners, autofill) repaint to the
  // right scheme immediately on toggle — not just after a reload. The CSS
  // `color-scheme` on :root/.dark is the source of truth; this mirrors it.
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "dark" : "light");
}

function getServerSnapshot(): Theme {
  return "dark";
}

function subscribe(callback: () => void) {
  const handler = (e: StorageEvent) => {
    if (e.key !== THEME_KEY) return;
    applyTheme(readTheme());
    callback();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

let transitionTimer = 0;

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, getServerSnapshot);

  const setTheme = useCallback((t: Theme) => {
    const root = document.documentElement;
    root.classList.add("theme-transition");
    window.clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(() => {
      root.classList.remove("theme-transition");
    }, TRANSITION_MS);
    localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
  }, []);

  const toggle = useCallback(() => {
    setTheme(readTheme() === "dark" ? "light" : "dark");
  }, [setTheme]);

  return { theme, setTheme, toggle };
}
