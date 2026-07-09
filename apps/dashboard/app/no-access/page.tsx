"use client";
import { useSession } from "@/components/SessionProvider";

export default function NoAccess() {
  const { user, logout } = useSession();
  return (
    <div className="boot" style={{ flexDirection: "column", gap: 12 }}>
      <p>No staff surface is available for {user?.roleName ?? "this role"}.</p>
      <button className="text-btn" onClick={logout}>Sign out</button>
    </div>
  );
}
