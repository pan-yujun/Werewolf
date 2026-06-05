/**
 * GameReplayRecorder — 游戏回放记录器
 *
 * 在游戏运行时被动采集所有关键事件，生成自包含的回放数据文件。
 * 使用回放数据可完整重现整局游戏过程。
 */

import { v4 as uuidv4 } from "uuid";
import type {
  GameReplayData,
  ReplayMeta,
  ReplayPlayer,
  ReplayEvent,
  ReplayEventData,
} from "@/types/replay";
import type {
  Role,
  Alignment,
  Phase,
  DifficultyLevel,
  GameScenario,
  GameState,
  Player,
  ModelRef,
  PlayerMind,
} from "@/types/game";
import { REPLAY_FORMAT_VERSION, REPLAY_STORAGE_PREFIX, REPLAY_INDEX_KEY, REPLAY_MAX_STORAGE } from "@/types/replay";

// ── SSR 安全 ──────────────────────────────────────────────

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

// ── 索引类型 ──────────────────────────────────────────────

export interface ReplayIndexItem {
  gameId: string;
  timestamp: number;
  duration: number;
  playerCount: number;
  result: "village_win" | "wolf_win";
  humanRole: Role;
  humanSeat: number;
  totalDays: number;
}

// ── Recorder 类 ──────────────────────────────────────────

export class GameReplayRecorder {
  private data: GameReplayData | null = null;
  private eventCounter = 0;

  /**
   * 记录器是否已通过 start() 初始化。
   *
   * 背景：游戏状态通过 gameStateAtom 持久化到 localStorage，页面刷新后可恢复。
   * 但 GameReplayRecorder 是纯内存对象，组件重挂载时会重新创建新实例（data = null）。
   * 如果不跟踪初始化状态，就无法在重挂载后判断记录器是否需要重新初始化，
   * 导致 finish() 因 data === null 静默跳过持久化，最终造成：
   *   1. 游戏结束界面"下载回放"按钮点击无反应（downloadJSON 发现 data 为 null 直接返回）
   *   2. 大厅游戏记录中无回放按钮（回放数据从未写入 localStorage）
   */
  private _started = false;

  // === 生命周期 ===

  /**
   * 查询记录器是否已初始化（即 start() 是否已被调用过）。
   * 用于 useGameLogic 中检测页面刷新后的恢复场景。
   */
  isStarted(): boolean {
    return this._started;
  }

  /** 游戏开始时调用，初始化 meta + players */
  start(config: ReplayMeta["config"], players: ReplayPlayer[]): void {
    this.eventCounter = 0;
    this._started = true;
    this.data = {
      meta: {
        gameId: "",
        version: REPLAY_FORMAT_VERSION,
        recordedAt: 0,
        startTime: Date.now(),
        endTime: 0,
        duration: 0,
        config,
        result: {
          winner: "village",
          humanRole: "Villager",
          humanSeat: 0,
          totalDays: 0,
        },
      },
      players,
      timeline: [],
      finalState: {
        badge: { holderSeat: null, history: {} },
        nightHistory: {},
        dayHistory: {},
        voteHistory: {},
        roleAbilities: {
          witchHealUsed: false,
          witchPoisonUsed: false,
          hunterCanShoot: true,
          idiotRevealed: false,
          whiteWolfKingBoomUsed: false,
        },
        dailySummaries: {},
      },
    };
  }

  /** 游戏结束时调用，写入终态并持久化 */
  finish(gameId: string, winner: Alignment, state: GameState): void {
    if (!this.data) return;

    const humanPlayer = state.players.find((p) => p.isHuman);
    this.data.meta.gameId = gameId;
    this.data.meta.endTime = Date.now();
    this.data.meta.duration = Math.round((this.data.meta.endTime - this.data.meta.startTime) / 1000);
    this.data.meta.recordedAt = Date.now();
    this.data.meta.result = {
      winner,
      humanRole: humanPlayer?.role ?? "Villager",
      humanSeat: humanPlayer?.seat ?? 0,
      totalDays: state.day,
    };

    // 写入终态快照
    this.data.finalState = {
      badge: this.buildBadgeFinalState(state),
      nightHistory: state.nightHistory ?? {},
      dayHistory: state.dayHistory ?? {},
      voteHistory: state.voteHistory,
      roleAbilities: { ...state.roleAbilities },
      dailySummaries: state.dailySummaries,
    };

    // GAME_END 事件
    this.pushEvent("GAME_END", {
      type: "GAME_END",
      winner,
      totalDays: state.day,
      finalPlayers: state.players.map((p) => ({
        seat: p.seat,
        alive: p.alive,
        role: p.role,
        deathDay: this.findDeathDay(p, state),
        deathCause: this.findDeathCause(p, state),
      })),
    });

    // 持久化
    this.persistToStorage();
  }

  /** 获取完整回放数据 */
  export(): GameReplayData | null {
    return this.data;
  }

  /** 序列化为 JSON 字符串 */
  exportJSON(): string | null {
    if (!this.data) return null;
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * 触发浏览器下载回放 JSON 文件。
   *
   * 修复点：
   * 1. 当 data 为 null 时打印警告日志，方便排查"点击下载无反应"的问题
   * 2. 将 <a> 元素先挂载到 document.body 再触发 click，兼容部分浏览器
   *    （某些浏览器对未挂载到 DOM 的 <a> 标签 click() 不生效）
   * 3. URL.revokeObjectURL 延迟 1 秒执行，避免浏览器还没开始读取 blob 就被释放的竞态问题
   *    （原代码在 a.click() 后立即 revoke，部分浏览器可能来不及启动下载）
   */
  downloadJSON(filename?: string): void {
    const json = this.exportJSON();
    if (!json) {
      // data 为 null 的典型场景：页面刷新后记录器被重新创建但未重新初始化
      console.warn("[wolfcha] downloadJSON: no replay data to download");
      return;
    }
    const name = filename ?? `wolfcha-replay-${this.data?.meta.gameId ?? "unknown"}.json`;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    // 挂载到 DOM 以确保 click 在所有浏览器中生效
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 延迟释放 blob URL，给浏览器足够时间启动下载流
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // === 阶段记录 ===

  recordPhaseEnter(phase: Phase, day: number): void {
    this.pushEvent("PHASE_ENTER", { type: "PHASE_ENTER", phase, day });
  }

  recordPhaseExit(phase: Phase): void {
    this.pushEvent("PHASE_EXIT", { type: "PHASE_EXIT", phase });
  }

  // === 夜晚行动记录 ===

  recordGuardProtect(guardSeat: number, targetSeat: number, isHuman: boolean): void {
    this.pushEvent("NIGHT_GUARD_PROTECT", {
      type: "NIGHT_GUARD_PROTECT",
      guardSeat,
      targetSeat,
      isHuman,
    });
  }

  recordWolfKill(wolfVotes: Array<{ wolfSeat: number; targetSeat: number; isHuman: boolean }>, finalTarget: number): void {
    this.pushEvent("NIGHT_WOLF_KILL", {
      type: "NIGHT_WOLF_KILL",
      wolfVotes,
      finalTarget,
    });
  }

  recordWitchSave(witchSeat: number, targetSeat: number, isHuman: boolean): void {
    this.pushEvent("NIGHT_WITCH_SAVE", {
      type: "NIGHT_WITCH_SAVE",
      witchSeat,
      targetSeat,
      isHuman,
    });
  }

  recordWitchPoison(witchSeat: number, targetSeat: number, isHuman: boolean): void {
    this.pushEvent("NIGHT_WITCH_POISON", {
      type: "NIGHT_WITCH_POISON",
      witchSeat,
      targetSeat,
      isHuman,
    });
  }

  recordWitchSkip(witchSeat: number, reason: "pass" | "no_potions"): void {
    this.pushEvent("NIGHT_WITCH_SKIP", {
      type: "NIGHT_WITCH_SKIP",
      witchSeat,
      reason,
    });
  }

  recordSeerCheck(seerSeat: number, targetSeat: number, result: "wolf" | "good", isHuman: boolean): void {
    this.pushEvent("NIGHT_SEER_CHECK", {
      type: "NIGHT_SEER_CHECK",
      seerSeat,
      targetSeat,
      result,
      isHuman,
    });
  }

  recordNightResolve(deaths: Array<{ seat: number; reason: "wolf" | "poison" | "milk" }>): void {
    this.pushEvent("NIGHT_RESOLVE", {
      type: "NIGHT_RESOLVE",
      deaths,
      isPeaceNight: deaths.length === 0,
    });
  }

  // === 白天记录 ===

  recordSpeechSegment(
    speakerSeat: number,
    speakerName: string,
    content: string,
    segmentIndex: number,
    isHuman: boolean,
    isLastWords: boolean,
  ): void {
    this.pushEvent("SPEECH_SEGMENT", {
      type: "SPEECH_SEGMENT",
      speakerSeat,
      speakerName,
      content,
      segmentIndex,
      isHuman,
      isLastWords,
    });
  }

  recordSystemAnnouncement(content: string): void {
    this.pushEvent("SYSTEM_ANNOUNCEMENT", { type: "SYSTEM_ANNOUNCEMENT", content });
  }

  recordDeathAnnouncement(
    deaths: Array<{ seat: number; name: string; reason: string }>,
    isPeaceNight: boolean,
  ): void {
    this.pushEvent("DEATH_ANNOUNCEMENT", {
      type: "DEATH_ANNOUNCEMENT",
      deaths,
      isPeaceNight,
    });
  }

  // === 投票记录 ===

  recordVoteCast(
    voterSeat: number,
    targetSeat: number,
    reason: string | undefined,
    isHuman: boolean,
    isSheriffVote: boolean,
  ): void {
    this.pushEvent("VOTE_CAST", {
      type: "VOTE_CAST",
      voterSeat,
      targetSeat,
      reason,
      isHuman,
      isSheriffVote,
    });
  }

  recordVoteResult(
    eliminated: number | null,
    voteDistribution: Record<string, number[]>,
    isTie: boolean,
    isPK: boolean,
    pkRound: number,
  ): void {
    this.pushEvent("VOTE_RESULT", {
      type: "VOTE_RESULT",
      eliminated,
      voteDistribution,
      isTie,
      isPK,
      pkRound,
    });
  }

  // === 警长竞选记录 ===

  recordBadgeSignupDecision(seat: number, signedUp: boolean, isHuman: boolean): void {
    this.pushEvent("BADGE_SIGNUP_DECISION", {
      type: "BADGE_SIGNUP_DECISION",
      seat,
      signedUp,
      isHuman,
    });
  }

  recordBadgeElectionVote(voterSeat: number, candidateSeat: number, isHuman: boolean): void {
    this.pushEvent("BADGE_ELECTION_VOTE", {
      type: "BADGE_ELECTION_VOTE",
      voterSeat,
      candidateSeat,
      isHuman,
    });
  }

  recordBadgeElected(seat: number, voteDistribution: Record<string, number[]>): void {
    this.pushEvent("BADGE_ELECTED", {
      type: "BADGE_ELECTED",
      seat,
      voteDistribution,
    });
  }

  recordBadgeTransfer(fromSeat: number, toSeat: number, isHuman: boolean): void {
    this.pushEvent("BADGE_TRANSFER", {
      type: "BADGE_TRANSFER",
      fromSeat,
      toSeat,
      isHuman,
    });
  }

  recordBadgeTorn(fromSeat: number, isHuman: boolean): void {
    this.pushEvent("BADGE_TORN", {
      type: "BADGE_TORN",
      fromSeat,
      isHuman,
    });
  }

  // === 特殊事件记录 ===

  recordHunterShoot(hunterSeat: number, targetSeat: number | null, diedAtNight: boolean, isHuman: boolean): void {
    this.pushEvent("HUNTER_SHOOT", {
      type: "HUNTER_SHOOT",
      hunterSeat,
      targetSeat,
      diedAtNight,
      isHuman,
    });
  }

  recordWhiteWolfKingBoom(wwkSeat: number, targetSeat: number, isHuman: boolean): void {
    this.pushEvent("WHITE_WOLF_KING_BOOM", {
      type: "WHITE_WOLF_KING_BOOM",
      wwkSeat,
      targetSeat,
      isHuman,
    });
  }

  recordIdiotRevealed(seat: number): void {
    this.pushEvent("IDIOT_REVEALED", { type: "IDIOT_REVEALED", seat });
  }

  // === 内部方法 ===

  private pushEvent(type: string, data: ReplayEventData): void {
    if (!this.data) return;
    const event: ReplayEvent = {
      id: uuidv4(),
      ts: Date.now(),
      day: this.data.meta.result.totalDays || 0,
      phase: "LOBBY" as Phase,
      type: type as ReplayEvent["type"],
      data,
    };
    this.data.timeline.push(event);
    this.eventCounter++;
  }

  /** 带 phase 和 day 参数的事件推送（供外部传入当前状态） */
  pushEventWithState(type: string, data: ReplayEventData, phase: Phase, day: number): void {
    if (!this.data) return;
    const event: ReplayEvent = {
      id: uuidv4(),
      ts: Date.now(),
      day,
      phase,
      type: type as ReplayEvent["type"],
      data,
    };
    this.data.timeline.push(event);
    this.eventCounter++;
  }

  private buildBadgeFinalState(state: GameState): GameReplayData["finalState"]["badge"] {
    const history: Record<number, { from: number; to: number; method: "elected" | "transfer" | "torn" }> = {};
    // 从 badge.history 中提取警长变迁记录
    for (const [dayStr, votes] of Object.entries(state.badge.history)) {
      const day = Number(dayStr);
      // 找出得票最多的人作为当选者
      const voteCounts: Record<number, number> = {};
      for (const targetSeat of Object.values(votes)) {
        voteCounts[targetSeat] = (voteCounts[targetSeat] ?? 0) + 1;
      }
      const winner = Object.entries(voteCounts).sort((a, b) => b[1] - a[1])[0];
      if (winner) {
        history[day] = { from: -1, to: Number(winner[0]), method: "elected" };
      }
    }
    return {
      holderSeat: state.badge.holderSeat,
      history,
    };
  }

  private findDeathDay(player: Player, state: GameState): number | undefined {
    // 在 nightHistory 中查找
    for (const [dayStr, record] of Object.entries(state.nightHistory ?? {})) {
      if (record.deaths?.some((d) => d.seat === player.seat)) {
        return Number(dayStr);
      }
    }
    // 在 dayHistory 中查找
    for (const [dayStr, record] of Object.entries(state.dayHistory ?? {})) {
      if (record.executed?.seat === player.seat) return Number(dayStr);
      if (record.hunterShot?.targetSeat === player.seat) return Number(dayStr);
      if (record.whiteWolfKingBoom?.targetSeat === player.seat) return Number(dayStr);
      if (record.whiteWolfKingBoom?.boomSeat === player.seat) return Number(dayStr);
    }
    return undefined;
  }

  private findDeathCause(player: Player, state: GameState): string | undefined {
    for (const record of Object.values(state.nightHistory ?? {})) {
      const death = record.deaths?.find((d) => d.seat === player.seat);
      if (death) return death.reason;
    }
    for (const record of Object.values(state.dayHistory ?? {})) {
      if (record.executed?.seat === player.seat) return "exiled";
      if (record.hunterShot?.targetSeat === player.seat) return "shot";
      if (record.whiteWolfKingBoom?.targetSeat === player.seat) return "boom";
      if (record.whiteWolfKingBoom?.boomSeat === player.seat) return "boom";
    }
    return undefined;
  }

  // === 持久化 ===

  private persistToStorage(): void {
    if (!this.data || !canUseStorage()) return;
    const gameId = this.data.meta.gameId;
    try {
      // 保存完整数据
      window.localStorage.setItem(
        `${REPLAY_STORAGE_PREFIX}${gameId}`,
        JSON.stringify(this.data),
      );

      // 更新索引
      const index = this.readIndex();
      const item: ReplayIndexItem = {
        gameId,
        timestamp: this.data.meta.recordedAt,
        duration: this.data.meta.duration,
        playerCount: this.data.meta.config.playerCount,
        result: this.data.meta.result.winner === "village" ? "village_win" : "wolf_win",
        humanRole: this.data.meta.result.humanRole,
        humanSeat: this.data.meta.result.humanSeat,
        totalDays: this.data.meta.result.totalDays,
      };
      const existing = index.findIndex((i) => i.gameId === gameId);
      if (existing >= 0) {
        index[existing] = item;
      } else {
        index.unshift(item);
      }

      // LRU 淘汰
      while (index.length > REPLAY_MAX_STORAGE) {
        const removed = index.pop();
        if (removed) {
          window.localStorage.removeItem(`${REPLAY_STORAGE_PREFIX}${removed.gameId}`);
        }
      }
      window.localStorage.setItem(REPLAY_INDEX_KEY, JSON.stringify(index));
    } catch (err) {
      // localStorage 满或不可用时记录警告（原代码静默失败，排查问题时无任何线索）
      // 常见触发场景：localStorage 配额耗尽（通常为 5-10MB）、隐私模式下不可用
      console.warn("[wolfcha] Failed to persist replay to localStorage:", err);
    }
  }

  private readIndex(): ReplayIndexItem[] {
    if (!canUseStorage()) return [];
    try {
      const raw = window.localStorage.getItem(REPLAY_INDEX_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

// ── 静态工具函数 ──────────────────────────────────────────

/** 从 Player 数组构建 ReplayPlayer 数组 */
export function buildReplayPlayers(players: Player[]): ReplayPlayer[] {
  return players.map((p) => ({
    playerId: p.playerId,
    seat: p.seat,
    displayName: p.displayName,
    avatarSeed: p.avatarSeed,
    role: p.role,
    alignment: p.alignment,
    isHuman: p.isHuman,
    agentProfile: p.agentProfile
      ? {
          model: p.agentProfile.modelRef,
          persona: {
            mbti: p.agentProfile.persona.mbti,
            gender: p.agentProfile.persona.gender,
            age: p.agentProfile.persona.age,
            styleLabel: p.agentProfile.persona.styleLabel,
            voiceRules: p.agentProfile.persona.voiceRules,
            basicInfo: p.agentProfile.persona.basicInfo,
          },
          playerMind: p.agentProfile.playerMind,
        }
      : undefined,
  }));
}

/** 从 GameState 提取游戏配置 */
export function buildReplayConfig(state: GameState): ReplayMeta["config"] {
  return {
    playerCount: state.players.length,
    difficulty: state.difficulty,
    isGenshinMode: state.isGenshinMode ?? false,
    isSpectatorMode: state.isSpectatorMode ?? false,
    scenario: state.scenario,
    roleDistribution: state.players.map((p) => p.role),
  };
}

// ── 回放数据读取 ──────────────────────────────────────────

/** 从 localStorage 读取回放索引 */
export function getReplayIndex(): ReplayIndexItem[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(REPLAY_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 从 localStorage 读取完整回放数据 */
export function getReplayById(gameId: string): GameReplayData | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(`${REPLAY_STORAGE_PREFIX}${gameId}`);
    if (!raw) return null;
    return JSON.parse(raw) as GameReplayData;
  } catch {
    return null;
  }
}

/** 删除指定回放 */
export function deleteReplay(gameId: string): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(`${REPLAY_STORAGE_PREFIX}${gameId}`);
    const index = getReplayIndex().filter((i) => i.gameId !== gameId);
    window.localStorage.setItem(REPLAY_INDEX_KEY, JSON.stringify(index));
  } catch {
    // 静默失败
  }
}

/** 清空所有回放 */
export function clearAllReplays(): void {
  if (!canUseStorage()) return;
  try {
    const index = getReplayIndex();
    for (const item of index) {
      window.localStorage.removeItem(`${REPLAY_STORAGE_PREFIX}${item.gameId}`);
    }
    window.localStorage.removeItem(REPLAY_INDEX_KEY);
  } catch {
    // 静默失败
  }
}

/** 从 JSON 字符串导入回放数据到 localStorage，返回 gameId 或 null */
export function importReplayFromJSON(json: string): string | null {
  if (!canUseStorage()) return null;
  try {
    const data = JSON.parse(json) as GameReplayData;
    if (!data.meta?.gameId || !data.players || !data.timeline) return null;
    const gameId = data.meta.gameId;
    // 保存完整数据
    window.localStorage.setItem(`${REPLAY_STORAGE_PREFIX}${gameId}`, JSON.stringify(data));
    // 更新索引
    const index = getReplayIndex();
    const item: ReplayIndexItem = {
      gameId,
      timestamp: data.meta.recordedAt ?? data.meta.endTime ?? Date.now(),
      duration: data.meta.duration ?? 0,
      playerCount: data.meta.config?.playerCount ?? data.players.length,
      result: data.meta.result?.winner === "village" ? "village_win" : "wolf_win",
      humanRole: data.meta.result?.humanRole ?? "Villager",
      humanSeat: data.meta.result?.humanSeat ?? 0,
      totalDays: data.meta.result?.totalDays ?? 0,
    };
    const existing = index.findIndex((i) => i.gameId === gameId);
    if (existing >= 0) {
      index[existing] = item;
    } else {
      index.unshift(item);
    }
    // LRU 淘汰
    while (index.length > REPLAY_MAX_STORAGE) {
      const removed = index.pop();
      if (removed) {
        window.localStorage.removeItem(`${REPLAY_STORAGE_PREFIX}${removed.gameId}`);
      }
    }
    window.localStorage.setItem(REPLAY_INDEX_KEY, JSON.stringify(index));
    return gameId;
  } catch {
    return null;
  }
}
