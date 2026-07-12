"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { surfaceAccess } from "@stello/shared";
import { useSession } from "@/components/SessionProvider";

export default function Home() {
  const { user, tenant, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    const isOwner = user.permissions.includes("*") || user.permissions.includes("settings.manage");
    if (isOwner && tenant?.onboardedAt == null && pathname !== "/onboarding") {
      router.replace("/onboarding");
      return;
    }
    const { primary } = surfaceAccess(user.permissions);
    router.replace(primary ? `/${primary}` : "/no-access");
  }, [user, tenant, loading, router, pathname]);

  return <div className="boot">Loading…</div>;
}
