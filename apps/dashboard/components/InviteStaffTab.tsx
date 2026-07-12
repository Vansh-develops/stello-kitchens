"use client";

import { useCallback, useEffect, useState } from "react";
import type { RoleDto } from "@stello/shared";
import { api } from "@/lib/api";

export function InviteStaffTab() {
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [roleId, setRoleId] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadRoles = useCallback(async () => {
    try {
      const data = await api.tenantRoles();
      setRoles(data);
      setRoleId((cur) => cur || data[0]?.id || "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load roles");
    }
  }, []);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const invite = async () => {
    if (busy) return; // avoid double-submit while a create is already in flight
    if (!email.trim() || !roleId) {
      setError("Enter an email and choose a role.");
      return;
    }
    setBusy(true);
    setError(null);
    setInviteLink(null);
    setCopied(false);
    try {
      const res = await api.createInvite(email.trim(), roleId);
      setInviteLink(res.inviteLink);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create invite");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setError("Could not copy automatically — select and copy the link manually.");
    }
  };

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Invite staff</h1>
      </div>
      {error && (
        <div className="banner-error" onClick={() => setError(null)}>
          {error} — dismiss
        </div>
      )}
      <p className="hint wide">
        Invite a teammate by email and role. They&apos;ll get a link to set their own password and
        join this restaurant with the permissions of the role you choose.
      </p>

      <div className="invite-new">
        <input
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.length === 0 && <option value="">No roles yet</option>}
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="btn-primary sm" onClick={() => void invite()} disabled={busy || roles.length === 0}>
          {busy ? "Creating…" : "Create invite"}
        </button>
      </div>

      {inviteLink && (
        <div className="invite-link-row">
          <input
            className="invite-link-field"
            readOnly
            value={inviteLink}
            onFocus={(e) => e.target.select()}
          />
          <button className="btn-ghost sm" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
