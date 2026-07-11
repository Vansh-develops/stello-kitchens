"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { THEMES } from "@stello/shared";
import type { AuthUser, OutletDto, UpdateOutletInput } from "@stello/shared";
import { api } from "@/lib/api";

// Same scheme as ScanOrderTab.tsx: the diner PWA served on :5176 in dev, or the
// ordering site's own origin in prod.
const ORDER_BASE =
  typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:5176` : "";

const STEP_LABELS = ["Brand & theme", "Outlet & GST", "Starter menu", "Tables & QR", "Finish"] as const;

type CreatedTable = { id: string; name: string; publicToken: string };
type MenuChoice = "sample" | "blank";

export function OnboardingWizard({ user, outlet }: { user: AuthUser; outlet: OutletDto }) {
  const router = useRouter();
  const outletId = user.outletIds[0] as string | undefined;

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: brand & theme. Only a theme change is persisted (the only
  // brand-update endpoint the API exposes, `PATCH /brands/:id/theme` — see
  // AppearanceTab); the restaurant-name field is required client-side but
  // has no dedicated persistence endpoint today.
  const [brandName, setBrandName] = useState(outlet.brandName);
  const [themeId, setThemeId] = useState(outlet.themeId);
  const [step1Done, setStep1Done] = useState(false);

  // Step 2: outlet & GST.
  const [outletName, setOutletName] = useState(outlet.name);
  const [address, setAddress] = useState(outlet.address ?? "");
  const [gstin, setGstin] = useState("");
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [upiVpa, setUpiVpa] = useState("");
  const [step2Done, setStep2Done] = useState(false);

  // Step 3: starter menu.
  const [menuChoice, setMenuChoice] = useState<MenuChoice>("sample");
  const [step3Done, setStep3Done] = useState(false);
  const [templateResult, setTemplateResult] = useState<{ categoriesCreated: number; itemsCreated: number } | null>(
    null,
  );

  // Step 4: tables & QR.
  const [tableCount, setTableCount] = useState(8);
  const [step4Done, setStep4Done] = useState(false);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [tables, setTables] = useState<CreatedTable[]>([]);
  const [qr, setQr] = useState<Record<string, string>>({});

  // Render a scannable QR for every created table (same rendering options as ScanOrderTab).
  useEffect(() => {
    tables.forEach((t) => {
      const url = `${ORDER_BASE}/t/${t.publicToken}`;
      QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: "#14110f", light: "#f4ede2" } }).then((d) =>
        setQr((prev) => (prev[t.id] === d ? prev : { ...prev, [t.id]: d })),
      );
    });
  }, [tables]);

  const currentTheme = useMemo(() => THEMES.find((t) => t.id === themeId) ?? THEMES[0], [themeId]);

  if (!outletId) {
    return <div className="boot">No outlet is assigned to this account yet — contact support.</div>;
  }

  const goBack = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  // Step 1: theme (name is local-only — required, but has no backend to persist to).
  const submitStep1 = async () => {
    if (!brandName.trim()) {
      setError("Restaurant name is required.");
      return;
    }
    setError(null);
    if (step1Done) {
      setStep(1);
      return;
    }
    setBusy(true);
    try {
      await api.setBrandTheme(outlet.brandId, themeId);
      setStep1Done(true);
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the theme");
    } finally {
      setBusy(false);
    }
  };

  // Step 2: outlet name/address/GST.
  const submitStep2 = async () => {
    if (!outletName.trim() || !address.trim()) {
      setError("Outlet name and address are required.");
      return;
    }
    setError(null);
    if (step2Done) {
      setStep(2);
      return;
    }
    setBusy(true);
    try {
      const input: UpdateOutletInput = { name: outletName.trim(), address: address.trim() };
      if (gstin.trim()) input.gstin = gstin.trim();
      if (placeOfSupply.trim()) input.placeOfSupply = placeOfSupply.trim();
      if (upiVpa.trim()) input.upiVpa = upiVpa.trim();
      await api.updateOutlet(outletId, input);
      setStep2Done(true);
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save outlet details");
    } finally {
      setBusy(false);
    }
  };

  // Step 3: starter menu — apply-template is NOT idempotent, so it must only ever
  // fire once per successful run (step3Done guards both Next and Skip).
  const submitStep3 = async () => {
    setError(null);
    if (step3Done) {
      setStep(3);
      return;
    }
    if (menuChoice === "blank") {
      setStep3Done(true);
      setStep(3);
      return;
    }
    setBusy(true);
    try {
      const res = await api.applyMenuTemplate(outletId);
      setTemplateResult(res);
      setStep3Done(true);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the starter menu");
    } finally {
      setBusy(false);
    }
  };

  const skipStep3 = () => {
    setError(null);
    setStep3Done(true);
    setStep(3);
  };

  // Step 4: create the "Main" area once, then the requested tables. Neither
  // call is idempotent, so both are guarded by step4Done.
  const submitStep4 = async () => {
    setError(null);
    if (step4Done) {
      setStep(4);
      return;
    }
    const count = Math.min(50, Math.max(1, Math.round(tableCount) || 1));
    setBusy(true);
    try {
      let area = areaId;
      if (!area) {
        const created = await api.createArea(outletId, { name: "Main" });
        area = created.id;
        setAreaId(area);
      }
      const res = await api.createTables(outletId, { areaId: area, count });
      setTables(res.tables);
      setStep4Done(true);
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create tables");
    } finally {
      setBusy(false);
    }
  };

  const skipStep4 = () => {
    setError(null);
    setStep4Done(true);
    setStep(4);
  };

  const finish = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.completeOnboarding();
      router.replace("/console");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish setup");
      setBusy(false);
    }
  };

  return (
    <div className="onboard-wrap">
      <div className="onboard-steps">
        {STEP_LABELS.map((label, i) => (
          <div key={label} className={`onboard-step${i === step ? " active" : ""}${i < step ? " done" : ""}`}>
            <span className="onboard-step-n">{i + 1}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>

      {error && (
        <div className="banner-error" onClick={() => setError(null)}>
          {error} — dismiss
        </div>
      )}

      <div className="onboard-card">
        {step === 0 && (
          <>
            <h2>Brand &amp; theme</h2>
            <p className="muted">Name your restaurant and pick the look that will apply across POS, KDS, Console and Scan &amp; Order.</p>
            <label className="field">
              Restaurant name
              <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Spice Route" />
            </label>
            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`theme-card${t.id === themeId ? " sel" : ""}`}
                  onClick={() => setThemeId(t.id)}
                  aria-pressed={t.id === themeId}
                >
                  <span className="theme-prev" style={{ background: t.tokens["--bg"], color: t.tokens["--ink"] }}>
                    <span className="tw" style={{ color: t.tokens["--accent"] }}>
                      STELLO KITCHENS
                    </span>
                    <span className="tbtn" style={{ background: t.tokens["--accent"], color: t.tokens["--accent-ink"] }}>
                      Send KOT
                    </span>
                  </span>
                  <span className="theme-meta">
                    <b>{t.name}</b>
                    <span className={`mode ${t.mode}`}>{t.mode}</span>
                  </span>
                </button>
              ))}
            </div>
            <p className="hint">Selected: <b>{currentTheme.name}</b></p>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Outlet &amp; GST</h2>
            <p className="muted">These details print on bills and invoices.</p>
            <label className="field">
              Outlet name
              <input value={outletName} onChange={(e) => setOutletName(e.target.value)} placeholder="Spice Route - MG Road" />
            </label>
            <label className="field">
              Address
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="12 MG Road, Bengaluru" />
            </label>
            <div className="field-row">
              <label className="field">
                GSTIN (optional)
                <input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="29ABCDE1234F1Z5" maxLength={20} />
              </label>
              <label className="field short">
                Place of supply
                <input value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)} placeholder="29" maxLength={4} />
              </label>
            </div>
            <label className="field">
              UPI VPA (optional)
              <input value={upiVpa} onChange={(e) => setUpiVpa(e.target.value)} placeholder="restaurant@upi" />
            </label>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Starter menu</h2>
            <p className="muted">Get a small cuisine-neutral menu to start punching orders immediately, or start from a blank menu.</p>
            <div className="radio-group">
              <button
                type="button"
                className={`radio-card${menuChoice === "sample" ? " sel" : ""}`}
                onClick={() => setMenuChoice("sample")}
                aria-pressed={menuChoice === "sample"}
              >
                <b>Add a sample menu</b>
                <span>Starters, Main Course, Breads &amp; Rice, Beverages — ready to edit.</span>
              </button>
              <button
                type="button"
                className={`radio-card${menuChoice === "blank" ? " sel" : ""}`}
                onClick={() => setMenuChoice("blank")}
                aria-pressed={menuChoice === "blank"}
              >
                <b>Start blank</b>
                <span>Build the menu from scratch in Console → Menu.</span>
              </button>
            </div>
            {step3Done && templateResult && (
              <p className="hint">
                Added {templateResult.categoriesCreated} categories and {templateResult.itemsCreated} items.
              </p>
            )}
            {step3Done && !templateResult && <p className="hint">Starting with a blank menu.</p>}
          </>
        )}

        {step === 3 && (
          <>
            <h2>Tables &amp; QR</h2>
            <p className="muted">Create tables under a &quot;Main&quot; area — each gets a scannable Scan &amp; Order QR code.</p>
            {!step4Done && (
              <label className="field short">
                Number of tables
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={tableCount}
                  onChange={(e) => setTableCount(Number(e.target.value))}
                />
              </label>
            )}
            {step4Done && tables.length > 0 && (
              <>
                <div className="onboard-print-head">
                  <p className="hint">{tables.length} tables created.</p>
                  <button type="button" className="text-btn" onClick={() => window.print()}>
                    Print all
                  </button>
                </div>
                <div className="qr-grid onboard-print-area">
                  {tables.map((t) => (
                    <div key={t.id} className="qr-card">
                      <div className="qr-img">
                        {qr[t.id] ? <img src={qr[t.id]} alt={t.name} /> : <span className="qr-skel" />}
                      </div>
                      <span className="qr-label">{t.name}</span>
                      {qr[t.id] && (
                        <a className="text-btn" href={qr[t.id]} download={`${t.name.replace(/\s+/g, "-")}-qr.png`}>
                          Download
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {step4Done && tables.length === 0 && <p className="hint">Skipped — no tables were created.</p>}
          </>
        )}

        {step === 4 && (
          <>
            <h2>Finish</h2>
            <p className="muted">You&apos;re ready to take orders.</p>
            <ul className="onboard-summary">
              <li><span>Theme</span><b>{currentTheme.name}</b></li>
              <li><span>Outlet</span><b>{outletName || outlet.name}</b></li>
              <li>
                <span>Menu</span>
                <b>
                  {templateResult
                    ? `${templateResult.categoriesCreated} categories, ${templateResult.itemsCreated} items`
                    : "Blank"}
                </b>
              </li>
              <li><span>Tables</span><b>{tables.length > 0 ? `${tables.length} created` : "None"}</b></li>
            </ul>
          </>
        )}
      </div>

      <div className="onboard-actions">
        <button className="btn-ghost" onClick={goBack} disabled={step === 0 || busy}>
          Back
        </button>
        <div className="onboard-actions-right">
          {step === 2 && (
            <button className="btn-ghost" onClick={skipStep3} disabled={busy}>
              Skip
            </button>
          )}
          {step === 3 && (
            <button className="btn-ghost" onClick={skipStep4} disabled={busy}>
              Skip
            </button>
          )}
          {step === 0 && (
            <button className="btn-primary" onClick={submitStep1} disabled={busy}>
              {busy ? "Saving…" : "Next"}
            </button>
          )}
          {step === 1 && (
            <button className="btn-primary" onClick={submitStep2} disabled={busy}>
              {busy ? "Saving…" : "Next"}
            </button>
          )}
          {step === 2 && (
            <button className="btn-primary" onClick={submitStep3} disabled={busy}>
              {busy ? "Applying…" : "Next"}
            </button>
          )}
          {step === 3 && (
            <button className="btn-primary" onClick={submitStep4} disabled={busy}>
              {busy ? "Creating…" : "Next"}
            </button>
          )}
          {step === 4 && (
            <button className="btn-primary" onClick={finish} disabled={busy}>
              {busy ? "Finishing…" : "Finish setup"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
