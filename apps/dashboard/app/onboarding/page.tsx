"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Shell } from "@/components/Shell";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { useSession } from "@/components/SessionProvider";

export default function OnboardingPage() {
  const { user, outlet, tenant, loading } = useSession();
  const router = useRouter();

  const alreadyOnboarded = tenant?.onboardedAt != null;

  useEffect(() => {
    if (loading) return;
    if (alreadyOnboarded) router.replace("/console");
  }, [loading, alreadyOnboarded, router]);

  if (loading || alreadyOnboarded) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <Shell surface="console">
      {user && outlet && <OnboardingWizard user={user} outlet={outlet} />}
    </Shell>
  );
}
