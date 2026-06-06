"use client";

/**
 * @file useDayPhase.ts
 * @description 白天阶段核心 Hook，负责管理白天流程中的所有发言相关逻辑。
 *
 * 主要职责：
 * 1. AI 发言生成：通过流式分段输出（streaming）方式生成 AI 玩家的发言内容，
 *    并将每个段落实时推送到发言队列中进行打字机效果展示。
 * 2. 人类发言输入：人类玩家发言时，保存回调函数等待用户输入完成后再继续流程。
 * 3. 遗言阶段（Last Words）：处理被处决/击杀玩家的遗言，区分人类与 AI 路径。
 * 4. 发言者轮转：根据当前阶段类型（白天发言、PK 发言、警长竞选发言等）
 *    计算下一个发言者，支持顺时针/逆时针方向及警长特殊规则。
 * 5. 预取优化：在当前 AI 发言完成时，预先生成下一位 AI 玩家的发言，减少等待时间。
 * 6. TTS 音频链：将 AI 发言的每个段落按顺序提交给音频管理器进行语音合成播放。
 */

import { useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useAtom } from "jotai";
import type { GameState, Player, Phase } from "@/types/game";
import type { PrefetchCriteria, PrefetchedSpeech } from "../useDialogueManager";
import { gameStateAtom } from "@/store/game-machine";
import {
  transitionPhase,
  addSystemMessage,
  addPlayerMessage,
  killPlayer,
  generateAISpeechSegmentsStream,
  getNextAliveSeat,
} from "@/lib/game-master";
import { PHASE_CATEGORIES } from "@/lib/game-constants";
import { type FlowToken } from "@/lib/game-flow-controller";
import { audioManager, makeAudioTaskId } from "@/lib/audio-manager";
import { resolveVoiceId, shouldUseMimoTts, type AppLocale } from "@/lib/voice-constants";
import { getLocale } from "@/i18n/locale-store";
import { gameLogger } from "@/lib/game-logger";

/**
 * @interface DayPhaseCallbacks
 * @description 白天阶段所需的全部回调函数集合，由上层 Hook（useDialogueManager 等）注入。
 * 这些回调解耦了白天阶段逻辑与 UI 状态管理、音频播放、回放记录等子系统。
 */
export interface DayPhaseCallbacks {
  /** 设置对话框内容：speaker 为发言者名称，text 为显示文本，isStreaming 标记是否正在流式生成中 */
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  /** 设置"AI 正在组织语言"的等待状态，用于 UI 显示加载指示器 */
  setIsWaitingForAI: (waiting: boolean) => void;
  /** 设置"等待下一轮"状态，通常在发言结束后、进入投票前使用 */
  setWaitingForNextRound: (waiting: boolean) => void;
  /** 校验 FlowToken 是否仍然有效，用于在异步操作后检测游戏是否已被重置或阶段已切换 */
  isTokenValid: (token: FlowToken) => boolean;
  /** 初始化完整的发言队列（一次性传入所有段落），用于预取命中或非流式场景 */
  initSpeechQueue: (segments: string[], player: Player, afterSpeech?: (s: unknown) => Promise<void>) => void;
  /** 初始化流式发言队列（空队列），后续通过 appendToSpeechQueue 逐段追加 */
  initStreamingSpeechQueue: (player: Player, afterSpeech?: (s: unknown) => Promise<void>) => void;
  /** 向流式发言队列追加一个段落，触发打字机效果逐字显示 */
  appendToSpeechQueue: (segment: string) => void;
  /** 标记发言队列完成，触发队列清空和后续流程；nextSpeakerIsAI 用于优化预取时机 */
  finalizeSpeechQueue: (options?: { nextSpeakerIsAI?: boolean }) => void;
  /** 设置预取的发言缓存，供下一位 AI 发言时快速消费，避免重复生成 */
  setPrefetchedSpeech: (prefetch: PrefetchedSpeech | null) => void;
  /** 尝试消费预取缓存，根据 criteria 匹配（玩家ID、阶段、天数、消息数），命中则返回段落数组 */
  consumePrefetchedSpeech: (criteria: PrefetchCriteria) => string[] | null;
  /** 设置遗言完成后的回调函数，供人类玩家输入遗言后触发后续流程 */
  setAfterLastWords: (callback: ((s: GameState) => Promise<void>) | null) => void;
  /**
   * 回放记录回调（可选）：将每个发言段落记录到回放系统中，用于游戏回放功能。
   * @param speakerSeat - 发言者座位号
   * @param speakerName - 发言者名称
   * @param content - 段落内容
   * @param segmentIndex - 段落索引（在本次发言中的序号）
   * @param isHuman - 是否为人类玩家发言
   * @param isLastWords - 是否为遗言阶段
   * @param phase - 当前游戏阶段
   * @param day - 当前天数
   */
  onRecordSpeechSegment?: (
    speakerSeat: number,
    speakerName: string,
    content: string,
    segmentIndex: number,
    isHuman: boolean,
    isLastWords: boolean,
    phase: Phase,
    day: number,
  ) => void;
}

/**
 * @interface DayPhaseActions
 * @description useDayPhase Hook 暴露的两个核心操作，供上层游戏循环调用。
 */
export interface DayPhaseActions {
  /**
   * 启动遗言阶段。
   * 当玩家被处决（投票出局）或夜间被杀后触发，流程：
   * 1. 若玩家仍存活则执行 killPlayer 标记死亡
   * 2. 切换阶段到 DAY_LAST_WORDS
   * 3. 设置当前发言者座位
   * 4. 区分人类/AI 路径：人类等待输入，AI 直接生成发言
   */
  startLastWordsPhase: (state: GameState, seat: number, afterLastWords: (s: GameState) => Promise<void>, token: FlowToken) => Promise<void>;
  /**
   * 执行 AI 玩家的发言流程。
   * 这是最核心的函数，完整流程包括：去重检查、语音解析、预取消费或流式生成、
   * TTS 音频链、发言队列管理、完成后触发下一个发言者预取。
   */
  runAISpeech: (state: GameState, player: Player, options?: { afterSpeech?: (s: GameState) => Promise<void> }) => Promise<void>;
}

/**
 * @function isSpeechLikePhase
 * @description 判断给定阶段是否属于"发言类"阶段。
 *
 * 为什么需要检查阶段类别？
 * 在 AI 流式发言过程中，游戏阶段可能会发生变化（例如从发言切换到投票）。
 * 如果阶段已不再是发言类阶段，则应该停止继续处理流式段落，避免在非发言阶段
 * 错误地显示发言内容。SPEECH_PHASES 包括：DAY_SPEECH、DAY_PK_SPEECH、
 * DAY_BADGE_SPEECH、DAY_LAST_WORDS 等所有需要 AI/人类发言的阶段。
 */
const isSpeechLikePhase = (phase: Phase): boolean => {
  return PHASE_CATEGORIES.SPEECH_PHASES.includes(phase as typeof PHASE_CATEGORIES.SPEECH_PHASES[number]);
};

/**
 * @hook useDayPhase
 * @description 白天阶段核心 Hook，管理白天流程中的所有发言相关逻辑。
 *
 * @param humanPlayer - 当前人类玩家对象（旁观者模式下为 null）
 * @param callbacks - 由上层注入的回调函数集合，用于与 UI 状态、音频、回放等子系统交互
 * @returns DayPhaseActions - 暴露 startLastWordsPhase 和 runAISpeech 两个操作
 */
export function useDayPhase(
  humanPlayer: Player | null,
  callbacks: DayPhaseCallbacks
): DayPhaseActions {
  const t = useTranslations();
  const speakerHost = t("speakers.host");
  const [gameState, setGameState] = useAtom(gameStateAtom);

  // 从 callbacks 中解构出所有需要的回调函数，方便后续直接调用
  const {
    setDialogue,
    setIsWaitingForAI,
    setWaitingForNextRound,
    isTokenValid,
    initSpeechQueue,
    initStreamingSpeechQueue,
    appendToSpeechQueue,
    finalizeSpeechQueue,
    setPrefetchedSpeech,
    consumePrefetchedSpeech,
    setAfterLastWords,
    onRecordSpeechSegment,
  } = callbacks;

  /**
   * @function buildPostSpeechState
   * @description 将发言段落提交到游戏状态的消息列表中。
   *
   * 工作流程：
   * 1. 对段落进行标准化处理：去除首尾空白，过滤空段落
   * 2. 使用 reduce 逐段调用 addPlayerMessage，将每个段落作为独立的玩家消息追加到状态中
   *
   * 这个函数在 AI 发言完成后被调用，用于构建"发言后"的游戏状态快照，
   * 供预取下一位 AI 发言时使用（因为预取需要基于最新的消息历史生成 prompt）。
   *
   * @param baseState - 发言前的游戏状态
   * @param speaker - 发言玩家对象
   * @param segments - 发言段落数组
   * @returns 包含所有发言消息的新游戏状态
   */
  const buildPostSpeechState = useCallback((
    baseState: GameState,
    speaker: Player,
    segments: string[]
  ): GameState => {
    const normalized = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    return normalized.reduce((nextState, segment) => {
      return addPlayerMessage(nextState, speaker.playerId, segment);
    }, baseState);
  }, []);


  // 使用 ref 来获取最新的 gameState，避免闭包问题。
  // 在异步回调（如 onSegmentReceived、onComplete）中，如果直接引用 gameState 变量，
  // 会捕获到创建闭包时的旧值。通过 ref 始终能读到最新的游戏状态。
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;

  // 防止 AI 发言重复触发的守卫 ref。
  // 存储当前正在发言的玩家 ID。如果 runAISpeech 被同一玩家重复调用（例如由于
  // React 严格模式的双重渲染或事件冒泡），第二次调用会检测到重复并直接返回。
  const currentSpeakingPlayerRef = useRef<string | null>(null);

  // 用于存储流式生成的发言段落。
  // 在流式生成过程中，每个段落通过 onSegmentReceived 回调追加到此数组。
  // 发言完成后，这些段落用于：1) 构建发言后状态（buildPostSpeechState）
  // 2) 传递给 finalizeSpeechQueue 完成发言队列。
  const streamingSegmentsRef = useRef<string[]>([]);

  /**
   * @function resolveNextSpeaker
   * @description 计算下一个发言者及其座位号，是发言者轮转的核心逻辑。
   *
   * 复杂的发言者轮转规则：
   *
   * 1. PK 发言阶段（DAY_PK_SPEECH）：
   *    - 按照 pkTargets 数组中的顺序依次发言
   *    - 找到当前发言者在数组中的索引，取下一个索引对应的座位
   *    - PK 参与者可能是任意座位，不需要连续
   *
   * 2. 警长竞选发言阶段（DAY_BADGE_SPEECH）：
   *    - 只有报名参选的候选人（badge.candidates）且仍然存活的玩家才有发言资格
   *    - 从当前发言者座位 +1 开始，按座位号循环查找下一个存活的候选人
   *    - 使用模运算处理座位号环绕（从最大座位号回到 0）
   *
   * 3. 白天发言阶段（DAY_SPEECH）且警长存活：
   *    - 警长拥有"最后发言权"（可以多发一次言）
   *    - 如果警长是起始发言者（daySpeechStartSeat === sheriffSeat）：
   *      正常轮转到最后一个存活玩家后，再回到第一个非警长存活玩家，
   *      此时将发言权交给警长（警长收尾发言）
   *    - 如果警长不是起始发言者：
   *      正常轮转到末尾（nextSeat === null）时，补充一次警长发言机会
   *
   * 4. 其他阶段（普通白天发言，无警长或警长已死）：
   *    - 使用 getNextAliveSeat 按方向（顺时针/逆时针）找到下一个存活玩家
   *
   * @param state - 当前游戏状态
   * @returns { nextSeat, nextSpeakerIsAI } - 下一个发言者的座位号和是否为 AI 玩家
   */
  const resolveNextSpeaker = useCallback((state: GameState) => {
    let nextSpeakerIsAI = false;
    const sheriffSeat = state.badge.holderSeat;
    const isSheriffAlive = sheriffSeat !== null && state.players.some((p) => p.seat === sheriffSeat && p.alive);
    const isDaySpeech = state.phase === "DAY_SPEECH";
    const direction = state.speechDirection ?? "clockwise";

    let nextSeat: number | null = null;

    // === 分支1：PK 发言阶段 ===
    // PK 参与者按 pkTargets 数组顺序发言，不按座位号轮转
    if (state.phase === "DAY_PK_SPEECH") {
      const pkTargets = state.pkTargets || [];
      const currentSeat = state.currentSpeakerSeat ?? -1;
      const currentIndex = pkTargets.indexOf(currentSeat);
      const nextIndex = currentIndex + 1;
      // 还有下一个 PK 参与者未发言
      if (nextIndex < pkTargets.length) {
        nextSeat = pkTargets[nextIndex];
      }
      // nextSeat === null 表示所有 PK 参与者已发言完毕

    // === 分支2：警长竞选发言阶段 ===
    // 只有报名参选且存活的候选人才有发言资格
    } else if (state.phase === "DAY_BADGE_SPEECH") {
      const candidates = state.badge.candidates || [];
      // 过滤出仍然存活的候选人座位
      const aliveCandidateSeats = candidates.filter((seat) =>
        state.players.some((p) => p.seat === seat && p.alive)
      );
      const total = state.players.length;
      // 从当前座位 +1 开始循环查找下一个存活候选人
      const cursor = (state.currentSpeakerSeat ?? -1) + 1;
      for (let step = 0; step < total; step++) {
        // 使用模运算实现座位号环绕，((x % n) + n) % n 确保正数
        const seat = ((cursor + step) % total + total) % total;
        if (aliveCandidateSeats.includes(seat)) {
          nextSeat = seat;
          break;
        }
      }

    // === 分支3：白天发言阶段且警长存活 ===
    // 警长拥有"最后发言权"，需要特殊处理轮转逻辑
    } else if (isDaySpeech && isSheriffAlive) {
      // 先按正常规则（跳过已死玩家）获取下一个存活座位
      nextSeat = getNextAliveSeat(state, state.currentSpeakerSeat ?? -1, true, direction);

      const sheriffIsStartSpeaker = state.daySpeechStartSeat === sheriffSeat;

      if (sheriffIsStartSpeaker) {
        // 情况A：警长是起始发言者
        // 警长先发言，然后所有人按顺序发言，最后再轮到警长收尾。
        // 检查是否已轮转回到第一个非警长存活玩家（即所有人都发过言了），
        // 如果是，则将发言权交给警长。
        const nonSheriffAliveSeats = state.players
          .filter((p) => p.alive && p.seat !== sheriffSeat)
          .map((p) => p.seat)
          .sort((a, b) => a - b);
        const firstNonSheriffSeat = nonSheriffAliveSeats[0];
        if (nextSeat !== null && nextSeat === firstNonSheriffSeat && state.currentSpeakerSeat !== sheriffSeat) {
          // 已轮转一圈，交给警长收尾
          nextSeat = sheriffSeat;
        }
      } else {
        // 情况B：警长不是起始发言者
        // 所有人按顺序发言完毕后（nextSeat === null），补充一次警长发言机会
        if (nextSeat === null && state.currentSpeakerSeat !== sheriffSeat) {
          nextSeat = sheriffSeat;
        }
      }

    // === 分支4：普通白天发言（无警长或警长已死） ===
    // 简单地按方向（顺时针/逆时针）找下一个存活玩家
    } else {
      nextSeat = getNextAliveSeat(state, state.currentSpeakerSeat ?? -1, false, direction);
    }

    // 根据下一个发言者的座位号判断是否为 AI 玩家
    // 仅当玩家存在、不是人类、且仍然存活时才标记为 AI
    if (nextSeat !== null) {
      const nextPlayer = state.players.find((p) => p.seat === nextSeat);
      nextSpeakerIsAI = nextPlayer ? !nextPlayer.isHuman && nextPlayer.alive : false;
    }

    return { nextSeat, nextSpeakerIsAI };
  }, []);

  /**
   * @function prefetchNextAISpeech
   * @description 预取下一位 AI 玩家的发言内容，是一种 UX 优化策略。
   *
   * 预取的工作原理：
   * 当当前 AI 发言完成时，我们已经知道下一个发言者是谁。如果下一位也是 AI，
   * 可以在当前发言的打字机效果还在播放时，就开始后台生成下一位的发言内容。
   * 这样当轮到下一位 AI 发言时，内容可能已经准备好，可以立即显示而无需等待。
   *
   * 预取缓存通过 setPrefetchedSpeech 存储，包含：
   * - playerId / phase / day / messageCount：用于后续匹配校验（确保缓存仍然有效）
   * - segments：已收集的段落数组，随生成进度实时更新
   * - isComplete：标记生成是否全部完成
   *
   * 当 runAISpeech 被调用时，会先通过 consumePrefetchedSpeech 尝试消费缓存，
   * 如果命中（玩家、阶段、天数、消息数都匹配），则直接使用缓存的段落，跳过生成。
   *
   * @param state - 当前游戏状态
   * @param player - 下一位要发言的 AI 玩家
   */
  const prefetchNextAISpeech = useCallback(async (
    state: GameState,
    player: Player
  ) => {
    // 仅在白天发言类阶段执行预取，其他阶段（如投票、夜间）不需要
    if (!["DAY_SPEECH", "DAY_PK_SPEECH", "DAY_BADGE_SPEECH"].includes(state.phase)) return;
    // 没有 agentProfile 的玩家无法生成 AI 发言，跳过
    if (!player.agentProfile) return;

    // 构建预取缓存的基础对象，记录匹配所需的元信息
    const basePrefetch: PrefetchedSpeech = {
      playerId: player.playerId,
      phase: state.phase,
      day: state.day,
      messageCount: state.messages.length, // 消息数用于检测状态是否已变化
      segments: [],
      isComplete: false,
      createdAt: Date.now(),
    };

    // 先设置一个空的预取占位，表示已开始预取
    setPrefetchedSpeech(basePrefetch);

    // 收集器：存放已生成的段落，用于在 onComplete 时提供完整列表
    const collected: string[] = [];

    try {
      const segments = await generateAISpeechSegmentsStream(state, player, {
        // 每收到一个段落，实时更新预取缓存（UI 可选择性地展示预取进度）
        onSegmentReceived: (segment) => {
          collected.push(segment);
          setPrefetchedSpeech({
            ...basePrefetch,
            segments: [...collected],
            isComplete: false,
          });
        },
        // 生成完成，标记 isComplete 并存储最终段落列表
        onComplete: (finalSegments) => {
          setPrefetchedSpeech({
            ...basePrefetch,
            segments: finalSegments,
            isComplete: true,
          });
        },
        // 生成失败，清除预取缓存，后续 runAISpeech 会走实时生成路径
        onError: () => {
          setPrefetchedSpeech(null);
        },
      });

      // 如果 LLM 返回了空段落（例如模型认为不需要发言），清除缓存
      if (segments.length === 0) {
        setPrefetchedSpeech(null);
      }
    } catch {
      // 异常情况下清除预取缓存，确保不会使用损坏的数据
      setPrefetchedSpeech(null);
    }
  }, [setPrefetchedSpeech]);

  /**
   * @function runAISpeech
   * @description AI 玩家发言的核心函数，也是整个白天阶段最复杂的函数。
   *
   * 完整执行流程：
   *
   * 第一步：去重守卫（Dedup Guard）
   *   - 检查是否处于夜间阶段（不应调用此函数）
   *   - 检查 currentSpeakingPlayerRef 是否已标记同一玩家正在发言
   *   - 防止 React 严格模式双重渲染或事件重复触发导致的重复发言
   *
   * 第二步：语音（TTS）解析
   *   - 获取当前语言区域（locale）
   *   - 判断是否使用 Mimo TTS 引擎
   *   - 根据玩家的 persona 信息（voiceId、gender、age）解析出具体的 TTS voiceId
   *
   * 第三步：预取消费快速路径（Prefetch Fast Path）
   *   - 通过 consumePrefetchedSpeech 尝试消费之前预取的缓存
   *   - 匹配条件：playerId、phase、day、messageCount 四项全部一致
   *   - 如果命中缓存：
   *     a. TTS 启用时：先 ensureReady 第一段的音频，等待就绪后再开始显示文本
   *        （避免文本已显示但声音还没出来的不同步问题）
   *     b. 用 initSpeechQueue 一次性初始化完整发言队列
   *     c. 剩余段落的 TTS 音频按顺序链式提交（chained promise）
   *     d. 直接 return，跳过后续的流式生成路径
   *
   * 第四步：流式生成路径（Streaming Path）
   *   - 设置 currentSpeakingPlayerRef 防重入
   *   - 显示"正在组织语言"对话框，设置等待状态
   *   - 启动 60 秒超时计时器，防止 LLM 响应过慢导致永久卡死
   *   - 调用 initStreamingSpeechQueue 初始化空的流式发言队列
   *   - 调用 generateAISpeechSegmentsStream 启动流式生成，注册三个回调：
   *
   *   4a. onSegmentReceived：每收到一个段落时触发
   *       - 超时检查：如果已超时则忽略
   *       - 阶段检查：如果阶段已离开发言类则忽略（isSpeechLikePhase）
   *       - 去重：跳过已收集的重复段落
   *       - 立即 appendToSpeechQueue（触发打字机效果）
   *       - 首段特殊处理：设置 hasReceivedFirstSegment = true，
   *         调用 setIsWaitingForAI(false) 关闭加载指示器
   *       - 记录回放：调用 onRecordSpeechSegment 将段落写入回放系统
   *       - TTS 音频：将 ensureReady → addToQueue 链式追加到 audioChain，
   *         保证音频按段落顺序入队（而非按生成完成时间乱序）
   *
   *   4b. onComplete：所有段落生成完毕时触发
   *       - 超时/阶段检查
   *       - 调用 resolveNextSpeaker 计算下一个发言者
   *       - 如果下一位是 AI 玩家，构建发言后状态并启动 prefetchNextAISpeech
   *       - 调用 finalizeSpeechQueue({ nextSpeakerIsAI }) 标记队列完成
   *
   *   4c. onError：生成出错时触发
   *       - 如果尚未收到任何段落，显示"发言中断"消息并完成队列
   *
   *   使用 Promise.race 等待 streamPromise 或 timeoutPromise 先完成：
   *   - 如果超时先触发：显示超时消息，完成队列
   *   - 如果流式生成先完成：正常结束
   *
   * 第五步：异常处理与清理（catch / finally）
   *   - catch：流式生成异常且未收到任何段落时，显示中断消息
   *   - finally：清除 currentSpeakingPlayerRef（释放防重入锁），
   *     如果从未收到段落则关闭等待状态
   *
   * @param state - 当前游戏状态
   * @param player - 要发言的 AI 玩家
   * @param options.afterSpeech - 发言完成后的回调函数
   */
  const runAISpeech = useCallback(async (
    state: GameState,
    player: Player,
    options?: { afterSpeech?: (s: GameState) => Promise<void> }
  ) => {
    // === 第一步：去重守卫 ===
    // 夜间阶段不应调用此函数，如果发生说明上游逻辑有误
    if (state.phase.includes("NIGHT")) {
      console.warn("[wolfcha] runAISpeech called during NIGHT phase:", state.phase);
      return;
    }

    // 防止同一玩家的发言被重复触发
    if (currentSpeakingPlayerRef.current === player.playerId) {
      console.warn("[wolfcha] runAISpeech: already speaking for", player.displayName);
      return;
    }

    // 重置流式段落收集器，为新一轮发言做准备
    streamingSegmentsRef.current = [];
    // 标记是否已收到第一个段落（用于首段特殊处理和超时后的判断）
    let hasReceivedFirstSegment = false;
    // 标记是否已触发超时（用于忽略超时后的回调）
    let isTimedOut = false;

    // 记录日志：区分遗言和普通发言
    // gameLogger 用于在游戏日志面板中显示发言开始的记录
    const isLastWords = state.phase === "DAY_LAST_WORDS";
    if (isLastWords) {
      gameLogger.lastWords(player.seat, player.displayName, false);
    } else {
      gameLogger.speech(player.seat, player.displayName, false);
    }

    // === 第二步：TTS 语音解析 ===
    // 根据当前语言环境和玩家角色信息解析出用于 TTS 合成的 voiceId
    const locale = getLocale() as AppLocale;
    const useMimo = shouldUseMimoTts();
    const voiceId = resolveVoiceId(
      player.agentProfile?.persona?.voiceId,
      player.agentProfile?.persona?.gender,
      player.agentProfile?.persona?.age,
      locale,
      useMimo
    );

    // === 第三步：预取消费快速路径 ===
    // 构建匹配条件，与预取缓存中的元信息进行比对
    const prefetchCriteria: PrefetchCriteria = {
      playerId: player.playerId,
      phase: state.phase,
      day: state.day,
      messageCount: state.messages.length,
    };

    // 尝试消费预取缓存（如果命中，缓存会被清除并返回段落数组）
    const prefetchedSegments = consumePrefetchedSpeech(prefetchCriteria);

    if (prefetchedSegments && prefetchedSegments.length > 0) {
      // --- 预取命中，走快速路径 ---
      currentSpeakingPlayerRef.current = player.playerId;

      const ttsEnabled = audioManager.isEnabled();
      const firstSegment = prefetchedSegments[0];

      if (ttsEnabled && firstSegment) {
        // TTS 启用时的快速路径：
        // 1. 先显示"正在组织语言"（此时音频正在后台准备）
        // 2. ensureReady 等待第一段音频 TTS 合成完成
        // 3. 音频就绪后才关闭等待状态并开始显示文本
        //    这样用户看到文字时同时能听到声音，体验更自然
        setDialogue(player.displayName, t("dayPhase.organizing"), true);
        const task = {
          id: makeAudioTaskId(voiceId, firstSegment),
          text: firstSegment,
          voiceId,
          playerId: player.playerId,
        };
        try {
          await audioManager.ensureReady(task);
        } catch {
          // TTS 合成失败，继续无音频模式（不阻塞发言显示）
        }
        setIsWaitingForAI(false);
        // 一次性初始化完整发言队列（所有段落已知）
        initSpeechQueue(
          prefetchedSegments,
          player,
          options?.afterSpeech as ((s: unknown) => Promise<void>) | undefined
        );
        // 将第一段音频加入播放队列
        audioManager.addToQueue(task);
        // 剩余段落的 TTS 音频按顺序链式处理，保证播放顺序与发言顺序一致
        let chain = Promise.resolve();
        for (let i = 1; i < prefetchedSegments.length; i++) {
          const seg = prefetchedSegments[i];
          const segTask = { id: makeAudioTaskId(voiceId, seg), text: seg, voiceId, playerId: player.playerId };
          chain = chain.then(() =>
            audioManager.ensureReady(segTask).then(() => audioManager.addToQueue(segTask)).catch(() => {})
          );
        }
      } else {
        // TTS 未启用，直接显示文本，无需等待音频
        setIsWaitingForAI(false);
        initSpeechQueue(
          prefetchedSegments,
          player,
          options?.afterSpeech as ((s: unknown) => Promise<void>) | undefined
        );
      }

      // 释放防重入锁
      currentSpeakingPlayerRef.current = null;
      return;
    }

    // === 第四步：流式生成路径（预取未命中） ===
    // 标记当前玩家正在发言，防止重复调用
    currentSpeakingPlayerRef.current = player.playerId;
    // 设置等待状态，UI 显示"AI 正在组织语言"加载指示器
    setIsWaitingForAI(true);
    setDialogue(player.displayName, t("dayPhase.organizing"), true);

    // 60秒首包超时，20秒空闲（包距）超时机制：防止 LLM 响应过慢或网络断连导致游戏永久卡死。
    const FIRST_PACKET_TIMEOUT_MS = 60000;
    const IDLE_TIMEOUT_MS = 20000;
    let idleTimer: number | null = null;
    let resolveTimeoutPromise: (val: "timeout") => void;

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      resolveTimeoutPromise = resolve;
    });

    const resetIdleTimer = (timeoutMs: number) => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
      }
      idleTimer = window.setTimeout(() => {
        isTimedOut = true;
        resolveTimeoutPromise("timeout");
      }, timeoutMs);
    };

    // 启动初始超时计时器（首包限时 60 秒）
    resetIdleTimer(FIRST_PACKET_TIMEOUT_MS);

    try {
      // 初始化空的流式发言队列，后续通过 appendToSpeechQueue 逐段追加
      initStreamingSpeechQueue(player, options?.afterSpeech as ((s: unknown) => Promise<void>) | undefined);

      // TTS 音频链：确保多个段落的音频按顺序入队（而非按合成完成时间乱序）
      let audioChain = Promise.resolve();

      // 启动流式生成，LLM 会逐段返回发言内容
      const streamPromise = generateAISpeechSegmentsStream(state, player, {
        // --- 回调 4a：收到单个段落 ---
        onSegmentReceived: (segment, index) => {
          // 如果已超时，忽略后续到达的段落（避免在超时后仍显示内容）
          if (isTimedOut) return;

          // 刷新空闲超时计时器（后续段落限时 20 秒）
          resetIdleTimer(IDLE_TIMEOUT_MS);

          // 检查当前阶段是否仍在发言类（可能在生成过程中阶段已切换到投票等）
          const currentPhase = gameStateRef.current.phase;
          if (!isSpeechLikePhase(currentPhase)) {
            return;
          }

          // 段落去重：流式生成可能因网络重试等原因产生重复段落
          if (streamingSegmentsRef.current.includes(segment)) {
            return;
          }
          streamingSegmentsRef.current.push(segment);

          // 构建 TTS 音频任务对象
          const task = {
            id: makeAudioTaskId(voiceId, segment),
            text: segment,
            voiceId,
            playerId: player.playerId,
          };

          const ttsEnabled = audioManager.isEnabled();

          // 首段特殊处理：收到第一个段落时关闭加载指示器，
          // 让用户立即看到发言内容开始出现（打字机效果）
          if (!hasReceivedFirstSegment) {
            hasReceivedFirstSegment = true;
            setIsWaitingForAI(false);
          }
          // 将段落追加到发言队列，触发 UI 逐字显示（打字机效果）
          appendToSpeechQueue(segment);

          // 记录发言段落到回放系统，用于游戏结束后回放功能
          // gameLogger 已在函数开头记录了发言开始，此处由回放系统记录具体内容
          onRecordSpeechSegment?.(
            player.seat,
            player.displayName,
            segment,
            index,
            false,          // isHuman = false（AI 发言）
            state.phase === "DAY_LAST_WORDS",
            state.phase,
            state.day,
          );

          // TTS 音频处理：通过链式 Promise 保证音频按段落顺序入队。
          // ensureReady 异步等待 TTS 合成完成，然后 addToQueue 加入播放队列。
          // 即使合成失败也不会阻塞后续段落（catch 吞掉错误）。
          if (ttsEnabled) {
            audioChain = audioChain.then(() =>
              audioManager.ensureReady(task).then(() => {
                if (isTimedOut) return;
                audioManager.addToQueue(task);
              }).catch(() => {})
            );
          }
        },

        // --- 回调 4b：所有段落生成完毕 ---
        onComplete: () => {
          // 如果已超时，忽略完成回调（超时路径已自行处理后续流程）
          if (isTimedOut) return;

          // 再次检查阶段是否仍在发言类（生成过程中可能已切换）
          const currentState = gameStateRef.current;
          const currentPhase = currentState.phase;
          if (!isSpeechLikePhase(currentPhase)) {
            // 阶段已变（如切换到投票），跳过后续处理
            console.warn("[wolfcha] runAISpeech: phase changed during AI speech generation, skipping display. Expected speech phase, got:", currentPhase);
            return;
          }

          // 计算下一个发言者，用于预取优化
          const { nextSeat, nextSpeakerIsAI } = resolveNextSpeaker(currentState);

          // 如果下一位也是 AI，立即开始预取其发言内容（后台生成）。
          // 这样当打字机效果播放完毕后，下一位 AI 的发言可能已经准备好了。
          if (nextSeat !== null && nextSpeakerIsAI) {
            // 构建包含当前发言消息的"发言后状态"，供预取生成 prompt 时使用
            const postSpeechState = buildPostSpeechState(currentState, player, streamingSegmentsRef.current);
            const nextPlayer = postSpeechState.players.find((p) => p.seat === nextSeat);
            if (nextPlayer && !nextPlayer.isHuman && nextPlayer.alive) {
              // void 表示不等待预取完成（后台执行），不阻塞当前流程
              void prefetchNextAISpeech(postSpeechState, nextPlayer);
            }
          }

          // 标记流式发言队列完成。
          // nextSpeakerIsAI 信息传递给队列管理器，用于优化打字机速度：
          // 如果下一个是 AI，可以适当加快当前打字机速度以减少等待。
          finalizeSpeechQueue({ nextSpeakerIsAI });
        },

        // --- 回调 4c：生成出错 ---
        onError: () => {
          // 如果已超时，忽略错误（超时路径已处理）
          if (isTimedOut) return;

          // 如果从未收到任何段落，说明生成完全失败，显示中断消息
          // 如果已经收到了部分段落，仍必须调用 finalizeSpeechQueue 以关闭发言队列，引导游戏向下一位推进
          if (!hasReceivedFirstSegment) {
            appendToSpeechQueue(t("dayPhase.interrupted"));
          }
          finalizeSpeechQueue();
        },
      });

      // 等待流式生成完成或超时，以先发生者为准
      const result = await Promise.race([streamPromise, timeoutPromise]);

      // 处理超时情况：60秒无首包或中途20秒挂起
      if (result === "timeout") {
        if (!hasReceivedFirstSegment) {
          // gameLogger 记录超时警告，便于调试
          console.warn(`[wolfcha] runAISpeech: first segment timeout after ${FIRST_PACKET_TIMEOUT_MS}ms for ${player.displayName}, skipping to next speaker`);
          // 显示超时提示消息
          appendToSpeechQueue(t("dayPhase.timeout"));
        } else {
          console.warn(`[wolfcha] runAISpeech: stream idle timeout after ${IDLE_TIMEOUT_MS}ms for ${player.displayName}, finalizing speech`);
          // 如果已收到段落，不显示超时消息，只在日志中打印并结束发言，保留已有内容
        }
        finalizeSpeechQueue();
      }
    } catch {
      // 流式生成整体异常（如网络断开、API 调用失败）且未收到任何段落
      // 显示中断消息作为兜底
      if (!hasReceivedFirstSegment && !isTimedOut) {
        initSpeechQueue([t("dayPhase.interrupted")], player, options?.afterSpeech as ((s: unknown) => Promise<void>) | undefined);
      }
    } finally {
      // 清理空闲计时器
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
      // === 第五步：清理 ===
      // 无论成功、失败还是超时，都必须释放防重入锁
      currentSpeakingPlayerRef.current = null;
      // 如果从未收到任何段落（异常退出或超时），确保关闭加载指示器
      if (!hasReceivedFirstSegment) {
        setIsWaitingForAI(false);
      }
    }
  }, [
    setIsWaitingForAI,
    setDialogue,
    initSpeechQueue,
    initStreamingSpeechQueue,
    appendToSpeechQueue,
    finalizeSpeechQueue,
    consumePrefetchedSpeech,
    prefetchNextAISpeech,
    resolveNextSpeaker,
    buildPostSpeechState,
    t,
    onRecordSpeechSegment,
  ]);

  /**
   * @function startLastWordsPhase
   * @description 启动遗言阶段，处理被处决或被击杀玩家的最后发言。
   *
   * 遗言阶段的触发场景：
   * - 白天投票出局：玩家得票最高被淘汰后，可发表遗言
   * - 夜间被杀：狼人击杀的玩家在次日白天可发表遗言
   * - 猎人开枪：猎人死亡时可选择射击一名玩家，射击前后可能有遗言
   *
   * 完整流程：
   * 1. 查找发言者：根据座位号在 players 数组中找到对应玩家
   *    - 如果找不到（理论上不应发生），记录日志并直接调用 afterLastWords 跳过
   *
   * 2. 状态准备：
   *    - 关闭"等待下一轮"状态
   *    - 如果玩家仍存活（如投票出局但尚未标记死亡），调用 killPlayer 标记死亡
   *    - 切换游戏阶段到 DAY_LAST_WORDS
   *    - 设置当前发言者座位号
   *    - 添加系统消息通知所有玩家："X号玩家 XX 开始发表遗言"
   *    - 更新全局游戏状态
   *
   * 3. 人类玩家路径：
   *    - 通过 setAfterLastWords 保存 afterLastWords 回调
   *    - 通过 setDialogue 显示遗言输入提示
   *    - 等待人类玩家在 UI 中输入遗言并提交
   *    - 提交后由 UI 层调用保存的 afterLastWords 回调继续流程
   *
   * 4. AI 玩家路径：
   *    - 先校验 FlowToken 确保游戏未被重置
   *    - 调用 runAISpeech 生成 AI 遗言
   *    - afterSpeech 回调中再次校验 token，然后调用 afterLastWords 继续流程
   *
   * @param state - 当前游戏状态
   * @param seat - 遗言者的座位号
   * @param afterLastWords - 遗言完成后的回调函数（通常用于触发下一阶段）
   * @param token - FlowToken，用于在异步操作后校验游戏是否仍处于有效状态
   */
  const startLastWordsPhase = useCallback(async (
    state: GameState,
    seat: number,
    afterLastWords: (s: GameState) => Promise<void>,
    token: FlowToken
  ) => {
    // 根据座位号查找发言者
    const speaker = state.players.find((p) => p.seat === seat);
    if (!speaker) {
      // 找不到发言者（异常情况），记录日志并跳过遗言直接继续
      gameLogger.flow("遗言阶段：未找到发言者，跳过");

      await afterLastWords(state);
      return;
    }

    setWaitingForNextRound(false);

    // 确保遗言发言者已标记为死亡。
    // 某些场景下玩家可能仍然存活（如投票出局流程中 killPlayer 尚未被调用），
    // 此处兜底确保死亡状态正确。
    let currentState = speaker.alive ? killPlayer(state, seat) : state;
    // 切换到遗言阶段
    currentState = transitionPhase(currentState, "DAY_LAST_WORDS");
    // 设置当前发言者座位，供发言队列和 UI 定位使用
    currentState = { ...currentState, currentSpeakerSeat: seat };
    // 添加系统消息，通知所有玩家遗言开始
    currentState = addSystemMessage(currentState, t("dayPhase.lastWordsSystem", { seat: seat + 1, name: speaker.displayName }));
    setGameState(currentState);

    if (speaker.isHuman) {
      // --- 人类玩家路径 ---
      // 保存 afterLastWords 回调到全局状态，等玩家在 UI 中输入遗言后由 UI 层调用
      setAfterLastWords(afterLastWords);
      // 显示遗言提示对话框，引导人类玩家输入
      setDialogue(speakerHost, t("dayPhase.lastWordsPrompt", { seat: seat + 1, name: speaker.displayName }), false);
      return;
    }

    // --- AI 玩家路径 ---
    // 校验 FlowToken：在之前的异步操作（如 killPlayer、setGameState）期间，
    // 游戏可能已被用户重置，token 失效则直接返回不再继续
    if (!isTokenValid(token)) return;

    // 调用 runAISpeech 生成 AI 遗言
    await runAISpeech(currentState, speaker, {
      afterSpeech: async (s) => {
        // 遗言完成后再次校验 token（AI 发言期间可能耗时较长）
        if (!isTokenValid(token)) return;
        await afterLastWords(s as GameState);
      },
    });
  }, [setGameState, setDialogue, setWaitingForNextRound, isTokenValid, runAISpeech, setAfterLastWords, speakerHost, t]);

  // 暴露两个核心操作供上层游戏循环（useGameLogic）调用
  return {
    startLastWordsPhase,
    runAISpeech,
  };
}
