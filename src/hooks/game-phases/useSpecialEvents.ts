"use client";

/**
 * @file useSpecialEvents.ts
 * @description 特殊事件处理 Hook，负责管理游戏中三类关键的特殊流程：
 *   1. 猎人死亡时的开枪流程（handleHunterDeath / handleHumanHunterShoot）
 *   2. 游戏结束流程（endGame）—— 包括状态终结、角色揭示、会话记录、旁白播报
 *   3. 夜晚结算流程（resolveNight）—— 包括狼人击杀判定、女巫毒杀判定、死亡数组构建、
 *      夜晚历史记录、预言家查验结果展示，以及最终的杀人与胜负判定
 *
 * 本 Hook 是 useGameLogic 的子模块之一，通过回调接口与主 Hook 解耦通信。
 * 所有异步操作均通过 FlowToken 进行有效性检查，防止游戏重置期间的过期回调执行。
 */

import { useCallback } from "react";
import { useAtom } from "jotai";
import type { GameState, Player, Alignment } from "@/types/game";
import { gameStateAtom } from "@/store/game-machine";
import {
  transitionPhase,
  addSystemMessage,
  killPlayer,
  checkWinCondition,
  generateHunterShoot,
} from "@/lib/game-master";
import { getSystemMessages } from "@/lib/game-texts";
import { getI18n } from "@/i18n/translator";
import { DELAY_CONFIG, getRoleName } from "@/lib/game-constants";
import { delay, type FlowToken } from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { gameStatsTracker } from "@/hooks/useGameStats";
import { gameSessionTracker } from "@/lib/game-session-tracker";
import { gameLogger, fmtPlayer } from "@/lib/game-logger";

/**
 * 特殊事件所需的回调函数接口
 * 这些回调由上层 useGameLogic Hook 注入，用于与 UI 层、流程控制层、数据记录层通信，
 * 从而使本 Hook 本身不直接依赖 React 组件的 setState 等细节。
 */
export interface SpecialEventsCallbacks {
  /** 设置对话框内容：显示说话人、文本、是否流式输出 */
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  /** 设置 AI 等待状态标志，用于在 UI 上显示"AI 思考中"等提示 */
  setIsWaitingForAI: (waiting: boolean) => void;
  /** 等待用户点击"继续"按钮或自动播放恢复，用于游戏暂停/自动播放模式 */
  waitForUnpause: () => Promise<void>;
  /** 检查当前 FlowToken 是否仍然有效，无效则说明游戏已被重置或切换了流程 */
  isTokenValid: (token: FlowToken) => boolean;
  /** 获取当前用户的 Supabase 访问令牌，用于后端 API 调用鉴权 */
  getAccessToken: () => string | null;
  /**
   * 可选：在游戏结束前对最终状态进行异步处理（如保存统计数据、生成总结等）。
   * 如果提供了此回调，endGame 会先调用它来获取处理后的状态，再进行结束转换。
   */
  prepareFinalState?: (state: GameState) => Promise<GameState>;
  /** 回放记录回调（可选）：记录夜晚结算的死亡数据，用于游戏回放系统重建夜间事件 */
  onRecordNightResolve?: (deaths: Array<{ seat: number; reason: "wolf" | "poison" | "milk" }>, day: number) => void;
  /** 回放记录回调（可选）：记录猎人射击事件，包含射手座位、目标座位、是否夜间死亡等信息 */
  onRecordHunterShoot?: (hunterSeat: number, targetSeat: number | null, diedAtNight: boolean, isHuman: boolean, phase: string, day: number) => void;
}

/**
 * 特殊事件 Hook 向外暴露的四个操作方法
 * 由 useGameLogic 在适当的时机调用，驱动特殊事件的执行。
 */
export interface SpecialEventsActions {
  /**
   * 处理猎人死亡后的开枪流程
   * @param state - 当前游戏状态
   * @param hunter - 猎人玩家对象
   * @param diedAtNight - 是否在夜间死亡（影响历史记录写入 nightHistory 还是 dayHistory）
   * @param token - 流程令牌，用于检查游戏是否被重置
   * @param afterHunter - 猎人开枪完成后的回调，由调用方定义后续流程（如继续白天发言或继续结算）
   */
  handleHunterDeath: (state: GameState, hunter: Player, diedAtNight: boolean, token: FlowToken, afterHunter: (state: GameState) => Promise<void>) => Promise<void>;
  /**
   * 处理人类玩家控制的猎人选择射击目标（由玩家在 UI 上选择目标后触发）
   * @param targetSeat - 玩家选择的目标座位号
   * @param diedAtNight - 是否在夜间死亡
   * @returns 更新后的游戏状态
   */
  handleHumanHunterShoot: (targetSeat: number, diedAtNight: boolean) => Promise<GameState>;
  /**
   * 结束游戏：执行状态终结转换、添加胜负系统消息、角色揭示、会话记录、旁白播报
   * @param state - 当前游戏状态
   * @param winner - 胜利阵营（"village" 或 "wolf"）
   */
  endGame: (state: GameState, winner: Alignment) => Promise<void>;
  /**
   * 结算夜晚：执行狼人击杀判定、女巫毒杀判定、死亡处理、天亮转换，并在之后调用 afterResolve 回调
   * @param state - 当前游戏状态
   * @param token - 流程令牌
   * @param afterResolve - 夜晚结算完成后的回调（通常会进入白天发言阶段）
   */
  resolveNight: (state: GameState, token: FlowToken, afterResolve: (state: GameState) => Promise<void>) => Promise<void>;
}

/**
 * 特殊事件 Hook
 * 负责管理猎人开枪、游戏结束、夜晚结算等特殊流程
 */
export function useSpecialEvents(
  callbacks: SpecialEventsCallbacks
): SpecialEventsActions {
  /**
   * 获取国际化文本资源的辅助函数
   * 为什么不在组件顶层获取：因为 getI18n() 依赖运行时语言设置，
   * 用户可能在游戏过程中切换语言，所以需要在每次使用时实时获取，
   * 而不是在 Hook 初始化时缓存一次。
   * 返回的对象包含：
   *   - t: 翻译函数，通过 key 获取对应语言的文本
   *   - systemMessages: 预定义的系统消息模板（如天亮、胜利、猎人射击等）
   *   - speakerHost / speakerSystem: 主持人和系统的说话人名称（已翻译）
   */
  const getTexts = () => {
    const { t } = getI18n();
    return {
      t,
      systemMessages: getSystemMessages(),
      speakerHost: t("speakers.host"),
      speakerSystem: t("speakers.system"),
    };
  };
  // 全局游戏状态原子（只使用 setter，因为读取状态通过参数传入）
  const [, setGameState] = useAtom(gameStateAtom);

  // 从回调接口中解构出各回调函数，便于后续直接使用
  const { setDialogue, setIsWaitingForAI, waitForUnpause, isTokenValid, getAccessToken, prepareFinalState, onRecordNightResolve, onRecordHunterShoot } = callbacks;

  /**
   * 游戏结束流程
   *
   * 完整执行顺序：
   * 1. 记录胜利日志（gameLogger.win）
   * 2. 如果提供了 prepareFinalState 回调，先对状态进行预处理（如保存统计数据）
   * 3. 将游戏阶段转换为 GAME_END
   * 4. 在状态中设置胜利者（winner 字段）
   * 5. 添加胜负结果的系统消息
   * 6. 构建角色揭示载荷（ROLE_REVEAL），包含所有玩家的座位、角色、是否人类等信息，
   *    以 [ROLE_REVEAL] 前缀的系统消息发送，前端解析后展示翻牌动画
   * 7. 设置主持人对话框显示胜利台词
   * 8. 更新全局游戏状态
   * 9. 通过 gameSessionTracker 将游戏结果写入 Supabase 数据库
   * 10. 播放胜负旁白语音（村庄胜利 / 狼人胜利）
   */
  const endGame = useCallback(async (state: GameState, winner: Alignment) => {
    const texts = getTexts();

    // 步骤1：记录胜利日志，包含胜利方和原因
    // gameLogger.win 会输出结构化的胜利日志，便于调试和日志分析
    const reason = winner === "village" ? "所有狼人已被消灭" : "狼人数量大于等于好人";
    gameLogger.win(winner, reason);

    // 步骤2：如果提供了 prepareFinalState（如需要在结束前保存统计/生成总结），先调用它
    const finalInputState = prepareFinalState ? await prepareFinalState(state) : state;

    // 步骤3：将游戏阶段转换为 GAME_END
    let currentState = transitionPhase(finalInputState, "GAME_END");

    // 步骤4：在状态中标记胜利者
    currentState = { ...currentState, winner };

    // 步骤5：添加胜负结果的系统消息（村庄胜利 / 狼人胜利）
    currentState = addSystemMessage(currentState, winner === "village" ? texts.systemMessages.villageWin : texts.systemMessages.wolfWin);

    // 步骤6：构建角色揭示载荷，按座位号排序，包含每位玩家的身份信息
    // 该载荷以 [ROLE_REVEAL] 前缀嵌入系统消息中，前端通过解析此前缀触发翻牌 UI
    const roleRevealPayload = {
      title: texts.t("specialEvents.roleRevealTitle"),
      players: currentState.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          playerId: p.playerId,
          seat: p.seat,
          name: p.displayName,
          role: p.role,
          isHuman: p.isHuman,
          modelRef: p.agentProfile?.modelRef,
        })),
    };
    currentState = addSystemMessage(currentState, `[ROLE_REVEAL]${JSON.stringify(roleRevealPayload)}`);

    // 步骤7：设置主持人台词（非流式，一次性显示）
    setDialogue(texts.speakerHost, winner === "village" ? texts.t("specialEvents.villageWinLine") : texts.t("specialEvents.wolfWinLine"), false);

    // 步骤8：将最终状态写入全局原子，触发 UI 更新
    setGameState(currentState);

    // 步骤9：将游戏结果异步写入 Supabase 数据库（记录胜者、标记完成等）
    // 使用 .catch 防止写入失败影响游戏流程
    const winnerType = winner === "village" ? "villager" : "wolf";
    gameSessionTracker.end(winnerType, true).catch((err) => {
      console.error("[game-session] Failed to end:", err);
    });

    // 步骤10：播放游戏结束旁白语音
    await playNarrator(winner === "village" ? "villageWin" : "wolfWin");
  }, [setGameState, setDialogue, prepareFinalState]);

  /**
   * 处理猎人死亡后的开枪流程
   *
   * 根据猎人是否为人类玩家，分为两条路径：
   *
   * 路径A —— 人类猎人：
   *   将游戏阶段切换到 HUNTER_SHOOT，存储夜间死亡标志到状态扩展字段，
   *   显示提示文字让玩家选择射击目标，然后直接 return。
   *   后续由玩家在 UI 上选择目标后调用 handleHumanHunterShoot 完成射击。
   *
   * 路径B —— AI 猎人：
   *   将游戏阶段切换到 HUNTER_SHOOT，调用 generateHunterShoot 让 LLM 决定射击目标，
   *   执行 killPlayer 杀死目标，添加系统消息，记录到 nightHistory 或 dayHistory，
   *   然后检查胜负条件；如果游戏未结束，等待一段时间后调用 afterHunter 回调继续。
   *
   * 历史记录规则：
   *   - diedAtNight=true  → 写入 nightHistory[day].hunterShot
   *   - diedAtNight=false → 写入 dayHistory[day].hunterShot
   */
  const handleHunterDeath = useCallback(async (
    state: GameState,
    hunter: Player,
    diedAtNight: boolean,
    token: FlowToken,
    afterHunter: (state: GameState) => Promise<void>
  ) => {
    const texts = getTexts();

    // 记录猎人死亡触发日志
    // gameLogger.flow 用于追踪游戏流程中的关键事件节点
    gameLogger.flow(`猎人(${fmtPlayer(hunter.seat, hunter.displayName)}) 死亡，触发开枪技能 (夜间:${diedAtNight})`);

    // 将游戏阶段切换为 HUNTER_SHOOT（猎人射击阶段）
    let currentState = transitionPhase(state, "HUNTER_SHOOT");
    setGameState(currentState);

    // 路径A：人类猎人 —— 只展示提示，等待玩家在 UI 上选择目标
    if (hunter.isHuman) {
      // 将夜间死亡标志存储到状态的扩展字段中，
      // 供后续 handleHumanHunterShoot 和主 Hook 的 handleNightAction 使用，
      // 以决定射击完成后是继续夜晚结算还是白天流程
      (currentState as GameState & { _hunterDiedAtNight?: boolean })._hunterDiedAtNight = diedAtNight;
      setGameState(currentState);
      setDialogue(texts.speakerSystem, texts.t("specialEvents.hunterPrompt"), false);
      return; // 等待玩家选择目标，后续由 handleHumanHunterShoot 接管
    }

    // 路径B：AI 猎人 —— 由 LLM 生成射击决策
    setIsWaitingForAI(true);
    const targetSeat = await generateHunterShoot(currentState, hunter);
    setIsWaitingForAI(false);

    // FlowToken 检查：如果在 LLM 生成过程中游戏被重置，直接退出，不执行后续操作
    if (!isTokenValid(token)) return;

    // 如果 AI 猎人选择了射击目标（targetSeat 不为 null）
    if (targetSeat !== null) {
      const target = currentState.players.find((p) => p.seat === targetSeat);

      // gameLogger.hunterShoot 记录猎人射击的详细信息：射手座位/名字、目标座位/名字
      gameLogger.hunterShoot(hunter.seat, hunter.displayName, targetSeat, target?.displayName || null);

      // 执行击杀：将目标玩家标记为死亡状态
      currentState = killPlayer(currentState, targetSeat);

      // 添加猎人射击的系统消息和主持人对话
      if (target) {
        currentState = addSystemMessage(currentState, texts.systemMessages.hunterShoot(hunter.seat + 1, targetSeat + 1, target.displayName));
        setDialogue(texts.speakerHost, texts.systemMessages.hunterShoot(hunter.seat + 1, targetSeat + 1, target.displayName), false);
      }

      // 将猎人射击事件记录到回放系统，用于游戏回放重建
      onRecordHunterShoot?.(hunter.seat, targetSeat, diedAtNight, false, "HUNTER_SHOOT", currentState.day);

      // 将猎人射击记录写入历史：
      // - 如果猎人在夜间死亡（diedAtNight=true），写入 nightHistory[day].hunterShot
      // - 如果猎人在白天死亡（diedAtNight=false），写入 dayHistory[day].hunterShot
      // 注意：需要保留该天已有的历史记录（如夜间的狼人击杀、守卫、女巫等数据）
      const shot = { hunterSeat: hunter.seat, targetSeat };
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

    // 猎人射击后检查胜负条件：射击可能导致某一方全灭
    const winner = checkWinCondition(currentState);
    if (winner) {
      await endGame(currentState, winner);
      return; // 游戏已结束，不再执行后续流程
    }

    // 游戏未结束，等待一段时间让玩家查看射击结果
    await delay(DELAY_CONFIG.LONG);
    await waitForUnpause(); // 等待自动播放模式恢复或用户手动继续
    if (!isTokenValid(token)) return;

    // 调用 afterHunter 回调，由调用方决定接下来的流程
    // （如夜晚猎人死亡后继续夜晚结算，或白天猎人死亡后继续白天发言）
    await afterHunter(currentState);
  }, [setGameState, setDialogue, setIsWaitingForAI, waitForUnpause, isTokenValid, endGame]);

  /**
   * 人类猎人开枪（由玩家在 UI 上选择目标后触发）
   * 注意：此函数目前为占位实现，实际逻辑在主 Hook（useGameLogic）中处理。
   * 主 Hook 会接收玩家选择的目标座位，执行击杀、消息添加、历史记录等操作，
   * 然后调用 afterHunter 回调继续后续流程。
   * @param targetSeat - 玩家选择射击的目标座位号
   * @param diedAtNight - 猎人是否在夜间死亡（影响历史记录写入位置）
   * @returns 更新后的游戏状态（由主 Hook 填充实际逻辑）
   */
  const handleHumanHunterShoot = useCallback(async (
    targetSeat: number,
    diedAtNight: boolean
  ): Promise<GameState> => {
    // 这个函数返回更新后的状态，由主 hook 处理后续流程
    return {} as GameState; // 占位，实际逻辑在主 hook 中
  }, []);

  /**
   * 结算夜晚
   *
   * 完整的夜晚结算流程：
   * 1. 将游戏阶段切换为 NIGHT_RESOLVE
   * 2. 从 nightActions 中读取所有夜间行动结果
   * 3. 狼人击杀判定：根据守卫保护 + 女巫解药的组合决定是否击杀成功
   * 4. 女巫毒杀判定：如果女巫使用了毒药，则添加毒杀死亡
   * 5. 构建 nightDeaths 数组（包含所有夜间死亡及死因）
   * 6. 更新状态中的 pendingWolfVictim / pendingPoisonVictim
   * 7. 记录完整的夜晚历史到 nightHistory[day]
   * 8. 记录夜晚结算到回放系统
   * 9. 输出夜晚结算日志
   * 10. 等待后切换到白天（DAY_START），添加天亮系统消息
   * 11. 同步游戏进度到数据库，播放天亮旁白语音
   * 12. 调用 afterResolve 回调进入白天发言阶段
   *
   * 狼人击杀的核心逻辑（奶穿规则）：
   *   - 守卫保护 + 女巫解药 → 两种保护同时存在，视为"奶穿"，受害者仍然死亡（死因为 "milk"）
   *   - 仅守卫保护（无解药） → 守卫成功，受害者存活
   *   - 仅女巫解药（无守卫） → 解药成功，受害者存活
   *   - 无保护 → 狼人击杀成功（死因为 "wolf"）
   */
  const resolveNight = useCallback(async (
    state: GameState,
    token: FlowToken,
    afterResolve: (state: GameState) => Promise<void>
  ) => {
    const texts = getTexts();

    // 步骤1：切换到夜晚结算阶段
    let currentState = transitionPhase(state, "NIGHT_RESOLVE");
    setGameState(currentState);

    // 步骤2：从 nightActions 中提取各项夜间行动结果
    // wolfTarget: 狼人选择的击杀目标座位号
    // guardTarget: 守卫选择的保护目标座位号
    // witchSave: 女巫是否使用了解药（true=使用）
    // witchPoison: 女巫毒杀的目标座位号（undefined=未使用毒药）
    const { wolfTarget, guardTarget, witchSave, witchPoison } = currentState.nightActions;
    let wolfKillSuccessful = false;
    let wolfVictimSeat: number | undefined;
    let poisonVictimSeat: number | undefined;

    // 夜间死亡记录数组，每项包含座位号和死因
    // 死因类型：wolf（狼人击杀）、poison（女巫毒杀）、milk（奶穿：守卫+解药同时生效）
    const nightDeaths: Array<{ seat: number; reason: "wolf" | "poison" | "milk" }> = [];

    /**
     * 添加夜间死亡记录的辅助函数
     * 如果该座位已有记录且新死因不是 wolf，则更新死因（poison/milk 优先级高于 wolf）
     * 如果该座位没有记录，则直接添加
     */
    const addNightDeath = (seat: number, reason: "wolf" | "poison" | "milk") => {
      const existing = nightDeaths.find((death) => death.seat === seat);
      if (!existing) {
        nightDeaths.push({ seat, reason });
        return;
      }
      if (reason !== "wolf") {
        existing.reason = reason;
      }
    };

    // 步骤3：狼人击杀判定
    // 核心逻辑：守卫保护和女巫解药的组合决定狼人击杀是否成功
    if (wolfTarget !== undefined) {
      const isProtected = guardTarget === wolfTarget; // 守卫是否保护了狼人目标
      const isSaved = witchSave === true;             // 女巫是否使用了解药

      // 奶穿规则：
      //   (isProtected && isSaved) → 守卫和解药同时作用 → "奶穿"，受害者仍然死亡（死因标记为 milk）
      //   (!isProtected && !isSaved) → 无任何保护 → 狼人击杀成功（死因标记为 wolf）
      //   (isProtected && !isSaved) → 仅守卫保护 → 击杀被阻止，受害者存活
      //   (!isProtected && isSaved) → 仅解药保护 → 击杀被阻止，受害者存活
      if ((isProtected && isSaved) || (!isProtected && !isSaved)) {
        wolfKillSuccessful = true;
        wolfVictimSeat = wolfTarget;
        addNightDeath(wolfTarget, isProtected && isSaved ? "milk" : "wolf");
      }
    }

    // 步骤4：女巫毒杀判定
    // 如果女巫使用了毒药（witchPoison 不为 undefined），则添加毒杀死亡记录
    if (witchPoison !== undefined) {
      poisonVictimSeat = witchPoison;
      addNightDeath(witchPoison, "poison");
    }

    // 步骤5：更新状态中的待处理死亡信息
    // pendingWolfVictim: 待处理的狼人击杀目标（供后续 killPlayer 使用）
    // pendingPoisonVictim: 待处理的毒杀目标
    // lastGuardTarget: 记录本轮守卫目标（供下轮守卫不能连续保护同一人的规则使用）
    currentState = {
      ...currentState,
      nightActions: {
        ...currentState.nightActions,
        lastGuardTarget: guardTarget,
        pendingWolfVictim: wolfKillSuccessful ? wolfVictimSeat : undefined,
        pendingPoisonVictim: poisonVictimSeat,
      },
    };

    // 步骤6：记录完整的夜晚历史
    // 将本轮夜晚的所有行动和结果写入 nightHistory[day]，
    // 用于游戏回放、复盘分析、以及守卫不能连续保护同一人的规则判断
    currentState = {
      ...currentState,
      nightHistory: {
        ...(currentState.nightHistory || {}),
        [currentState.day]: {
          guardTarget: currentState.nightActions.guardTarget,
          wolfTarget: currentState.nightActions.wolfTarget,
          witchSave: currentState.nightActions.witchSave,
          witchPoison: currentState.nightActions.witchPoison,
          seerTarget: currentState.nightActions.seerTarget,
          seerResult: currentState.nightActions.seerResult,
          deaths: nightDeaths,
        },
      },
    };

    setGameState(currentState);

    // 步骤7：将夜晚结算数据记录到回放系统，用于游戏回放重建夜间事件
    onRecordNightResolve?.(nightDeaths, currentState.day);

    // 步骤8：输出夜晚结算日志
    // gameLogger.nightResolve 记录当夜的死亡情况，便于调试和日志分析
    // 如果是平安夜（无人死亡），输出特殊提示
    if (nightDeaths.length === 0) {
      gameLogger.nightResolve(currentState.day, "平安夜，无人死亡");
    } else {
      // 生成详细的死亡信息文本，包含玩家名字和死因
      const deathDetails = nightDeaths.map(d => {
        const player = currentState.players.find(p => p.seat === d.seat);
        const reasonText = d.reason === "wolf" ? "狼人击杀" : d.reason === "poison" ? "女巫毒杀" : "奶穿(守卫+解药)";
        return `${player ? fmtPlayer(d.seat, player.displayName) : `座位${d.seat + 1}`}(${reasonText})`;
      }).join(", ");
      gameLogger.nightResolve(currentState.day, `${nightDeaths.length}人死亡: ${deathDetails}`);
    }

    // 等待一段时间让玩家查看夜晚结算结果
    await delay(DELAY_CONFIG.LONG);
    await waitForUnpause(); // 等待自动播放模式恢复或用户手动继续
    if (!isTokenValid(token)) return;

    // 步骤9：切换到白天阶段，添加天亮系统消息
    currentState = transitionPhase(currentState, "DAY_START");
    currentState = addSystemMessage(currentState, texts.systemMessages.dayBreak);
    setGameState(currentState);
    setDialogue(texts.speakerHost, texts.systemMessages.dayBreak, false);

    // 步骤10：天亮时同步游戏进度到数据库
    // 使用 .catch 防止同步失败影响游戏流程
    gameSessionTracker.syncProgress().catch(() => {});

    // 步骤11：播放天亮旁白语音
    await playNarrator("dayBreak");

    // 等待旁白播放完成后继续
    await delay(DELAY_CONFIG.MEDIUM);
    await waitForUnpause();
    if (!isTokenValid(token)) return;

    // 步骤12：调用 afterResolve 回调，由调用方决定后续流程（通常是进入白天发言阶段）
    await afterResolve(currentState);
  }, [setGameState, setDialogue, waitForUnpause, isTokenValid]);

  // 返回四个特殊事件操作方法，供 useGameLogic 在适当时机调用
  return {
    handleHunterDeath,      // 猎人死亡后的开枪流程（AI/人类两条路径）
    handleHumanHunterShoot, // 人类猎人选择射击目标（占位，实际逻辑在主 Hook）
    endGame,                // 游戏结束：状态终结 + 角色揭示 + 会话记录 + 旁白
    resolveNight,           // 夜晚结算：击杀判定 + 毒杀判定 + 天亮转换
  };
}
