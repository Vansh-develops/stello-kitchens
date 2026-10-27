// PWA plumbing: service-worker registration, the deferred install prompt and
// "relaunch where you left off" for installed kiosks / token boards.
// Imported once from main.tsx so `beforeinstallprompt` is captured even if it
// fires before the kiosk menu or board has mounted.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState = {
  /** Chromium install prompt is available. */
  canPrompt: boolean;
  /** Running as an installed app (no install UI needed). */
  standalone: boolean;
  /** iOS Safari, where install is manual via the Share sheet. */
  iosManual: boolean;
};

const LAST_ROUTE_KEY = "stello.order.lastRoute";

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = computeState();
const listeners = new Set<() => void>();

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // In-app browsers and Chrome/Firefox on iOS can't add to home screen the same way.
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram/.test(ua);
}

function computeState(): InstallState {
  const standalone = isStandalone();
  return { canPrompt: !standalone && deferred !== null, standalone, iosManual: !standalone && isIosSafari() };
}

function emit() {
  state = computeState();
  listeners.forEach((l) => l());
}

export function subscribeInstall(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getInstallState(): InstallState {
  return state;
}

/** Shows the native install dialog. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null; // a prompt event can only be used once
  await e.prompt();
  const { outcome } = await e.userChoice;
  emit();
  return outcome === "accepted";
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // we show our own, quieter button
  deferred = e as BeforeInstallPromptEvent;
  emit();
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  emit();
});
window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", emit);

// An installed app always launches at start_url ("/"). Kiosks and token boards
// are installed from their deep link, so remember it and resume there.
// Runs before the first render, so App sees the restored path.
(function resumeLastRoute() {
  try {
    const path = window.location.pathname;
    if (/^\/(kiosk|board)\/[^/]+\/?$/.test(path)) {
      localStorage.setItem(LAST_ROUTE_KEY, path);
    } else if (path === "/" && isStandalone()) {
      const last = localStorage.getItem(LAST_ROUTE_KEY);
      if (last && /^\/(kiosk|board)\/[^/]+\/?$/.test(last)) window.history.replaceState(null, "", last);
    }
  } catch {
    /* storage blocked — just open the landing page */
  }
})();

/** Registers /sw.js. Call only in production builds. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;

  // A new worker took over after a deploy. The token board holds no user
  // state, so reload it to pick up the new build; diner/kiosk screens keep
  // running (their bundle is already loaded) and update on next navigation.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && window.location.pathname.startsWith("/board/")) window.location.reload();
  });

  const register = () =>
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        // Long-running screens (kiosk, TV board) never navigate — check hourly.
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      })
      .catch(() => {
        /* offline support is best-effort */
      });
  // Register after load so precaching doesn't compete with the first paint.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
