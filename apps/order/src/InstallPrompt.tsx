import { useState, useSyncExternalStore } from "react";
import { getInstallState, promptInstall, subscribeInstall } from "./pwa";

const DISMISS_KEY = "stello.order.installDismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

// Quiet "Install app" card for the kiosk and the token board — screens that
// live on one device and are worth running full-screen. Hidden once installed
// or dismissed; on iOS Safari it explains the manual Share-sheet route.
export function InstallPrompt({ placement = "board" }: { placement?: "board" | "kiosk" }) {
  const { canPrompt, standalone, iosManual } = useSyncExternalStore(subscribeInstall, getInstallState);
  const [dismissed, setDismissed] = useState(readDismissed);

  if (standalone || dismissed || (!canPrompt && !iosManual)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode — dismissal lasts for this session only */
    }
  };

  return (
    <div className={`install-prompt install-${placement}`} role="region" aria-label="Install app">
      <img className="install-icon" src="/icons/icon-192.png" alt="" width={36} height={36} />
      {canPrompt ? (
        <>
          <span className="install-text">Run this screen full-screen as an app.</span>
          <button className="install-go" onClick={() => promptInstall().catch(() => {})}>
            Install app
          </button>
        </>
      ) : (
        <span className="install-text">
          To install, tap <b>Share</b> → <b>Add to Home Screen</b>.
        </span>
      )}
      <button className="install-x" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
