"use client";

import { useState } from "react";
import "./platform.css";

/** One-time display of 2FA recovery codes with copy + download. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = `Stello Kitchens recovery codes (each works once)\n\n${codes.join("\n")}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "stello-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="pf-stack">
      <p className="hint">
        Keep these somewhere safe, like a password manager. If you lose your phone, each code signs you in once. They
        won&apos;t be shown again.
      </p>
      <div className="pf-codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="pf-row">
        <button type="button" className="btn-ghost sm" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="btn-ghost sm" onClick={download}>Download .txt</button>
      </div>
    </div>
  );
}
