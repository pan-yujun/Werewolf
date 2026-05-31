"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, UserCircle } from "@phosphor-icons/react";
import { useCredits } from "@/hooks/useCredits";
import { UserProfileContent } from "@/components/game/UserProfileContent";
import { AccountModal } from "@/components/game/AccountModal";
import { SharePanel } from "@/components/game/SharePanel";
import { ResetPasswordModal } from "@/components/game/ResetPasswordModal";
import { REFERRAL_BONUS_ENABLED } from "@/lib/welfare-config";
import { isCustomKeyEnabled } from "@/lib/api-keys";
import { useTranslations } from "next-intl";

export default function AccountPage() {
  const router = useRouter();
  const t = useTranslations();
  const {
    user,
    credits,
    referralCode,
    totalReferrals,
    signOut,
    isPasswordRecovery,
    clearPasswordRecovery,
    fetchCredits,
    springCampaign,
    redeemCode,
  } = useCredits();

  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [customKeyEnabled, setCustomKeyEnabled] = useState(() => isCustomKeyEnabled());

  const defaultTab = user ? "profile" : "custom";

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]" data-theme="dark">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[var(--bg-main)]/90 backdrop-blur-md border-b border-[var(--color-gold)]/20 px-5 py-4 flex items-center gap-4 shadow-lg">
        <button
          onClick={() => router.push("/")}
          className="w-9 h-9 border border-[var(--color-gold)]/30 rounded flex items-center justify-center bg-black/20 hover:bg-white/5 transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-[var(--color-gold)]" />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 border border-[var(--color-gold)]/30 rounded flex items-center justify-center bg-black/20">
            <UserCircle className="w-5 h-5 text-[var(--color-gold)]" />
          </div>
          <h1 className="font-bold text-xl text-[var(--color-gold)] tracking-wider drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            {t("accountPage.title")}
          </h1>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 py-8">
        <UserProfileContent
          email={user?.email}
          credits={credits ?? undefined}
          springCampaign={springCampaign}
          referralCode={referralCode}
          totalReferrals={totalReferrals}
          onChangePassword={() => setIsAccountOpen(true)}
          onShareInvite={() => setIsShareOpen(true)}
          onSignOut={() => {
            signOut();
            router.push("/");
          }}
          onRedeemCode={redeemCode}
          onCustomKeyEnabledChange={setCustomKeyEnabled}
          onCreditsChange={fetchCredits}
          defaultTab={defaultTab}
        />
      </main>

      {/* Nested modals */}
      <AccountModal open={isAccountOpen} onOpenChange={setIsAccountOpen} />
      {REFERRAL_BONUS_ENABLED && (
        <SharePanel
          open={isShareOpen}
          onOpenChange={setIsShareOpen}
          referralCode={referralCode}
          totalReferrals={totalReferrals}
        />
      )}
      <ResetPasswordModal
        open={isPasswordRecovery}
        onOpenChange={(open) => !open && clearPasswordRecovery()}
        onSuccess={clearPasswordRecovery}
      />
    </div>
  );
}
