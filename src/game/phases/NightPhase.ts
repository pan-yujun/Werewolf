/**
 * 夜晚阶段（NightPhase）实现
 *
 * 这是狼人杀游戏的核心阶段之一，负责编排夜晚所有角色的行动流程。
 * 夜晚行动按固定顺序依次执行：守卫 → 狼人 → 女巫 → 预言家
 * 每个子阶段都会判断该角色是否存活、是否为人类玩家：
 *   - 角色不存在/已死亡：跳过该子阶段（播放假动画延迟以掩护身份）
 *   - 人类玩家：暂停流水线，等待玩家通过 UI 做出决策后恢复
 *   - AI 玩家：调用 LLM 生成决策并自动应用结果
 *
 * 设计要点：
 *   1. 采用「流水线 + 中断恢复」模式：runNightPhase 顺序执行各子阶段，
 *      遇到人类玩家时 return 中断，由 handleAction 分发的 CONTINUE_* 动作恢复
 *   2. FlowToken 机制确保游戏重置/中断时能安全停止异步流程
 *   3. 每个子阶段之间插入延迟（NIGHT_PHASE_GAP），模拟角色起身/入睡的节奏感
 *   4. gameLogger 输出用于 UI 日志面板展示，方便玩家了解游戏进程
 */
import type { GameState, Player, Phase } from "@/types/game";
import { isWolfRole } from "@/types/game";
import { GamePhase } from "../core/GamePhase";
import type { GameAction, GameContext, PromptResult, SystemPromptPart } from "../core/types";
import {
  buildGameContext,
  buildTodayTranscript,
  buildPlayerTodaySpeech,
  getRoleText,
  getWinCondition,
  buildSystemTextFromParts,
} from "@/lib/prompt-utils";
import {
  addSystemMessage,
  generateGuardAction,
  generateSeerAction,
  generateWitchAction,
  generateWolfAction,
  transitionPhase as rawTransitionPhase,
} from "@/lib/game-master";
import { getSystemMessages, getUiText } from "@/lib/game-texts";
import { DELAY_CONFIG } from "@/lib/game-constants";
import {
  delay,
  type FlowToken,
} from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { getI18n } from "@/i18n/translator";
import { gameLogger, fmtPlayer } from "@/lib/game-logger";

/**
 * 生成随机的假行动延迟时间
 * 当某个角色不存在或已死亡时，仍然需要播放一段动画延迟，
 * 以防止其他玩家通过「是否有动画」推断出某个角色是否存活（信息隐藏策略）。
 * 延迟时间在配置的最小值和最大值之间随机取值，增加自然感。
 */
function randomFakeActionDelay(): number {
  const min = DELAY_CONFIG.NIGHT_ROLE_ANIMATION_MIN;
  const max = DELAY_CONFIG.NIGHT_ROLE_ANIMATION_MAX;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 夜晚阶段运行时上下文类型
 * 由 useGameLogic hook 在启动夜晚阶段时注入，提供与 React 层交互的所有回调。
 *
 * @property token - 流程令牌，用于检测游戏是否被重置/中断（FlowToken 模式）
 * @property setGameState - 更新游戏状态的回调，同步到 React 状态和 localStorage
 * @property setDialogue - 设置当前对话气泡的显示内容（角色名 + 台词）
 * @property setIsWaitingForAI - 控制 UI 是否显示「AI 思考中」的加载状态
 * @property waitForUnpause - 等待游戏从暂停状态恢复（人类玩家决策期间游戏会暂停）
 * @property isTokenValid - 检查流程令牌是否仍然有效（未被重置作废）
 * @property onNightComplete - 夜晚所有子阶段完成后调用，触发夜晚结算逻辑
 */
type NightPhaseRuntime = {
  token: FlowToken;
  setGameState: (value: GameState | ((prev: GameState) => GameState)) => void;
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  setIsWaitingForAI: (waiting: boolean) => void;
  waitForUnpause: () => Promise<void>;
  isTokenValid: (token: FlowToken) => boolean;
  onNightComplete: (state: GameState) => Promise<void>;
};

/**
 * 夜晚阶段主类
 *
 * 继承 GamePhase 基类，实现夜晚阶段的完整生命周期：
 *   - onEnter: 进入阶段时的初始化（此处为空，实际初始化由 runNightPhase 处理）
 *   - getPrompt: 根据当前子阶段为指定角色构建 LLM 提示词
 *   - handleAction: 分发夜晚阶段的各种动作事件
 *   - onExit: 退出阶段时的清理（此处为空）
 */
export class NightPhase extends GamePhase {
  /**
   * 生命周期：进入夜晚阶段
   * 当前为空实现，因为夜晚的实际逻辑由 START_NIGHT 动作触发的 runNightPhase 驱动
   */
  async onEnter(): Promise<void> {
    return;
  }

  /**
   * 根据当前夜晚子阶段，为指定 AI 玩家构建 LLM 提示词
   *
   * 夜晚分为四个子阶段，每个子阶段需要不同的提示词模板：
   *   - NIGHT_GUARD_ACTION → 守卫选择守护目标
   *   - NIGHT_WOLF_ACTION  → 狼人选择击杀目标（含队友投票信息）
   *   - NIGHT_WITCH_ACTION → 女巫决定是否使用解药/毒药
   *   - NIGHT_SEER_ACTION  → 预言家选择查验目标
   *
   * 每个 build*Prompt 方法都会将提示词分为可缓存（cacheable）和动态两部分，
   * 以优化 LLM API 调用的 token 消耗。
   */
  getPrompt(context: GameContext, player: Player): PromptResult {
    const state = context.state;
    const extras = context.extras ?? {};

    switch (state.phase) {
      case "NIGHT_GUARD_ACTION":
        return this.buildGuardPrompt(state, player);
      case "NIGHT_WOLF_ACTION":
        return this.buildWolfPrompt(
          state,
          player,
          (extras.existingVotes as Record<string, number> | undefined) ?? {}
        );
      case "NIGHT_WITCH_ACTION":
        return this.buildWitchPrompt(
          state,
          player,
          extras.wolfTarget as number | undefined
        );
      case "NIGHT_SEER_ACTION":
        return this.buildSeerPrompt(state, player);
      default:
        return this.buildWolfPrompt(state, player, {});
    }
  }

  /**
   * 动作分发器：根据 action.type 将夜晚阶段的各种事件路由到对应处理方法
   *
   * 夜晚流水线采用「中断-恢复」模式：
   *   1. START_NIGHT            → 启动完整的夜晚流水线（从守卫开始）
   *   2. CONTINUE_NIGHT_AFTER_* → 人类玩家完成操作后，从断点恢复流水线
   *      - CONTINUE_NIGHT_AFTER_GUARD  → 守卫阶段结束后，从狼人阶段继续
   *      - CONTINUE_NIGHT_AFTER_WOLF   → 狼人阶段结束后，从女巫阶段继续
   *      - CONTINUE_NIGHT_AFTER_WITCH  → 女巫阶段结束后，从预言家阶段继续
   *
   * 每次恢复前都会检查 FlowToken 有效性，防止过期回调干扰当前游戏状态。
   */
  async handleAction(_context: GameContext, _action: GameAction): Promise<void> {
    const runtime = this.getRuntime(_context);
    if (!runtime) return;

    if (_action.type === "START_NIGHT") {
      await this.runNightPhase(_context.state, runtime);
      return;
    }
    if (_action.type === "CONTINUE_NIGHT_AFTER_GUARD") {
      await this.continueNightAfterGuard(_context.state, runtime);
      return;
    }
    if (_action.type === "CONTINUE_NIGHT_AFTER_WOLF") {
      await this.continueNightAfterWolf(_context.state, runtime);
      return;
    }
    if (_action.type === "CONTINUE_NIGHT_AFTER_WITCH") {
      await this.continueNightAfterWitch(_context.state, runtime);
      return;
    }
  }

  /**
   * 生命周期：退出夜晚阶段
   * 当前为空实现，夜晚结算逻辑在 onNightComplete 回调中完成
   */
  async onExit(): Promise<void> {
    return;
  }

  /**
   * 从 GameContext 中提取夜晚阶段的运行时上下文
   * 运行时上下文由 useGameLogic hook 通过 extras 字段注入。
   * 如果缺少关键回调方法则返回 null，调用方会安全退出。
   */
  private getRuntime(context: GameContext): NightPhaseRuntime | null {
    const raw = context.extras as NightPhaseRuntime | undefined;
    if (!raw) return null;
    if (!raw.setGameState || !raw.setDialogue || !raw.waitForUnpause || !raw.isTokenValid) return null;
    return raw;
  }

  /**
   * 切换游戏阶段（纯函数委托）
   * 将状态中的 phase 字段更新为新阶段，并重置该阶段相关的临时状态。
   */
  private transitionPhase(state: GameState, newPhase: Phase): GameState {
    return rawTransitionPhase(state, newPhase);
  }

  /**
   * 执行守卫行动子阶段
   *
   * 流程：切换阶段 → 查找守卫 → 判断处理路径
   *   - 守卫不存在/已死亡：播放假动画延迟（掩护身份信息），然后跳过
   *   - 人类守卫：暂停流水线，等待玩家通过 UI 选择守护目标
   *   - AI 守卫：调用 LLM 生成守护决策，将结果写入 nightActions.guardTarget
   *
   * 守卫规则：不能连续两晚守护同一个人（lastGuardTarget 用于此校验）
   */
  private async runGuardAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    const guard = state.players.find((p) => p.role === "Guard" && p.alive);

    // 切换到守卫行动子阶段，并向游戏消息流中添加守卫行动开始的系统提示
    let currentState = this.transitionPhase(state, "NIGHT_GUARD_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.guardActionStart);
    runtime.setGameState(currentState);

    // 设置 UI 为「AI 等待中」状态，播放守卫睁眼旁白音效
    runtime.setIsWaitingForAI(true);
    runtime.setDialogue(speakerSystem, uiText.guardActing, false);
    await playNarrator("guardWake");

    // 路径1：无存活守卫 → 播放假动画延迟以掩护身份，然后跳过
    if (!guard) {
      gameLogger.guardAction("无存活守卫，跳过"); // UI日志：告知玩家守卫阶段被跳过
      await delay(randomFakeActionDelay()); // 假动画延迟，防止通过动画时长推断守卫是否存在
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return currentState;
      runtime.setIsWaitingForAI(false);
      await playNarrator("guardClose"); // 播放守卫闭眼旁白
      return currentState;
    }

    // 路径2：人类守卫 → 暂停流水线，等待玩家在 UI 上选择守护目标
    // 玩家选择完成后会触发 CONTINUE_NIGHT_AFTER_GUARD 动作恢复流水线
    if (guard.isHuman) {
      gameLogger.guardAction("等待人类守卫选择..."); // UI日志：提示等待人类玩家操作
      runtime.setIsWaitingForAI(false);
      runtime.setDialogue(speakerSystem, uiText.waitingGuard, false);
      return currentState; // 中断流水线，等待人类玩家操作
    }

    // 路径3：AI 守卫 → 调用 LLM 生成守护决策
    gameLogger.guardAction(`AI守卫(${fmtPlayer(guard.seat, guard.displayName)}) 思考中...`); // UI日志：AI开始思考
    const guardTarget = await generateGuardAction(currentState, guard);
    await runtime.waitForUnpause();

    if (!runtime.isTokenValid(runtime.token)) return currentState;

    // 将 AI 守卫的决策结果写入 nightActions
    if (guardTarget !== undefined) {
      const target = currentState.players.find((p) => p.seat === guardTarget);
      gameLogger.guardAction(`AI守卫(${fmtPlayer(guard.seat, guard.displayName)}) 选择守护 ${target ? fmtPlayer(guardTarget, target.displayName) : `座位${guardTarget + 1}`}`); // UI日志：记录守卫守护了谁
      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, guardTarget },
      };
    }
    runtime.setGameState(currentState);
    runtime.setIsWaitingForAI(false);

    await playNarrator("guardClose"); // 播放守卫闭眼旁白

    return currentState;
  }

  /**
   * 执行狼人行动子阶段
   *
   * 流程：切换阶段 → 查找存活狼人 → 判断处理路径
   *   - 无存活狼人：播放假动画延迟后跳过（理论上游戏应已结束，此为防御性处理）
   *   - 存在人类狼人：暂停流水线，等待玩家选择击杀目标
   *   - 全为 AI 狼人：由第一个狼人调用 LLM 决策，其余狼人自动达成共识
   *
   * 狼人投票机制简化：第一个存活狼人的决策作为全体狼人的共识，
   * 所有狼人的投票记录（wolfVotes）统一指向同一目标。
   * 最终击杀目标记录在 nightActions.wolfTarget 中。
   */
  private async runWolfAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    // 切换到狼人行动子阶段，添加系统消息
    let currentState = this.transitionPhase(state, "NIGHT_WOLF_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.wolfActionStart);
    runtime.setGameState(currentState);

    // 获取所有存活的狼人（包括白狼王等狼人阵营角色）
    const wolves = currentState.players.filter((p) => isWolfRole(p.role) && p.alive);

    // 路径1：无存活狼人 → 播放假动画延迟后跳过（防御性处理，正常情况下不会走到这里）
    if (wolves.length === 0) {
      gameLogger.wolfAction("无存活狼人，跳过"); // UI日志：记录狼人阶段被跳过
      runtime.setIsWaitingForAI(true);
      runtime.setDialogue(speakerSystem, uiText.wolfActing, false);
      await playNarrator("wolfWake"); // 播放狼人睁眼旁白

      await delay(randomFakeActionDelay()); // 假动画延迟，掩护身份信息
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return currentState;

      runtime.setIsWaitingForAI(false);
      await playNarrator("wolfClose"); // 播放狼人闭眼旁白
      return currentState;
    }

    if (wolves.length > 0) {
      const humanWolf = wolves.find((w) => w.isHuman);
      const wolfNames = wolves.map(w => fmtPlayer(w.seat, w.displayName)).join(", ");
      gameLogger.wolfAction(`存活狼人: ${wolfNames}`); // UI日志：列出所有存活狼人

      if (humanWolf) {
        gameLogger.wolfAction("等待人类狼人选择目标..."); // UI日志：提示等待人类玩家操作
        runtime.setDialogue(speakerSystem, uiText.waitingWolf, false);
      } else {
        runtime.setIsWaitingForAI(true);
        runtime.setDialogue(speakerSystem, uiText.wolfActing, false);
      }

      await playNarrator("wolfWake"); // 播放狼人睁眼旁白

      // 如果存在人类狼人，暂停流水线等待玩家操作
      // 玩家选择完成后会触发 CONTINUE_NIGHT_AFTER_WOLF 动作恢复流水线
      if (humanWolf) {
        return currentState; // 中断流水线，等待人类玩家操作
      }

      // 路径3：全为 AI 狼人 → 由第一个狼人代表决策
      const wolfVotes: Record<string, number> = {};
      try {
        // 简化逻辑：第一个狼人决定目标，其他狼人自动达成共识
        const firstWolf = wolves[0];
        const targetSeat = await generateWolfAction(currentState, firstWolf, {});

        await runtime.waitForUnpause();
        if (!runtime.isTokenValid(runtime.token)) return currentState;

        if (targetSeat !== undefined) {
          const target = currentState.players.find((p) => p.seat === targetSeat);
          gameLogger.wolfAction(`狼人选择击杀 ${target ? fmtPlayer(targetSeat, target.displayName) : `座位${targetSeat + 1}`}`); // UI日志：记录狼人选择的击杀目标
          // 所有狼人投票给同一个目标（模拟狼队共识）
          for (const wolf of wolves) {
            wolfVotes[wolf.playerId] = targetSeat;
          }
        }

        // 更新夜晚行动记录：投票明细 + 最终击杀目标
        currentState = {
          ...currentState,
          nightActions: {
            ...currentState.nightActions,
            wolfVotes,
            ...(targetSeat !== undefined ? { wolfTarget: targetSeat } : {}),
          },
        };
        runtime.setGameState(currentState);
      } catch (error) {
        console.error("[wolfcha] AI wolf vote failed:", error);
        currentState = {
          ...currentState,
          nightActions: { ...currentState.nightActions, wolfVotes },
        };
        runtime.setGameState(currentState);
      }

      runtime.setIsWaitingForAI(false);

      await playNarrator("wolfClose"); // 播放狼人闭眼旁白
    }

    return currentState;
  }

  /**
   * 执行女巫行动子阶段
   *
   * 流程：切换阶段 → 查找女巫 → 判断处理路径
   *   - 女巫不存在/已死亡，或解药和毒药均已使用：播放假动画延迟后跳过
   *   - 人类女巫：暂停流水线，等待玩家决策
   *   - AI 女巫：调用 LLM 生成决策，支持三种选择：
 *       save   - 使用解药救活被狼人击杀的玩家（仅当解药未使用且有击杀目标时可用）
 *       poison - 使用毒药毒杀一名玩家（仅当毒药未使用时可用）
 *       pass   - 本晚不使用药水
   *
   * 女巫规则：解药和毒药各只有一次使用机会，且同一晚不能同时使用。
   * AI 决策时会被告知狼人的击杀目标（wolfTarget）以帮助判断是否使用解药。
   */
  private async runWitchAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    const witch = state.players.find((p) => p.role === "Witch" && p.alive);
    // 判断女巫是否还能行动：至少有一种药水未使用
    const canWitchAct = witch && (!state.roleAbilities.witchHealUsed || !state.roleAbilities.witchPoisonUsed);
    // 切换到女巫行动子阶段
    let currentState = this.transitionPhase(state, "NIGHT_WITCH_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.witchActionStart);
    runtime.setGameState(currentState);

    // 设置 UI 为「AI 等待中」状态，播放女巫睁眼旁白
    runtime.setIsWaitingForAI(true);
    runtime.setDialogue(speakerSystem, uiText.witchActing, false);
    await playNarrator("witchWake");

    // 路径1：女巫不存在或两种药水均已使用 → 播放假动画延迟后跳过
    if (!witch || !canWitchAct) {
      gameLogger.witchAction(witch ? "解药和毒药均已使用，跳过" : "无存活女巫，跳过"); // UI日志：记录跳过原因
      await delay(randomFakeActionDelay()); // 假动画延迟，掩护身份信息
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return currentState;
      runtime.setIsWaitingForAI(false);
      await playNarrator("witchClose"); // 播放女巫闭眼旁白
      return currentState;
    }

    // 路径2：人类女巫 → 暂停流水线，等待玩家决策
    // 玩家决策完成后会触发 CONTINUE_NIGHT_AFTER_WITCH 动作恢复流水线
    if (witch.isHuman) {
      gameLogger.witchAction("等待人类女巫决策..."); // UI日志：提示等待人类玩家操作
      runtime.setIsWaitingForAI(false);
      runtime.setDialogue(speakerSystem, uiText.waitingWitch, false);
      return currentState; // 中断流水线，等待人类玩家操作
    }

    // 路径3：AI 女巫 → 调用 LLM 生成决策
    gameLogger.witchAction(`AI女巫(${fmtPlayer(witch.seat, witch.displayName)}) 思考中...`); // UI日志：AI开始思考
    const witchAction = await generateWitchAction(currentState, witch, currentState.nightActions.wolfTarget);
    await runtime.waitForUnpause();

    if (!runtime.isTokenValid(runtime.token)) return currentState;

    // 根据 AI 决策结果更新状态
    if (witchAction.type === "save") {
      // 使用解药救人：标记 witchSave=true，同时标记解药已使用
      gameLogger.witchAction(`AI女巫(${fmtPlayer(witch.seat, witch.displayName)}) 使用解药救人`); // UI日志：记录使用解药
      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, witchSave: true },
        roleAbilities: { ...currentState.roleAbilities, witchHealUsed: true },
      };
    } else if (witchAction.type === "poison" && witchAction.target !== undefined) {
      // 使用毒药：记录毒杀目标，同时标记毒药已使用
      const poisonTarget = currentState.players.find((p) => p.seat === witchAction.target);
      gameLogger.witchAction(`AI女巫(${fmtPlayer(witch.seat, witch.displayName)}) 使用毒药毒杀 ${poisonTarget ? fmtPlayer(witchAction.target, poisonTarget.displayName) : `座位${witchAction.target + 1}`}`); // UI日志：记录使用毒药及目标
      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, witchPoison: witchAction.target },
        roleAbilities: { ...currentState.roleAbilities, witchPoisonUsed: true },
      };
    } else {
      // 不使用药水（pass）
      gameLogger.witchAction(`AI女巫(${fmtPlayer(witch.seat, witch.displayName)}) 选择不使用药水`); // UI日志：记录女巫放弃使用药水
    }
    runtime.setGameState(currentState);
    runtime.setIsWaitingForAI(false);

    await playNarrator("witchClose"); // 播放女巫闭眼旁白

    return currentState;
  }

  /**
   * 执行预言家行动子阶段
   *
   * 流程：切换阶段 → 查找预言家 → 判断处理路径
   *   - 预言家不存在/已死亡：播放假动画延迟后跳过
   *   - 人类预言家：暂停流水线，等待玩家选择查验目标
   *   - AI 预言家：调用 LLM 选择查验目标，查验结果记录在 nightActions 中
   *
   * 预言家能力：每晚可以查验一名玩家的阵营（好人/狼人）。
   * 查验结果存储在三个地方：
   *   - seerTarget: 本次查验的目标座位号
   * - seerResult: 本次查验结果 { targetSeat, isWolf }
   * - seerHistory: 历史所有查验记录（含天数），用于提示词中避免重复查验
   */
  private async runSeerAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    const seer = state.players.find((p) => p.role === "Seer" && p.alive);
    // 切换到预言家行动子阶段
    let currentState = this.transitionPhase(state, "NIGHT_SEER_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.seerActionStart);
    runtime.setGameState(currentState);

    // 设置 UI 为「AI 等待中」状态，播放预言家睁眼旁白
    runtime.setIsWaitingForAI(true);
    runtime.setDialogue(speakerSystem, uiText.seerChecking, false);
    await playNarrator("seerWake");

    // 路径1：无存活预言家 → 播放假动画延迟后跳过
    if (!seer) {
      gameLogger.seerAction("无存活预言家，跳过"); // UI日志：记录预言家阶段被跳过
      await delay(randomFakeActionDelay()); // 假动画延迟，掩护身份信息
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return currentState;
      runtime.setIsWaitingForAI(false);
      await playNarrator("seerClose"); // 播放预言家闭眼旁白
      return currentState;
    }

    // 路径2：人类预言家 → 暂停流水线，等待玩家选择查验目标
    // 玩家选择完成后会触发 CONTINUE_NIGHT_AFTER_SEER（理论上预言家是最后一个子阶段，直接进入结算）
    if (seer.isHuman) {
      gameLogger.seerAction("等待人类预言家选择查验目标..."); // UI日志：提示等待人类玩家操作
      runtime.setIsWaitingForAI(false);
      runtime.setDialogue(speakerSystem, uiText.waitingSeer, false);
      return currentState; // 中断流水线，等待人类玩家操作
    }

    // 路径3：AI 预言家 → 调用 LLM 选择查验目标
    gameLogger.seerAction(`AI预言家(${fmtPlayer(seer.seat, seer.displayName)}) 思考中...`); // UI日志：AI开始思考
    const targetSeat = await generateSeerAction(currentState, seer);
    if (!runtime.isTokenValid(runtime.token)) return currentState;

    // AI 未选择查验目标（可能因某种原因放弃）
    if (targetSeat === undefined) {
      runtime.setGameState(currentState);
      runtime.setIsWaitingForAI(false);
      await playNarrator("seerClose"); // 播放预言家闭眼旁白
      return currentState;
    }

    // 执行查验：判断目标是否为狼人阵营
    const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
    const isWolf = targetPlayer ? targetPlayer.alignment === "wolf" : false;

    // UI日志：记录查验结果（狼人用🐺标记，好人用✅标记），方便玩家了解预言家的行动
    gameLogger.seerAction(`AI预言家(${fmtPlayer(seer.seat, seer.displayName)}) 查验 ${targetPlayer ? fmtPlayer(targetSeat, targetPlayer.displayName) : `座位${targetSeat + 1}`} → ${isWolf ? "🐺 狼人" : "✅ 好人"}`);

    // 更新夜晚行动记录：本次查验结果 + 历史查验记录（用于提示词构建时避免重复查验）
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
    runtime.setGameState(currentState);
    runtime.setIsWaitingForAI(false);

    await playNarrator("seerClose"); // 播放预言家闭眼旁白

    return currentState;
  }

  /**
   * 夜晚阶段主流水线
   *
   * 按固定顺序依次执行四个子阶段：守卫 → 狼人 → 女巫 → 预言家
   * 每个子阶段之间插入 NIGHT_PHASE_GAP 延迟，模拟角色起身/入睡的节奏感。
   *
   * 关键设计：「中断-恢复」模式
   *   当某个子阶段遇到人类玩家时，流水线会 return 中断。
   *   人类玩家完成操作后，UI 层会派发 CONTINUE_NIGHT_AFTER_* 动作，
   *   由 handleAction 路由到对应的 continueNight* 方法恢复流水线。
   *
   * 每一步都会检查 FlowToken 有效性，确保游戏重置时能安全停止。
   * 所有子阶段完成后，调用 onNightComplete 触发夜晚结算。
   */
  private async runNightPhase(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    let currentState = state;

    // 记录夜晚开始，day 参数用于 UI 日志面板显示「第N个夜晚」
    gameLogger.nightStart(currentState.day);

    // ===== 子阶段1：守卫行动 =====
    // 仅当游戏中配置了守卫角色时才执行
    const hasGuard = currentState.players.some((p) => p.role === "Guard");
    if (hasGuard) {
      currentState = await this.runGuardAction(currentState, runtime);
      if (!runtime.isTokenValid(runtime.token)) return; // 游戏已重置，安全退出

      // 如果是人类守卫且尚未做出选择，中断流水线等待玩家操作
      const guard = currentState.players.find((p) => p.role === "Guard" && p.alive);
      if (guard?.isHuman && currentState.nightActions.guardTarget === undefined) {
        return; // 中断：等待 CONTINUE_NIGHT_AFTER_GUARD 恢复
      }

      // 子阶段间延迟，模拟角色行动的节奏感
      await delay(DELAY_CONFIG.NIGHT_PHASE_GAP);
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return;
    }

    // ===== 子阶段2：狼人行动 =====
    currentState = await this.runWolfAction(currentState, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    // 如果存在人类狼人且尚未选择击杀目标，中断流水线等待玩家操作
    const humanWolf = currentState.players.find((p) => isWolfRole(p.role) && p.alive && p.isHuman);
    if (humanWolf && currentState.nightActions.wolfTarget === undefined) {
      return; // 中断：等待 CONTINUE_NIGHT_AFTER_WOLF 恢复
    }

    await delay(DELAY_CONFIG.NIGHT_PHASE_GAP);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    // ===== 子阶段3：女巫行动 =====
    currentState = await this.runWitchAction(currentState, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    // 如果是人类女巫且尚未做出决策（未使用解药也未使用毒药），中断流水线
    const witch = currentState.players.find((p) => p.role === "Witch" && p.alive);
    const canWitchAct = witch && (!currentState.roleAbilities.witchHealUsed || !currentState.roleAbilities.witchPoisonUsed);
    if (witch?.isHuman && canWitchAct) {
      const decided =
        currentState.nightActions.witchSave !== undefined ||
        currentState.nightActions.witchPoison !== undefined;
      if (!decided) return; // 中断：等待 CONTINUE_NIGHT_AFTER_WITCH 恢复
    }

    await delay(DELAY_CONFIG.NIGHT_PHASE_GAP);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    // ===== 子阶段4：预言家行动 =====
    currentState = await this.runSeerAction(currentState, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    // 如果是人类预言家且尚未选择查验目标，中断流水线等待玩家操作
    const seer = currentState.players.find((p) => p.role === "Seer" && p.alive);
    if (seer?.isHuman && currentState.nightActions.seerTarget === undefined) {
      return; // 中断：等待预言家操作完成后直接进入结算
    }

    // 所有子阶段完成，最终延迟后触发夜晚结算
    await delay(DELAY_CONFIG.DIALOGUE);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    // 触发夜晚结算：计算击杀结果、检查胜负条件、过渡到白天阶段
    await runtime.onNightComplete(currentState);
  }

  /**
   * 恢复夜晚流水线：守卫阶段完成后继续
   *
   * 当人类守卫完成操作后，UI 层派发 CONTINUE_NIGHT_AFTER_GUARD 动作，
   * 由 handleAction 路由到此方法。从狼人阶段开始继续执行后续子阶段。
   * 如果遇到人类狼人则再次中断，形成链式恢复。
   */
  private async continueNightAfterGuard(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    // 继续执行狼人行动子阶段
    const currentState = await this.runWolfAction(state, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    // 如果存在人类狼人且尚未选择击杀目标，中断流水线等待玩家操作
    const humanWolf = currentState.players.find((p) => isWolfRole(p.role) && p.alive && p.isHuman);
    if (humanWolf && currentState.nightActions.wolfTarget === undefined) {
      return; // 中断：等待 CONTINUE_NIGHT_AFTER_WOLF 恢复
    }

    await delay(DELAY_CONFIG.NIGHT_PHASE_GAP);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    // 继续执行后续子阶段（女巫 → 预言家 → 结算）
    await this.continueNightAfterWolf(currentState, runtime);
  }

  /**
   * 恢复夜晚流水线：狼人阶段完成后继续
   *
   * 当人类狼人完成操作后，UI 层派发 CONTINUE_NIGHT_AFTER_WOLF 动作，
   * 由 handleAction 路由到此方法。从女巫阶段开始继续执行后续子阶段。
   * 如果遇到人类女巫则再次中断。
   */
  private async continueNightAfterWolf(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    // 继续执行女巫行动子阶段
    const currentState = await this.runWitchAction(state, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    // 如果是人类女巫且尚未做出决策，中断流水线等待玩家操作
    const witch = currentState.players.find((p) => p.role === "Witch" && p.alive);
    const canWitchAct = witch && (!currentState.roleAbilities.witchHealUsed || !currentState.roleAbilities.witchPoisonUsed);
    if (witch?.isHuman && canWitchAct) {
      const decided =
        currentState.nightActions.witchSave !== undefined ||
        currentState.nightActions.witchPoison !== undefined;
      if (!decided) return; // 中断：等待 CONTINUE_NIGHT_AFTER_WITCH 恢复
    }

    await delay(DELAY_CONFIG.NIGHT_PHASE_GAP);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    // 继续执行预言家阶段和结算
    await this.continueNightAfterWitch(currentState, runtime);
  }

  /**
   * 恢复夜晚流水线：女巫阶段完成后继续
   *
   * 当人类女巫完成操作后，UI 层派发 CONTINUE_NIGHT_AFTER_WITCH 动作，
   * 由 handleAction 路由到此方法。从预言家阶段开始继续执行，最终触发夜晚结算。
   * 这是夜晚流水线的最后一段恢复链。
   */
  private async continueNightAfterWitch(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    // 继续执行预言家行动子阶段
    const currentState = await this.runSeerAction(state, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    // 如果是人类预言家且尚未选择查验目标，中断流水线等待玩家操作
    const seer = currentState.players.find((p) => p.role === "Seer" && p.alive);
    if (seer?.isHuman && currentState.nightActions.seerTarget === undefined) {
      return; // 中断：等待预言家操作完成后
    }

    // 所有子阶段完成，最终延迟后触发夜晚结算
    await delay(DELAY_CONFIG.NIGHT_PHASE_GAP);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    // 触发夜晚结算：计算击杀结果、检查胜负条件、过渡到白天阶段
    await runtime.onNightComplete(currentState);
  }

  /**
   * 构建夜晚提示词的增强信息
   *
   * 为夜晚各角色的 LLM 提示词提供额外的上下文信息：
   *   - todayTranscript: 今天白天的完整讨论记录（包括已死亡玩家的遗言），
   *     排除当前玩家自己的发言（避免 LLM 重复引用自己的话）
   *   - selfSpeech: 当前玩家今天白天的发言记录
   *
   * 这些信息帮助 AI 角色在夜晚做出更符合剧情逻辑的决策。
   */
  private buildNightEnhancements(state: GameContext["state"], player: Player) {
    const todayTranscript = buildTodayTranscript(state, { includeDeadSpeech: true, excludePlayerId: player.playerId });
    const selfSpeech = buildPlayerTodaySpeech(state, player);
    return { todayTranscript, selfSpeech };
  }

  /**
   * 将游戏上下文、白天讨论记录和自身发言拼接为完整的用户提示词
   *
   * 拼接格式：游戏基础上下文 + 今天讨论记录（如有） + 自身发言记录（如有）
   * 各部分之间用空行分隔，空内容会被过滤掉。
   */
  private buildContextWithDay(
    context: string,
    todayTranscript: string,
    selfSpeech: string
  ): string {
    const { t } = getI18n();
    return [
      context,
      todayTranscript ? `${t("prompts.night.todayDiscussionLabel")}\n${todayTranscript}` : "",
      selfSpeech ? `${t("prompts.night.selfSpeechLabel")}\n${selfSpeech}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * 构建预言家的 LLM 提示词
   *
   * 提示词结构：
   *   system = 身份信息（可缓存）+ 查验任务描述（动态）
   *   user   = 游戏上下文 + 白天讨论记录 + JSON 输出格式示例
   *
   * 预言家提示词的特殊处理：
   *   - 优先推荐未查验过的玩家（uncheckedPlayers）
   *   - 如果所有存活玩家都已查验，则允许重复查验
   *   - 提供历史查验记录列表（checkedList），帮助 AI 避免重复查验
   *   - 已查验过的玩家结果不会在提示词中泄露（预言家只知道查了谁，不记得结果）
   */
  private buildSeerPrompt(state: GameContext["state"], player: Player): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const { todayTranscript, selfSpeech } = this.buildNightEnhancements(state, player);
    // 获取历史查验记录，用于区分已查验和未查验的玩家
    const seerHistory = state.nightActions.seerHistory || [];
    const checkedSeats = seerHistory.map((h) => h.targetSeat);

    // 获取所有存活玩家（排除自己）
    const alivePlayers = state.players.filter(
      (p) => p.alive && p.playerId !== player.playerId
    );

    // 将存活玩家分为「未查验」和「已查验」两组，优先推荐未查验的
    const uncheckedPlayers = alivePlayers.filter((p) => !checkedSeats.includes(p.seat));
    const alreadyChecked = alivePlayers.filter((p) => checkedSeats.includes(p.seat));

    const checkedList = alreadyChecked
      .map((p) => t("promptUtils.gameContext.seatLabel", { seat: p.seat + 1 }))
      .join(t("promptUtils.gameContext.listSeparator"));
    // 如果还有未查验的玩家，优先展示；否则展示所有存活玩家（允许重复查验）
    const optionsList = (uncheckedPlayers.length > 0 ? uncheckedPlayers : alivePlayers)
      .map((p) => t("prompts.night.option", { seat: p.seat + 1, name: p.displayName }))
      .join(t("promptUtils.gameContext.listSeparator"));

    // 可缓存部分：身份信息（角色、座位、胜利条件），这些内容在同一局游戏中不会变化
    const cacheableContent = t("prompts.night.seer.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText("Seer"),
      winCondition: getWinCondition("Seer"),
    });

    // 动态部分：查验任务描述（已查验列表 + 可选目标）
    const dynamicContent = t("prompts.night.seer.task", {
      checkedLine: alreadyChecked.length > 0 ? t("prompts.night.seer.checkedLine", { list: checkedList }) : "",
      options: optionsList,
    });

    // 将提示词分为可缓存和动态两部分，优化 LLM API 的 token 消耗
    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    // user 消息：包含游戏上下文 + JSON 输出格式示例
    const user = t("prompts.night.seer.user", {
      context: this.buildContextWithDay(context, todayTranscript, selfSpeech),
      jsonFormat: JSON.stringify({ seat: 5 }), // JSON 格式示例，引导 LLM 输出正确格式
    });

    return { system, user, systemParts };
  }

  /**
   * 构建狼人的 LLM 提示词
   *
   * 提示词结构：
   *   system = 身份信息（可缓存）+ 胜利条件规则（可缓存）+ 击杀任务描述（动态）
   *   user   = 游戏上下文 + 白天讨论记录 + JSON 输出格式示例
   *
   * 狼人提示词的特殊处理：
   *   - 展示所有存活玩家作为可选目标（包括队友和自己，但通常选择击杀好人）
   *   - 如果有队友已经投票，展示队友的投票意向（teammateVotes），
   *     帮助当前狼人做出与队友一致的决策（模拟狼队夜晚沟通）
   *   - existingVotes 参数用于传递其他狼人已有的投票记录
   */
  private buildWolfPrompt(
    state: GameContext["state"],
    player: Player,
    existingVotes: Record<string, number>
  ): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const { todayTranscript, selfSpeech } = this.buildNightEnhancements(state, player);
    // 狼人可以刀任何存活玩家（包括队友和自己），但通常刀好人
    const alivePlayers = state.players.filter((p) => p.alive);
    // 获取队友列表（排除自己），用于展示队友投票意向
    const teammates = state.players.filter(
      (p) => isWolfRole(p.role) && p.playerId !== player.playerId && p.alive
    );

    // 构建队友投票意向文本，帮助当前狼人与队友达成共识
    const teammateVotesStr = teammates
      .map((teammate) => {
        const vote = existingVotes[teammate.playerId];
        if (vote === undefined) return null;
        const target = state.players.find((p) => p.seat === vote);
        return t("prompts.night.wolf.voteLine", {
          seat: teammate.seat + 1,
          name: teammate.displayName,
          targetSeat: vote + 1,
          targetName: target ? t("prompts.night.optionName", { name: target.displayName }) : "",
        });
      })
      .filter(Boolean)
      .join("\n");

    // 可缓存部分1：身份信息（座位、角色名）
    const identitySection = t("prompts.night.wolf.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText(player.role),
    });
    // 可缓存部分2：胜利条件规则
    const cacheableRules = t("prompts.night.wolf.rules", {
      winCondition: getWinCondition(player.role),
    });
    // 动态部分：队友投票意向 + 击杀目标选项
    const teammateVotesSection = teammateVotesStr
      ? t("prompts.night.wolf.teammateVotes", { lines: teammateVotesStr })
      : "";
    const taskSection = t("prompts.night.wolf.task", {
      teammateVotesSection,
      options: alivePlayers
        .map((p) => t("prompts.night.option", { seat: p.seat + 1, name: p.displayName }))
        .join(t("promptUtils.gameContext.listSeparator")),
    });

    // 将提示词分为三部分：身份信息（可缓存）、规则（可缓存）、任务（动态）
    const systemParts: SystemPromptPart[] = [
      { text: identitySection, cacheable: true, ttl: "1h" },
      { text: cacheableRules, cacheable: true, ttl: "1h" },
      { text: taskSection },
    ];
    const system = buildSystemTextFromParts(systemParts);

    // user 消息：包含游戏上下文 + JSON 输出格式示例
    const user = t("prompts.night.wolf.user", {
      context: this.buildContextWithDay(context, todayTranscript, selfSpeech),
      jsonFormat: JSON.stringify({ seat: 2 }), // JSON 格式示例，引导 LLM 输出正确格式
    });

    return { system, user, systemParts };
  }

  /**
   * 构建守卫的 LLM 提示词
   *
   * 提示词结构：
   *   system = 身份信息（可缓存）+ 守护任务描述（动态）
   *   user   = 游戏上下文 + 白天讨论记录 + JSON 输出格式示例
   *
   * 守卫提示词的特殊处理：
   *   - 从可选目标中排除上一晚守护的玩家（lastTarget），
   *     因为守卫不能连续两晚守护同一个人
   *   - 如果存在上一晚守护记录，在提示词中明确告知 AI 该限制
   *   - 可选目标为所有存活玩家（不限阵营）
   */
  private buildGuardPrompt(state: GameContext["state"], player: Player): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const { todayTranscript, selfSpeech } = this.buildNightEnhancements(state, player);
    const alivePlayers = state.players.filter((p) => p.alive);
    // 获取上一晚守护的目标，守卫不能连续两晚守护同一个人
    const lastTarget = state.nightActions.lastGuardTarget;

    // 可缓存部分：身份信息（角色、座位、胜利条件）
    const cacheableContent = t("prompts.night.guard.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText("Guard"),
      winCondition: getWinCondition("Guard"),
    });
    // 动态部分：可选目标（排除上一晚守护的人）+ 上一晚守护记录提示
    const options = alivePlayers
      .filter((p) => p.seat !== lastTarget) // 排除上一晚守护的目标
      .map((p) => t("prompts.night.option", { seat: p.seat + 1, name: p.displayName }))
      .join(t("promptUtils.gameContext.listSeparator"));
    const lastTargetLine =
      lastTarget !== undefined ? t("prompts.night.guard.lastTarget", { seat: lastTarget + 1 }) : "";
    const dynamicContent = t("prompts.night.guard.task", {
      options,
      lastTargetLine,
    });

    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    // user 消息：包含游戏上下文 + JSON 输出格式示例
    const user = t("prompts.night.guard.user", {
      context: this.buildContextWithDay(context, todayTranscript, selfSpeech),
      jsonFormat: JSON.stringify({ seat: 3 }), // JSON 格式示例，引导 LLM 输出正确格式
    });

    return { system, user, systemParts };
  }

  /**
   * 构建女巫的 LLM 提示词
   *
   * 提示词结构：
   *   system = 身份信息（可缓存）+ 药水决策任务描述（动态）
   *   user   = 游戏上下文 + 白天讨论记录
   *
   * 女巫提示词的特殊处理：
   *   - 展示解药和毒药的当前状态（已使用/可用）
   *   - 告知 AI 今晚被狼人击杀的玩家信息（victimInfo），帮助判断是否使用解药
   *   - 提供三种 JSON 输出格式示例：save（救人）、poison（毒人）、pass（不操作）
   *   - 解药和毒药的可用性由 canSave / canPoison 变量控制
   *   - wolfTarget 参数由 runWolfAction 阶段传递，表示狼人选择的击杀目标
   */
  private buildWitchPrompt(
    state: GameContext["state"],
    player: Player,
    wolfTarget: number | undefined
  ): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const { todayTranscript, selfSpeech } = this.buildNightEnhancements(state, player);
    // 获取除自己外的所有存活玩家（毒药可选目标）
    const alivePlayers = state.players.filter(
      (p) => p.alive && p.playerId !== player.playerId
    );

    // 判断解药是否可用：解药未使用 且 今晚有狼人击杀目标
    const canSave =
      !state.roleAbilities.witchHealUsed &&
      wolfTarget !== undefined;
    // 判断毒药是否可用：毒药未使用
    const canPoison = !state.roleAbilities.witchPoisonUsed;

    // 获取今晚被击杀的玩家信息（用于告知女巫谁被刀了）
    const victimInfo =
      wolfTarget !== undefined && !state.roleAbilities.witchHealUsed
        ? state.players.find((p) => p.seat === wolfTarget)
        : null;

    // 可缓存部分：身份信息（角色、座位、胜利条件）
    const cacheableContent = t("prompts.night.witch.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText("Witch"),
      winCondition: getWinCondition("Witch"),
    });
    // 动态部分：药水状态 + 今晚情况 + 各选项说明 + JSON 格式示例
    const statusHeal = state.roleAbilities.witchHealUsed
      ? t("promptUtils.gameContext.used")
      : t("promptUtils.gameContext.available");
    const statusPoison = state.roleAbilities.witchPoisonUsed
      ? t("promptUtils.gameContext.used")
      : t("promptUtils.gameContext.available");
    // 今晚情况：有人被刀（显示受害者）、解药已使用（无感）、无人被刀
    const tonightInfo = victimInfo
      ? t("prompts.night.witch.victimLine", { seat: wolfTarget! + 1, name: victimInfo.displayName })
      : state.roleAbilities.witchHealUsed
        ? t("prompts.night.witch.noSense")
        : t("prompts.night.witch.noAttack");
    // 解药选项：可用时显示救人的座位号，不可用时显示不可用原因
    const saveLine = canSave
      ? t("prompts.night.witch.saveOption", { seat: wolfTarget! + 1 })
      : t("prompts.night.witch.noSave");
    // 毒药选项：可用时显示可毒杀的玩家列表，不可用时显示不可用原因
    const poisonLine = canPoison ? t("prompts.night.witch.poisonOption") : t("prompts.night.witch.noPoison");
    const poisonTargets = alivePlayers
      .map((p) => t("promptUtils.gameContext.seatLabel", { seat: p.seat + 1 }))
      .join(t("promptUtils.gameContext.listSeparator"));
    const dynamicContent = t("prompts.night.witch.task", {
      healStatus: statusHeal,
      poisonStatus: statusPoison,
      tonightInfo,
      saveLine,
      poisonLine,
      poisonTargets,
      saveJsonFormat: JSON.stringify({ action: "save" }),
      poisonJsonFormat: JSON.stringify({ action: "poison", seat: 3 }),
      passJsonFormat: JSON.stringify({ action: "pass" }),
    });

    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    // user 消息：仅包含游戏上下文（女巫的 JSON 格式示例已在 system 的 dynamicContent 中）
    const user = t("prompts.night.witch.user", { context: this.buildContextWithDay(context, todayTranscript, selfSpeech) });

    return { system, user, systemParts };
  }
}
