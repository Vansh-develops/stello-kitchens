"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  hasPermission,
  missingPermissions,
  type AuthUser,
  type RoleDetailDto,
  type StaffAccountDto,
} from "@stello/shared";
import { platformApi } from "@/lib/platform-api";
import "./platform.css";

type Draft = { id: string | null; name: string; permissions: string[]; owner: boolean };

/** Custom roles per tenant (grouped, described permission catalogue) and staff role assignment. */
export function RolesTab({ user }: { user: AuthUser }) {
  const [roles, setRoles] = useState<RoleDetailDto[]>([]);
  const [staff, setStaff] = useState<StaffAccountDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const allowed = hasPermission(user.permissions, "roles.manage");

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([platformApi.roles(), platformApi.staff()]);
      setRoles(r);
      setStaff(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load roles");
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // Keys a role holds that aren't in the catalogue (added by other modules) stay visible.
  const extraKeys = useMemo(
    () => (draft ? draft.permissions.filter((k) => k !== "*" && !PERMISSIONS.some((p) => p.key === k)) : []),
    [draft],
  );

  if (!allowed) return <div className="pf-access">You need the “Manage roles &amp; staff” permission to see this page.</div>;

  const canGrant = (key: string) => missingPermissions(user.permissions, [key]).length === 0;
  const editable = (perms: string[]) => missingPermissions(user.permissions, perms).length === 0;

  const pick = (r: RoleDetailDto) => {
    setDraft({ id: r.id, name: r.name, permissions: r.permissions, owner: r.isOwnerRole });
    setConfirmDelete(false);
    setNotice(null);
  };

  const toggle = (key: string) =>
    setDraft((d) => d && { ...d, permissions: d.permissions.includes(key) ? d.permissions.filter((k) => k !== key) : [...d.permissions, key] });

  const toggleGroup = (keys: string[], on: boolean) =>
    setDraft((d) => d && { ...d, permissions: on ? [...new Set([...d.permissions, ...keys.filter(canGrant)])] : d.permissions.filter((k) => !keys.includes(k) || !canGrant(k)) });

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
      if (done) setNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    draft &&
    run(async () => {
      const input = { name: draft.name.trim(), permissions: draft.owner ? ["*"] : draft.permissions };
      const saved = draft.id ? await platformApi.updateRole(draft.id, input) : await platformApi.createRole(input);
      setDraft({ id: saved.id, name: saved.name, permissions: saved.permissions, owner: saved.isOwnerRole });
    }, "Role saved");

  const remove = () =>
    draft?.id &&
    run(async () => {
      await platformApi.deleteRole(draft.id!);
      setDraft(null);
    }, "Role deleted");

  const assign = (s: StaffAccountDto, roleId: string) => run(async () => void (await platformApi.assignRole(s.id, roleId)), `${s.name} is now ${roles.find((r) => r.id === roleId)?.name}`);

  const draftLocked = draft?.id ? !editable(roles.find((r) => r.id === draft.id)?.permissions ?? []) : false;

  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Roles &amp; staff</h1>
        <button className="btn-primary sm" onClick={() => { setDraft({ id: null, name: "", permissions: [], owner: false }); setNotice(null); }}>+ New role</button>
      </div>
      {error && <div className="banner-error" onClick={() => setError(null)}>{error} — dismiss</div>}
      {notice && <p className="form-success">{notice}</p>}
      <p className="hint wide">
        A role is a named set of permissions. You can only grant permissions you hold yourself, and a restaurant always
        keeps at least one active owner.
      </p>

      <div className="pf-grid wide-left">
        <div className="pf-stack">
          <div className="pf-list">
            {roles.map((r) => (
              <button key={r.id} className={`pf-item selectable ${draft?.id === r.id ? "active" : ""}`} onClick={() => pick(r)}>
                <div className="pf-item-main">
                  <span className="pf-item-title">{r.name}</span>
                  <span className="pf-item-sub">{r.isOwnerRole ? "Full access" : `${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"}`}</span>
                </div>
                <span className="pf-chip">{r.userCount} staff</span>
              </button>
            ))}
            {roles.length === 0 && <p className="empty pf-item">No roles yet.</p>}
          </div>

          <div className="report-card">
            <span className="card-title">Staff</span>
            <div className="pf-scroll">
              <table className="pf-table">
                <thead><tr><th>Name</th><th>Role</th><th>2FA</th></tr></thead>
                <tbody>
                  {staff.map((s) => {
                    const current = roles.find((r) => r.id === s.roleId);
                    const movable = current ? editable(current.permissions) : false;
                    return (
                      <tr key={s.id}>
                        <td>
                          <div className="pf-item-title">{s.name}{!s.isActive && <span className="pf-faint"> · inactive</span>}</div>
                          <div className="pf-item-sub">{s.email}</div>
                        </td>
                        <td>
                          <select value={s.roleId} disabled={busy || !movable} onChange={(e) => void assign(s, e.target.value)} title={movable ? "Change role" : "This person has access you don't hold"}>
                            {roles.map((r) => (
                              <option key={r.id} value={r.id} disabled={!editable(r.permissions)}>{r.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>{s.mfaEnabled ? <span className="status-pill good">On</span> : <span className="status-pill muted">Off</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="report-card">
          {!draft && <p className="hint">Pick a role to edit its permissions, or create a new one.</p>}
          {draft && (
            <div className="pf-stack">
              <span className="card-title">{draft.id ? "Edit role" : "New role"}</span>
              <label className="pf-label">
                Name
                <input value={draft.name} maxLength={60} disabled={draftLocked} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Shift manager" />
              </label>
              {draftLocked && <p className="pf-owner-note">This role has access you don&apos;t hold, so you can view it but not change it.</p>}
              {draft.owner ? (
                <p className="pf-owner-note">Owner role: full access to everything, including permissions added in future.</p>
              ) : (
                <div>
                  {PERMISSION_GROUPS.map((g) => {
                    const perms = PERMISSIONS.filter((p) => p.group === g);
                    const all = perms.every((p) => draft.permissions.includes(p.key));
                    return (
                      <div key={g} className="pf-perm-group">
                        <h4>
                          {g}
                          {!draftLocked && (
                            <button type="button" className="text-btn" onClick={() => toggleGroup(perms.map((p) => p.key), !all)}>{all ? "Clear" : "All"}</button>
                          )}
                        </h4>
                        {perms.map((p) => {
                          const locked = draftLocked || !canGrant(p.key);
                          return (
                            <label key={p.key} className={`pf-perm ${locked ? "locked" : ""}`} title={locked && !draftLocked ? "You don't hold this permission" : undefined}>
                              <input type="checkbox" checked={draft.permissions.includes(p.key)} disabled={locked} onChange={() => toggle(p.key)} />
                              <span>
                                <strong>{p.label}<code>{p.key}</code></strong>
                                <small>{p.description}</small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
                  {extraKeys.length > 0 && (
                    <div className="pf-perm-group">
                      <h4>Other</h4>
                      {extraKeys.map((k) => (
                        <label key={k} className={`pf-perm ${draftLocked || !canGrant(k) ? "locked" : ""}`}>
                          <input type="checkbox" checked disabled={draftLocked || !canGrant(k)} onChange={() => toggle(k)} />
                          <span><strong>{k}</strong><small>Permission added by another module</small></span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!draftLocked && (
                <div className="pf-row between">
                  {draft.id ? (
                    <button
                      className={`text-btn danger ${confirmDelete ? "armed" : ""}`}
                      disabled={busy}
                      onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
                    >
                      {confirmDelete ? "Confirm delete role" : "Delete role"}
                    </button>
                  ) : <span />}
                  <button className="btn-primary sm" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save role"}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
