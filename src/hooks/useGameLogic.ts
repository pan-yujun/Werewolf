"use client";

/**
 * useGameLogic - 游戏主逻辑协调 Hook（中央编排器）
 *
 * 这是整个狼人杀游戏的核心协调层，承担"总指挥"角色：
 *
 * ## 核心职责
 * 1. **子 Hook 编排** — 将以下子模块串联成完整的游戏循环：
 *    - `useDayPhase`：白天发言阶段（自由讨论、遗言）
 *    - `useBadgePhase`：警长竞选阶段（报名、演讲、投票、移交）
 *    - `useSpecialEvents`：特殊事件处理（夜晚结算、猎人开枪、游戏结束）
 *    - `useDialogueManager`：对话/旁白管理（打字机效果、流式语音队列）
 *    - `useReplayRecorder`：回放记录器（记录完整对局时间线，支持事后回放）
 *
 * 2. **全局状态管理** — 通过 Jotai atom (`gameStateAtom`) 管理游戏状态，
 *    并利用 localStorage 持久化实现页面刷新后的断点恢复
 *
 * 3. **人类玩家输入处理** — 接收并分发人类玩家的操作：
 *    夜晚行动（守卫/狼人/女巫/预言家/猎人/白狼王）、发言、投票
 *
 * 4. **昼夜循环驱动** — 协调 night→day→night 的主循环：
 *    夜晚各角色行动 → 夜晚结算 → 白天开始 → 警长竞选(第1天) → 讨论发言 → 投票 → 处决 → 遗言 → 回到夜晚
 *
 * 5. **Dev 调试支持** — 处理开发模式下的阶段跳转和状态修改
 *
 * ## 关键设计模式
 * - **FlowToken 模式**：异步操作前获取 token，await 后检查 token.isValid()，
 *   防止游戏重置期间的陈旧回调继续执行
 * - **Ref 回调模式**：大量使用 useRef 存储函数引用，用于打破子模块间的
 *   循环依赖，并确保异步回调中能访问到最新的函数版本
 * - **Phase Extras 模式**：通过 queuePhaseExtras 在阶段切换时传递上下文数据，
 *   PhaseManager 在 onEnter 时读取这些 extras 配置阶段行为
 *
 * ## 流程概览
 * ```
 * startGame() → 角色揭示 → continueAfterRoleReveal() → 夜晚流程
 *   → proceedToNight() → [守卫→狼人→女巫→预言家→结算]
 *   → startDayPhaseInternal() → [警长竞选(第1天) | 自由讨论]
 *   → enterVotePhase() → handleVoteComplete() → [处决→遗言→警徽移交→猎人开枪]
 *   → proceedToNight() → 循环...
 * ```
 */

// ============================================
// React 核心 & 第三方库
// ============================================
import { useState, useCallback, useRef, useEffect } from "react";
import { useAtom } from "jotai";                    // Jotai 状态管理，用于读写全局 gameStateAtom
import { useLocalStorageState } from "ahooks";       // localStorage 持久化 hook，用于保存人类玩家名称
import { toast } from "sonner";                       // 轻量 toast 通知组件
import { useTranslations } from "next-intl";          // 国际化翻译 hook

// ============================================
// 游戏类型定义 & 状态管理
// ============================================
import { ALL_MODELS, PLAYER_MODELS, PROJECT_MODELS, isWolfRole, type GameState, type Player, type Phase, type Role, type DevPreset, type ModelRef, type StartGameOptions } from "@/types/game";
import { gameStateAtom, isValidTransition, clearPersistedGameState, isGameInProgress } from "@/store/game-machine";
import { getGeneratorModel } from "@/lib/api-keys";

// ============================================
// Game Master — 纯函数层（玩家设置、阶段转换、胜负判定、击杀结算等）
// ============================================
import {
  createInitialGameState,
  setupPlayers,
  addSystemMessage,
  addPlayerMessage,
  transitionPhase as rawTransitionPhase,
  checkWinCondition,
  killPlayer,
  generateDailySummary,
  getNextAliveSeat,
  generateWhiteWolfKingBoomDecision,
} from "@/lib/game-master";

// ============================================
// 角色生成 & 游戏文本 & 场景 & 常量 & 工具
// ============================================
import { buildGenshinModelRefs, generateCharacters, generateGenshinModeCharacters, sampleModelRefs, type GeneratedCharacter } from "@/lib/character-generator";
import { getSystemMessages, getUiText } from "@/lib/game-texts";
import { getRandomScenario } from "@/lib/scenarios";
import { DELAY_CONFIG, getRoleName } from "@/lib/game-constants";
import { generateUUID } from "@/lib/utils";

// ============================================
// 流程控制 & 音频 & 阶段管理器
// ============================================
import {
  AsyncFlowController,    // 异步流程控制器：interrupt/pause/resume，FlowToken 防止陈旧回调
  delay,
  randomDelay,
  computeUniqueTopSeat,
} from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";  // 旁白语音播放（"天黑请闭眼"等）
import { PhaseManager } from "@/game/core/PhaseManager";     // 阶段管理器：将 Phase 枚举映射到 GamePhase 实例

// ============================================
// 外部服务 & 数据追踪
// ============================================
import { supabase } from "@/lib/supabase";                    // Supabase 客户端（认证 + 数据库）
import { gameStatsTracker } from "@/hooks/useGameStats";      // 游戏统计追踪器（本地统计）
import { gameSessionTracker } from "@/lib/game-session-tracker"; // 游戏会话追踪器（云端持久化）
import { isCustomKeyEnabled } from "@/lib/api-keys";
import { isQuotaExhaustedMessage } from "@/lib/llm";
import { aiLogger } from "@/lib/ai-logger";                   // AI 调用日志记录器
import { gameLogger } from "@/lib/game-logger";               // 游戏事件日志记录器

// ============================================
// 子 Hook 模块（核心业务逻辑被拆分到以下子模块中）
// ============================================
import { useDialogueManager, type DialogueState } from "./useDialogueManager";  // 对话/旁白管理（打字机效果、语音队列）
import { useDayPhase } from "./game-phases/useDayPhase";        // 白天发言阶段（自由讨论、遗言）
import { useBadgePhase } from "./game-phases/useBadgePhase";    // 警长竞选阶段（报名、演讲、投票、移交）
import { useSpecialEvents } from "./game-phases/useSpecialEvents"; // 特殊事件（夜晚结算、猎人开枪、游戏结束）
import { useReplayRecorder } from "./useReplayRecorder";        // 回放记录器（记录完整对局时间线）

// ============================================
// 辅助函数（在 Hook 外部定义，不依赖 React 状态）
// ============================================

/**
 * 根据模型名称查找对应的 ModelRef。
 * 优先从 PROJECT_MODELS 中查找（项目内置模型），再从 ALL_MODELS 中查找，
 * 都找不到时回退到 zenmux provider 的默认配置。
 */
function getModelRefForModel(model: string): ModelRef {
  return (
    PROJECT_MODELS.find((ref) => ref.model === model) ??
    ALL_MODELS.find((ref) => ref.model === model) ??
    { provider: "zenmux" as const, model }
  );
}

/**
 * 随机获取一个 AI 模型引用。
 * 优先从 sampleModelRefs 池中采样，池为空时从 PLAYER_MODELS 中随机选择，
 * 最终兜底使用 GENERATOR_MODEL。
 */
function getRandomModelRef(): ModelRef {
  const fallback = sampleModelRefs(1)[0];
  if (fallback) return fallback;
  if (PLAYER_MODELS.length === 0) {
    // Fallback to GENERATOR_MODEL if no models available
    return getModelRefForModel(getGeneratorModel());
  }
  const randomIndex = Math.floor(Math.random() * PLAYER_MODELS.length);
  return PLAYER_MODELS[randomIndex];
}

// Re-export for backward compatibility
export type { DialogueState };

export function useGameLogic() {
  const t = useTranslations();
  const speakerHost = t("speakers.host");

  // ============================================
  // 基础状态（UI 驱动 & 全局游戏状态）
  // ============================================

  // 人类玩家昵称，持久化到 localStorage，下次打开自动填充
  const [humanName, setHumanName] = useLocalStorageState<string>("wolfcha_human_name", {
    defaultValue: "",
  });
  // 游戏是否已开始（控制大厅/游戏桌面的 UI 切换）
  const [gameStarted, setGameStarted] = useState(false);
  // 核心游戏状态 — 通过 Jotai atom 管理，自动持久化到 localStorage（24h TTL）
  const [gameState, setGameState] = useAtom(gameStateAtom);
  // 加载状态（角色生成阶段显示加载动画）
  const [isLoading, setIsLoading] = useState(false);
  // 加载进度（percent: 0-100, stage: 当前阶段名称，用于进度条 UI）
  const [loadingProgress, setLoadingProgress] = useState({ percent: 0, stage: "" });
  // 人类玩家输入框的文本
  const [inputText, setInputText] = useState("");
  // 是否显示玩家桌面（座位表），游戏开始后显示
  const [showTable, setShowTable] = useState(false);
  // 游戏日志区域的 DOM 引用，用于自动滚动到底部
  const logRef = useRef<HTMLDivElement>(null);

  // ============================================
  // 断点恢复相关的状态标记
  // ============================================

  // 是否已经执行过挂载时的状态恢复逻辑（防止重复执行）
  const hasRestoredRef = useRef(false);
  // 组件首次渲染时，游戏是否已经在进行中（即从 localStorage 恢复的场景）
  // 如果是，则后续 checkpoint restore useEffect 需要根据当前阶段决定如何继续流程
  const restoredInProgressOnMountRef = useRef(
    isGameInProgress(gameState) && gameState.players.length > 0
  );
  // 是否已经从检查点恢复并推进了流程（防止 checkpoint useEffect 重复执行）
  const hasResumedFromCheckpointRef = useRef(false);

  // Restore game state from localStorage on mount
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;
    
    // Check if the current gameState is from a restored game in progress
    if (isGameInProgress(gameState) && gameState.players.length > 0) {
      console.info("[wolfcha] Restoring game session from previous state");
      setGameStarted(true);
      setShowTable(true);
    }
  }, [gameState]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    void aiLogger.clearLogsOncePerPageLoad();
  }, []);

  // ============================================
  // 流程控制 & Ref 架构
  // ============================================
  //
  // 为什么需要这么多 useRef？核心原因有三：
  //
  // 1. **打破循环依赖**：子模块（useDayPhase、useBadgePhase 等）需要回调主模块的函数
  //    （如 endGame、resolveNight），但主模块又需要调用子模块的函数。
  //    如果直接在 useCallback 依赖中引用，会导致循环引用。
  //    解法：先创建空 ref，再在函数定义后赋值（xxxRef.current = xxx）。
  //
  // 2. **异步回调中访问最新函数**：游戏流程涉及大量 async/await，
  //    在 await 之后闭包捕获的函数可能是旧版本。通过 ref 始终访问 .current，
  //    确保调用的是最新版本的函数。
  //
  // 3. **跨渲染保持引用**：某些状态（如 flowController、phaseManager）
  //    需要在组件整个生命周期内保持同一实例，不能因重渲染而重建。

  // --- 核心流程控制 ---
  const flowController = useRef(new AsyncFlowController());  // 异步流程控制器：interrupt 中断、pause 暂停、FlowToken 验证
  const phaseManagerRef = useRef(new PhaseManager());        // 阶段管理器：管理所有 GamePhase 实例的生命周期
  const phaseExtrasRef = useRef<{ phase: Phase; extras: Record<string, unknown> } | null>(null);  // 暂存阶段切换时的附加数据（如投票配置、回调函数），在 onEnter 时消费

  // --- 状态追踪 refs（用于 useEffect 比较前后值，避免不必要的副作用触发） ---
  const gameStateRef = useRef<GameState>(gameState);         // 始终指向最新的 gameState，供异步回调读取
  const prevPhaseRef = useRef<Phase>(gameState.phase);       // 上一次的阶段，用于检测阶段变化
  const phaseLifecycleRef = useRef<Phase>(gameState.phase);  // 阶段生命周期追踪（onExit/onEnter 委托）
  const prevDayRef = useRef<number>(gameState.day);          // 上一次的天数，用于检测天数变化
  const prevDevMutationIdRef = useRef<number | undefined>(gameState.devMutationId);   // Dev 模式修改计数器
  const prevDevPhaseJumpTsRef = useRef<number | undefined>(undefined);                // Dev 阶段跳转时间戳（防重复触发）

  // --- 回调 refs（子模块间的异步回调桥梁，打破循环依赖） ---
  // 这些 ref 在函数定义后被赋值（xxxRef.current = xxx），
  // 子模块通过 extras 参数接收 ref 的 wrapper 函数来间接调用
  const runAISpeechRef = useRef<((state: GameState, player: Player) => Promise<void>) | null>(null);           // AI 发言生成
  const handleVoteCompleteRef = useRef<((state: GameState, result: { seat: number; count: number } | null, token: ReturnType<typeof getToken>) => Promise<void>) | null>(null);  // 投票完成后的处理（处决、遗言、猎人等）
  const endGameRef = useRef<((state: GameState, winner: "village" | "wolf") => Promise<void>) | null>(null);    // 游戏结束
  const resolveNightRef = useRef<((state: GameState, token: ReturnType<typeof getToken>, onComplete: (resolvedState: GameState) => Promise<void>) => Promise<void>) | null>(null);  // 夜晚结算（统计死亡、播报结果）
  const startDayPhaseInternalRef = useRef<((state: GameState, token: ReturnType<typeof getToken>, options?: { skipAnnouncements?: boolean }) => Promise<void>) | null>(null);       // 白天阶段入口（判断第1天走警长竞选还是直接发言）
  const badgeTransferRef = useRef<((state: GameState, sheriff: Player, afterTransfer: (s: GameState) => Promise<void>) => Promise<void>) | null>(null);   // 警徽移交
  const hunterDeathRef = useRef<((state: GameState, hunter: Player, diedAtNight: boolean) => Promise<void>) | null>(null);  // 猎人死亡触发开枪
  const proceedToNightRef = useRef<((state: GameState, token: ReturnType<typeof getToken>) => Promise<void>) | null>(null); // 白天→夜晚的过渡
  const onStartVoteRef = useRef<((state: GameState, token: ReturnType<typeof getToken>) => Promise<void>) | null>(null);    // 发起投票
  const onBadgeSpeechEndRef = useRef<((state: GameState) => Promise<void>) | null>(null);   // 警长竞选演讲结束
  const onPkSpeechEndRef = useRef<((state: GameState) => Promise<void>) | null>(null);      // PK 演讲结束
  const wwkBoomCheckRef = useRef<((state: GameState, wwk: Player) => Promise<boolean>) | null>(null);  // 白狼王自爆决策

  // --- 游戏启动相关 refs（控制角色揭示 → 第一晚的过渡流程） ---
  const pendingStartStateRef = useRef<GameState | null>(null);   // 暂存 startGame 创建的初始状态，等待角色揭示后继续
  const hasContinuedAfterRevealRef = useRef(false);              // 是否已经执行过 continueAfterRoleReveal（防重复）
  const isAwaitingRoleRevealRef = useRef(false);                 // 是否正在等待玩家确认角色揭示（阻塞夜晚流程）
  const showTableTimeoutRef = useRef<number | null>(null);       // 桌面显示的延迟定时器 ID
  const lastGameOptionsRef = useRef<Partial<StartGameOptions> | null>(null);  // 上一局的游戏配置，用于"再来一局"时恢复
  const autoRestartTimerRef = useRef<number | null>(null);       // 自动重启定时器 ID

  // --- 人类操作后继续流程的回调 refs ---
  // 当流程需要等待人类玩家输入时，将"下一步"逻辑暂存到 ref 中，
  // 人类操作完成后从 ref 中取出并执行，实现"暂停-恢复"机制
  const afterLastWordsRef = useRef<((state: GameState) => Promise<void>) | null>(null);     // 人类遗言结束后的回调
  const nightContinueRef = useRef<((state: GameState) => Promise<void>) | null>(null);      // 人类预言家查验后的回调（继续夜晚→白天）
  const afterBadgeTransferRef = useRef<((state: GameState) => Promise<void>) | null>(null);  // 警徽移交完成后的回调
  const badgeSpeechEndRef = useRef<((state: GameState) => Promise<void>) | null>(null);      // 警长演讲结束后的回调

  // ============================================
  // 回放记录器
  // ============================================
  const replay = useReplayRecorder();

  /**
   * 页面刷新/组件重挂载时恢复回放记录器。
   *
   * 问题背景：
   *   游戏状态通过 gameStateAtom 持久化到 localStorage（见 game-machine.ts），
   *   页面刷新后可自动恢复游戏进度。但 GameReplayRecorder 是纯内存对象，
   *   组件重挂载时 useRef 会重新初始化为新的空实例（data = null, _started = false）。
   *   而 startRecording() 仅在 startGame() 中被调用（新游戏开始时），
   *   从 localStorage 恢复的进行中游戏不会触发 startGame()，导致记录器从未初始化。
   *
   * 后果：
   *   游戏结束时 finishRecording() → finish() 发现 data === null 直接 return，
   *   回放数据既不会持久化到 localStorage，也不会保留在内存中：
   *     1. 点击"下载回放"按钮无反应（downloadJSON 发现 data 为 null）
   *     2. 大厅游戏记录中无回放按钮（localStorage 中无回放索引）
   *
   * 修复方案：
   *   在组件挂载时检测：如果游戏已开始（非 LOBBY 阶段且有玩家）但记录器未初始化，
   *   则用当前 gameState 重新初始化记录器。
   *   注意：此时只能记录后续事件，刷新前的事件已丢失，但至少能保证结束时有数据可保存。
   *
   * 依赖数组为空 []：仅在组件首次挂载时执行一次。
   * eslint-disable-line：gameState 和 replay 不放入依赖数组是有意为之，
   *   因为只需要在挂载时检查一次，后续由正常的 startRecording 流程接管。
   */
  useEffect(() => {
    if (
      gameState.phase !== "LOBBY" &&
      gameState.players.length > 0 &&
      !replay.isStarted()
    ) {
      replay.startRecording(gameState);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 仅在挂载时检查一次，后续由正常流程接管

  // ============================================
  // 对话管理（打字机效果、语音队列、旁白显示）
  // ============================================
  // useDialogueManager 管理所有 UI 上显示的对话内容，包括：
  // - 系统旁白（"天黑请闭眼"等）
  // - AI 玩家发言（支持流式打字机效果 + 分段播放）
  // - 人类玩家发言确认
  const dialogue = useDialogueManager();
  const {
    currentDialogue,
    isWaitingForAI,
    waitingForNextRound,
    setIsWaitingForAI,
    setWaitingForNextRound,
    setDialogue,
    clearDialogue,
    initSpeechQueue,
    initStreamingSpeechQueue,
    appendToSpeechQueue,
    finalizeSpeechQueue,
    getSpeechQueue,
    advanceSpeechQueue,
    clearSpeechQueue,
    resetDialogueState,
    setPrefetchedSpeech,
    consumePrefetchedSpeech,
    markCurrentSegmentCommitted,
    isCurrentSegmentCommitted,
    markCurrentSegmentCompleted,
    isCurrentSegmentCompleted,
    shouldAutoAdvanceToNextAI,
  } = dialogue;

  // ============================================
  // 派生状态（从 gameState 派生，无需单独维护）
  // ============================================
  const humanPlayer = gameState.players.find((p) => p.isHuman) || null;  // 人类玩家对象，观战模式下为 null
  const isNight = gameState.phase.includes("NIGHT");                      // 当前是否为夜晚阶段

  // ============================================
  // 工具函数（通用辅助逻辑）
  // ============================================

  /**
   * 安全的阶段转换 — 先检查转换合法性（isValidTransition），
   * 再委托给 game-master 的纯函数执行转换。
   * 非法转换仅打印警告，不阻断流程（容错设计）。
   */
  const transitionPhase = useCallback((state: GameState, newPhase: Phase): GameState => {
    if (!isValidTransition(state.phase, newPhase)) {
      console.warn(`[wolfcha] Invalid phase transition: ${state.phase} -> ${newPhase}`);
    }
    return rawTransitionPhase(state, newPhase);
  }, []);

  /** 等待游戏取消暂停 — 在暂停时轮询检测，每 100ms 检查一次 */
  const waitForUnpause = useCallback(async () => {
    while (gameStateRef.current.isPaused) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, []);

  /** 获取当前流程 token — 用于 FlowToken 模式，异步操作前获取，await 后检查有效性 */
  const getToken = useCallback(() => flowController.current.getToken(), []);
  /** 检查 token 是否仍然有效（未被 interrupt 中断） */
  const isTokenValid = useCallback((token: { isValid: () => boolean }) => token.isValid(), []);

  // 细粒度恢复逻辑在后面定义（等 runNightPhaseAction 等函数定义后）

  /** 滚动游戏日志到底部（新消息出现时自动调用） */
  const scrollToBottom = useCallback(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, []);

  /**
   * 暂存阶段附加数据 — 在调用 transitionPhase 之前设置，
   * PhaseManager 在 onEnter 时从 phaseExtrasRef 中读取并消费。
   * 这样可以避免将大量回调函数塞进 GameState 中。
   */
  const queuePhaseExtras = useCallback((phase: Phase, extras: Record<string, unknown>) => {
    phaseExtrasRef.current = { phase, extras };
  }, []);

  /**
   * 构建投票阶段的 extras 对象 — 包含投票阶段所需的所有回调和依赖：
   * - token: 流程控制 token
   * - isRevote: 是否为 PK 重投
   * - onVoteComplete: 投票结算完成回调
   * - onGameEnd: 游戏结束回调
   * - runAISpeech: AI 发言回调
   * - onRecordVoteCast/Result: 回放记录回调
   */
  const buildVotePhaseExtras = useCallback((token: ReturnType<typeof getToken>, options?: { isRevote?: boolean }) => {
    return {
      token,
      isRevote: options?.isRevote === true,
      humanPlayer,
      setGameState,
      setDialogue,
      setIsWaitingForAI,
      waitForUnpause,
      isTokenValid,
      onVoteComplete: async (state: GameState, result: { seat: number; count: number } | null) => {
        const nextToken = getToken();
        const fn = handleVoteCompleteRef.current;
        if (fn) {
          await fn(state, result, nextToken);
        }
      },
      onGameEnd: async (state: GameState, winner: "village" | "wolf") => {
        const fn = endGameRef.current;
        if (fn) {
          await fn(state, winner);
        }
      },
      runAISpeech: async (state: GameState, player: Player) => {
        const fn = runAISpeechRef.current;
        if (fn) {
          await fn(state, player);
        }
      },
      onRecordVoteCast: (voterSeat: number, targetSeat: number, reason: string | undefined, isHuman: boolean, isSheriffVote: boolean, phase: string, day: number) =>
        replay.recordVoteCast(voterSeat, targetSeat, reason, isHuman, isSheriffVote, phase as Phase, day),
      onRecordVoteResult: (eliminated: number | null, dist: Record<string, number[]>, isTie: boolean, isPK: boolean, pkRound: number, phase: string, day: number) =>
        replay.recordVoteResult(eliminated, dist, isTie, isPK, pkRound, phase as Phase, day),
    };
  }, [getToken, humanPlayer, isTokenValid, setDialogue, setGameState, setIsWaitingForAI, waitForUnpause]);

  /**
   * 构建夜晚阶段的 extras 对象 — 包含夜晚流程所需的关键回调：
   * - onNightComplete: 夜晚行动全部完成后，触发 resolveNight（结算死亡）并进入白天
   */
  const buildNightPhaseExtras = useCallback((token: ReturnType<typeof getToken>) => {
    return {
      token,
      setGameState,
      setDialogue,
      setIsWaitingForAI,
      waitForUnpause,
      isTokenValid,
      onNightComplete: async (state: GameState) => {
        const nextToken = getToken();
        const resolveFn = resolveNightRef.current;
        const startDayFn = startDayPhaseInternalRef.current;
        if (!resolveFn || !startDayFn) return;
        await resolveFn(state, nextToken, async (resolvedState) => {
          await startDayFn(resolvedState, nextToken);
        });
      },
    };
  }, [getToken, isTokenValid, setDialogue, setGameState, setIsWaitingForAI, waitForUnpause]);

  /**
   * 构建白天发言阶段的 extras 对象 — 最复杂的 extras，包含：
   * - runAISpeech: AI 玩家发言生成
   * - onStartVote: 发起投票
   * - onBadgeSpeechEnd: 警长竞选演讲结束 → 进入选举投票
   * - onPkSpeechEnd: PK 演讲结束 → 重新投票
   * - onWhiteWolfKingBoomCheck: 白狼王自爆决策检查
   * - onBadgeTransfer: 警徽移交
   * - onHunterDeath: 猎人死亡（白天被处决时触发开枪）
   * - onGameEnd: 游戏结束
   */
  const buildDaySpeechExtras = useCallback((token: ReturnType<typeof getToken>) => {
    return {
      token,
      setGameState,
      setDialogue,
      waitForUnpause,
      runAISpeech: async (state: GameState, player: Player) => {
        const fn = runAISpeechRef.current;
        if (fn) {
          await fn(state, player);
        }
      },
      onStartVote: async (state: GameState, nextToken: ReturnType<typeof getToken>) => {
        const fn = onStartVoteRef.current;
        if (fn) {
          await fn(state, nextToken);
        }
      },
      onBadgeSpeechEnd: async (state: GameState) => {
        const fn = onBadgeSpeechEndRef.current;
        if (fn) {
          await fn(state);
        }
      },
      onPkSpeechEnd: async (state: GameState) => {
        const fn = onPkSpeechEndRef.current;
        if (fn) {
          await fn(state);
        }
      },
      onWhiteWolfKingBoomCheck: async (state: GameState, wwk: Player): Promise<boolean> => {
        const fn = wwkBoomCheckRef.current;
        if (fn) {
          return fn(state, wwk);
        }
        return false;
      },
      onBadgeTransfer: async (state: GameState, sheriff: Player, afterTransfer: (s: GameState) => Promise<void>) => {
        const fn = badgeTransferRef.current;
        if (fn) {
          await fn(state, sheriff, afterTransfer);
        }
      },
      onHunterDeath: async (state: GameState, hunter: Player, diedAtNight: boolean) => {
        const fn = hunterDeathRef.current;
        if (fn) {
          await fn(state, hunter, diedAtNight);
        }
      },
      onGameEnd: async (state: GameState, winner: "village" | "wolf") => {
        const fn = endGameRef.current;
        if (fn) {
          await fn(state, winner);
        }
      },
    };
  }, [setDialogue, setGameState, waitForUnpause]);

  /**
   * 执行白天发言阶段的动作 — 委托给 PhaseManager 中的 DAY_SPEECH 实例。
   * 支持两种动作：
   * - START_DAY_SPEECH_AFTER_BADGE: 警长竞选结束后开始自由讨论
   * - ADVANCE_SPEAKER: 推进到下一位发言者
   */
  const runDaySpeechAction = useCallback(
    async (
      state: GameState,
      token: ReturnType<typeof getToken>,
      action: "START_DAY_SPEECH_AFTER_BADGE" | "ADVANCE_SPEAKER",
      options?: { skipAnnouncements?: boolean }
    ) => {
      const phaseImpl = phaseManagerRef.current.getPhase("DAY_SPEECH");
      if (!phaseImpl) return;
      await phaseImpl.handleAction(
        { state, phase: state.phase, extras: buildDaySpeechExtras(token) },
        action === "START_DAY_SPEECH_AFTER_BADGE"
          ? { type: action, options }
          : { type: action }
      );
    },
    [buildDaySpeechExtras]
  );

  /**
   * 执行夜晚阶段的动作 — 委托给 PhaseManager 中的 NIGHT_START 实例。
   * 支持的动作序列：START_NIGHT → CONTINUE_NIGHT_AFTER_GUARD →
   *   CONTINUE_NIGHT_AFTER_WOLF → CONTINUE_NIGHT_AFTER_WITCH
   * 每个动作完成后，Phase 内部会自动推进到下一个夜晚子阶段。
   */
  const runNightPhaseAction = useCallback(
    async (state: GameState, token: ReturnType<typeof getToken>, action: "START_NIGHT" | "CONTINUE_NIGHT_AFTER_GUARD" | "CONTINUE_NIGHT_AFTER_WOLF" | "CONTINUE_NIGHT_AFTER_WITCH") => {
      const phaseImpl = phaseManagerRef.current.getPhase("NIGHT_START");
      if (!phaseImpl) return;
      await phaseImpl.handleAction(
        { state, phase: state.phase, extras: buildNightPhaseExtras(token) },
        { type: action }
      );
    },
    [buildNightPhaseExtras]
  );

  // ============================================
  // 阶段生命周期 useEffect（onExit/onEnter 委托）
  // ============================================
  // 当 gameState.phase 发生变化时，自动调用：
  //   1. prevPhase.onExit() — 旧阶段的清理逻辑
  //   2. nextPhase.onEnter() — 新阶段的初始化逻辑
  //
  // 通过 phaseExtrasRef 传递阶段配置数据（如投票阶段的回调函数），
  // 如果没有预设 extras（如 DAY_VOTE），则在此处自动构建默认 extras。
  // cancelled 标志防止组件卸载后继续执行异步 onExit/onEnter。
  // ============================================
  useEffect(() => {
    const prevPhase = phaseLifecycleRef.current;
    const nextPhase = gameState.phase;
    if (prevPhase === nextPhase) return;

    // 记录阶段转换到回放
    replay.recordPhaseExit(prevPhase, gameState.day);
    replay.recordPhaseEnter(nextPhase, gameState.day);

    const manager = phaseManagerRef.current;
    const prevImpl = manager.getPhase(prevPhase);
    const nextImpl = manager.getPhase(nextPhase);
    let cancelled = false;
    const queued = phaseExtrasRef.current;
    let extras = queued?.phase === nextPhase ? queued.extras : undefined;
    if (queued?.phase === nextPhase) {
      phaseExtrasRef.current = null;
    }
    if (!extras && nextPhase === "DAY_VOTE") {
      extras = buildVotePhaseExtras(getToken());
    }

    (async () => {
      if (prevImpl) {
        await prevImpl.onExit({ state: gameState, phase: prevPhase });
      }
      if (cancelled) return;
      if (nextImpl) {
        await nextImpl.onEnter({ state: gameState, phase: nextPhase, extras });
      }
    })();

    phaseLifecycleRef.current = nextPhase;
    return () => {
      cancelled = true;
    };
  }, [buildVotePhaseExtras, gameState, gameState.phase, getToken]);

  // ============================================
  // 每日总结生成（AI 生成当天发言摘要，供后续 LLM 调用使用）
  // ============================================
  // 在夜晚开始时和投票前调用，将当天的长篇发言压缩为要点摘要，
  // 减少后续 LLM 调用的 token 消耗，同时保留关键信息。
  const maybeGenerateDailySummary = useCallback(
    async (state: GameState, options?: { force?: boolean }): Promise<GameState> => {
      if (state.day <= 0) return state;
      if (!options?.force && state.dailySummaries?.[state.day]?.length) return state;
      if (!state.messages || state.messages.length === 0) return state;
      try {
        const summary = await generateDailySummary(state);
        if (!summary || summary.bullets.length === 0) return state;
        return {
          ...state,
          dailySummaries: { ...state.dailySummaries, [state.day]: summary.bullets },
          dailySummaryVoteData: {
            ...(state.dailySummaryVoteData ?? {}),
            ...(summary.voteData ? { [state.day]: summary.voteData } : {}),
          },
        };
      } catch {
        return state;
      }
    },
    []
  );

  const buildRawDayTranscript = useCallback((state: GameState): string => {
    const aliveIds = new Set(state.players.filter((p) => p.alive).map((p) => p.playerId));
    const dayStartIndex = (() => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.isSystem && m.content === t("system.dayBreak")) return i;
      }
      return 0;
    })();

    const voteStartIndex = (() => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.isSystem && m.content === t("system.voteStart")) return i;
      }
      return state.messages.length;
    })();

    const slice = state.messages.slice(
      dayStartIndex,
      voteStartIndex > dayStartIndex ? voteStartIndex : state.messages.length
    );

    return slice
      .filter((m) => !m.isSystem && aliveIds.has(m.playerId))
      .map((m) => `${m.playerName}: ${m.content}`)
      .join("\n");
  }, []);

  // ============================================
  // 特殊事件处理（夜晚结算、猎人开枪、游戏结束等）
  // ============================================

  // 缓存 Supabase access token，用于游戏会话的云端持久化
  const accessTokenRef = useRef<string | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      accessTokenRef.current = session?.access_token ?? null;
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      accessTokenRef.current = session?.access_token ?? null;
    });
    return () => subscription.unsubscribe();
  }, []);

  const getAccessToken = useCallback((): string | null => {
    return accessTokenRef.current;
  }, []);

  // 监听页面卸载（beforeunload），将中断的游戏会话同步到云端。
  // 使用 sendBeacon 确保页面关闭时请求能发出（普通 fetch 可能被浏览器取消）。
  useEffect(() => {
    const handleBeforeUnload = () => {
      const summary = gameSessionTracker.getSummary();
      const accessToken = accessTokenRef.current;
      if (!summary || !accessToken) return;

      // 使用 sendBeacon 确保页面关闭时请求能发出
      // 由于 sendBeacon 无法等待异步操作，仍使用 API 路由
      const payload = JSON.stringify({
        action: "update",
        sessionId: summary.sessionId,
        accessToken,
        winner: null,
        completed: false,
        roundsPlayed: summary.roundsPlayed,
        durationSeconds: summary.durationSeconds,
        aiCallsCount: summary.aiCallsCount,
        aiInputChars: summary.aiInputChars,
        aiOutputChars: summary.aiOutputChars,
        aiPromptTokens: summary.aiPromptTokens,
        aiCompletionTokens: summary.aiCompletionTokens,
      });
      navigator.sendBeacon?.(
        "/api/game-sessions",
        new Blob([payload], { type: "application/json" })
      );
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // 初始化特殊事件子模块 — 传入对话管理、流程控制等依赖，
  // 返回 endGame（游戏结束处理）和 resolveNight（夜晚结算）等核心函数
  const specialEvents = useSpecialEvents({
    setDialogue,
    setIsWaitingForAI,
    waitForUnpause,
    isTokenValid,
    getAccessToken,
    prepareFinalState: (state) => maybeGenerateDailySummary(state, { force: true }),
    onRecordNightResolve: (deaths, day) => replay.recordNightResolve(deaths, day),
    onRecordHunterShoot: (hunterSeat, targetSeat, diedAtNight, isHuman, phase, day) =>
      replay.recordHunterShoot(hunterSeat, targetSeat, diedAtNight, isHuman, phase as Phase, day),
  });

  const { endGame, resolveNight } = specialEvents;

  /**
   * 安全地结束游戏 — 统一的游戏结束处理函数。
   * 流程：
   * 1. 记录胜负日志
   * 2. 清理对话/语音队列/UI 状态
   * 3. 完成回放记录并持久化到 localStorage（兜底：如果记录器未初始化则先补初始化）
   * 4. 委托给 specialEvents.endGame 执行最终结算（统计、云端记录等）
   */
  const endGameSafely = useCallback(
    async (state: GameState, winner: "village" | "wolf") => {
      const reason = winner === "village"
        ? "所有狼人已被消灭"
        : "狼人数量大于等于好人";
      gameLogger.win(winner, reason);  // 记录游戏胜负结果（胜方 + 原因）

      clearSpeechQueue();
      clearDialogue();
      setIsWaitingForAI(false);
      setWaitingForNextRound(false);

      /**
       * 完成回放记录并持久化到 localStorage。
       *
       * 安全兜底：如果记录器尚未初始化（极端场景下 useEffect 恢复逻辑未执行或被跳过），
       * 则在结束前强制补一次 startRecording，确保 finishRecording 能正常持久化。
       * 即便此时 timeline 为空，至少 meta、players、finalState 等核心数据能被保存，
       * 用户仍可通过"下载回放"或"游戏记录→回放"查看终态信息。
       */
      if (!replay.isStarted()) {
        replay.startRecording(state);
      }
      replay.finishRecording(state.gameId, winner, state);
      await endGame(state, winner);
    },
    [clearDialogue, clearSpeechQueue, endGame, replay, setIsWaitingForAI, setWaitingForNextRound]
  );

  endGameRef.current = endGameSafely;
  resolveNightRef.current = resolveNight;

  // ============================================
  // 投票阶段（由 PhaseManager 驱动，此处负责进入和结算）
  // ============================================

  /**
   * 进入投票阶段 — 清空上次投票数据，转换到 DAY_VOTE 阶段，
   * 并通过 queuePhaseExtras 将回调函数传递给 PhaseManager。
   * @param isRevote - 是否为 PK 平票后的重投
   */
  const enterVotePhase = useCallback(
    async (state: GameState, token: ReturnType<typeof getToken>, options?: { isRevote?: boolean }) => {
      // 投票阶段不再触发总结 - 避免重复调用
      // 总结将在进入夜晚时统一生成，此时信息最完整（包含投票结果和遗言）
      
      queuePhaseExtras("DAY_VOTE", buildVotePhaseExtras(token, options));
      const clearedState: GameState = {
        ...state,
        votes: {},
        lastVoteReasons: state.voteReasons ? { ...state.voteReasons } : {},
        voteReasons: {},
      };
      const nextState = transitionPhase(clearedState, "DAY_VOTE");
      setGameState(nextState);
    },
    [buildVotePhaseExtras, queuePhaseExtras, setGameState, transitionPhase]
  );

  /**
   * 触发投票结算 — 委托给 PhaseManager 的 DAY_VOTE 实例执行 RESOLVE_VOTES 动作。
   * Phase 内部会统计票数、处理平票 PK、调用 onVoteComplete 回调。
   */
  const resolveVotePhase = useCallback(
    async (state: GameState, token: ReturnType<typeof getToken>) => {
      const phaseImpl = phaseManagerRef.current.getPhase("DAY_VOTE");
      if (!phaseImpl) return;
      await phaseImpl.handleAction(
        { state, phase: "DAY_VOTE", extras: buildVotePhaseExtras(token) },
        { type: "RESOLVE_VOTES" }
      );
    },
    [buildVotePhaseExtras]
  );

  /**
   * 安全的投票结算 — 通过 isResolvingVotesRef 防止重复触发。
   * 多个地方可能同时检测到"全员已投票"（useEffect + handleHumanVote），
   * 此互斥锁确保结算只执行一次。
   */
  const resolveVotesSafely = useCallback(async (
    state: GameState,
    token: ReturnType<typeof getToken>
  ) => {
    if (isResolvingVotesRef.current) return;
    isResolvingVotesRef.current = true;
    try {
      await resolveVotePhase(state, token);
    } finally {
      isResolvingVotesRef.current = false;
    }
  }, [resolveVotePhase]);

  // ============================================
  // 白天发言阶段（自由讨论、遗言）
  // ============================================
  // useDayPhase 管理白天的发言流程，包括：
  // - AI 发言生成（流式打字机效果）
  // - 遗言阶段（被处决/夜间死亡玩家的最后发言）
  // - 发言队列管理（分段播放、预取）
  const dayPhase = useDayPhase(humanPlayer, {
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
    setAfterLastWords: (cb) => { afterLastWordsRef.current = cb; },
    onRecordSpeechSegment: (seat, name, content, idx, isHuman, isLastWords, phase, day) =>
      replay.recordSpeechSegment(seat, name, content, idx, isHuman, isLastWords, phase, day),
  });

  const { startLastWordsPhase, runAISpeech } = dayPhase;
  runAISpeechRef.current = runAISpeech;

  // ============================================
  // 警长竞选阶段（报名、演讲、投票、移交）
  // ============================================
  // useBadgePhase 管理警长竞选的完整流程：
  // 第1天：报名 → 演讲 → 投票 → 当选
  // 后续天：警长死亡时的警徽移交（交给存活玩家或撕毁）
  const badgePhase = useBadgePhase({
    setDialogue,
    clearDialogue,
    setIsWaitingForAI,
    waitForUnpause,
    isTokenValid,
    onBadgeElectionComplete: async (state) => {
      const token = getToken();
      await runDaySpeechAction(state, token, "START_DAY_SPEECH_AFTER_BADGE");
    },
    onBadgeTransferComplete: async (state) => {
      const afterTransfer = afterBadgeTransferRef.current;
      afterBadgeTransferRef.current = null;
      if (afterTransfer) {
        await afterTransfer(state);
      }
    },
    runAISpeech: async (state, player) => {
      await runAISpeech(state, player);
    },
    onRecordBadgeSignupDecision: (seat, signedUp, isHuman, day) =>
      replay.recordBadgeSignupDecision(seat, signedUp, isHuman, day),
    onRecordBadgeElectionVote: (voterSeat, candidateSeat, isHuman, day) =>
      replay.recordBadgeElectionVote(voterSeat, candidateSeat, isHuman, day),
    onRecordBadgeElected: (seat, dist, day) =>
      replay.recordBadgeElected(seat, dist, day),
    onRecordBadgeTransfer: (fromSeat, toSeat, isHuman, phase, day) =>
      replay.recordBadgeTransfer(fromSeat, toSeat, isHuman, phase as Phase, day),
    onRecordBadgeTorn: (fromSeat, isHuman, phase, day) =>
      replay.recordBadgeTorn(fromSeat, isHuman, phase as Phase, day),
  });
  // 将子模块函数赋值到回调 refs，供其他模块通过 ref 间接调用
  badgeTransferRef.current = badgePhase.handleBadgeTransfer;   // 警徽移交处理
  onStartVoteRef.current = enterVotePhase;                     // 发起投票

  // 警长竞选演讲结束回调：先生成每日总结，再进入选举投票阶段
  onBadgeSpeechEndRef.current = async (state: GameState) => {
    const summarized = await maybeGenerateDailySummary(state);
    if (summarized !== state) {
      setGameState(summarized);
    }
    await badgePhase.startBadgeElectionPhase(summarized);
  };
  // PK 演讲结束回调：根据 PK 来源（警长竞选 or 投票平票）重新进入对应的投票阶段
  onPkSpeechEndRef.current = async (state: GameState) => {
    const token = getToken();
    const nextState = {
      ...state,
      pkTargets: undefined,
      pkSource: undefined,
    };

    if (state.pkSource === "badge") {
      await badgePhase.startBadgeElectionPhase(nextState, { isRevote: true });
      return;
    }

    if (state.pkSource === "vote") {
      await enterVotePhase(state, token, { isRevote: true });
      return;
    }
  };

  /**
   * AI 白狼王自爆决策 — 由白天发言阶段在白狼王发言时触发检查。
   * 流程：AI 决策是否自爆 → 选择带走目标 → 执行自爆（自杀+杀目标）→
   *   处理警徽撕毁 → 被带走的猎人可开枪 → 胜负检查 → 继续游戏
   * @returns true 表示已执行自爆（流程已接管），false 表示不自爆
   */
  wwkBoomCheckRef.current = async (state: GameState, wwk: Player): Promise<boolean> => {
    if (state.roleAbilities.whiteWolfKingBoomUsed) return false;
    if (!wwk.agentProfile?.modelRef) return false;

    const targetSeat = await generateWhiteWolfKingBoomDecision(state, wwk);
    if (targetSeat === null) return false; // AI 选择不自爆

    const token = getToken();
    if (!isTokenValid(token)) return false;

    // 执行自爆逻辑
    let currentState = transitionPhase(state, "WHITE_WOLF_KING_BOOM");
    currentState = killPlayer(currentState, wwk.seat);
    currentState = {
      ...currentState,
      roleAbilities: { ...currentState.roleAbilities, whiteWolfKingBoomUsed: true },
    };

    const target = currentState.players.find((p) => p.seat === targetSeat);
    if (target && target.alive) {
      currentState = killPlayer(currentState, targetSeat);
      const msg = t("system.whiteWolfKingBoom", {
        seat: wwk.seat + 1,
        name: wwk.displayName,
        targetSeat: targetSeat + 1,
        targetName: target.displayName,
      });
      currentState = addSystemMessage(currentState, msg);
      setDialogue(speakerHost, msg, false);

      const prevDayRecord = (currentState.dayHistory || {})[currentState.day] || {};
      currentState = {
        ...currentState,
        dayHistory: {
          ...(currentState.dayHistory || {}),
          [currentState.day]: { ...prevDayRecord, whiteWolfKingBoom: { boomSeat: wwk.seat, targetSeat } },
        },
      };
    } else {
      const msg = t("system.whiteWolfKingBoomNoTarget", { seat: wwk.seat + 1, name: wwk.displayName });
      currentState = addSystemMessage(currentState, msg);
      setDialogue(speakerHost, msg, false);
    }

    // 白狼王自爆带走的人没有遗言，如果被带走的人或白狼王是警长，警徽直接撕毁
    const sheriffSeat = currentState.badge.holderSeat;
    if (sheriffSeat !== null && (!currentState.players.find((p) => p.seat === sheriffSeat)?.alive)) {
      const sheriffPlayer = currentState.players.find((p) => p.seat === sheriffSeat);
      const forceTornMsg = t("system.badgeForceTorn", { seat: sheriffSeat + 1, name: sheriffPlayer?.displayName || "" });
      currentState = addSystemMessage(currentState, forceTornMsg);
      currentState = {
        ...currentState,
        badge: { ...currentState.badge, holderSeat: null },
      };
    }

    setGameState(currentState);

    // 白狼王自爆带走猎人时，猎人可以开枪（非毒死，技能可发动）
    const boomTarget = currentState.players.find((p) => p.seat === targetSeat);
    if (boomTarget?.role === "Hunter" && currentState.roleAbilities.hunterCanShoot) {
      await delay(1200);
      const hunterFn = hunterDeathRef.current;
      if (hunterFn) await hunterFn(currentState, boomTarget, false);
      return true;
    }

    const winner = checkWinCondition(currentState);
    if (winner) {
      const endFn = endGameRef.current;
      if (endFn) await endFn(currentState, winner);
      return true;
    }

    await delay(1200);
    const proceedFn = proceedToNightRef.current;
    if (proceedFn) await proceedFn(currentState, token);
    return true;
  };

  // ============================================
  // 内部流程函数（昼夜循环的核心衔接逻辑）
  // ============================================

  /**
   * 白天阶段入口 — 判断应该进入哪种白天流程：
   * - 第1天且无警长 → 进入警长竞选流程（报名 → 演讲 → 投票）
   * - 其他情况 → 直接进入自由讨论发言
   *
   * 此函数是夜晚结算后进入白天的统一入口，也被检查点恢复逻辑调用。
   */
  const startDayPhaseInternal = useCallback(async (
    state: GameState,
    token: ReturnType<typeof getToken>,
    options?: { skipAnnouncements?: boolean }
  ) => {
    // 第一天：先进行警徽评选
    if (state.day === 1 && state.badge.holderSeat === null) {
      gameLogger.flow("第1天：进入警长竞选流程");  // 记录流程分支：第1天走警长竞选
      await badgePhase.startBadgeSignupPhase(state);
      return;
    }
    // 非第一天：直接进入讨论
    const aliveCount = state.players.filter((p) => p.alive).length;
    gameLogger.speechPhase(`第${state.day}天 自由发言阶段开始 (共${aliveCount}位存活玩家)`);  // 记录发言阶段开始
    await runDaySpeechAction(state, token, "START_DAY_SPEECH_AFTER_BADGE", options);
  }, [badgePhase, runDaySpeechAction]);
  startDayPhaseInternalRef.current = startDayPhaseInternal;

  /**
   * 白天→夜晚过渡 — 完整的昼夜切换流程：
   * 1. 同步游戏进度到数据库
   * 2. 递增天数，清除夜晚行动数据（保留守卫上次目标和预言家历史）
   * 3. 转换到 NIGHT_START 阶段
   * 4. 播放"天黑请闭眼"旁白语音
   * 5. 生成每日总结（AI 压缩当天发言为要点）
   * 6. 启动夜晚行动流程（守卫→狼人→女巫→预言家）
   */
  const proceedToNight = useCallback(async (state: GameState, token: ReturnType<typeof getToken>) => {
    if (!isTokenValid(token)) return;
    if (isAwaitingRoleRevealRef.current) return;

    gameLogger.flow(`第${state.day}天结束，进入夜晚`);  // 记录昼夜切换

    // 天黑时同步游戏进度到数据库（incrementRound 内部会立即同步）
    gameSessionTracker.incrementRound().catch(() => {});

    const systemMessages = getSystemMessages();
    const lastGuardTarget = state.nightActions.guardTarget ?? state.nightActions.lastGuardTarget;
    // Preserve seerHistory across nights
    const seerHistory = state.nightActions.seerHistory;
    let nextState = {
      ...state,
      day: state.day + 1,
      nightActions: {
        ...(lastGuardTarget !== undefined ? { lastGuardTarget } : {}),
        ...(seerHistory ? { seerHistory } : {}),
      },
    };
    nextState = transitionPhase(nextState, "NIGHT_START");
    nextState = addSystemMessage(nextState, systemMessages.nightFall(nextState.day));
    setGameState(nextState);

    // Set dialogue before playing audio so message box appears immediately
    setDialogue(speakerHost, systemMessages.nightFall(nextState.day), false);

    // 播放旁白语音
    await playNarrator("nightFall");

    await delay(250);
    if (!isTokenValid(token)) return;

    setDialogue(speakerHost, systemMessages.summarizingDay, false);

    const summarized = await maybeGenerateDailySummary(state, { force: true });
    if (!isTokenValid(token)) return;

    const mergedState = {
      ...nextState,
      dailySummaries: summarized.dailySummaries,
      dailySummaryFacts: summarized.dailySummaryFacts,
      dailySummaryVoteData: summarized.dailySummaryVoteData ?? nextState.dailySummaryVoteData,
    };

    await runNightPhaseAction(mergedState, token, "START_NIGHT");
  }, [isTokenValid, maybeGenerateDailySummary, runNightPhaseAction, setGameState, setDialogue, speakerHost, transitionPhase]);
  proceedToNightRef.current = proceedToNight;

  // ============================================
  // 从检查点恢复后的细粒度推进
  // ============================================
  // 页面刷新后，游戏状态从 localStorage 恢复，但异步流程全部丢失。
  // 此 useEffect 根据恢复时的具体阶段，决定如何重新推进游戏：
  //
  // - NIGHT_* 阶段：检查每个子阶段的完成状态，决定从哪里重新开始
  // - DAY_* 阶段：检查当前发言者状态，恢复到正确的等待状态
  // - DAY_VOTE：检查是否全员已投票，是则自动结算
  //
  // 对于需要人类输入的阶段（守卫、狼人、女巫、预言家），恢复到等待输入状态；
  // 对于 AI 阶段，重新触发 AI 行动。
  // ============================================
  useEffect(() => {
    if (!restoredInProgressOnMountRef.current) return;
    if (hasResumedFromCheckpointRef.current) return;

    const s = gameStateRef.current;
    if (!isGameInProgress(s) || s.players.length === 0) return;

    hasResumedFromCheckpointRef.current = true;
    const token = getToken();

    gameLogger.checkpointRestore(s.phase, s.day);  // 记录从 localStorage 恢复的检查点

    const uiText = getUiText();
    const speakerHint = t("speakers.hint");

    const didLastSpeechComeFrom = (state: GameState, playerId: string): boolean => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.isSystem) continue;
        if (m.day !== state.day) continue;
        if (m.phase !== state.phase) continue;
        return m.playerId === playerId;
      }
      return false;
    };

    // 根据恢复的阶段决定如何继续
    switch (s.phase) {
      case "NIGHT_START": {
        // 第一晚需要弹身份牌，后续夜晚直接开始夜晚流程
        if (s.day === 1) {
          // 第一晚：标记等待身份牌展示
          pendingStartStateRef.current = s;
          hasContinuedAfterRevealRef.current = false;
          isAwaitingRoleRevealRef.current = true;
        } else {
          // 后续夜晚：直接开始夜晚流程（不弹身份牌）
          hasContinuedAfterRevealRef.current = true;
          isAwaitingRoleRevealRef.current = false;
          void runNightPhaseAction(s, token, "START_NIGHT");
        }
        break;
      }

      case "NIGHT_GUARD_ACTION": {
        // 守卫阶段：检查是否已完成
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        const guard = s.players.find((p) => p.role === "Guard" && p.alive);
        if (!guard || s.nightActions.guardTarget !== undefined) {
          // 守卫已选择或没有守卫，继续到狼人阶段
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
        } else if (!guard.isHuman) {
          // AI 守卫需要重新选择
          void runNightPhaseAction(s, token, "START_NIGHT");
        }
        // 人类守卫等待输入
        break;
      }

      case "NIGHT_WOLF_ACTION": {
        // 狼人阶段：检查是否已完成
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        if (s.nightActions.wolfTarget !== undefined) {
          // 狼人已选择，继续到女巫阶段
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
        } else {
          const humanWolf = s.players.find((p) => isWolfRole(p.role) && p.alive && p.isHuman);
          if (!humanWolf) {
            // AI 狼人需要重新选择
            void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
          }
          // 人类狼人等待输入
        }
        break;
      }

      case "NIGHT_WITCH_ACTION": {
        // 女巫阶段：检查是否已完成
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        const witch = s.players.find((p) => p.role === "Witch" && p.alive);
        const witchDone =
          !witch ||
          (s.roleAbilities.witchHealUsed && s.roleAbilities.witchPoisonUsed) ||
          s.nightActions.witchSave !== undefined ||
          s.nightActions.witchPoison !== undefined;

        if (witchDone) {
          // 女巫已决定，继续到预言家阶段
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
        } else if (!witch?.isHuman) {
          // AI 女巫需要重新选择
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
        }
        // 人类女巫等待输入
        break;
      }

      case "NIGHT_SEER_ACTION": {
        // 预言家阶段：检查是否已完成
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        if (s.nightActions.seerTarget !== undefined) {
          // 预言家已查验，设置继续回调并显示查验结果
          const seerResult = s.nightActions.seerResult;
          if (seerResult) {
            const targetPlayer = s.players.find((p) => p.seat === seerResult.targetSeat);
            setDialogue(
              t("speakers.seerResult"),
              t("gameLogicMessages.seerResultText", {
                seat: seerResult.targetSeat + 1,
                name: targetPlayer?.displayName || "",
                result: seerResult.isWolf ? t("gameLogicMessages.werewolfResult") : t("gameLogicMessages.goodResult"),
              }),
              false
            );
          }
          nightContinueRef.current = async (state) => {
            await resolveNight(state, token, async (resolvedState) => {
              await startDayPhaseInternal(resolvedState, token);
            });
          };
        } else {
          const seer = s.players.find((p) => p.role === "Seer" && p.alive);
          if (!seer?.isHuman) {
            // AI 预言家需要重新查验
            void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
          }
          // 人类预言家等待输入
        }
        break;
      }

      case "DAY_START": {
        // 白天开始：进入警徽/讨论流程
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        void startDayPhaseInternal(s, token);
        break;
      }

      case "DAY_BADGE_SIGNUP": {
        // Day 1 警长竞选报名：恢复后继续让 AI 补齐报名，并在全员决定后衔接发言
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        void badgePhase.resumeBadgeSignupPhase(s);
        break;
      }

      case "DAY_BADGE_SPEECH":
      case "DAY_PK_SPEECH":
      case "DAY_SPEECH": {
        // 发言阶段：恢复后尝试把 UI/AI 推进到一个可继续的状态
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;

        // 若没有 speaker（异常/边界），尝试推进到下一个 speaker
        if (s.currentSpeakerSeat === null) {
          void runDaySpeechAction(s, token, "ADVANCE_SPEAKER");
          break;
        }

        const currentSpeaker = s.players.find((p) => p.seat === s.currentSpeakerSeat) || null;
        if (!currentSpeaker || !currentSpeaker.alive) {
          void runDaySpeechAction(s, token, "ADVANCE_SPEAKER");
          break;
        }

        if (currentSpeaker.isHuman) {
          setDialogue(speakerHint, uiText.yourTurn, false);
          break;
        }

        // AI speaker：如果刷新前它已经说完（最后一条本 phase 消息来自它），则恢复为"等待下一轮"状态
        // 否则说明它还没开始/没说完，重新触发一次发言生成
        const aiAlreadySpoke = didLastSpeechComeFrom(s, currentSpeaker.playerId);
        if (aiAlreadySpoke) {
          setWaitingForNextRound(true);
          break;
        }

        void runAISpeech(s, currentSpeaker);
        break;
      }

      case "DAY_LAST_WORDS": {
        // 遗言阶段：发言者应该是已死亡的玩家
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;

        // 若没有 speaker，说明状态异常，跳过遗言直接进入下一阶段
        if (s.currentSpeakerSeat === null) {
          console.warn('[wolfcha] DAY_LAST_WORDS: currentSpeakerSeat is null, skipping last words');
          void proceedToNight(s, token);
          break;
        }

        const lastWordsSpeaker = s.players.find((p) => p.seat === s.currentSpeakerSeat) || null;
        
        // 遗言发言者必须存在（无论生死）
        if (!lastWordsSpeaker) {
          console.warn('[wolfcha] DAY_LAST_WORDS: speaker not found, skipping last words');
          void proceedToNight(s, token);
          break;
        }

        // 遗言阶段的发言者应该是已死亡的玩家，如果还活着说明状态异常
        if (lastWordsSpeaker.alive) {
          console.warn('[wolfcha] DAY_LAST_WORDS: speaker is still alive, this should not happen');
          void proceedToNight(s, token);
          break;
        }

        if (lastWordsSpeaker.isHuman) {
          // 人类玩家：始终恢复到可以继续发言的状态，让玩家决定是否继续或结束
          setDialogue(speakerHint, uiText.yourTurn, false);
          break;
        }

        // AI 遗言发言者：由于无法可靠判断是否已完整说完（可能只说了一部分就刷新了）
        // 因此不检查历史消息，直接重新触发 AI 发言
        // AI 会根据历史消息自行判断是否需要继续说，如果已经说过遗言，AI 会生成简短的补充或确认
        console.info('[wolfcha] DAY_LAST_WORDS: Restoring AI last words, re-triggering speech');
        void runAISpeech(s, lastWordsSpeaker);
        break;
      }

      case "DAY_BADGE_ELECTION": {
        // 如果已经全员投票，恢复后直接触发一次结算（否则维持现状）
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        void badgePhase.maybeResolveBadgeElection(s);
        break;
      }

      case "DAY_VOTE": {
        // 投票阶段恢复：检查是否所有应投票的玩家都已投完
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        // PK 投票时，参与PK的人不投票
        const pkTargets =
          s.pkSource === "vote" && Array.isArray(s.pkTargets) ? s.pkTargets : [];
        const voterIds = s.players
          .filter((p) => p.alive && !pkTargets.includes(p.seat))
          .map((p) => p.playerId);
        const allVoted = voterIds.length > 0 && voterIds.every((id) => typeof s.votes[id] === "number");
        if (allVoted) {
          void resolveVotesSafely(s, token);
        }
        // 否则等待剩余玩家投票（人类和AI）
        break;
      }

      default: {
        // 其他阶段暂不自动推进
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        break;
      }
    }
  }, [badgePhase, getToken, runAISpeech, runDaySpeechAction, runNightPhaseAction, resolveNight, resolveVotesSafely, setDialogue, setWaitingForNextRound, startDayPhaseInternal, t]);

  /**
   * 猎人死亡处理 — 当猎人被杀（夜间/处决/白狼王自爆）时触发开枪流程。
   * 猎人选择一个目标射杀后，根据死亡时机决定：
   * - diedAtNight=true → 跳过遗言，直接进入白天（skipAnnouncements）
   * - diedAtNight=false → 进入夜晚
   */
  hunterDeathRef.current = async (state: GameState, hunter: Player, diedAtNight: boolean) => {
    const token = getToken();
    await specialEvents.handleHunterDeath(state, hunter, diedAtNight, token, async (afterState) => {
      const startDayFn = startDayPhaseInternalRef.current;
      const proceedFn = proceedToNightRef.current;
      if (!startDayFn || !proceedFn) return;
      if (diedAtNight) {
        await startDayFn(afterState, token, { skipAnnouncements: true });
      } else {
        await proceedFn(afterState, token);
      }
    });
  };

  /**
   * 投票完成后的完整处理流程 — 投票结算后的"后处理链"：
   *
   * 有处决目标时：
   *   1. 记录投票结果日志
   *   2. 进入遗言阶段（startLastWordsPhase）
   *   3. 遗言结束后：
   *      a. 如果被处决者是警长 → 警徽移交（badgeTransfer）→
   *         移交后检查猎人开枪 → 胜负检查 → 进入夜晚
   *      b. 如果被处决者是猎人 → 猎人开枪 → 胜负检查 → 进入夜晚
   *      c. 其他情况 → 胜负检查 → 进入夜晚
   *
   * 平票（无处决目标）时：
   *   直接进入夜晚
   */
  const handleVoteComplete = useCallback(async (
    state: GameState,
    result: { seat: number; count: number } | null,
    token: ReturnType<typeof getToken>
  ) => {
    if (result) {
      const executedPlayer = state.players.find((p) => p.seat === result.seat);
      const isSheriff = state.badge.holderSeat === result.seat;

      if (executedPlayer) {
        gameLogger.voteResult(`${executedPlayer.displayName}(座位${result.seat + 1}) 被投票处决 (${result.count}票)`);  // 记录投票处决结果
      }

      await delay(DELAY_CONFIG.MEDIUM);
      if (!isTokenValid(token)) return;

      await startLastWordsPhase(state, result.seat, async (s) => {
        // 警长死亡，先移交警徽
        if (isSheriff && executedPlayer) {
          afterBadgeTransferRef.current = async (afterTransferState) => {
            if (executedPlayer?.role === "Hunter" && afterTransferState.roleAbilities.hunterCanShoot) {
              await specialEvents.handleHunterDeath(afterTransferState, executedPlayer, false, token, async (afterHunterState) => {
                await proceedToNight(afterHunterState, token);
              });
              return;
            }

            const winnerAfterTransfer = checkWinCondition(afterTransferState);
            if (winnerAfterTransfer) {
              await endGameSafely(afterTransferState, winnerAfterTransfer);
              return;
            }

            await proceedToNight(afterTransferState, token);
          };
          await badgePhase.handleBadgeTransfer(s, executedPlayer, async (afterTransferState) => {
            const cb = afterBadgeTransferRef.current;
            afterBadgeTransferRef.current = null;
            if (cb) await cb(afterTransferState);
          });
          return;
        }

        // 猎人开枪
        if (executedPlayer?.role === "Hunter" && s.roleAbilities.hunterCanShoot) {
          await specialEvents.handleHunterDeath(s, executedPlayer, false, token, async (afterHunterState) => {
            await proceedToNight(afterHunterState, token);
          });
          return;
        }

        // 检查胜负
        const winnerAfterLastWords = checkWinCondition(s);
        if (winnerAfterLastWords) {
          await endGameSafely(s, winnerAfterLastWords);
          return;
        }

        await proceedToNight(s, token);
      }, token);
      return;
    }

    // 平票，等待一段时间让用户看到结果，然后进入夜晚
    gameLogger.voteResult("平票，无人被处决");  // 记录平票结果
    await delay(DELAY_CONFIG.MEDIUM);
    if (!isTokenValid(token)) return;
    await proceedToNight(state, token);
  }, [isTokenValid, startLastWordsPhase, badgePhase, specialEvents, endGame, proceedToNight]);
  handleVoteCompleteRef.current = handleVoteComplete;

  

  // ============================================
  // 投票完成监控（安全保障机制 / 兜底触发）
  // ============================================
  // 此 useEffect 是投票结算的"安全网"：
  // 当所有应投票的玩家（排除已翻牌白痴、PK 选手）都已投票，
  // 且当前不在等待 AI 状态时，自动触发 resolveVotePhase。
  //
  // 这解决了以下场景：
  // - handleHumanVote 中的结算检查因竞态条件被跳过
  // - AI 投票后没有正确触发结算
  // - 页面刷新恢复后所有投票已完成但未结算
  // ============================================
  const isResolvingVotesRef = useRef(false);
  useEffect(() => {
    if (gameState.phase !== "DAY_VOTE") return;
    if (isResolvingVotesRef.current) return;
    if (isWaitingForAI) return;

    // Revealed Idiot cannot vote, exclude from allVoted check
    const revealedIdiotId = gameState.roleAbilities.idiotRevealed
      ? gameState.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;
    // PK投票时，参与PK的人不投票，需要排除
    const pkTargets =
      gameState.pkSource === "vote" && Array.isArray(gameState.pkTargets) ? gameState.pkTargets : [];
    const voterIds = gameState.players
      .filter((p) => p.alive && p.playerId !== revealedIdiotId && !pkTargets.includes(p.seat))
      .map((p) => p.playerId);
    const allVoted = voterIds.every((id) => typeof gameState.votes[id] === "number");
    
    if (allVoted && voterIds.length > 0) {
      console.log("[wolfcha] useEffect: All votes detected, triggering resolveVotePhase as safety net");
      const token = getToken();
      void resolveVotesSafely(gameState, token);
    }
  }, [gameState.phase, gameState.votes, gameState.players, getToken, resolveVotesSafely, isWaitingForAI]);

  // ============================================
  // 同步 gameStateRef & Dev Mode 容错处理
  // ============================================
  // 此 useEffect 做两件事：
  // 1. 始终将最新 gameState 同步到 gameStateRef.current
  //    （供异步回调读取最新状态）
  //
  // 2. Dev Mode 容错：当 Dev 面板修改了游戏状态（devMutationId 变化）时：
  //    - 中断当前所有异步流程（interrupt）
  //    - 清理 UI 状态（对话、输入框、等待标志）
  //    - 对"软编辑"（不改变阶段/天数的修改），尝试自动继续被中断的流程
  //      例如：手动补齐夜晚行动数据后，自动推进到下一子阶段
  useEffect(() => {
    gameStateRef.current = gameState;

    // Dev Mode 容错
    const prevDevMutationId = prevDevMutationIdRef.current;
    const devMutationId = gameState.devMutationId;
    const devMutated =
      typeof devMutationId === "number" &&
      (typeof prevDevMutationId !== "number" || devMutationId !== prevDevMutationId);

    const phaseChanged = prevPhaseRef.current !== gameState.phase;
    const dayChanged = prevDayRef.current !== gameState.day;
    const hardReset = phaseChanged || dayChanged || !!gameState.devPhaseJump;

    if (devMutated) {
      flowController.current.interrupt();
      pendingStartStateRef.current = null;
      hasContinuedAfterRevealRef.current = false;

      if (waitingForNextRound) setWaitingForNextRound(false);
      if (isWaitingForAI) setIsWaitingForAI(false);

      if (hardReset) {
        afterLastWordsRef.current = null;
        nightContinueRef.current = null;
        clearSpeechQueue();
        if (currentDialogue) clearDialogue();
        if (inputText) setInputText("");
      } else {
        // Dev 动作编辑：可能中断了 runNightPhase 的后台推进。若关键数据已被用户补齐，则自动继续夜晚流程。
        // 注意：只在"软编辑"时尝试恢复，避免和显式跳转冲突。
        const s = gameState;
        (async () => {
          const token = flowController.current.getToken();

          // Night phases: if the required action is already set (possibly via Dev actions tab), continue.
          if (s.phase === "NIGHT_GUARD_ACTION") {
            const guard = s.players.find((p) => p.role === "Guard" && p.alive);
            if (!guard || s.nightActions.guardTarget !== undefined) {
              await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
            }
            return;
          }

          if (s.phase === "NIGHT_WOLF_ACTION") {
            if (s.nightActions.wolfTarget !== undefined) {
              await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
            }
            return;
          }

          if (s.phase === "NIGHT_WITCH_ACTION") {
            const witch = s.players.find((p) => p.role === "Witch" && p.alive);
            const usedAll = s.roleAbilities.witchHealUsed && s.roleAbilities.witchPoisonUsed;
            const decided = s.nightActions.witchSave !== undefined || s.nightActions.witchPoison !== undefined;
            if (!witch || usedAll || decided) {
              await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
            }
            return;
          }

          if (s.phase === "NIGHT_SEER_ACTION") {
            if (s.nightActions.seerTarget !== undefined) {
              // 预言家已查验，设置 nightContinueRef 以便用户确认后继续
              nightContinueRef.current = async (state) => {
                await resolveNight(state, token, async (resolvedState) => {
                  await startDayPhaseInternal(resolvedState, token);
                });
              };
            }
            return;
          }

          if (s.phase === "DAY_VOTE") {
            const revIdiotId = s.roleAbilities.idiotRevealed
              ? s.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
              : undefined;
            const aliveIds = s.players.filter((p) => p.alive && p.playerId !== revIdiotId).map((p) => p.playerId);
            const allVoted = aliveIds.every((id) => typeof s.votes[id] === "number");
            if (allVoted) {
              await resolveVotePhase(s, token);
            }
          }
        })();
      }
    }

    prevPhaseRef.current = gameState.phase;
    prevDayRef.current = gameState.day;
    prevDevMutationIdRef.current = devMutationId;
  }, [gameState, currentDialogue, inputText, isWaitingForAI, waitingForNextRound, clearDialogue, clearSpeechQueue, setIsWaitingForAI, setWaitingForNextRound, runNightPhaseAction, resolveNight, startDayPhaseInternal, resolveVotePhase]);

  // ============================================
  // Dev Phase Jump 处理（开发模式阶段跳转）
  // ============================================
  // Dev 面板允许开发者直接跳转到任意游戏阶段。
  // 当检测到 devPhaseJump payload 时：
  //   1. 中断当前流程
  //   2. 根据目标阶段调用对应的流程函数
  //   3. 清除跳转标记（防止重复触发）
  //
  // 支持的跳转目标：NIGHT_START/GUARD/WOLF/WITCH/SEER/RESOLVE、
  //   DAY_START/SPEECH/VOTE/LAST_WORDS/RESOLVE
  useEffect(() => {
    const payload = gameState.devPhaseJump;
    if (!payload) return;
    if (prevDevPhaseJumpTsRef.current === payload.ts) return;
    prevDevPhaseJumpTsRef.current = payload.ts;

    flowController.current.interrupt();
    const token = getToken();
    const to = payload.to;
    const s = gameStateRef.current;

    const clearMark = () => {
      setGameState((prev) => {
        if (!prev.devPhaseJump || prev.devPhaseJump.ts !== payload.ts) return prev;
        return { ...prev, devPhaseJump: undefined };
      });
    };

    (async () => {
      try {
        if (to === "NIGHT_START" || to === "NIGHT_GUARD_ACTION") {
          if (isAwaitingRoleRevealRef.current) return;
          await runNightPhaseAction(s, token, "START_NIGHT");
          return;
        }
        if (to === "NIGHT_WOLF_ACTION") {
          await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
          return;
        }
        if (to === "NIGHT_WITCH_ACTION") {
          await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
          return;
        }
        if (to === "NIGHT_SEER_ACTION") {
          await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
          return;
        }
        if (to === "NIGHT_RESOLVE") {
          await resolveNight(s, token, async (resolvedState) => {
            await startDayPhaseInternal(resolvedState, token);
          });
          return;
        }
        if (to === "DAY_START" || to === "DAY_SPEECH") {
          await startDayPhaseInternal(s, token);
          return;
        }
        if (to === "DAY_VOTE") {
          await enterVotePhase(s, token);
          return;
        }
        if (to === "DAY_LAST_WORDS") {
          const seat = s.currentSpeakerSeat ?? s.players.find((p) => !p.alive)?.seat ?? 0;
          await startLastWordsPhase(s, seat, async (after) => {
            await proceedToNight(after, token);
          }, token);
          return;
        }
        if (to === "DAY_RESOLVE") {
          await resolveVotePhase(s, token);
          return;
        }
      } finally {
        clearMark();
      }
    })();
  }, [gameState.devPhaseJump, getToken, runNightPhaseAction, resolveNight, startDayPhaseInternal, enterVotePhase, startLastWordsPhase, resolveVotePhase, proceedToNight, setGameState]);

  /**
   * 开始游戏 — 完整的游戏初始化流程，包含以下步骤：
   *
   * 1. **重置状态** — 清空对话、输入框、桌面显示等 UI 状态
   * 2. **统计追踪初始化** — 启动 gameStatsTracker 和 gameSessionTracker
   * 3. **场景生成** — 随机选择一个游戏场景（原神模式除外）
   * 4. **玩家初始化** — 创建空的玩家列表（人类座位 0，其余为 AI）
   * 5. **角色生成** — 三条路径：
   *    - 自定义角色列表（customCharacters）→ 直接使用
   *    - 原神模式（isGenshinMode）→ 生成原神角色
   *    - 标准模式 → 调用 generateCharacters（异步流式生成，带动画效果）
   * 6. **角色分配** — 调用 setupPlayers 分配狼人/村民等角色和模型
   * 7. **初始状态创建** — 创建 GameState，设置为 NIGHT_START 阶段
   * 8. **日志记录** — 记录游戏开始和角色分配
   * 9. **Dev 预设** — 如果指定了 devPreset，跳转到对应阶段
   * 10. **回放记录** — 启动 replay recorder
   * 11. **角色揭示** — 设置 pendingStartState，等待玩家确认角色
   *     （观战模式跳过揭示，直接开始夜晚流程）
   *
   * @param options - 游戏配置选项（角色、人数、难度、模式等）
   */
  const startGame = useCallback(async (options?: Partial<StartGameOptions>) => {
    // 取消待执行的自动重启定时器，防止竞争条件：
    // 当用户点击"再来一局"后，restartGame(true) 会设置 3 秒定时器自动重启；
    // 若用户在 3 秒内手动点击"开始游戏"，需要取消该定时器，
    // 否则定时器触发时会用上一局的旧配置覆盖用户刚启动的新游戏。
    if (autoRestartTimerRef.current !== null) {
      window.clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
    }

    const {
      fixedRoles,                      // 自定义角色分配（开发模式或自定义配置时使用）
      devPreset,                       // 开发预设（跳转到特定阶段）
      difficulty = "normal",           // 难度等级
      playerCount = 10,                // 游戏人数
      configPreset = "standard",       // 配置预设（standard/noGuard），用于区分同人数的不同角色方案
      isGenshinMode = false,           // 是否启用原神模式
      isSpectatorMode = false,         // 是否启用观战模式
      customCharacters = [],           // 自定义角色列表
      preferredRole,                   // 玩家偏好角色
    } = options ?? {};

    // 保存本次游戏配置，供"再来一局"时复用
    lastGameOptionsRef.current = options ?? {};

    const totalPlayers = playerCount;

    resetDialogueState();
    setInputText("");
    setShowTable(false);
    pendingStartStateRef.current = null;
    hasContinuedAfterRevealRef.current = false;
    isAwaitingRoleRevealRef.current = false;
    badgeSpeechEndRef.current = null;
    if (showTableTimeoutRef.current !== null) {
      window.clearTimeout(showTableTimeoutRef.current);
      showTableTimeoutRef.current = null;
    }

    setIsLoading(true);
    setLoadingProgress({ percent: 0, stage: "init" });
    try {
      // 初始化游戏统计追踪器
      setLoadingProgress({ percent: 5, stage: "init" });
      const statsConfig = {
        playerCount,
        difficulty,
        usedCustomKey: isCustomKeyEnabled(),
      };
      gameStatsTracker.start(statsConfig);

      // 创建游戏会话记录（前端直接调用 Supabase）
      gameSessionTracker.start({
        playerCount,
        difficulty,
        usedCustomKey: isCustomKeyEnabled(),
        modelUsed: getGeneratorModel(),
      }).then((sessionId) => {
        if (sessionId) {
          gameStatsTracker.setSessionId(sessionId);
        }
      }).catch((err) => {
        console.error("[game-session] Failed to create:", err);
      });

      setLoadingProgress({ percent: 10, stage: "scenario" });
      const systemMessages = getSystemMessages();
      const scenario = isGenshinMode ? undefined : getRandomScenario();
      const makeId = () => generateUUID();

      // In spectator mode, there's no human player - all seats are AI
      const humanSeat = isSpectatorMode ? -1 : 0;

      const aiSeats = Array.from({ length: totalPlayers }, (_, seat) => seat).filter(
        (seat) => seat !== humanSeat
      );
      const aiSeatOrder = (() => {
        const shuffled = [...aiSeats];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
      })();

      const aiModelRefs = sampleModelRefs(isSpectatorMode ? totalPlayers : totalPlayers - 1);
      const initialPlayers: Player[] = Array.from({ length: totalPlayers }).map((_, seat) => {
        const isHuman = !isSpectatorMode && seat === humanSeat;
        const playerId = makeId();
        return {
          playerId,
          seat,
          displayName: isHuman ? (humanName || "你") : "",
          avatarSeed: playerId,
          alive: true,
          role: "Villager" as Role,
          alignment: "village",
          isHuman,
        };
      });

      const seedPlayerIds = initialPlayers.map((p) => p.playerId);

      setGameState({
        ...createInitialGameState(),
        scenario,
        players: initialPlayers,
        phase: "LOBBY",
        day: 0,
        difficulty,
        isGenshinMode,
        isSpectatorMode,
      });

      setGameStarted(true);
      setShowTable(true);

      let characters: GeneratedCharacter[] = [];
      let genshinModelRefs: ModelRef[] | undefined = undefined;
      const numAiPlayers = isSpectatorMode ? totalPlayers : totalPlayers - 1;

      setLoadingProgress({ percent: 15, stage: "players" });

      // Convert custom characters to GeneratedCharacter format
      const customCharsToUse = customCharacters.slice(0, numAiPlayers);
      const customGeneratedCharacters: GeneratedCharacter[] = customCharsToUse.map((cc) => ({
        displayName: cc.display_name,
        persona: {
          styleLabel: "",
          voiceRules: cc.style_label?.trim() ? [cc.style_label.trim()] : [],
          mbti: cc.mbti || "",
          gender: cc.gender,
          age: cc.age,
          basicInfo: cc.basic_info?.trim() || undefined,
          voiceId: undefined,
        },
        avatarSeed: cc.avatar_seed || undefined,
      }));
      // Per-character model overrides (undefined = use random from pool)
      const customModelRefs = customCharsToUse.map((cc) => cc.modelRef);

      const applyCustomCharactersToState = (customList: GeneratedCharacter[]) => {
        if (customList.length === 0) return;
        const seatMap = new Map<number, { character: GeneratedCharacter; index: number }>();
        customList.forEach((character, index) => {
          const seat = aiSeatOrder[index] ?? index + 1;
          if (Number.isFinite(seat)) {
            seatMap.set(seat, { character, index });
          }
        });
        if (seatMap.size === 0) return;
        setGameState((prev) => {
          const nextPlayers = prev.players.map((pl) => {
            const match = seatMap.get(pl.seat);
            if (!match || pl.isHuman) return pl;
            return {
              ...pl,
              displayName: match.character.displayName,
              avatarSeed: match.character.avatarSeed ?? pl.avatarSeed ?? pl.playerId,
              agentProfile: {
                modelRef: customModelRefs[match.index] ?? aiModelRefs[match.index] ?? getRandomModelRef(),
                persona: match.character.persona,
                playerMind: match.character.playerMind,
              },
            };
          });
          return { ...prev, players: nextPlayers };
        });
      };

      // Use custom characters if provided, otherwise generate
      const hasCustomCharacters = customGeneratedCharacters.length > 0;

      if (hasCustomCharacters) {
        setLoadingProgress({ percent: 20, stage: "players" });
        applyCustomCharactersToState(customGeneratedCharacters);
        // Fill remaining slots with generated characters if needed
        const remainingCount = numAiPlayers - customGeneratedCharacters.length;
        if (remainingCount > 0) {
          const extraCharacters = await generateCharacters(remainingCount, scenario, {});
          characters = [...customGeneratedCharacters, ...extraCharacters];
        } else {
          characters = customGeneratedCharacters;
        }
        setLoadingProgress({ percent: 80, stage: "players" });
        
        // Custom characters appear immediately (no delay), generated ones animate in
        const customCount = customGeneratedCharacters.length;
        characters.forEach((character, index) => {
          const seat = aiSeatOrder[index] ?? index + 1;
          const isCustom = index < customCount;
          const delay = isCustom ? 0 : 200 + (index - customCount) * 180;
          
          window.setTimeout(() => {
            setGameState((prev) => {
              const nextPlayers = prev.players.map((pl) => {
                if (pl.seat !== seat) return pl;
                if (pl.isHuman) return pl;
                return {
                  ...pl,
                  displayName: character.displayName,
                  avatarSeed: character.avatarSeed ?? pl.avatarSeed ?? pl.playerId,
                  agentProfile: {
                    modelRef: customModelRefs[index] ?? aiModelRefs[index] ?? getRandomModelRef(),
                    persona: character.persona,
                    playerMind: character.playerMind,
                  },
                };
              });
              return { ...prev, players: nextPlayers };
            });
          }, delay);
        });
      } else if (isGenshinMode) {
        setLoadingProgress({ percent: 20, stage: "players" });
        genshinModelRefs = buildGenshinModelRefs(numAiPlayers);
        characters = await generateGenshinModeCharacters(numAiPlayers, genshinModelRefs);
        setLoadingProgress({ percent: 80, stage: "players" });
        
        // 为 Genshin 模式添加逐个出现的动画效果
        characters.forEach((character, index) => {
          const seat = aiSeatOrder[index] ?? index + 1;
          window.setTimeout(() => {
            setGameState((prev) => {
              const nextPlayers = prev.players.map((pl) => {
                if (pl.seat !== seat) return pl;
                if (pl.isHuman) return pl;
                return {
                  ...pl,
                  displayName: character.displayName,
                  avatarSeed: pl.avatarSeed ?? pl.playerId,
                  agentProfile: {
                    modelRef: genshinModelRefs![index] ?? getRandomModelRef(),
                    persona: character.persona,
                    playerMind: character.playerMind,
                  },
                };
              });
              return { ...prev, players: nextPlayers };
            });
          }, 200 + index * 180); // 逐个出现，每个间隔 180ms
        });
      } else {
        setLoadingProgress({ percent: 20, stage: "profiles" });
        characters = await generateCharacters(numAiPlayers, scenario, {
          onBaseProfiles: (profiles) => {
            setLoadingProgress({ percent: 40, stage: "personas" });
            profiles.forEach((p, i) => {
              const seat = aiSeatOrder[i] ?? i + 1;
              window.setTimeout(() => {
                setGameState((prev) => {
                  const nextPlayers = prev.players.map((pl) => {
                    if (pl.seat === seat) return { ...pl, displayName: p.displayName };
                    return pl;
                  });
                  return { ...prev, players: nextPlayers };
                });
              }, 420 + i * 260);
            });
          },
          onCharacter: (index, character) => {
            // Update progress based on character index
            const progress = 40 + Math.floor((index / numAiPlayers) * 40);
            setLoadingProgress({ percent: progress, stage: "personas" });
            const seat = aiSeatOrder[index] ?? index + 1;
            window.setTimeout(() => {
              setGameState((prev) => {
                const nextPlayers = prev.players.map((pl) => {
                  if (pl.seat !== seat) return pl;
                  if (pl.isHuman) return pl;
                  return {
                    ...pl,
                    displayName: character.displayName,
                  avatarSeed: pl.avatarSeed ?? pl.playerId,
                    agentProfile: {
                      modelRef: aiModelRefs[index] ?? getRandomModelRef(),
                      persona: character.persona,
                      playerMind: character.playerMind,
                    },
                  };
                });
                return { ...prev, players: nextPlayers };
              });
            }, 120);
          },
        });
        setLoadingProgress({ percent: 80, stage: "personas" });
      }

      setLoadingProgress({ percent: 85, stage: "roles" });
      // Merge custom model refs into aiModelRefs so setupPlayers uses them
      // 合并自定义模型引用到 AI 模型列表
      const mergedModelRefs = isGenshinMode
        ? genshinModelRefs!
        : aiModelRefs.map((ref, i) => customModelRefs[i] ?? ref);
      // 初始化玩家：分配角色、模型、人设，configPreset 决定使用哪种角色配置方案
      const players = setupPlayers(
        characters,
        humanSeat,
        humanName || "你",
        totalPlayers,
        fixedRoles,
        seedPlayerIds,
        mergedModelRefs,
        aiSeatOrder,
        preferredRole,
        configPreset
      );

      let newState: GameState = {
        ...createInitialGameState(),
        scenario,
        players,
        phase: "NIGHT_START",
        day: 1,
        difficulty,
        isGenshinMode,
        isSpectatorMode,
      };

      newState = addSystemMessage(newState, systemMessages.gameStart);
      newState = addSystemMessage(newState, systemMessages.nightFall(1));

      // 记录角色分配日志
      const roleList = players
        .filter((p) => !p.isHuman)
        .map((p) => `${p.displayName}(${p.role})`)
        .join(", ");
      gameLogger.gameStart(totalPlayers, difficulty);   // 记录游戏开始（人数、难度）
      gameLogger.rolesAssigned(roleList);                // 记录角色分配详情（AI玩家名+角色）

      // Dev 预设处理
      if (devPreset === "MILK_POISON_TEST") {
        const newPlayers = newState.players.map((p, i) => {
          if (i === 0) return { ...p, role: "Guard" as Role, alignment: "village" as const, alive: true };
          if (i === 1) return { ...p, role: "Witch" as Role, alignment: "village" as const, alive: true };
          if (i === 2) return { ...p, role: "Werewolf" as Role, alignment: "wolf" as const, alive: true };
          if (i === 3) return { ...p, role: "Villager" as Role, alignment: "village" as const, alive: true };
          return { ...p, alive: true };
        });
        newState = {
          ...newState,
          players: newPlayers,
          phase: "NIGHT_WITCH_ACTION",
          day: 1,
          devMutationId: (newState.devMutationId ?? 0) + 1,
          devPhaseJump: { to: "NIGHT_WITCH_ACTION", ts: Date.now() },
          nightActions: {
            ...newState.nightActions,
            guardTarget: 3,
            wolfTarget: 3,
          },
          roleAbilities: {
            ...newState.roleAbilities,
            witchHealUsed: false,
            witchPoisonUsed: false,
            hunterCanShoot: true,
          },
        };
      } else if (devPreset === "LAST_WORDS_TEST") {
        const alivePlayers = newState.players.filter((p) => p.alive);
        const votes: Record<string, number> = {};
        alivePlayers.forEach((p) => {
          votes[p.playerId] = 0;
        });
        newState = {
          ...newState,
          phase: "DAY_VOTE",
          day: 1,
          devMutationId: (newState.devMutationId ?? 0) + 1,
          devPhaseJump: { to: "DAY_VOTE", ts: Date.now() },
          votes,
        };
      }

      setGameState(newState);

      // 开始回放记录
      replay.startRecording(newState);

      setLoadingProgress({ percent: 95, stage: "finalizing" });
      // In spectator mode, skip role reveal and start the game immediately
      if (isSpectatorMode) {
        pendingStartStateRef.current = null;
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        
        // Start the night phase directly after state is set
        setTimeout(async () => {
          const token = getToken();
          if (isTokenValid(token)) {
            const systemMessages = getSystemMessages();
            setDialogue(speakerHost, systemMessages.nightFall(newState.day), false);
            await playNarrator("nightFall");
            await runNightPhaseAction(newState, token, "START_NIGHT");
          }
        }, 0);
      } else {
        pendingStartStateRef.current = devPreset ? null : newState;
        hasContinuedAfterRevealRef.current = false;
        isAwaitingRoleRevealRef.current = true;
      }
    } catch (error) {
      const msg = String(error);
      gameLogger.flow(`游戏启动失败: ${msg}`);  // 记录启动失败（网络错误、API 限流等）
      if (isQuotaExhaustedMessage(msg)) {
        toast.error(t("gameLogicMessages.quotaExhausted.title"), {
          description: t("gameLogicMessages.quotaExhausted.description"),
          duration: 10000,
        });
      } else if (msg.includes("ZenMux API error: 401") || msg.includes(" 401")) {
        toast.error(t("gameLogicMessages.zenmux401"));
      } else {
        toast.error(t("gameLogicMessages.requestFailed"), { description: msg });
      }
      setDialogue(t("speakers.system"), t("gameLogicMessages.errorOccurred", { error: String(error) }), false);
      setGameStarted(false);
      setShowTable(false);
    } finally {
      setLoadingProgress({ percent: 100, stage: "complete" });
      // Small delay before hiding progress bar so user can see 100%
      setTimeout(() => {
        setIsLoading(false);
        setLoadingProgress({ percent: 0, stage: "" });
      }, 500);
    }
  }, [humanName, resetDialogueState, setDialogue, setGameStarted, setGameState, setInputText, setIsLoading, setShowTable, t]);

  /**
   * 角色揭示后继续 — 玩家在角色揭示界面点击确认后调用。
   * 流程：
   * 1. 从 pendingStartStateRef 获取暂存的初始状态
   * 2. 标记已继续（防重复）
   * 3. 播放"天黑请闭眼"旁白语音
   * 4. 启动夜晚行动流程（守卫→狼人→女巫→预言家）
   */
  const continueAfterRoleReveal = useCallback(async () => {
    const token = getToken();
    const pending = pendingStartStateRef.current ?? gameStateRef.current;
    gameLogger.flow("角色揭示完毕，进入第一晚");  // 记录角色揭示 → 第一晚过渡
    if (!pending) return;
    // Only meaningful at NIGHT_START (role reveal screen)
    if (pending.phase !== "NIGHT_START") return;
    if (hasContinuedAfterRevealRef.current) return;

    hasContinuedAfterRevealRef.current = true;
    pendingStartStateRef.current = null;
    isAwaitingRoleRevealRef.current = false;

    if (!isTokenValid(token)) return;

    const systemMessages = getSystemMessages();

    // Set dialogue before playing audio so message box appears immediately
    setDialogue(speakerHost, systemMessages.nightFall(pending.day), false);
    
    // 播放第一晚的"天黑请闭眼"旁白
    await playNarrator("nightFall");
    
    await runNightPhaseAction(pending, token, "START_NIGHT");
  }, [getToken, isTokenValid, runNightPhaseAction, setDialogue, speakerHost]);

  /**
   * 重新开始游戏 — 完全重置所有状态，回到大厅。
   * 按顺序执行：
   * 1. 记录重启日志
   * 2. 中断所有异步流程（flowController.interrupt）
   * 3. 结束当前游戏会话（云端标记为未完成）
   * 4. 清除 localStorage 中的持久化状态
   * 5. 重置 gameState 到初始值
   * 6. 重置对话状态、输入框、桌面显示
   * 7. 清理所有 refs（回调、标记、定时器）
   */
  const restartGame = useCallback((autoRestart?: boolean) => {
    gameLogger.gameRestart();  // 记录游戏重启事件
    // 清空日志在 gameRestart 之后、重置状态之前，这样"游戏重启"这条日志也会被记录
    setTimeout(() => gameLogger.clearLogs(), 100);  // 延迟清空，确保重启日志被写入

    // 1. 中断所有异步流程
    flowController.current.interrupt();

    // 2. 结束当前游戏会话（如果有）
    gameSessionTracker.end(null, false).catch(() => {});

    // 3. 清除持久化的游戏状态
    clearPersistedGameState();

    // 4. 重置游戏状态到初始值
    setGameState(createInitialGameState());

    // 5. 重置对话状态
    resetDialogueState();

    // 6. 清空输入
    setInputText("");

    // 7. 隐藏桌面，标记游戏未开始
    setShowTable(false);
    setGameStarted(false);

    // 8. 清理所有 refs
    pendingStartStateRef.current = null;
    hasContinuedAfterRevealRef.current = false;
    isAwaitingRoleRevealRef.current = false;
    badgeSpeechEndRef.current = null;
    afterLastWordsRef.current = null;
    nightContinueRef.current = null;
    afterBadgeTransferRef.current = null;
    isResolvingVotesRef.current = false;

    // 9. 清除定时器
    if (showTableTimeoutRef.current !== null) {
      window.clearTimeout(showTableTimeoutRef.current);
      showTableTimeoutRef.current = null;
    }

    // 10. 清除自动重启定时器（如果存在）
    if (autoRestartTimerRef.current !== null) {
      window.clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
    }

    // 11. 如果需要自动重启，3秒后使用上一局配置自动开始新游戏
    //     注意：若用户在 3 秒内手动点击"开始游戏"，startGame 会取消此定时器
    if (autoRestart) {
      const savedOptions = lastGameOptionsRef.current;
      autoRestartTimerRef.current = window.setTimeout(() => {
        autoRestartTimerRef.current = null;
        startGame(savedOptions ?? {});
      }, 3000);
    }
  }, [setGameState, resetDialogueState, startGame]);

  /**
   * 人类玩家发言 — 将输入框文本添加到游戏消息列表。
   * 前置检查：当前阶段必须是发言阶段（DAY_SPEECH/LAST_WORDS/BADGE_SPEECH/PK_SPEECH），
   * 且当前发言者必须是人类玩家。区分遗言和正常发言记录不同日志。
   */
  const handleHumanSpeech = useCallback(async () => {
    if (!inputText.trim() || !humanPlayer) return;

    const s = gameStateRef.current;
    const isMyTurn = (s.phase === "DAY_SPEECH" || s.phase === "DAY_LAST_WORDS" || s.phase === "DAY_BADGE_SPEECH" || s.phase === "DAY_PK_SPEECH") && s.currentSpeakerSeat === humanPlayer.seat;
    if (!isMyTurn) return;

    const speech = inputText.trim();
    const isLastWords = s.phase === "DAY_LAST_WORDS";
    if (isLastWords) {
      gameLogger.lastWords(humanPlayer.seat, humanPlayer.displayName, true);  // 记录人类遗言
    } else {
      gameLogger.speech(humanPlayer.seat, humanPlayer.displayName, true);     // 记录人类发言
    }
    setInputText("");

    const currentState = addPlayerMessage(gameStateRef.current, humanPlayer.playerId, speech);
    setGameState(currentState);
  }, [inputText, humanPlayer, setGameState]);

  /**
   * 人类玩家结束发言 — 点击"结束发言"按钮后调用。
   * - 遗言阶段：调用 afterLastWordsRef 中的回调（进入夜晚或继续流程）
   * - 正常发言：调用 ADVANCE_SPEAKER 推进到下一位发言者
   * 延迟 300ms 是为了让最后一条消息的动画播放完毕。
   */
  const handleFinishSpeaking = useCallback(async () => {
    if (!humanPlayer) return;

    if (gameStateRef.current.phase === "DAY_LAST_WORDS") {
      const next = afterLastWordsRef.current;
      afterLastWordsRef.current = null;
      if (next) {
        await delay(500);
        await next(gameStateRef.current);
      }
      return;
    }

    const startState = gameStateRef.current;
    const startGameId = startState.gameId;
    const startPhase = startState.phase;

    await delay(300);

    const liveState = gameStateRef.current;
    if (liveState.gameId !== startGameId) return;
    if (liveState.phase !== startPhase) return;

    const token = getToken();
    await runDaySpeechAction(liveState, token, "ADVANCE_SPEAKER");
  }, [humanPlayer, getToken, runDaySpeechAction]);

  /**
   * 下一轮按钮 — 当一轮发言结束、显示"下一轮"按钮时调用。
   * 清除等待标志，推进到下一位发言者。
   */
  const handleNextRound = useCallback(async () => {
    const startState = gameStateRef.current;
    const startGameId = startState.gameId;
    const startPhase = startState.phase;

    if (startPhase !== "DAY_SPEECH" && startPhase !== "DAY_LAST_WORDS" && startPhase !== "DAY_BADGE_SPEECH" && startPhase !== "DAY_PK_SPEECH") {
      return;
    }

    setWaitingForNextRound(false);
    await delay(300);

    const liveState = gameStateRef.current;
    if (liveState.gameId !== startGameId) return;
    if (liveState.phase !== startPhase) return;

    const token = getToken();
    await runDaySpeechAction(liveState, token, "ADVANCE_SPEAKER");
  }, [getToken, runDaySpeechAction, setWaitingForNextRound]);

  /**
   * 人类玩家投票 — 处理投票提交和自动结算。
   * 支持两种投票场景：
   * - DAY_BADGE_ELECTION：警长选举投票（记录到 badge.votes）
   * - DAY_VOTE：普通投票/PK 投票（记录到 votes）
   *
   * 投票后自动检查是否全员已投票，是则触发结算（resolveVotesSafely）。
   * 使用函数式 setGameState 更新确保状态一致性。
   */
  const handleHumanVote = useCallback(async (targetSeat: number) => {
    if (!humanPlayer) return;
    if (!humanPlayer.alive) return;

    // Revealed Idiot cannot vote
    const baseState0 = gameStateRef.current;
    if (humanPlayer.role === "Idiot" && baseState0.roleAbilities.idiotRevealed) return;

    const baseState = baseState0;
    if (baseState.phase !== "DAY_VOTE" && baseState.phase !== "DAY_BADGE_ELECTION") return;
    const targetPlayer = baseState.players.find((p) => p.seat === targetSeat);
    if (!targetPlayer || !targetPlayer.alive) return;

    if (baseState.phase === "DAY_BADGE_ELECTION") {
      if (typeof baseState.badge.votes?.[humanPlayer.playerId] === "number") return;
      const candidates = baseState.badge.candidates || [];
      if (candidates.includes(humanPlayer.seat)) {
        console.warn("[wolfcha] Candidate cannot vote in badge election");
        return;
      }

      const nextState: GameState = {
        ...baseState,
        badge: {
          ...baseState.badge,
          votes: { ...baseState.badge.votes, [humanPlayer.playerId]: targetSeat },
        },
      };
      setGameState(nextState);
      gameStateRef.current = nextState;

      await delay(200);
      await badgePhase.maybeResolveBadgeElection(nextState);
      return;
    }

    if (typeof baseState.votes[humanPlayer.playerId] === "number") return;
    if (baseState.pkSource === "vote" && Array.isArray(baseState.pkTargets) && baseState.pkTargets.length > 0) {
      if (!baseState.pkTargets.includes(targetSeat)) {
        console.warn("[wolfcha] Vote target not in PK list");
        return;
      }
    }

    gameLogger.voteCast(humanPlayer.seat, humanPlayer.displayName, targetSeat, targetPlayer.displayName, true, false);  // 记录人类投票（投票者→目标）

    // 使用函数式更新确保获取最新状态（解决AI投票后状态同步问题）
    let updatedState: GameState | null = null;
    setGameState((prevState) => {
      updatedState = {
        ...prevState,
        votes: { ...prevState.votes, [humanPlayer.playerId]: targetSeat },
      };
      return updatedState;
    });

    // 等待状态更新完成
    await delay(200);
    
    // 从 ref 获取最新状态（setGameState 的函数式更新会确保 prevState 是最新的）
    const latestState = updatedState || gameStateRef.current;
    gameStateRef.current = latestState;

    // 检查是否所有人都投票了（已翻牌白痴除外）
    const revealedIdiotId2 = latestState.roleAbilities.idiotRevealed
      ? latestState.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;
    const aliveIds = latestState.players.filter((p) => p.alive && p.playerId !== revealedIdiotId2).map((p) => p.playerId);
    const allVoted = aliveIds.every((id) => typeof latestState.votes[id] === "number");
    
    console.log("[wolfcha] handleHumanVote: allVoted =", allVoted, "votes count =", Object.keys(latestState.votes).length, "alive count =", aliveIds.length);
    
    if (allVoted && !isWaitingForAI) {
      const token = getToken();
      await resolveVotesSafely(latestState, token);
    }
  }, [humanPlayer, setGameState, badgePhase, getToken, resolveVotesSafely, isWaitingForAI]);

  /**
   * 人类玩家夜晚行动 — 统一的夜晚操作分发器。
   * 根据当前阶段和人类玩家角色，分发到对应的处理逻辑：
   *
   * - **守卫**（NIGHT_GUARD_ACTION）：选择守护目标（不能连续两晚守同一人）
   * - **狼人**（NIGHT_WOLF_ACTION）：选择击杀目标（人类决定后 AI 狼人自动达成共识）
   * - **女巫**（NIGHT_WITCH_ACTION）：使用解药救人 / 使用毒药毒杀 / 不使用
   * - **预言家**（NIGHT_SEER_ACTION）：选择查验目标，显示查验结果，设置 nightContinue 回调
   * - **猎人**（HUNTER_SHOOT）：选择射杀目标，检查胜负，进入下一阶段
   * - **白狼王**（WHITE_WOLF_KING_BOOM）：选择自爆带走目标，处理警徽/猎人/胜负
   *
   * @param targetSeat - 目标座位号
   * @param witchAction - 女巫专用："save"（救人）| "poison"（毒人）| "pass"（不用药）
   */
  const handleNightAction = useCallback(async (targetSeat: number, witchAction?: "save" | "poison" | "pass") => {
    if (!humanPlayer) return;
    if (!humanPlayer.alive && gameState.phase !== "HUNTER_SHOOT") return;

    const token = getToken();
    const systemMessages = getSystemMessages();
    let currentState = gameState;

    // 守卫保护
    if (gameState.phase === "NIGHT_GUARD_ACTION" && humanPlayer.role === "Guard") {
      if (currentState.nightActions.lastGuardTarget === targetSeat) {
        toast.error(t("gameLogicMessages.guardNoRepeat"));
        return;
      }
      const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
      gameLogger.guardAction(`人类守卫 选择守护 ${targetPlayer ? `座位${targetSeat + 1}-${targetPlayer.displayName}` : `座位${targetSeat + 1}`}`);  // 记录守卫守护行动
      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, guardTarget: targetSeat },
      };
      setDialogue(t("speakers.system"), t("gameLogicMessages.youProtected", { seat: targetSeat + 1, name: targetPlayer?.displayName || "" }), false);
      setGameState(currentState);

      await delay(1000);
      await waitForUnpause();
      await runNightPhaseAction(currentState, token, "CONTINUE_NIGHT_AFTER_GUARD");
    }
    // 狼人击杀
    else if (gameState.phase === "NIGHT_WOLF_ACTION" && isWolfRole(humanPlayer.role)) {
      const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
      gameLogger.wolfAction(`人类狼人 选择击杀 ${targetPlayer ? `座位${targetSeat + 1}-${targetPlayer.displayName}` : `座位${targetSeat + 1}`}`);  // 记录狼人击杀行动
      const wolves = currentState.players.filter((p) => isWolfRole(p.role) && p.alive);
      
      // 简化逻辑：人类狼人决定目标，其他AI狼人自动达成共识
      const wolfVotes: Record<string, number> = {};
      for (const wolf of wolves) {
        wolfVotes[wolf.playerId] = targetSeat;
      }

      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, wolfVotes, wolfTarget: targetSeat },
      };
      
      // 显示狼队达成一致的确认消息
      setDialogue(t("speakers.system"), t("gameLogicMessages.wolfDecided", { seat: targetSeat + 1, name: targetPlayer?.displayName || "" }), false);
      setGameState(currentState);

      await delay(800);
      await waitForUnpause();
      await runNightPhaseAction(currentState, token, "CONTINUE_NIGHT_AFTER_WOLF");
    }
    // 女巫用药
    else if (gameState.phase === "NIGHT_WITCH_ACTION" && humanPlayer.role === "Witch") {
      if (witchAction === "save" && !currentState.roleAbilities.witchHealUsed) {
        gameLogger.witchAction("人类女巫 使用解药救人");  // 记录女巫使用解药
        currentState = {
          ...currentState,
          nightActions: { ...currentState.nightActions, witchSave: true },
          roleAbilities: { ...currentState.roleAbilities, witchHealUsed: true },
        };
        setDialogue(t("speakers.system"), t("gameLogicMessages.usedAntidote"), false);
      } else if (witchAction === "poison" && !currentState.roleAbilities.witchPoisonUsed) {
        const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
        gameLogger.witchAction(`人类女巫 使用毒药毒杀 ${targetPlayer ? `座位${targetSeat + 1}-${targetPlayer.displayName}` : `座位${targetSeat + 1}`}`);  // 记录女巫使用毒药
        currentState = {
          ...currentState,
          nightActions: { ...currentState.nightActions, witchPoison: targetSeat },
          roleAbilities: { ...currentState.roleAbilities, witchPoisonUsed: true },
        };
        setDialogue(t("speakers.system"), t("gameLogicMessages.usedPoison", { seat: targetSeat + 1, name: targetPlayer?.displayName || "" }), false);
      } else {
        gameLogger.witchAction("人类女巫 选择不使用药水");  // 记录女巫放弃用药
        setDialogue(t("speakers.system"), t("gameLogicMessages.noPotion"), false);
      }
      setGameState(currentState);

      await delay(800);
      await waitForUnpause();
      await runNightPhaseAction(currentState, token, "CONTINUE_NIGHT_AFTER_WITCH");
    }
    // 预言家查验
    else if (gameState.phase === "NIGHT_SEER_ACTION" && humanPlayer.role === "Seer") {
      // Check if seer has already checked this night
      if (currentState.nightActions.seerTarget !== undefined) {
        return;
      }
      const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
      const isWolf = targetPlayer ? targetPlayer.alignment === "wolf" : false;
      gameLogger.seerAction(`人类预言家 查验 ${targetPlayer ? `座位${targetSeat + 1}-${targetPlayer.displayName}` : `座位${targetSeat + 1}`} → ${isWolf ? "🐺 狼人" : "✅ 好人"}`);  // 记录预言家查验结果

      const seerHistory = currentState.nightActions.seerHistory || [];

      currentState = {
        ...currentState,
        nightActions: {
          ...currentState.nightActions,
          seerTarget: targetSeat,
          seerResult: { targetSeat, isWolf: isWolf || false },
          seerHistory: [...seerHistory, { targetSeat, isWolf: isWolf || false, day: currentState.day }],
        },
      };
      setDialogue(t("speakers.seerResult"), t("gameLogicMessages.seerResultText", { seat: targetSeat + 1, name: targetPlayer?.displayName || "", result: isWolf ? t("gameLogicMessages.werewolfResult") : t("gameLogicMessages.goodResult") }), false);
      setGameState(currentState);

      nightContinueRef.current = async (s) => {
        await resolveNight(s, token, async (resolvedState) => {
          await startDayPhaseInternal(resolvedState, token);
        });
      };
      return;
    }
    // 猎人开枪
    else if (gameState.phase === "HUNTER_SHOOT" && humanPlayer.role === "Hunter") {
      const diedAtNight = (currentState as GameState & { _hunterDiedAtNight?: boolean })._hunterDiedAtNight ?? true;
      if (targetSeat >= 0) {
        currentState = killPlayer(currentState, targetSeat);
        const target = currentState.players.find((p) => p.seat === targetSeat);
        gameLogger.hunterShoot(humanPlayer.seat, humanPlayer.displayName, targetSeat, target?.displayName || null);  // 记录猎人开枪
        if (target) {
          currentState = addSystemMessage(currentState, systemMessages.hunterShoot(humanPlayer.seat + 1, targetSeat + 1, target.displayName));
          setDialogue(speakerHost, systemMessages.hunterShoot(humanPlayer.seat + 1, targetSeat + 1, target.displayName), false);
        }

        const shot = { hunterSeat: humanPlayer.seat, targetSeat };
        if (diedAtNight) {
          const prevNightRecord = (currentState.nightHistory || {})[currentState.day] || {};
          currentState = {
            ...currentState,
            nightHistory: {
              ...(currentState.nightHistory || {}),
              [currentState.day]: { ...prevNightRecord, hunterShot: shot },
            },
          };
        } else {
          const prevDayRecord = (currentState.dayHistory || {})[currentState.day] || {};
          currentState = {
            ...currentState,
            dayHistory: {
              ...(currentState.dayHistory || {}),
              [currentState.day]: { ...prevDayRecord, hunterShot: shot },
            },
          };
        }
        setGameState(currentState);
      }

      const winner = checkWinCondition(currentState);
      if (winner) {
        await endGameSafely(currentState, winner);
        return;
      }

      await delay(1200);
      if (diedAtNight) {
        currentState = transitionPhase(currentState, "DAY_START");
        currentState = addSystemMessage(currentState, systemMessages.dayBreak);
        setGameState(currentState);
        await delay(800);
        await startDayPhaseInternal(currentState, token, { skipAnnouncements: true });
      } else {
        await proceedToNight(currentState, token);
      }
    }
    // 白狼王自爆
    else if (gameState.phase === "WHITE_WOLF_KING_BOOM" && humanPlayer.role === "WhiteWolfKing") {
      // Kill the White Wolf King himself
      currentState = killPlayer(currentState, humanPlayer.seat);
      currentState = {
        ...currentState,
        roleAbilities: { ...currentState.roleAbilities, whiteWolfKingBoomUsed: true },
      };

      if (targetSeat >= 0) {
        // Kill the target
        currentState = killPlayer(currentState, targetSeat);
        const target = currentState.players.find((p) => p.seat === targetSeat);
        if (target) {
          const msg = t("system.whiteWolfKingBoom", { seat: humanPlayer.seat + 1, name: humanPlayer.displayName, targetSeat: targetSeat + 1, targetName: target.displayName });
          currentState = addSystemMessage(currentState, msg);
          setDialogue(speakerHost, msg, false);
        }
        const prevDayRecord = (currentState.dayHistory || {})[currentState.day] || {};
        currentState = {
          ...currentState,
          dayHistory: {
            ...(currentState.dayHistory || {}),
            [currentState.day]: { ...prevDayRecord, whiteWolfKingBoom: { boomSeat: humanPlayer.seat, targetSeat } },
          },
        };
      } else {
        const msg = t("system.whiteWolfKingBoomNoTarget", { seat: humanPlayer.seat + 1, name: humanPlayer.displayName });
        currentState = addSystemMessage(currentState, msg);
        setDialogue(speakerHost, msg, false);
      }

      // 白狼王自爆带走的人没有遗言，如果被带走的人或白狼王是警长，警徽直接撕毁
      const boomSheriffSeat = currentState.badge.holderSeat;
      if (boomSheriffSeat !== null && (!currentState.players.find((p) => p.seat === boomSheriffSeat)?.alive)) {
        const boomSheriffPlayer = currentState.players.find((p) => p.seat === boomSheriffSeat);
        const forceTornMsg = t("system.badgeForceTorn", { seat: boomSheriffSeat + 1, name: boomSheriffPlayer?.displayName || "" });
        currentState = addSystemMessage(currentState, forceTornMsg);
        currentState = {
          ...currentState,
          badge: { ...currentState.badge, holderSeat: null },
        };
      }

      setGameState(currentState);

      // 白狼王自爆带走猎人时，猎人可以开枪（非毒死，技能可发动）
      if (targetSeat >= 0) {
        const boomTarget = currentState.players.find((p) => p.seat === targetSeat);
        if (boomTarget?.role === "Hunter" && currentState.roleAbilities.hunterCanShoot) {
          await delay(1200);
          const hunterFn = hunterDeathRef.current;
          if (hunterFn) await hunterFn(currentState, boomTarget, false);
          return;
        }
      }

      const winner = checkWinCondition(currentState);
      if (winner) {
        await endGameSafely(currentState, winner);
        return;
      }

      await delay(1200);
      await proceedToNight(currentState, token);
    }
  }, [gameState, humanPlayer, setGameState, setDialogue, setIsWaitingForAI, waitForUnpause, getToken, runNightPhaseAction, resolveNight, startDayPhaseInternal, proceedToNight, endGame, transitionPhase, speakerHost, t]);

  /**
   * 人类白狼王自爆 — 在白天发言阶段触发，转换到 WHITE_WOLF_KING_BOOM 阶段。
   * 实际的自爆逻辑（杀自己、杀目标、处理警徽等）在 handleNightAction 中的
   * WHITE_WOLF_KING_BOOM 分支处理。此处仅负责阶段转换和 UI 提示。
   */
  const handleWhiteWolfKingBoom = useCallback(async () => {
    if (!humanPlayer || humanPlayer.role !== "WhiteWolfKing" || !humanPlayer.alive) return;
    const currentState = gameStateRef.current;
    if (currentState.roleAbilities.whiteWolfKingBoomUsed) return;
    gameLogger.whiteWolfKingBoom(humanPlayer.seat, humanPlayer.displayName, null, null);  // 记录白狼王自爆事件
    gameLogger.flow("人类白狼王选择自爆！");  // 记录自爆流程触发
    if (currentState.phase !== "DAY_SPEECH" && currentState.phase !== "DAY_BADGE_SPEECH" && currentState.phase !== "DAY_PK_SPEECH") return;

    // Transition to WWK boom phase
    const nextState = transitionPhase(currentState, "WHITE_WOLF_KING_BOOM");
    setGameState(nextState);
    clearDialogue();
    setDialogue(speakerHost, t("ui.whiteWolfKingBoom"), false);
  }, [humanPlayer, transitionPhase, setGameState, clearDialogue, setDialogue, speakerHost, t]);

  /** 人类警长移交 — 将警徽交给指定座位的玩家，委托给 badgePhase 处理 */
  const handleHumanBadgeTransfer = useCallback(async (targetSeat: number) => {
    await badgePhase.handleHumanBadgeTransfer(targetSeat);
  }, [badgePhase]);

  /**
   * 推进发言 — 由 UI 层（对话框组件）在每段语音/文字播放完毕后调用。
   * 核心职责：
   * 1. 将当前分段添加到消息列表（如果尚未提交）
   * 2. 推进语音队列到下一段
   * 3. 如果队列播放完毕，执行 afterSpeech 回调或返回 shouldAdvanceToNextSpeaker
   *
   * 特殊处理：
   * - 游戏结束/夜晚阶段时直接返回 finished
   * - 流式传输中且当前段未完成时不推进
   * - 对话文本超过 10000 字符时提前触发每日总结（减少 token 消耗）
   *
   * @returns { finished, shouldAdvanceToNextSpeaker, shouldAutoAdvanceToNextAI }
   */
  const advanceSpeech = useCallback(async (): Promise<{ finished: boolean; shouldAdvanceToNextSpeaker: boolean; shouldAutoAdvanceToNextAI: boolean }> => {
    if (gameStateRef.current.phase === "GAME_END" || gameStateRef.current.winner) {
      clearSpeechQueue();
      clearDialogue();
      setIsWaitingForAI(false);
      setWaitingForNextRound(false);
      return { finished: true, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }
    if (gameStateRef.current.phase.includes("NIGHT")) {
      const cont = nightContinueRef.current;
      if (cont) {
        nightContinueRef.current = null;
        clearDialogue();
        setIsWaitingForAI(false);
        setWaitingForNextRound(false);
        await cont(gameStateRef.current);
        return { finished: true, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
      }
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    const queue = getSpeechQueue();
    if (!queue) {
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    if (queue.isStreaming && !isCurrentSegmentCompleted()) {
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    const { segments, currentIndex, player, afterSpeech } = queue;

    let nextState = gameStateRef.current;

    // 将当前句子添加到消息列表（如果尚未提交）
    const currentSegment = segments[currentIndex];
    if (currentSegment && currentSegment.trim().length > 0 && !isCurrentSegmentCommitted()) {
      nextState = addPlayerMessage(nextState, player.playerId, currentSegment);
      setGameState(nextState);
      markCurrentSegmentCommitted();

      const rawTranscript = buildRawDayTranscript(nextState);
      const shouldSummarizeEarly =
        nextState.day > 0 &&
        !nextState.dailySummaries?.[nextState.day]?.length &&
        rawTranscript.length > 10000;
      if (shouldSummarizeEarly) {
        void maybeGenerateDailySummary(nextState)
          .then((summarized) => {
            setGameState((prev) => {
              if (prev.gameId !== summarized.gameId || prev.day !== summarized.day) return prev;
              return {
                ...prev,
                dailySummaries: summarized.dailySummaries,
                dailySummaryFacts: summarized.dailySummaryFacts,
                dailySummaryVoteData: summarized.dailySummaryVoteData ?? prev.dailySummaryVoteData,
              };
            });
          })
          .catch(() => {});
      }
    }

    const result = advanceSpeechQueue();
    if (!result) return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };

    if (!result.finished) {
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    setIsWaitingForAI(false);

    if (result.afterSpeech) {
      await result.afterSpeech(nextState);
      // 如果下一个发言者是AI，返回标志让调用方知道可以自动推进
      return { finished: true, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: result.shouldAutoAdvanceToNextAI ?? false };
    }

    // 不设置 waitingForNextRound，直接返回 shouldAdvanceToNextSpeaker: true
    // 让调用方立即调用 handleNextRound，避免单条消息时需要按两次回车的问题
    return { finished: true, shouldAdvanceToNextSpeaker: true, shouldAutoAdvanceToNextAI: false };
  }, [clearDialogue, clearSpeechQueue, setIsWaitingForAI, setWaitingForNextRound, getSpeechQueue, advanceSpeechQueue, setGameState, isCurrentSegmentCommitted, markCurrentSegmentCommitted, isCurrentSegmentCompleted]);

  /** 切换游戏暂停状态 — 暂停时所有 AI 流程会等待（通过 waitForUnpause） */
  const togglePause = useCallback(() => {
    setGameState((prev) => ({
      ...prev,
      isPaused: !prev.isPaused,
    }));
  }, [setGameState]);

  // ============================================
  // 返回 API — 暴露给 UI 组件的完整接口
  // ============================================
  // 分为两大类：
  // - State：只读状态（用于 UI 渲染）
  // - Actions：操作函数（用于事件处理）
  // ============================================
  return {
    // State
    humanName: humanName || "",
    setHumanName,
    gameStarted,
    gameState,
    isLoading,
    loadingProgress,
    isWaitingForAI,
    waitingForNextRound,
    currentDialogue,
    inputText,
    setInputText,
    showTable,
    logRef,
    humanPlayer,
    isNight,

    // Actions
    startGame,
    continueAfterRoleReveal,
    restartGame,
    downloadReplay: replay.downloadReplay,
    handleHumanSpeech,
    handleFinishSpeaking,
    handleBadgeSignup: badgePhase.handleBadgeSignup,
    handleHumanVote,
    handleNightAction,
    handleHumanBadgeTransfer,
    handleWhiteWolfKingBoom,
    handleNextRound,
    scrollToBottom,
    advanceSpeech,
    togglePause,
    markCurrentSegmentCompleted,
    isCurrentSegmentCompleted,
    shouldAutoAdvanceToNextAI,
  };
}
