"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { surfaceAccess } from "@stello/shared";
import { useSession } from "@/components/SessionProvider";

export default function Home() {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    const { primary } = surfaceAccess(user.permissions);
    router.replace(primary ? `/${primary}` : "/no-access");
  }, [user, loading, router]);

  return <div className="boot">Loading…</div>;
}
