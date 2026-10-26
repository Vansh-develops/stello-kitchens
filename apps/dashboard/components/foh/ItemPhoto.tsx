"use client";

import { useState } from "react";
import type { AdminItemDto } from "@stello/shared";
import { MEDIA_LIMITS } from "@stello/shared";
import { downscaleImage, fohApi } from "@/lib/foh-api";
import "./foh.css";

/** Menu photo picker for the item dialog (upload, replace, remove). */
export function ItemPhoto({ outletId, item }: { outletId: string; item: AdminItemDto | null }) {
  const [url, setUrl] = useState<string | null>(item?.imageUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!item) return <p className="hint">Save the item first, then add a photo.</p>;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!(MEDIA_LIMITS.types as readonly string[]).includes(file.type)) {
      setError("Use a JPEG, PNG or WebP photo");
      return;
    }
    setBusy(true);
    try {
      const { blob, name } = await downscaleImage(file);
      if (blob.size > MEDIA_LIMITS.maxBytes) throw new Error("Photo is still larger than 2 MB after resizing");
      const res = await fohApi.uploadItemImage(outletId, item.id, blob, name);
      setUrl(res.imageUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fohApi.removeItemImage(outletId, item.id);
      setUrl(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove photo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      Photo
      <div className="item-photo">
        {url ? <img src={url} alt={`${item.name} photo`} /> : <span className="ph">No photo</span>}
        <div className="foh-form">
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
          {url && (
            <button type="button" className="text-btn danger" onClick={remove} disabled={busy}>
              Remove photo
            </button>
          )}
          {busy && <span className="hint">Uploading…</span>}
          {error && <span className="form-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
