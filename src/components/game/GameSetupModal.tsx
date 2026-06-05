"use client";

import { useCallback, useEffect, useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SoundSettingsSection } from "@/components/game/SettingsModal";
import { useTranslations } from "next-intl";
import type { Role, ConfigPreset } from "@/types/game";
import type { CustomRoleConfig } from "@/store/settings";

/** 返回指定人数下可用的角色种类（去重后），用于角色偏好下拉框和自定义角色配置面板 */
function getAvailableRoles(playerCount: number): Role[] {
  const configs: Record<number, Role[]> = {
    6: ["Werewolf", "Seer", "Guard", "Villager"],
    8: ["Werewolf", "Seer", "Witch", "Hunter", "Villager"],
    9: ["Werewolf", "Seer", "Witch", "Hunter", "Villager"],
    10: ["Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Villager"],
    11: ["Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager"],
    12: ["Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager"],
  };
  return configs[playerCount] ?? configs[10];
}

/**
 * 根据人数和配置预设生成自定义角色配置面板的默认数量值。
 * 12人局无守卫配置走独立分支，其余走标准配置表。
 */
function getDefaultCustomRoleConfig(playerCount: number, configPreset: ConfigPreset = "standard"): CustomRoleConfig {
  // 12人局无守卫配置：4狼+4神+4民
  if (playerCount === 12 && configPreset === "noGuard") {
    return { Werewolf: 4, Seer: 1, Witch: 1, Hunter: 1, Idiot: 1, Villager: 4 };
  }
  // 标准配置：人数 → 各角色数量
  const defaults: Record<number, CustomRoleConfig> = {
    6: { Werewolf: 2, Seer: 1, Guard: 1, Villager: 2 },
    8: { Werewolf: 3, Seer: 1, Witch: 1, Hunter: 1, Villager: 2 },
    9: { Werewolf: 3, Seer: 1, Witch: 1, Hunter: 1, Villager: 3 },
    10: { Werewolf: 2, WhiteWolfKing: 1, Seer: 1, Witch: 1, Hunter: 1, Guard: 1, Villager: 3 },
    11: { Werewolf: 3, WhiteWolfKing: 1, Seer: 1, Witch: 1, Hunter: 1, Guard: 1, Idiot: 1, Villager: 2 },
    12: { Werewolf: 3, WhiteWolfKing: 1, Seer: 1, Witch: 1, Hunter: 1, Guard: 1, Idiot: 1, Villager: 3 },
  };
  return defaults[playerCount] ?? defaults[10];
}

interface GameSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playerCount: number;
  onPlayerCountChange: (value: number) => void;
  configPreset: ConfigPreset;
  onConfigPresetChange: (value: ConfigPreset) => void;
  preferredRole: Role | "";
  onPreferredRoleChange: (value: Role | "") => void;
  isGenshinMode: boolean;
  onGenshinModeChange: (value: boolean) => void;
  isSpectatorMode: boolean;
  onSpectatorModeChange: (value: boolean) => void;
  customRoleConfigEnabled: boolean;
  onCustomRoleConfigEnabledChange: (value: boolean) => void;
  customRoleConfig: CustomRoleConfig;
  onCustomRoleConfigChange: (value: CustomRoleConfig) => void;
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAiVoiceEnabled: boolean;
  isAutoAdvanceDialogueEnabled: boolean;
  onBgmVolumeChange: (value: number) => void;
  onSoundEnabledChange: (value: boolean) => void;
  onAiVoiceEnabledChange: (value: boolean) => void;
  onAutoAdvanceDialogueEnabledChange: (value: boolean) => void;
}


export function GameSetupModal({
  open,
  onOpenChange,
  playerCount,
  onPlayerCountChange,
  configPreset,
  onConfigPresetChange,
  preferredRole,
  onPreferredRoleChange,
  isGenshinMode,
  onGenshinModeChange,
  isSpectatorMode,
  onSpectatorModeChange,
  customRoleConfigEnabled,
  onCustomRoleConfigEnabledChange,
  customRoleConfig,
  onCustomRoleConfigChange,
  bgmVolume,
  isSoundEnabled,
  isAiVoiceEnabled,
  isAutoAdvanceDialogueEnabled,
  onBgmVolumeChange,
  onSoundEnabledChange,
  onAiVoiceEnabledChange,
  onAutoAdvanceDialogueEnabledChange,
}: GameSetupModalProps) {
  const t = useTranslations();

  // 人数选项列表：6-12人，12人有两种配置方案（标准/无守卫）
  const PLAYER_COUNT_OPTIONS = [
    { value: "6", label: t("gameSetup.playerCount.6.title"), description: t("gameSetup.playerCount.6.description"), roles: t("gameSetup.playerCount.6.roles") },
    { value: "8", label: t("gameSetup.playerCount.8.title"), description: t("gameSetup.playerCount.8.description"), roles: t("gameSetup.playerCount.8.roles") },
    { value: "9", label: t("gameSetup.playerCount.9.title"), description: t("gameSetup.playerCount.9.description"), roles: t("gameSetup.playerCount.9.roles") },
    { value: "10", label: t("gameSetup.playerCount.10.title"), description: t("gameSetup.playerCount.10.description"), roles: t("gameSetup.playerCount.10.roles") },
    { value: "11", label: t("gameSetup.playerCount.11.title"), description: t("gameSetup.playerCount.11.description"), roles: t("gameSetup.playerCount.11.roles") },
    { value: "12", label: t("gameSetup.playerCount.12.title"), description: t("gameSetup.playerCount.12.description"), roles: t("gameSetup.playerCount.12.roles") },
    { value: "12-noGuard", label: t("gameSetup.playerCount.12noGuard.title"), description: t("gameSetup.playerCount.12noGuard.description"), roles: t("gameSetup.playerCount.12noGuard.roles") },
  ];

  // 根据 playerCount + configPreset 推导下拉框当前选中值
  const selectValue = playerCount === 12 && configPreset === "noGuard" ? "12-noGuard" : String(playerCount);

  /** 处理人数选择变更：解析选项值，同步更新 playerCount 和 configPreset */
  const handlePlayerCountSelect = (val: string) => {
    if (val === "12-noGuard") {
      onPlayerCountChange(12);
      onConfigPresetChange("noGuard");
    } else {
      onPlayerCountChange(Number(val));
      onConfigPresetChange("standard");
    }
  };

  const roleLabels = useMemo<Record<Role, string>>(
    () => ({
      Villager: t("roles.villager"),
      Werewolf: t("roles.werewolf"),
      WhiteWolfKing: t("roles.whiteWolfKing"),
      Seer: t("roles.seer"),
      Witch: t("roles.witch"),
      Hunter: t("roles.hunter"),
      Guard: t("roles.guard"),
      Idiot: t("roles.idiot"),
    }),
    [t]
  );

  const roleDescriptions = useMemo<Record<Role, string>>(
    () => ({
      Villager: t("gameSetup.rolePreference.desc.villager"),
      Werewolf: t("gameSetup.rolePreference.desc.werewolf"),
      WhiteWolfKing: t("gameSetup.rolePreference.desc.whiteWolfKing"),
      Seer: t("gameSetup.rolePreference.desc.seer"),
      Witch: t("gameSetup.rolePreference.desc.witch"),
      Hunter: t("gameSetup.rolePreference.desc.hunter"),
      Guard: t("gameSetup.rolePreference.desc.guard"),
      Idiot: t("gameSetup.rolePreference.desc.idiot"),
    }),
    [t]
  );

  const availableRoles = useMemo(() => getAvailableRoles(playerCount), [playerCount]);

  // Reset preferred role if it's no longer available for the current player count
  const effectivePreferredRole = preferredRole && availableRoles.includes(preferredRole) ? preferredRole : "";

  useEffect(() => {
    if (preferredRole && !availableRoles.includes(preferredRole)) {
      onPreferredRoleChange("");
    }
  }, [preferredRole, availableRoles, onPreferredRoleChange]);

  // Sync custom role config when player count changes
  useEffect(() => {
    onCustomRoleConfigChange(getDefaultCustomRoleConfig(playerCount));
  }, [playerCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Custom role config: compute total and validation
  const customRoleTotal = useMemo(
    () => Object.values(customRoleConfig).reduce((sum, n) => sum + (n ?? 0), 0),
    [customRoleConfig]
  );
  const customRoleDiff = customRoleTotal - playerCount;

  const handleRoleCountChange = useCallback(
    (role: Role, delta: number) => {
      onCustomRoleConfigChange({
        ...customRoleConfig,
        [role]: Math.max(0, (customRoleConfig[role] ?? 0) + delta),
      });
    },
    [customRoleConfig, onCustomRoleConfigChange]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-[var(--text-primary)]">{t("gameSetup.title")}</DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            {t("gameSetup.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <div className="text-sm font-medium text-[var(--text-primary)]">{t("gameSetup.playerCountLabel")}</div>
            <Select
              value={selectValue}
              onValueChange={handlePlayerCountSelect}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("gameSetup.selectPlayerCount")} />
              </SelectTrigger>
              <SelectContent>
                {PLAYER_COUNT_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={String(option.value)}
                    label={option.label}
                    description={`${option.description}｜${option.roles}`}
                  />
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isSpectatorMode && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-[var(--text-primary)]">{t("gameSetup.rolePreference.label")}</div>
              <Select
                value={effectivePreferredRole || "_random"}
                onValueChange={(value) => onPreferredRoleChange(value === "_random" ? "" : (value as Role))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("gameSetup.rolePreference.random")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="_random"
                    label={t("gameSetup.rolePreference.random")}
                    description={t("gameSetup.rolePreference.randomDesc")}
                  />
                  {availableRoles.map((role) => (
                    <SelectItem
                      key={role}
                      value={role}
                      label={roleLabels[role]}
                      description={roleDescriptions[role]}
                    />
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-[var(--text-muted)]">
                {t("gameSetup.rolePreference.hint")}
              </div>
            </div>
          )}

          {/* Custom Role Configuration */}
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--text-primary)]">{t("gameSetup.customRoleConfig.title")}</div>
                <div className="text-xs text-[var(--text-muted)]">
                  {t("gameSetup.customRoleConfig.description")}
                </div>
              </div>
              <Switch className="shrink-0 mt-1" checked={customRoleConfigEnabled} onCheckedChange={onCustomRoleConfigEnabledChange} />
            </div>

            {customRoleConfigEnabled && (
              <div className="space-y-2 rounded-lg border border-[var(--border-color)] p-3">
                {availableRoles.map((role) => {
                  const count = customRoleConfig[role] ?? 0;
                  return (
                    <div key={role} className="flex items-center justify-between">
                      <span className="text-sm text-[var(--text-primary)]">{roleLabels[role]}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleRoleCountChange(role, -1)}
                          disabled={count <= 0}
                          className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-color)] text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-sm font-medium tabular-nums text-[var(--text-primary)]">{count}</span>
                        <button
                          type="button"
                          onClick={() => handleRoleCountChange(role, 1)}
                          disabled={customRoleTotal >= playerCount}
                          className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-color)] text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="border-t border-[var(--border-color)] pt-2 mt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {customRoleTotal} / {playerCount}
                    </span>
                    <span className={`text-xs ${customRoleDiff === 0 ? "text-green-500" : "text-red-400"}`}>
                      {customRoleDiff === 0
                        ? t("gameSetup.customRoleConfig.totalValid")
                        : customRoleDiff > 0
                          ? t("gameSetup.customRoleConfig.totalInvalid", { target: playerCount, extra: customRoleDiff })
                          : t("gameSetup.customRoleConfig.totalShort", { target: playerCount, missing: -customRoleDiff })}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">{t("gameSetup.genshinMode.title")}</div>
            <div className="text-xs text-[var(--text-muted)]">
              {t("gameSetup.genshinMode.description")}
            </div>
            </div>
            <Switch className="shrink-0 mt-1" checked={isGenshinMode} onCheckedChange={onGenshinModeChange} />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">{t("gameSetup.spectatorMode.title")}</div>
            <div className="text-xs text-[var(--text-muted)]">
              {t("gameSetup.spectatorMode.description")}
            </div>
            </div>
            <Switch className="shrink-0 mt-1" checked={isSpectatorMode} onCheckedChange={onSpectatorModeChange} />
          </div>

          <div className="border-t border-[var(--border-color)] pt-4">
            <div className="text-sm font-medium text-[var(--text-primary)] mb-3">{t("gameSetup.soundLabel")}</div>
            <SoundSettingsSection
              bgmVolume={bgmVolume}
              isSoundEnabled={isSoundEnabled}
              isAiVoiceEnabled={isAiVoiceEnabled}
              isAutoAdvanceDialogueEnabled={isAutoAdvanceDialogueEnabled}
              onBgmVolumeChange={onBgmVolumeChange}
              onSoundEnabledChange={onSoundEnabledChange}
              onAiVoiceEnabledChange={onAiVoiceEnabledChange}
              onAutoAdvanceDialogueEnabledChange={onAutoAdvanceDialogueEnabledChange}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
