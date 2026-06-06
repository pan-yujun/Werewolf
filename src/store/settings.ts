import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { DifficultyLevel, Role, ConfigPreset, CustomCharacterData, ModelRef } from "@/types/game";
import { getRoleConfiguration } from "@/lib/game-master";
export type { ConfigPreset } from "@/types/game";

export interface AudioSettings {
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAiVoiceEnabled: boolean;
  isGenshinMode: boolean;
  isAutoAdvanceDialogueEnabled: boolean;
  isSpectatorMode: boolean;
}

const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  bgmVolume: 0.35,
  isSoundEnabled: true,
  isAiVoiceEnabled: true,
  isGenshinMode: false,
  isAutoAdvanceDialogueEnabled: false,
  isSpectatorMode: false,
};

const clampVolume = (value: number) => Math.min(1, Math.max(0, value));

const normalizeAudioSettings = (value: Partial<AudioSettings>): AudioSettings => ({
  bgmVolume: clampVolume(
    typeof value.bgmVolume === "number" ? value.bgmVolume : DEFAULT_AUDIO_SETTINGS.bgmVolume
  ),
  isSoundEnabled:
    typeof value.isSoundEnabled === "boolean" ? value.isSoundEnabled : DEFAULT_AUDIO_SETTINGS.isSoundEnabled,
  isAiVoiceEnabled:
    typeof value.isAiVoiceEnabled === "boolean" ? value.isAiVoiceEnabled : DEFAULT_AUDIO_SETTINGS.isAiVoiceEnabled,
  isGenshinMode:
    typeof value.isGenshinMode === "boolean" ? value.isGenshinMode : DEFAULT_AUDIO_SETTINGS.isGenshinMode,
  isAutoAdvanceDialogueEnabled:
    typeof value.isAutoAdvanceDialogueEnabled === "boolean"
      ? value.isAutoAdvanceDialogueEnabled
      : DEFAULT_AUDIO_SETTINGS.isAutoAdvanceDialogueEnabled,
  isSpectatorMode:
    typeof value.isSpectatorMode === "boolean" ? value.isSpectatorMode : DEFAULT_AUDIO_SETTINGS.isSpectatorMode,
});

const rawAudioSettingsAtom = atomWithStorage<AudioSettings>("wolfcha.settings.audio", DEFAULT_AUDIO_SETTINGS);

export const audioSettingsAtom = atom(
  (get) => normalizeAudioSettings(get(rawAudioSettingsAtom)),
  (get, set, update: AudioSettings | ((prev: AudioSettings) => AudioSettings)) => {
    const prev = normalizeAudioSettings(get(rawAudioSettingsAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(rawAudioSettingsAtom, normalizeAudioSettings(next));
  }
);

// 游戏人数配置：默认 10 人，范围 6-12 人
const DEFAULT_PLAYER_COUNT = 10;
const MIN_PLAYER_COUNT = 6;
const MAX_PLAYER_COUNT = 12;

const normalizePlayerCount = (value: number) => {
  if (!Number.isFinite(value)) return DEFAULT_PLAYER_COUNT;
  return Math.min(MAX_PLAYER_COUNT, Math.max(MIN_PLAYER_COUNT, Math.round(value)));
};

const rawPlayerCountAtom = atomWithStorage<number>("wolfcha.settings.player_count", DEFAULT_PLAYER_COUNT);

export const playerCountAtom = atom(
  (get) => normalizePlayerCount(get(rawPlayerCountAtom)),
  (get, set, update: number | ((prev: number) => number)) => {
    const prev = normalizePlayerCount(get(rawPlayerCountAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(rawPlayerCountAtom, normalizePlayerCount(next));
  }
);

// 配置预设：用于区分同人数的不同角色配置方案（目前仅 12 人局有两种）
// "standard" = 标准配置（含白狼王+守卫），"noGuard" = 无守卫配置（4狼+4神+4民）
const DEFAULT_CONFIG_PRESET: ConfigPreset = "standard";
const CONFIG_PRESET_OPTIONS: ConfigPreset[] = ["standard", "noGuard"];

/** 校验配置预设值是否合法，非法值回退到默认值 */
const normalizeConfigPreset = (value: ConfigPreset) =>
  CONFIG_PRESET_OPTIONS.includes(value) ? value : DEFAULT_CONFIG_PRESET;

const rawConfigPresetAtom = atomWithStorage<ConfigPreset>("wolfcha.settings.config_preset", DEFAULT_CONFIG_PRESET);

/** 配置预设 atom，持久化到 localStorage，用于 12 人局的角色配置方案切换 */
export const configPresetAtom = atom(
  (get) => normalizeConfigPreset(get(rawConfigPresetAtom)),
  (get, set, update: ConfigPreset | ((prev: ConfigPreset) => ConfigPreset)) => {
    const prev = normalizeConfigPreset(get(rawConfigPresetAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(rawConfigPresetAtom, normalizeConfigPreset(next));
  }
);

// Preferred role setting (empty string means random)
const ALL_ROLES: Role[] = ["Villager", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot"];

const normalizePreferredRole = (value: string): Role | "" =>
  ALL_ROLES.includes(value as Role) ? (value as Role) : "";

const rawPreferredRoleAtom = atomWithStorage<Role | "">("wolfcha.settings.preferred_role", "");

export const preferredRoleAtom = atom(
  (get) => normalizePreferredRole(get(rawPreferredRoleAtom)),
  (get, set, update: (Role | "") | ((prev: Role | "") => Role | "")) => {
    const prev = normalizePreferredRole(get(rawPreferredRoleAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(rawPreferredRoleAtom, normalizePreferredRole(next));
  }
);

const DEFAULT_DIFFICULTY: DifficultyLevel = "normal";
const DIFFICULTY_OPTIONS: DifficultyLevel[] = ["easy", "normal", "hard"];

const normalizeDifficulty = (value: DifficultyLevel) =>
  DIFFICULTY_OPTIONS.includes(value) ? value : DEFAULT_DIFFICULTY;

const rawDifficultyAtom = atomWithStorage<DifficultyLevel>("wolfcha.settings.difficulty", DEFAULT_DIFFICULTY);

export const difficultyAtom = atom(
  (get) => normalizeDifficulty(get(rawDifficultyAtom)),
  (get, set, update: DifficultyLevel | ((prev: DifficultyLevel) => DifficultyLevel)) => {
    const prev = normalizeDifficulty(get(rawDifficultyAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(rawDifficultyAtom, normalizeDifficulty(next));
  }
);

// Custom role configuration
export type CustomRoleConfig = Partial<Record<Role, number>>;

export const customRoleConfigEnabledAtom = atomWithStorage<boolean>(
  "wolfcha.settings.custom_role_config_enabled",
  false
);

const DEFAULT_CUSTOM_ROLE_CONFIG: CustomRoleConfig = {};

const normalizeCustomRoleConfig = (value: CustomRoleConfig): CustomRoleConfig => {
  const result: CustomRoleConfig = {};
  for (const role of ALL_ROLES) {
    const count = value[role];
    if (typeof count === "number" && count > 0) {
      result[role] = Math.floor(count);
    }
  }
  return result;
};

const rawCustomRoleConfigAtom = atomWithStorage<CustomRoleConfig>(
  "wolfcha.settings.custom_role_config",
  DEFAULT_CUSTOM_ROLE_CONFIG
);

export const customRoleConfigAtom = atom(
  (get) => normalizeCustomRoleConfig(get(rawCustomRoleConfigAtom)),
  (get, set, update: CustomRoleConfig | ((prev: CustomRoleConfig) => CustomRoleConfig)) => {
    const prev = normalizeCustomRoleConfig(get(rawCustomRoleConfigAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(rawCustomRoleConfigAtom, normalizeCustomRoleConfig(next));
  }
);

/** 将自定义角色配置（Record<Role, number>）展平为 Role[] 数组 */
export function roleConfigToArray(config: CustomRoleConfig): Role[] {
  const result: Role[] = [];
  for (const [role, count] of Object.entries(config)) {
    for (let i = 0; i < (count ?? 0); i++) {
      result.push(role as Role);
    }
  }
  return result;
}

/**
 * 预计算的游戏角色配置（Role[] 数组）。
 * 根据人数 + 配置预设（标准模式）或自定义角色配置（自定义模式）生成。
 * 当人数、配置预设、自定义角色配置开关或自定义角色数量变更时自动重新生成并持久化。
 */
const rawGameConfigAtom = atomWithStorage<Role[]>("wolfcha.settings.game_config", []);

export const gameConfigAtom = atom(
  (get) => get(rawGameConfigAtom),
  (get, set, update: Role[] | ((prev: Role[]) => Role[])) => {
    const prev = get(rawGameConfigAtom);
    const next = typeof update === "function" ? update(prev) : update;
    set(rawGameConfigAtom, next);
  }
);

/**
 * 根据当前设置生成游戏配置（Role[] 数组）。
 * 自定义角色配置开启且总数匹配时使用自定义配置，否则使用标准配置。
 */
export function resolveGameConfig(
  playerCount: number,
  configPreset: ConfigPreset,
  customRoleConfigEnabled: boolean,
  customRoleConfig: CustomRoleConfig
): Role[] {
  if (customRoleConfigEnabled) {
    const total = Object.values(customRoleConfig).reduce((sum, n) => sum + (n ?? 0), 0);
    if (total === playerCount) {
      return roleConfigToArray(customRoleConfig);
    }
  }
  return getRoleConfiguration(playerCount, configPreset);
}

/**
 * 预持久化的自定义角色数据（含头像、名称、性别、年龄、LLM 模型等完整信息）。
 * 当勾选/取消勾选角色、修改角色信息或变更角色模型时自动同步更新。
 * 开始游戏时直接使用此数据，无需再次从数据库查询或组装。
 */
const rawPersistedCustomCharactersAtom = atomWithStorage<CustomCharacterData[]>(
  "wolfcha.settings.custom_characters",
  []
);

// ========== 自动游戏配置 ==========

/** 自动游戏开关：开启后自动进行多局游戏 */
export const autoGameEnabledAtom = atomWithStorage<boolean>("wolfcha.settings.auto_game_enabled", false);

/** 自动游戏局数：最小 1，最大 99 */
const DEFAULT_AUTO_GAME_COUNT = 1;
const normalizeAutoGameCount = (value: number) => {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_GAME_COUNT;
  return Math.min(99, Math.max(1, Math.round(value)));
};

const rawAutoGameCountAtom = atomWithStorage<number>("wolfcha.settings.auto_game_count", DEFAULT_AUTO_GAME_COUNT);

export const autoGameCountAtom = atom(
  (get) => normalizeAutoGameCount(get(rawAutoGameCountAtom)),
  (get, set, update: number | ((prev: number) => number)) => {
    const prev = normalizeAutoGameCount(get(rawAutoGameCountAtom));
    const next = typeof update === "function" ? update(prev) : update;
    set(rawAutoGameCountAtom, normalizeAutoGameCount(next));
  }
);

/** 自动下载日志：每局结束时自动下载游戏日志 */
export const autoDownloadLogAtom = atomWithStorage<boolean>("wolfcha.settings.auto_download_log", false);

/** 自动下载回放：每局结束时自动下载回放记录 */
export const autoDownloadReplayAtom = atomWithStorage<boolean>("wolfcha.settings.auto_download_replay", false);

export const persistedCustomCharactersAtom = atom(
  (get) => get(rawPersistedCustomCharactersAtom),
  (get, set, update: CustomCharacterData[] | ((prev: CustomCharacterData[]) => CustomCharacterData[])) => {
    const prev = get(rawPersistedCustomCharactersAtom);
    const next = typeof update === "function" ? update(prev) : update;
    set(rawPersistedCustomCharactersAtom, next);
  }
);
