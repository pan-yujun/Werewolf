"use client";

/**
 * @file useBadgePhase.ts
 * @description 警长竞选阶段 Hook
 *
 * 本文件负责管理狼人杀游戏中完整的警长竞选流程，包括：
 * 1. 报名阶段（Badge Signup）：所有存活玩家决定是否参选警长
 * 2. 发言阶段（Badge Speech）：参选者依次发表竞选演说
 * 3. 投票阶段（Badge Election）：非参选者投票选出警长
 * 4. PK 平票处理：当出现票数最高相同的情况时，进入 PK 发言并重新投票
 * 5. 警徽移交（Badge Transfer）：警长死亡时决定将警徽移交给其他玩家或撕毁
 *
 * 该 Hook 通过 BadgePhaseCallbacks 接收外部依赖（对话控制、回放记录等），
 * 返回 BadgePhaseActions 接口供上层游戏逻辑调用。
 */

import { useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { getI18n } from "@/i18n/translator";
import type { GameState, Player } from "@/types/game";
import { gameStateAtom } from "@/store/game-machine";
import {
  transitionPhase,
  addSystemMessage,
  generateAIBadgeVote,
  generateAIBadgeSignupBatch,
  generateBadgeTransfer,
  BADGE_VOTE_ABSTAIN,
  BADGE_TRANSFER_TORN,
} from "@/lib/game-master";
import { getSystemMessages, getUiText } from "@/lib/game-texts";
import { DELAY_CONFIG, GAME_CONFIG } from "@/lib/game-constants";
import { delay, type FlowToken } from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { gameLogger, fmtPlayer } from "@/lib/game-logger";

/**
 * 警长竞选阶段的回调接口
 * 由上层 Hook（如 useGameLogic）注入，用于解耦 UI 控制、AI 发言和回放记录
 */
export interface BadgePhaseCallbacks {
  /** 设置当前对话框显示内容（角色名、台词、是否流式输出） */
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  /** 清除对话框内容 */
  clearDialogue: () => void;
  /** 设置是否正在等待 AI 响应（用于 UI 显示加载状态） */
  setIsWaitingForAI: (waiting: boolean) => void;
  /** 等待游戏从暂停状态恢复（用户点击继续按钮） */
  waitForUnpause: () => Promise<void>;
  /** 检查 FlowToken 是否仍然有效（用于在异步操作后判断流程是否被中断） */
  isTokenValid: (token: FlowToken) => boolean;
  /** 警长竞选结算完成后的回调（进入下一阶段） */
  onBadgeElectionComplete: (state: GameState) => Promise<void>;
  /** 警徽移交完成后的回调（继续游戏流程） */
  onBadgeTransferComplete: (state: GameState) => Promise<void>;
  /** 执行 AI 玩家的发言（调用 LLM 生成台词并播放） */
  runAISpeech: (state: GameState, player: Player) => Promise<void>;
  /** 回放记录回调（可选）：记录警长报名决策 */
  onRecordBadgeSignupDecision?: (seat: number, signedUp: boolean, isHuman: boolean, day: number) => void;
  /** 回放记录回调（可选）：记录警长竞选投票 */
  onRecordBadgeElectionVote?: (voterSeat: number, candidateSeat: number, isHuman: boolean, day: number) => void;
  /** 回放记录回调（可选）：记录警长当选结果（含投票分布） */
  onRecordBadgeElected?: (seat: number, voteDistribution: Record<string, number[]>, day: number) => void;
  /** 回放记录回调（可选）：记录警徽移交 */
  onRecordBadgeTransfer?: (fromSeat: number, toSeat: number, isHuman: boolean, phase: string, day: number) => void;
  /** 回放记录回调（可选）：记录警徽被撕毁 */
  onRecordBadgeTorn?: (fromSeat: number, isHuman: boolean, phase: string, day: number) => void;
}

/**
 * 警长竞选阶段对外暴露的 7 个操作方法
 * 上层游戏逻辑通过这些方法驱动整个竞选流程
 */
export interface BadgePhaseActions {
  /** 开始报名阶段：初始化报名状态，同时启动 AI 报名决策 */
  startBadgeSignupPhase: (state: GameState) => Promise<void>;
  /** 开始发言阶段：所有参选者依次发表竞选演说 */
  startBadgeSpeechPhase: (state: GameState) => Promise<void>;
  /** 开始投票阶段：非参选者投票，支持 isRevote 标记是否为 PK 重投 */
  startBadgeElectionPhase: (state: GameState, options?: { isRevote?: boolean }) => Promise<void>;
  /** 恢复报名阶段（页面刷新后恢复游戏状态时使用） */
  resumeBadgeSignupPhase: (state: GameState) => Promise<void>;
  /** 人类玩家的报名决策（参选或不参选） */
  handleBadgeSignup: (wants: boolean) => Promise<void>;
  /** 警徽移交流程（支持 AI 和人类警长，撕毁或移交） */
  handleBadgeTransfer: (state: GameState, sheriff: Player, afterTransfer: (s: GameState) => Promise<void>) => Promise<void>;
  /** 人类警长选择移交对象（指定座位号或撕毁） */
  handleHumanBadgeTransfer: (targetSeat: number) => Promise<void>;
  /** 尝试结算警长竞选投票（计票、判断平票、确定当选者） */
  maybeResolveBadgeElection: (state: GameState) => Promise<void>;
}

/**
 * 警长竞选阶段 Hook
 * 负责管理警长竞选报名、发言、投票、PK 平票处理、警徽移交等完整流程
 *
 * @param callbacks - 外部注入的回调集合（对话控制、回放记录等）
 * @returns BadgePhaseActions - 7 个操作方法供上层调用
 */
export function useBadgePhase(
  callbacks: BadgePhaseCallbacks
): BadgePhaseActions {
  /** 获取当前语言环境下的所有文本资源（系统消息、UI 文本、角色名等） */
  const getTexts = () => {
    const { t } = getI18n();
    return {
      t,
      systemMessages: getSystemMessages(),
      uiText: getUiText(),
      speakerHost: t("speakers.host"),
      speakerHint: t("speakers.hint"),
      speakerSystem: t("speakers.system"),
    };
  };
  /** 全局游戏状态原子，用于读写当前游戏状态 */
  const [gameState, setGameState] = useAtom(gameStateAtom);

  // 从回调中解构出所有依赖，方便后续各函数直接调用
  const {
    setDialogue,         // 设置对话框内容
    clearDialogue,       // 清除对话框
    setIsWaitingForAI,   // 控制 AI 等待状态
    waitForUnpause,      // 等待暂停恢复
    isTokenValid,        // 检查流程令牌有效性
    onBadgeElectionComplete,  // 竞选结算回调
    onBadgeTransferComplete,  // 移交完成回调
    runAISpeech,         // AI 发言执行器
    onRecordBadgeSignupDecision,  // 回放：报名决策
    onRecordBadgeElectionVote,    // 回放：竞选投票
    onRecordBadgeElected,         // 回放：当选结果
    onRecordBadgeTransfer,        // 回放：警徽移交
    onRecordBadgeTorn,            // 回放：警徽撕毁
  } = callbacks;

  /**
   * 使用 ref 打破循环依赖：
   * startBadgeSpeechPhase 和 maybeStartBadgeSpeechAfterSignup 之间存在互相引用，
   * 通过 ref 在函数定义后动态赋值来解决
   */
  const startBadgeSpeechPhaseRef = useRef<(state: GameState) => Promise<void>>(async () => {});
  const maybeStartBadgeSpeechAfterSignupRef = useRef<(state: GameState) => Promise<void>>(async () => {});

  /** 人类警长移交时的回调暂存：人类玩家需要 UI 交互选择移交对象，回调需要跨渲染周期保存 */
  const humanBadgeTransferCallbackRef = useRef<((state: GameState) => Promise<void>) | null>(null);

  /**
   * 始终指向最新游戏状态的 ref：
   * 在 AI 投票循环等异步操作中，React state 可能已过时，
   * 通过此 ref 可以获取最新的 gameState 以避免覆盖其他操作的更新
   */
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;
  /** 防止 AI 报名并发执行的 Promise 引用（去重机制） */
  const aiSignupPromiseRef = useRef<Promise<GameState> | null>(null);

  /**
   * 生成警长投票详情的结构化 JSON 字符串
   *
   * 该函数将原始投票数据（voterId -> targetSeat）转换为按被投票者分组的展示格式，
   * 输出格式为 `[VOTE_RESULT]{...}`，前端通过前缀识别并渲染投票详情面板。
   *
   * 处理逻辑：
   * 1. 过滤：只保留存活投票者投给存活且有效候选人的票
   * 2. 分组：按被投票者座位号聚合投票者列表
   * 3. 排序：按得票数从高到低排列
   * 4. 序列化：生成包含标题和结果数组的 JSON
   *
   * @param votes - 原始投票映射 { 投票者playerId -> 被投票者座位号 }
   * @param players - 所有玩家列表（用于查找名称和判断存活状态）
   * @param candidates - 候选人座位号列表（为空时不限制被投票者范围）
   * @returns 格式化的投票详情字符串，如 `[VOTE_RESULT]{"title":"...","results":[...]}`
   */
  const generateBadgeVoteDetails = useCallback((
    votes: Record<string, number>,
    players: Player[],
    candidates: number[] = []
  ): string => {
    const { t } = getI18n();
    // 构建存活玩家的快速查找集合
    const aliveById = new Set(players.filter((p) => p.alive).map((p) => p.playerId));
    const aliveBySeat = new Set(players.filter((p) => p.alive).map((p) => p.seat));
    const candidateSet = new Set(candidates);
    // 按被投票者座位号分组：{ 被投票者座位号 -> [投票者座位号, ...] }
    const badgeVoteGroups: Record<number, number[]> = {};
    Object.entries(votes).forEach(([playerId, targetSeat]) => {
      // 跳过已死亡投票者的票
      if (!aliveById.has(playerId)) return;
      // 跳过投给已死亡玩家的票
      if (!aliveBySeat.has(targetSeat)) return;
      // 如果指定了候选人列表，跳过投给非候选人的票
      if (candidateSet.size > 0 && !candidateSet.has(targetSeat)) return;
      const voter = players.find(p => p.playerId === playerId);
      if (voter) {
        if (!badgeVoteGroups[targetSeat]) badgeVoteGroups[targetSeat] = [];
        badgeVoteGroups[targetSeat].push(voter.seat);
      }
    });

    // 将分组结果转换为排序后的展示数组
    const badgeVoteResults = Object.entries(badgeVoteGroups)
      .sort(([, votersA], [, votersB]) => votersB.length - votersA.length)
      .map(([targetSeat, voters]) => {
        const target = players.find(p => p.seat === Number(targetSeat));
        return {
          targetSeat: Number(targetSeat),
          targetName: target?.displayName || t("common.unknown"),
          voterSeats: voters,
          voteCount: voters.length
        };
      });

    // 返回带前缀的 JSON 字符串，前端据此渲染投票详情面板
    return `[VOTE_RESULT]${JSON.stringify({ title: t("badgePhase.voteDetailTitle"), results: badgeVoteResults })}`;
  }, []);

 /** 防止重复结算的标志：在异步结算过程中阻止多次触发 */
  const isResolvingBadgeElectionRef = useRef(false);

  /**
   * 开始警徽 PK 发言
   *
   * 当警长竞选投票出现平票（多人并列最高票）时，触发 PK 流程：
   * 1. 将游戏阶段切换为 DAY_PK_SPEECH
   * 2. 设置 PK 来源为 "badge"（区别于白天发言投票的 PK）
   * 3. 重置候选人为平票者，清空当前轮投票
   * 4. 播放平票提示消息，等待用户确认后开始 PK 发言
   * 5. 第一位 PK 发言者如果是 AI 则自动发言，如果是人类则提示轮次
   *
   * @param state - 当前游戏状态
   * @param pkTargets - 平票者的座位号列表
   */
  const startBadgePkSpeech = useCallback(async (state: GameState, pkTargets: number[]) => {
    const texts = getTexts();
    let currentState = transitionPhase(state, "DAY_PK_SPEECH");
    const firstSeat = pkTargets[0] ?? null;
    currentState = {
      ...currentState,
      pkTargets,
      pkSource: "badge",
      currentSpeakerSeat: firstSeat,
      daySpeechStartSeat: firstSeat,
      badge: {
        ...currentState.badge,
        candidates: pkTargets,
        votes: {},
      },
    };
    currentState = addSystemMessage(currentState, texts.t("badgePhase.tiePk"));
    setGameState(currentState);
    setDialogue(texts.speakerHost, texts.t("badgePhase.tiePk"), false);

    await delay(DELAY_CONFIG.DIALOGUE);
    await waitForUnpause();

    const firstSpeaker = currentState.players.find((p) => p.seat === firstSeat);
    if (firstSpeaker && !firstSpeaker.isHuman) {
      await runAISpeech(currentState, firstSpeaker);
    } else if (firstSpeaker?.isHuman) {
      setDialogue(texts.speakerHint, texts.uiText.yourTurn, false);
    }
  }, [setGameState, setDialogue, waitForUnpause, runAISpeech]);

  /**
   * 尝试结算警长竞选投票
   *
   * 完整的选举结算流程：
   * 1. 前置检查：确认处于投票阶段、未在结算中、警长尚未选出
   * 2. 计票：遍历所有有效投票，按候选人统计得票数（过滤已死亡玩家和无效票）
   * 3. 判断结果：
   *    - 唯一最高票 -> 该候选人当选警长，记录投票历史，触发 onBadgeElectionComplete
   *    - 多人平票 ->
   *      a. 首次平票：进入 PK 发言流程（startBadgePkSpeech），累积当前轮投票到 allVotes
   *      b. 第二次仍平票：达到最大重投次数（GAME_CONFIG.MAX_BADGE_REVOTE_COUNT），警徽被撕毁，本局无警长
   * 4. 结算完成后重置 isResolvingBadgeElectionRef 标志
   *
   * @param state - 当前游戏状态
   */
  const maybeResolveBadgeElection = useCallback(async (state: GameState) => {
    const texts = getTexts();
    if (state.phase !== "DAY_BADGE_ELECTION") return;
    
    // 防止重复结算
    if (isResolvingBadgeElectionRef.current) return;
    
    // 如果警长已经选出，不再结算
    if (state.badge.holderSeat !== null) return;

    const candidates = state.badge.candidates || [];
    const voters = state.players.filter((p) => p.alive && !candidates.includes(p.seat));
    const voterIds = voters.map((p) => p.playerId);
    const allVoted = voterIds.every((id) => typeof state.badge.votes[id] === "number");
    if (!allVoted) return;
    
    // 设置结算中标志
    isResolvingBadgeElectionRef.current = true;

    // 计票
    const aliveById = new Set(state.players.filter((p) => p.alive).map((p) => p.playerId));
    const aliveBySeat = new Set(state.players.filter((p) => p.alive).map((p) => p.seat));
    const candidateSet = new Set(candidates);
    const counts: Record<number, number> = {};
    for (const [voterId, seat] of Object.entries(state.badge.votes)) {
      if (!aliveById.has(voterId)) continue;
      if (!aliveBySeat.has(seat)) continue;
      if (candidateSet.size > 0 && !candidateSet.has(seat)) continue;
      counts[seat] = (counts[seat] || 0) + 1;
    }
    const entries = Object.entries(counts);
    let max = -1;
    for (const [, c] of entries) max = Math.max(max, c);
    const topSeats = entries.filter(([, c]) => c === max).map(([s]) => Number(s));

    // === 平票处理 ===
    if (topSeats.length !== 1) {
      const revoteCount = (state.badge.revoteCount || 0) + 1;

      // 第二轮仍平票：自动撕毁（本局无警长）
      if (revoteCount >= GAME_CONFIG.MAX_BADGE_REVOTE_COUNT) {
        // 日志记录：连续平票导致警徽撕毁（关键游戏事件）
        gameLogger.flow("警长竞选连续平票，警徽被撕毁，本局无警长");
        // 添加投票详情
        const badgeVoteDetailMessage = generateBadgeVoteDetails(state.badge.votes, state.players, state.badge.candidates || []);

        const badgeTieTearMessage = texts.t("badgePhase.tieTear" as never);

        // 合并所有轮次的投票保存到历史
        const finalVotes = { ...state.badge.allVotes, ...state.badge.votes };
        let nextState: GameState = {
          ...state,
          badge: {
            ...state.badge,
            holderSeat: null,
            votes: {},
            allVotes: {},
            candidates: [],
            revoteCount,
            history: { ...state.badge.history, [state.day]: finalVotes },
          },
        };

        nextState = addSystemMessage(nextState, badgeVoteDetailMessage);
        nextState = addSystemMessage(nextState, badgeTieTearMessage);

        setGameState(nextState);

        // 记录撕毁警徽到回放
        onRecordBadgeTorn?.(-1, false, "DAY_BADGE_ELECTION", state.day);
        setDialogue(texts.speakerHost, badgeTieTearMessage, false);

        await delay(DELAY_CONFIG.DIALOGUE);
        isResolvingBadgeElectionRef.current = false;
        await onBadgeElectionComplete(nextState);
        return;
      }

      // 进入 PK 发言：累积当前轮投票到 allVotes，为下一轮投票做准备
      isResolvingBadgeElectionRef.current = false;
      const nextState: GameState = {
        ...state,
        badge: {
          ...state.badge,
          votes: {},
          allVotes: { ...state.badge.allVotes, ...state.badge.votes },
          revoteCount,
          candidates: topSeats,
        },
      };
      await startBadgePkSpeech(nextState, topSeats);
      return;
    }

    // === 唯一最高票：当选警长 ===
    const winnerSeat = topSeats[0];
    const winner = state.players.find((p) => p.seat === winnerSeat);
    const votedCount = counts[winnerSeat] || 0;

    // 日志记录：新警长当选（座位号、显示名、得票数）
    gameLogger.badgeElected(winnerSeat, winner?.displayName || "");

    // 合并所有轮次的投票（包括 PK 轮）保存到历史
    const finalVotes = { ...state.badge.allVotes, ...state.badge.votes };
    let nextState: GameState = {
      ...state,
      badge: {
        ...state.badge,
        holderSeat: winnerSeat,
        allVotes: {},
        history: { ...state.badge.history, [state.day]: finalVotes },
      },
    };

    // 添加投票详情
    const badgeVoteDetailMessage = generateBadgeVoteDetails(state.badge.votes, state.players, state.badge.candidates || []);
    nextState = addSystemMessage(nextState, badgeVoteDetailMessage);
    nextState = addSystemMessage(nextState, texts.systemMessages.badgeElected(winnerSeat + 1, winner?.displayName || "", votedCount));

    setGameState(nextState);

    // 记录警长当选到回放
    const voteDistForRecord: Record<string, number[]> = {};
    for (const [voterId, targetSeat] of Object.entries(state.badge.votes)) {
      const k = String(targetSeat);
      if (!voteDistForRecord[k]) voteDistForRecord[k] = [];
      const voter = state.players.find((p) => p.playerId === voterId);
      if (voter) voteDistForRecord[k].push(voter.seat);
    }
    onRecordBadgeElected?.(winnerSeat, voteDistForRecord, state.day);

    setDialogue(texts.speakerHost, texts.systemMessages.badgeElected(winnerSeat + 1, winner?.displayName || "", votedCount), false);

    await delay(DELAY_CONFIG.DIALOGUE);
    isResolvingBadgeElectionRef.current = false;
    await onBadgeElectionComplete(nextState);
  }, [setGameState, setDialogue, generateBadgeVoteDetails, onBadgeElectionComplete]);

  /**
   * AI 玩家的批量报名决策
   *
   * 处理逻辑：
   * 1. 去重：如果已有正在执行的 AI 报名 Promise，直接复用（避免并发重复请求）
   * 2. 筛选：找出所有尚未做出报名决定的 AI 玩家
   * 3. 批量决策：调用 generateAIBadgeSignupBatch 一次性为所有待定 AI 生成报名结果
   * 4. 合并状态：将 AI 的报名结果与人类玩家的报名状态合并更新
   * 5. 状态保护：通过 gameStateRef 获取最新状态，避免覆盖其他并发操作的更新
   *
   * 该函数在人类玩家做出报名决策后异步并行执行，不阻塞人类操作。
   *
   * @param state - 当前游戏状态（包含人类玩家的报名决定）
   * @returns 更新后的游戏状态（包含所有玩家的报名决定）
   */
  const resolveAIBadgeSignup = useCallback(async (state: GameState): Promise<GameState> => {
    if (aiSignupPromiseRef.current) {
      const resolved = await aiSignupPromiseRef.current;
      const fallback = gameStateRef.current ?? state;
      const base = resolved ?? fallback;
      return {
        ...base,
        badge: {
          ...base.badge,
          signup: { ...base.badge.signup, ...state.badge.signup },
        },
      };
    }

    const task = (async (): Promise<GameState> => {
      const baseState = gameStateRef.current ?? state;
      const alivePlayers = baseState.players.filter((p) => p.alive);
      const aiPlayers = alivePlayers.filter((p) => !p.isHuman);
      const pendingAI = aiPlayers.filter(
        (p) => typeof baseState.badge.signup?.[p.playerId] !== "boolean"
      );
      // If all AI have signed up, merge baseState (with AI signups) and state (with human signup)
      if (pendingAI.length === 0) {
        return {
          ...baseState,
          badge: {
            ...baseState.badge,
            signup: { ...baseState.badge.signup, ...state.badge.signup },
          },
        };
      }

      setIsWaitingForAI(true);
      try {
        const results = await generateAIBadgeSignupBatch(baseState, pendingAI);
        const latestState = gameStateRef.current ?? baseState;
        const mergedSignup = {
          ...latestState.badge.signup,
          ...baseState.badge.signup,
          ...results,
        };
        const nextState: GameState = {
          ...latestState,
          badge: {
            ...latestState.badge,
            signup: mergedSignup,
          },
        };
        setGameState(nextState);
        return nextState;
      } finally {
        setIsWaitingForAI(false);
      }
    })();

    aiSignupPromiseRef.current = task;
    try {
      return await task;
    } finally {
      aiSignupPromiseRef.current = null;
    }
  }, [setGameState, setIsWaitingForAI]);

  /**
   * 开始警长竞选报名阶段
   *
   * 流程：
   * 1. 记录日志并切换阶段为 DAY_BADGE_SIGNUP
   * 2. 初始化报名状态（清空 signup 和 candidates）
   * 3. 显示报名开始的系统消息
   * 4. 如果没有存活的人类玩家（纯 AI 对局），直接让 AI 批量报名后进入发言阶段
   * 5. 如果有人类玩家，先启动 AI 报名（异步并行），等待人类通过 UI 按钮做出决策
   *
   * @param state - 当前游戏状态
   */
  const startBadgeSignupPhase = useCallback(async (state: GameState) => {
    const texts = getTexts();
    // 日志记录：警长竞选报名开始（标记天数）
    gameLogger.badgeSignupStart(state.day);
    let currentState = transitionPhase(state, "DAY_BADGE_SIGNUP");
    currentState = {
      ...currentState,
      currentSpeakerSeat: null,
      daySpeechStartSeat: null,
      badge: {
        ...currentState.badge,
        signup: {},
        candidates: [],
      },
    };

    currentState = addSystemMessage(currentState, texts.t("badgePhase.signupStart"));
    setGameState(currentState);
    clearDialogue();

    const alivePlayers = currentState.players.filter((p) => p.alive);
    const human = alivePlayers.find((p) => p.isHuman);
    if (!human) {
      const nextState = await resolveAIBadgeSignup(currentState);
      await maybeStartBadgeSpeechAfterSignupRef.current(nextState);
      return;
    }

    void resolveAIBadgeSignup(currentState);
  }, [setGameState, clearDialogue, resolveAIBadgeSignup]);

  /**
   * 报名结束后检查是否可以开始发言阶段
   *
   * 该函数在以下时机被调用：
   * - 人类玩家做出报名决定后（与 AI 报名并行完成后）
   * - 页面刷新恢复报名阶段时
   *
   * 逻辑：
   * 1. 检查所有存活玩家是否都已做出报名决定
   * 2. 如果所有人已决定，收集报名者（signup 为 true 的玩家）作为候选人
   * 3. 无人报名 -> 显示提示并直接结束竞选（无警长）
   * 4. 有人报名 -> 进入发言阶段
   */
  const maybeStartBadgeSpeechAfterSignup = useCallback(async (state: GameState) => {
    const texts = getTexts();
    const alivePlayers = state.players.filter((p) => p.alive);
    const signup = state.badge.signup || {};
    const allDecided = alivePlayers.every((p) => typeof signup[p.playerId] === "boolean");
    if (!allDecided) return;

    const candidates = alivePlayers
      .filter((p) => signup[p.playerId] === true)
      .map((p) => p.seat);

    if (candidates.length === 0) {
      const nextState = addSystemMessage(state, texts.t("badgePhase.noSignup"));
      setGameState(nextState);
      setDialogue(texts.speakerHost, texts.t("badgePhase.noSignup"), false);
      await delay(DELAY_CONFIG.DIALOGUE);
      await onBadgeElectionComplete(nextState);
      return;
    }

    await startBadgeSpeechPhaseRef.current({
      ...state,
      badge: { ...state.badge, candidates },
    });
  }, [setGameState, setDialogue, onBadgeElectionComplete]);

  /**
   * 处理人类玩家的报名决策
   *
   * 当人类玩家在 UI 上点击"参选"或"不参选"按钮时调用。
   *
   * 流程：
   * 1. 前置检查：确认处于报名阶段、人类玩家存活且尚未做出决定
   * 2. 将人类的报名结果写入 badge.signup
   * 3. 触发 AI 玩家的批量报名（与人类决策并行）
   * 4. 等待 AI 报名完成后，检查是否所有玩家已决定，进而进入发言阶段
   *
   * @param wants - true 表示参选，false 表示不参选
   */
  const handleBadgeSignup = useCallback(async (wants: boolean) => {
    if (gameState.phase !== "DAY_BADGE_SIGNUP") return;
    const human = gameState.players.find((p) => p.isHuman);
    if (!human?.alive) return;
    if (typeof gameState.badge.signup?.[human.playerId] === "boolean") return;

    let nextState: GameState = {
      ...gameState,
      badge: {
        ...gameState.badge,
        signup: { ...gameState.badge.signup, [human.playerId]: wants },
      },
    };
    setGameState(nextState);
    nextState = await resolveAIBadgeSignup(nextState);
    await maybeStartBadgeSpeechAfterSignup(nextState);
  }, [gameState, setGameState, resolveAIBadgeSignup, maybeStartBadgeSpeechAfterSignup]);

  /**
   * 页面刷新后恢复报名阶段
   *
   * 与 startBadgeSignupPhase 不同，恢复流程：
   * - 不重置 badge.signup / candidates（保留已有的报名决定，避免回到”报名刚开始”）
   * - 继续让 AI 参与报名（对未决定者补齐）
   * - 若报名已全部完成，直接衔接到发言阶段
   *
   * 这是为了解决用户刷新页面后游戏状态恢复的场景。
   *
   * @param state - 从 localStorage 恢复的游戏状态
   */
  const resumeBadgeSignupPhase = useCallback(async (state: GameState) => {
    if (state.phase !== "DAY_BADGE_SIGNUP") return;
    // 如果没有任何玩家（理论上不会出现），直接退出
    if (!state.players || state.players.length === 0) return;

    // 继续跑 AI 报名（仅补齐未决定者）
    const nextState = await resolveAIBadgeSignup(state);
    await maybeStartBadgeSpeechAfterSignup(nextState);
  }, [maybeStartBadgeSpeechAfterSignup, resolveAIBadgeSignup]);

  /**
   * 开始警长竞选发言阶段
   *
   * 所有报名参选的候选人依次发表竞选演说。
   *
   * 流程：
   * 1. 切换阶段为 DAY_BADGE_SPEECH
   * 2. 显示发言开始的系统消息
   * 3. 从候选人中随机选择一位作为起始发言者（随机顺序增加公平性）
   * 4. 设置当前发言者和发言起始座位
   * 5. 等待暂停恢复后，根据首位发言者类型：
   *    - AI 玩家：自动调用 runAISpeech 生成并播放发言
   *    - 人类玩家：显示"轮到你了"的提示，等待人类输入
   *
   * @param state - 当前游戏状态（需包含 badge.candidates）
   */
  const startBadgeSpeechPhase = useCallback(async (state: GameState) => {
    const texts = getTexts();
    let currentState = transitionPhase(state, "DAY_BADGE_SPEECH");
    currentState = { ...currentState, currentSpeakerSeat: null, daySpeechStartSeat: null };

    currentState = addSystemMessage(currentState, texts.systemMessages.badgeSpeechStart);
    setDialogue(texts.speakerHost, texts.systemMessages.badgeSpeechStart, false);

    const candidates = currentState.badge.candidates || [];
    const candidatePlayers = currentState.players.filter((p) => p.alive && candidates.includes(p.seat));
    const startSeat = candidatePlayers.length > 0
      ? candidatePlayers[Math.floor(Math.random() * candidatePlayers.length)].seat
      : null;
    const firstSpeaker = startSeat !== null
      ? candidatePlayers.find((p) => p.seat === startSeat) || null
      : null;

    currentState = {
      ...currentState,
      daySpeechStartSeat: startSeat,
      currentSpeakerSeat: firstSpeaker?.seat ?? null,
    };

    setGameState(currentState);

    await delay(DELAY_CONFIG.DIALOGUE);
    await waitForUnpause();

    if (firstSpeaker && !firstSpeaker.isHuman) {
      await runAISpeech(currentState, firstSpeaker);
    } else if (firstSpeaker?.isHuman) {
      setDialogue(texts.speakerHint, texts.uiText.yourTurn, false);
    }
  }, [setGameState, setDialogue, waitForUnpause, runAISpeech]);

  /**
   * 开始警长竞选投票阶段
   *
   * 非候选人（存活且未参选的玩家）为候选人投票选出警长。
   *
   * 流程：
   * 1. 切换阶段为 DAY_BADGE_ELECTION（支持 isRevote 标记是否为 PK 重投）
   * 2. 特殊情况：如果只有 1 位候选人，直接当选，跳过投票环节
   * 3. 播放竞选投票语音提示
   * 4. 根据人类玩家是否为候选人显示不同的提示信息
   * 5. AI 玩家逐个投票：调用 generateAIBadgeVote 获取投票目标
   *    - 异常处理：投票失败时视为弃票（BADGE_VOTE_ABSTAIN）
   *    - 有效性检查：投给非候选人时也视为弃票
   *    - 状态保护：从 gameStateRef 获取最新状态，避免覆盖人类玩家的投票
   * 6. AI 投票结束后统一调用 maybeResolveBadgeElection 进行结算
   *
   * @param state - 当前游戏状态
   * @param options - 可选参数，isRevote 标记是否为 PK 重投
   */
  const startBadgeElectionPhase = useCallback(async (state: GameState, options?: { isRevote?: boolean }) => {
    const texts = getTexts();
    const isRevote = options?.isRevote === true || state.phase === "DAY_BADGE_ELECTION";
    const shouldTransition = state.phase !== "DAY_BADGE_ELECTION";
    let currentState = shouldTransition ? transitionPhase(state, "DAY_BADGE_ELECTION") : state;

    currentState = {
      ...currentState,
      currentSpeakerSeat: null,
      badge: {
        ...currentState.badge,
        votes: isRevote ? currentState.badge.votes : {},
        revoteCount: isRevote ? currentState.badge.revoteCount : 0,
      },
    };

    if (!isRevote) {
      currentState = addSystemMessage(currentState, texts.systemMessages.badgeElectionStart);
      
      // 播放警徽竞选投票语音
      await playNarrator("badgeElectionStart");
    }

    const candidates = currentState.badge.candidates || [];
    if (candidates.length === 1) {
      // 只有一人竞选，直接当选，不展示投票环节
      const winnerSeat = candidates[0];
      const winner = currentState.players.find((p) => p.seat === winnerSeat);
      let nextState: GameState = {
        ...currentState,
        badge: {
          ...currentState.badge,
          holderSeat: winnerSeat,
          allVotes: {},
          history: { ...currentState.badge.history, [currentState.day]: {} },
        },
      };
      // 使用特殊消息，不显示票数
      const autoElectMsg = texts.t("badgePhase.autoElected", { seat: winnerSeat + 1, name: winner?.displayName || "" });
      nextState = addSystemMessage(nextState, autoElectMsg);
      setGameState(nextState);
      setDialogue(texts.speakerHost, autoElectMsg, false);
      await delay(DELAY_CONFIG.DIALOGUE);
      await onBadgeElectionComplete(nextState);
      return;
    }

    // AI 玩家投票（候选人不投票）
    const human = currentState.players.find((p) => p.isHuman);
    const humanIsCandidate = human && candidates.includes(human.seat);
    
    // 只对非候选人显示投票提示
    if (human?.alive && !humanIsCandidate) {
      setDialogue(texts.speakerHost, texts.uiText.badgeVotePrompt, false);
    } else {
      setDialogue(texts.speakerHost, texts.uiText.aiVoting, false);
    }
    setGameState(currentState);
    const aiPlayers = currentState.players.filter((p) => p.alive && !p.isHuman && !candidates.includes(p.seat));
    try {
      for (const aiPlayer of aiPlayers) {
        setIsWaitingForAI(true);
        let targetSeat: number;
        try {
          targetSeat = await generateAIBadgeVote(currentState, aiPlayer);
        } catch (e) {
          console.warn("[wolfcha] AI badge vote threw, treating as abstain", e);
          targetSeat = BADGE_VOTE_ABSTAIN;
        }

        // Abstain (-1) is recorded as-is; invalid non-abstain results also abstain.
        if (targetSeat !== BADGE_VOTE_ABSTAIN && candidates.length > 0 && !candidates.includes(targetSeat)) {
          targetSeat = BADGE_VOTE_ABSTAIN;
        }

        // 从最新状态获取投票，避免覆盖人类玩家的投票
        const latestState = gameStateRef.current;
        currentState = {
          ...currentState,
          badge: {
            ...currentState.badge,
            votes: { ...latestState.badge.votes, [aiPlayer.playerId]: targetSeat },
          },
        };
        setGameState(currentState);
      }
    } finally {
      setIsWaitingForAI(false);
    }

    // AI投票结束后统一结算一次
    await maybeResolveBadgeElection(currentState);
  }, [setGameState, setDialogue, setIsWaitingForAI, maybeResolveBadgeElection]);

  // 更新 ref 以打破循环依赖：
  // startBadgeSpeechPhase 被 maybeStartBadgeSpeechAfterSignup 调用，
  // maybeStartBadgeSpeechAfterSignup 被 startBadgeSignupPhase 和 handleBadgeSignup 调用。
  // 由于 useCallback 的依赖关系，两者需要通过 ref 互相引用。
  startBadgeSpeechPhaseRef.current = startBadgeSpeechPhase;
  maybeStartBadgeSpeechAfterSignupRef.current = maybeStartBadgeSpeechAfterSignup;

  /**
   * 警徽移交流程（警长死亡时触发）
   *
   * 当警长在夜晚被杀或白天被投票出局时，需要决定警徽的归属。
   *
   * 流程：
   * 1. 切换阶段为 BADGE_TRANSFER，显示移交开始消息
   * 2. 等待暂停恢复
   * 3. 根据警长类型分别处理：
   *    - 人类警长：保存 afterTransfer 回调到 ref，显示移交提示，等待人类通过 UI 选择
   *    - AI 警长：调用 generateBadgeTransfer 由 LLM 决定移交对象
   *      a. 如果返回 BADGE_TRANSFER_TORN -> 撕毁警徽（本局无警长）
   *      b. 否则 -> 将警徽移交给指定玩家
   * 4. 更新游戏状态，播放对应消息
   * 5. 延迟后调用 afterTransfer 回调继续游戏流程
   *
   * @param state - 当前游戏状态
   * @param sheriff - 死亡的警长玩家
   * @param afterTransfer - 移交完成后的回调（用于继续后续游戏流程）
   */
  const handleBadgeTransfer = useCallback(async (
    state: GameState,
    sheriff: Player,
    afterTransfer: (s: GameState) => Promise<void>
  ) => {
    const texts = getTexts();
    let currentState = transitionPhase(state, "BADGE_TRANSFER");
    currentState = addSystemMessage(currentState, texts.systemMessages.badgeTransferStart(sheriff.seat + 1, sheriff.displayName));
    setGameState(currentState);

    await waitForUnpause();

    if (sheriff.isHuman) {
      // 日志记录：人类警长死亡，等待 UI 交互选择移交对象
      gameLogger.flow(`人类警长(${fmtPlayer(sheriff.seat, sheriff.displayName)}) 死亡，等待选择移交对象`);
      // 保存回调以便人类操作后继续流程
      humanBadgeTransferCallbackRef.current = afterTransfer;
      setDialogue(texts.speakerSystem, texts.t("badgePhase.transferPrompt"), false);
      return;
    }

    // AI 警长选择移交对象
    // 日志记录：AI 警长死亡，开始 LLM 决策移交对象
    gameLogger.flow(`AI警长(${fmtPlayer(sheriff.seat, sheriff.displayName)}) 死亡，思考移交对象...`);
    setIsWaitingForAI(true);
    const targetSeat = await generateBadgeTransfer(currentState, sheriff);
    setIsWaitingForAI(false);

    if (targetSeat === BADGE_TRANSFER_TORN) {
      // 撕毁警徽
      // 日志记录：AI 警长选择撕毁警徽（fromSeat, fromName, null, null）
      gameLogger.badgeTransfer(sheriff.seat, sheriff.displayName, null, null);
      currentState = {
        ...currentState,
        badge: { ...currentState.badge, holderSeat: null },
      };
      currentState = addSystemMessage(currentState, texts.systemMessages.badgeTorn(sheriff.seat + 1, sheriff.displayName));
      setDialogue(texts.speakerHost, texts.systemMessages.badgeTorn(sheriff.seat + 1, sheriff.displayName), false);
      // 记录撕毁警徽到回放
      onRecordBadgeTorn?.(sheriff.seat, false, "BADGE_TRANSFER", currentState.day);
    } else {
      // 正常移交
      const target = currentState.players.find((p) => p.seat === targetSeat);
      if (target) {
        // 日志记录：AI 警长将警徽移交给目标玩家（fromSeat, fromName, toSeat, toName）
        gameLogger.badgeTransfer(sheriff.seat, sheriff.displayName, targetSeat, target.displayName);
        currentState = {
          ...currentState,
          badge: { ...currentState.badge, holderSeat: targetSeat },
        };
        currentState = addSystemMessage(currentState, texts.systemMessages.badgeTransferred(sheriff.seat + 1, targetSeat + 1, target.displayName));
        setDialogue(texts.speakerHost, texts.systemMessages.badgeTransferred(sheriff.seat + 1, targetSeat + 1, target.displayName), false);
        // 记录警徽流传到回放
        onRecordBadgeTransfer?.(sheriff.seat, targetSeat, false, "BADGE_TRANSFER", currentState.day);
      }
    }
    setGameState(currentState);

    await delay(DELAY_CONFIG.LONG);
    await waitForUnpause();
    await afterTransfer(currentState);
  }, [setGameState, setDialogue, setIsWaitingForAI, waitForUnpause]);

  /**
   * 处理人类警长的警徽移交操作
   *
   * 当人类玩家是警长且死亡后，通过 UI 选择移交对象或撕毁警徽。
   * 与 handleBadgeTransfer 中 AI 警长的处理不同，人类警长需要等待用户交互。
   *
   * 流程：
   * 1. 前置检查：确认处于 BADGE_TRANSFER 阶段且当前人类是警长
   * 2. 根据 targetSeat 值判断：
   *    - BADGE_TRANSFER_TORN -> 撕毁警徽，清空 holderSeat
   *    - 其他有效座位号 -> 将警徽移交给目标玩家（需验证目标存活）
   * 3. 更新游戏状态，显示对应消息
   * 4. 延迟后，使用之前保存在 humanBadgeTransferCallbackRef 中的回调继续流程
   *    如果没有保存的回调，则直接调用 onBadgeTransferComplete
   *
   * @param targetSeat - 移交目标座位号，或 BADGE_TRANSFER_TORN 表示撕毁
   */
  const handleHumanBadgeTransfer = useCallback(async (targetSeat: number) => {
    const texts = getTexts();
    if (gameState.phase !== "BADGE_TRANSFER") return;

    const sheriffSeat = gameState.badge.holderSeat;
    const human = gameState.players.find((p) => p.isHuman);
    if (!human || human.seat !== sheriffSeat) return;

    let currentState: GameState;

    if (targetSeat === BADGE_TRANSFER_TORN) {
      // 撕毁警徽
      // 日志记录：人类警长主动撕毁警徽
      gameLogger.badgeTransfer(sheriffSeat!, human.displayName, null, null);
      currentState = {
        ...gameState,
        badge: { ...gameState.badge, holderSeat: null },
      };
      currentState = addSystemMessage(currentState, texts.systemMessages.badgeTorn(sheriffSeat! + 1, human.displayName));
      setDialogue(texts.speakerHost, texts.systemMessages.badgeTorn(sheriffSeat! + 1, human.displayName), false);
      // 记录人类撕毁警徽到回放（isHuman = true）
      onRecordBadgeTorn?.(sheriffSeat!, true, "BADGE_TRANSFER", gameState.day);
    } else {
      // 正常移交
      const target = gameState.players.find((p) => p.seat === targetSeat);
      if (!target || !target.alive) return;
      // 日志记录：人类警长将警徽移交给目标玩家
      gameLogger.badgeTransfer(sheriffSeat!, human.displayName, targetSeat, target.displayName);

      currentState = {
        ...gameState,
        badge: { ...gameState.badge, holderSeat: targetSeat },
      };
      currentState = addSystemMessage(currentState, texts.systemMessages.badgeTransferred(sheriffSeat! + 1, targetSeat + 1, target.displayName));
      setDialogue(texts.speakerHost, texts.systemMessages.badgeTransferred(sheriffSeat! + 1, targetSeat + 1, target.displayName), false);
      // 记录人类警徽流传到回放
      onRecordBadgeTransfer?.(sheriffSeat!, targetSeat, true, "BADGE_TRANSFER", gameState.day);
    }

    setGameState(currentState);

    await delay(DELAY_CONFIG.LONG);
    await waitForUnpause();
    
    // 使用保存的回调继续流程
    const callback = humanBadgeTransferCallbackRef.current;
    humanBadgeTransferCallbackRef.current = null;
    if (callback) {
      await callback(currentState);
    } else {
      // 如果没有保存的回调，使用默认的onBadgeTransferComplete
      await onBadgeTransferComplete(currentState);
    }
  }, [gameState, setGameState, setDialogue, waitForUnpause, onBadgeTransferComplete]);

  // 返回 7 个操作方法供上层游戏逻辑调用
  return {
    startBadgeSignupPhase,      // 开始报名阶段
    startBadgeSpeechPhase,      // 开始发言阶段
    startBadgeElectionPhase,    // 开始投票阶段
    resumeBadgeSignupPhase,     // 恢复报名阶段（页面刷新后）
    handleBadgeSignup,          // 人类报名决策
    handleBadgeTransfer,        // 警徽移交流程
    handleHumanBadgeTransfer,   // 人类警长移交操作
    maybeResolveBadgeElection,  // 结算投票结果
  };
}
