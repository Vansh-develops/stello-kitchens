"use client";

import { Shell } from "@/components/Shell";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { useSession } from "@/components/SessionProvider";

export default function OnboardingPage() {
  const { user, outlet } = useSession();
  return (
    <Shell surface="console">
      {user && outlet && <OnboardingWizard user={user} outlet={outlet} />}
    </Shell>
  );
}
