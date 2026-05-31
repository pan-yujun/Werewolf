"use client";

import { UserCircle } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";
import { UserProfileContent, type UserProfileContentProps } from "./UserProfileContent";

interface UserProfileModalProps extends UserProfileContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UserProfileModal({
  open,
  onOpenChange,
  ...contentProps
}: UserProfileModalProps) {
  const t = useTranslations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCircle size={20} />
            {t("userProfile.title")}
          </DialogTitle>
          <DialogDescription>{t("userProfile.description")}</DialogDescription>
        </DialogHeader>

        {/* key={String(open)} forces re-mount on open so state re-initializes */}
        <UserProfileContent key={String(open)} {...contentProps} onSave={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
