"use client";

import { useState } from "react";
import { UserCircle } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";
import { useCredits } from "@/hooks/useCredits";
import { UserProfileContent } from "@/components/game/UserProfileContent";
import { AccountModal } from "@/components/game/AccountModal";
import { SharePanel } from "@/components/game/SharePanel";
import { ResetPasswordModal } from "@/components/game/ResetPasswordModal";
import { REFERRAL_BONUS_ENABLED } from "@/lib/welfare-config";
import { isCustomKeyEnabled } from "@/lib/api-keys";

interface AccountPageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccountPageDialog({ open, onOpenChange }: AccountPageDialogProps) {
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
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCircle size={20} />
              {t("accountPage.title")}
            </DialogTitle>
            <DialogDescription>{t("userProfile.description")}</DialogDescription>
          </DialogHeader>

          <UserProfileContent
            key={String(open)}
            email={user?.email}
            credits={credits ?? undefined}
            springCampaign={springCampaign}
            referralCode={referralCode}
            totalReferrals={totalReferrals}
            onChangePassword={() => setIsAccountOpen(true)}
            onShareInvite={() => setIsShareOpen(true)}
            onSignOut={() => {
              signOut();
              onOpenChange(false);
            }}
            onRedeemCode={redeemCode}
            onCustomKeyEnabledChange={setCustomKeyEnabled}
            onCreditsChange={fetchCredits}
            defaultTab={defaultTab}
          />
        </DialogContent>
      </Dialog>

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
        onOpenChange={(o) => !o && clearPasswordRecovery()}
        onSuccess={clearPasswordRecovery}
      />
    </>
  );
}
