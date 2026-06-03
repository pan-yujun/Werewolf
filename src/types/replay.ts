import type { Role, Alignment, Phase, DifficultyLevel, GameScenario, ModelRef, PlayerMind } from "./game";

// ============================================================
// ReplayMeta — 游戏元数据
// ============================================================

export interface ReplayMeta {
  gameId: string;
  version: number;
  recordedAt: number;
  startTime: number;
  endTime: number;
  duration: number;
  config: {
    playerCount: number;
    difficulty: DifficultyLevel;
    isGenshinMode: boolean;
    isSpectatorMode: boolean;
    scenario?: GameScenario;
    roleDistribution: Role[];
  };
  result: {
    winner: Alignment;
    humanRole: Role;
    humanSeat: number;
    totalDays: number;
  };
}

// ============================================================
// ReplayPlayer — 玩家信息快照
// ============================================================

export interface ReplayPlayer {
  playerId: string;
  seat: number;
  displayName: string;
  avatarSeed?: string;
  role: Role;
  alignment: Alignment;
  isHuman: boolean;
  agentProfile?: {
    model: ModelRef;
    persona: {
      mbti: string;
      gender: string;
      age: number;
      styleLabel?: string;
      voiceRules: string[];
      basicInfo?: string;
    };
    playerMind?: PlayerMind;
  };
}

// ============================================================
// ReplayEventType — 事件类型枚举
// ============================================================

export type ReplayEventType =
  // 游戏生命周期
  | "GAME_START"
  | "GAME_END"
  // 阶段转换
  | "PHASE_ENTER"
  | "PHASE_EXIT"
  // 夜晚行动
  | "NIGHT_GUARD_PROTECT"
  | "NIGHT_WOLF_KILL"
  | "NIGHT_WITCH_SAVE"
  | "NIGHT_WITCH_POISON"
  | "NIGHT_WITCH_SKIP"
  | "NIGHT_SEER_CHECK"
  | "NIGHT_RESOLVE"
  // 白天发言
  | "SPEECH_SEGMENT"
  // 投票
  | "VOTE_CAST"
  | "VOTE_RESULT"
  // 警长竞选
  | "BADGE_SIGNUP_DECISION"
  | "BADGE_ELECTION_VOTE"
  | "BADGE_ELECTED"
  | "BADGE_TRANSFER"
  | "BADGE_TORN"
  // 特殊事件
  | "HUNTER_SHOOT"
  | "WHITE_WOLF_KING_BOOM"
  | "IDIOT_REVEALED"
  // 系统公告
  | "SYSTEM_ANNOUNCEMENT"
  | "DEATH_ANNOUNCEMENT";

// ============================================================
// ReplayEventData — 各事件的数据载荷
// ============================================================

export interface GameStartData {
  type: "GAME_START";
  config: ReplayMeta["config"];
  players: ReplayPlayer[];
}

export interface GameEndData {
  type: "GAME_END";
  winner: Alignment;
  totalDays: number;
  finalPlayers: Array<{
    seat: number;
    alive: boolean;
    role: Role;
    deathDay?: number;
    deathCause?: string;
  }>;
}

export interface PhaseEnterData {
  type: "PHASE_ENTER";
  phase: Phase;
  day: number;
}

export interface PhaseExitData {
  type: "PHASE_EXIT";
  phase: Phase;
}

export interface GuardProtectData {
  type: "NIGHT_GUARD_PROTECT";
  guardSeat: number;
  targetSeat: number;
  isHuman: boolean;
}

export interface WolfKillData {
  type: "NIGHT_WOLF_KILL";
  wolfVotes: Array<{
    wolfSeat: number;
    targetSeat: number;
    isHuman: boolean;
  }>;
  finalTarget: number;
}

export interface WitchSaveData {
  type: "NIGHT_WITCH_SAVE";
  witchSeat: number;
  targetSeat: number;
  isHuman: boolean;
}

export interface WitchPoisonData {
  type: "NIGHT_WITCH_POISON";
  witchSeat: number;
  targetSeat: number;
  isHuman: boolean;
}

export interface WitchSkipData {
  type: "NIGHT_WITCH_SKIP";
  witchSeat: number;
  reason: "pass" | "no_potions";
}

export interface SeerCheckData {
  type: "NIGHT_SEER_CHECK";
  seerSeat: number;
  targetSeat: number;
  result: "wolf" | "good";
  isHuman: boolean;
}

export interface NightResolveData {
  type: "NIGHT_RESOLVE";
  deaths: Array<{
    seat: number;
    reason: "wolf" | "poison" | "milk";
  }>;
  isPeaceNight: boolean;
}

export interface SpeechSegmentData {
  type: "SPEECH_SEGMENT";
  speakerSeat: number;
  speakerName: string;
  content: string;
  segmentIndex: number;
  isHuman: boolean;
  isLastWords: boolean;
}

export interface VoteCastData {
  type: "VOTE_CAST";
  voterSeat: number;
  targetSeat: number;
  reason?: string;
  isHuman: boolean;
  isSheriffVote: boolean;
}

export interface VoteResultData {
  type: "VOTE_RESULT";
  eliminated: number | null;
  voteDistribution: Record<string, number[]>;
  isTie: boolean;
  isPK: boolean;
  pkRound: number;
}

export interface BadgeSignupDecisionData {
  type: "BADGE_SIGNUP_DECISION";
  seat: number;
  signedUp: boolean;
  isHuman: boolean;
}

export interface BadgeElectionVoteData {
  type: "BADGE_ELECTION_VOTE";
  voterSeat: number;
  candidateSeat: number;
  isHuman: boolean;
}

export interface BadgeElectedData {
  type: "BADGE_ELECTED";
  seat: number;
  voteDistribution: Record<string, number[]>;
}

export interface BadgeTransferData {
  type: "BADGE_TRANSFER";
  fromSeat: number;
  toSeat: number;
  isHuman: boolean;
}

export interface BadgeTornData {
  type: "BADGE_TORN";
  fromSeat: number;
  isHuman: boolean;
}

export interface HunterShootData {
  type: "HUNTER_SHOOT";
  hunterSeat: number;
  targetSeat: number | null;
  diedAtNight: boolean;
  isHuman: boolean;
}

export interface WhiteWolfKingBoomData {
  type: "WHITE_WOLF_KING_BOOM";
  wwkSeat: number;
  targetSeat: number;
  isHuman: boolean;
}

export interface IdiotRevealedData {
  type: "IDIOT_REVEALED";
  seat: number;
}

export interface SystemAnnouncementData {
  type: "SYSTEM_ANNOUNCEMENT";
  content: string;
}

export interface DeathAnnouncementData {
  type: "DEATH_ANNOUNCEMENT";
  deaths: Array<{
    seat: number;
    name: string;
    reason: string;
  }>;
  isPeaceNight: boolean;
}

/** 联合类型：所有可能的事件数据 */
export type ReplayEventData =
  | GameStartData
  | GameEndData
  | PhaseEnterData
  | PhaseExitData
  | GuardProtectData
  | WolfKillData
  | WitchSaveData
  | WitchPoisonData
  | WitchSkipData
  | SeerCheckData
  | NightResolveData
  | SpeechSegmentData
  | VoteCastData
  | VoteResultData
  | BadgeSignupDecisionData
  | BadgeElectionVoteData
  | BadgeElectedData
  | BadgeTransferData
  | BadgeTornData
  | HunterShootData
  | WhiteWolfKingBoomData
  | IdiotRevealedData
  | SystemAnnouncementData
  | DeathAnnouncementData;

// ============================================================
// ReplayEvent — 时间线事件
// ============================================================

export interface ReplayEvent {
  id: string;
  ts: number;
  day: number;
  phase: Phase;
  type: ReplayEventType;
  data: ReplayEventData;
}

// ============================================================
// GameReplayData — 顶层回放数据
// ============================================================

export interface GameReplayData {
  meta: ReplayMeta;
  players: ReplayPlayer[];
  timeline: ReplayEvent[];
  finalState: {
    badge: {
      holderSeat: number | null;
      history: Record<number, { from: number; to: number; method: "elected" | "transfer" | "torn" }>;
    };
    nightHistory: Record<
      number,
      {
        guardTarget?: number;
        wolfTarget?: number;
        witchSave?: boolean;
        witchPoison?: number;
        seerTarget?: number;
        seerResult?: { targetSeat: number; isWolf: boolean };
        deaths?: Array<{ seat: number; reason: "wolf" | "poison" | "milk" }>;
        hunterShot?: { hunterSeat: number; targetSeat: number };
      }
    >;
    dayHistory: Record<
      number,
      {
        executed?: { seat: number; votes: number };
        voteTie?: boolean;
        hunterShot?: { hunterSeat: number; targetSeat: number };
        whiteWolfKingBoom?: { boomSeat: number; targetSeat: number };
        idiotRevealed?: { seat: number };
      }
    >;
    voteHistory: Record<number, Record<string, number>>;
    roleAbilities: {
      witchHealUsed: boolean;
      witchPoisonUsed: boolean;
      hunterCanShoot: boolean;
      idiotRevealed: boolean;
      whiteWolfKingBoomUsed: boolean;
    };
    dailySummaries: Record<number, string[]>;
  };
}

/** 回放格式版本号 */
export const REPLAY_FORMAT_VERSION = 1;

/** localStorage key 前缀 */
export const REPLAY_STORAGE_PREFIX = "wolfcha_replay_";

/** localStorage 索引 key */
export const REPLAY_INDEX_KEY = "wolfcha_replay_index";

/** 最大存储回放数量 */
export const REPLAY_MAX_STORAGE = 5;
