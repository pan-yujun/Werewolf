/**
 * 投票阶段（VotePhase）实现
 *
 * 本文件负责游戏白天投票环节的完整流程，包括：
 * - AI 玩家的自动投票决策（通过 LLM 生成投票理由和目标）
 * - 投票计票与结果统计（支持警长 1.5 票权重、已翻牌白痴排除）
 * - 平票 PK 机制：平票时触发 PK 发言环节，PK 候选人不能投票
 * - 白痴（Idiot）免疫：若被投票出局的是未翻牌白痴，则免死但失去投票权
 * - 猎人（Hunter）被投出时的开枪流程延迟判定
 * - 胜负条件检查与阶段流转
 *
 * 生命周期：onEnter → (等待人类玩家投票) → handleAction(RESOLVE_VOTES) → resolveVotes → onExit
 */
import type { GameState, Player } from "@/types/game";
import { GamePhase } from "../core/GamePhase";
import type { GameAction, GameContext, PromptResult, SystemPromptPart } from "../core/types";
// 提示词构建工具：游戏上下文、今日发言记录、角色文本、胜利条件等
import {
  buildGameContext,
  buildTodayTranscript,
  buildPlayerTodaySpeech,
  getRoleText,
  getWinCondition,
  buildSystemTextFromParts,
} from "@/lib/prompt-utils";
// 国际化翻译器
import { getI18n } from "@/i18n/translator";
// game-master 核心函数：系统消息、胜负检查、AI 投票生成、计票、阶段转换
import {
  addSystemMessage,
  checkWinCondition,
  generateAIVote,
  tallyVotes,
  transitionPhase,
} from "@/lib/game-master";
// 游戏文本常量：系统消息模板、UI 文本
import { getSystemMessages, getUiText } from "@/lib/game-texts";
// 延迟配置常量
import { DELAY_CONFIG } from "@/lib/game-constants";
// 异步延迟工具和 FlowToken 类型（用于中断检测）
import { delay, type FlowToken } from "@/lib/game-flow-controller";
// 旁白音效播放
import { playNarrator } from "@/lib/narrator-audio-player";
// 根据座位号获取对应的死亡旁白音效 key
import { getPlayerDiedKey } from "@/lib/narrator-voice";
// 游戏日志记录器
import { gameLogger, fmtPlayer } from "@/lib/game-logger";

/**
 * 投票阶段运行时上下文类型
 *
 * 由外部 hook（如 useGameLogic）在进入投票阶段时构造，通过 GameContext.extras 传入。
 * 包含了投票阶段所需的全部回调和状态引用。
 */
type VotePhaseRuntime = {
  /** 流程令牌（FlowToken），用于异步操作间检测游戏是否被重置/中断，防止过期回调 */
  token: FlowToken;
  /** 是否为重投（PK 后的第二轮投票），影响 pkTargets 的保留逻辑 */
  isRevote?: boolean;
  /** 人类玩家对象，若为 null 表示没有人类玩家（纯 AI 对局）或人类已死亡 */
  humanPlayer: Player | null;
  /** 更新游戏状态的 setter，支持函数式更新 */
  setGameState: (value: GameState | ((prev: GameState) => GameState)) => void;
  /** 设置主持人/旁白对话内容，isStreaming 表示是否逐字显示 */
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  /** 标记是否正在等待 AI 玩家投票（用于 UI 显示加载状态） */
  setIsWaitingForAI: (waiting: boolean) => void;
  /** 等待用户点击"继续"按钮，用于在关键节点暂停让玩家确认 */
  waitForUnpause: () => Promise<void>;
  /** 检查 FlowToken 是否仍然有效，无效则应中止当前流程 */
  isTokenValid: (token: FlowToken) => boolean;
  /**
   * 投票完成回调
   * @param state 最终游戏状态
   * @param result 被处决者的座位号和票数，null 表示无人被处决（平票/白痴免疫）
   */
  onVoteComplete: (state: GameState, result: { seat: number; count: number } | null) => Promise<void>;
  /** 游戏结束回调，触发胜负结算界面 */
  onGameEnd: (state: GameState, winner: "village" | "wolf") => Promise<void>;
  /** 执行 AI 玩家发言（PK 发言环节使用） */
  runAISpeech: (state: GameState, player: Player) => Promise<void>;
  /** 回放记录回调：记录单张投票（谁投了谁） */
  onRecordVoteCast?: (voterSeat: number, targetSeat: number, reason: string | undefined, isHuman: boolean, isSheriffVote: boolean, phase: string, day: number) => void;
  /** 回放记录回调：记录投票最终结果（处决、分布、是否平票/PK） */
  onRecordVoteResult?: (eliminated: number | null, voteDistribution: Record<string, number[]>, isTie: boolean, isPK: boolean, pkRound: number, phase: string, day: number) => void;
};

/**
 * 投票阶段类
 *
 * 继承自 GamePhase 抽象类，实现了投票环节的核心逻辑。
 * PhaseManager 在进入 DAY_VOTE 阶段时实例化并调用 onEnter。
 *
 * 核心流程：
 * 1. onEnter  — 初始化投票状态，播放旁白，依次让 AI 玩家投票，等待人类玩家操作
 * 2. getPrompt — 为 AI 玩家构建投票决策的 LLM 提示词
 * 3. handleAction — 接收 RESOLVE_VOTES 动作，触发计票与结算
 * 4. onExit   — 阶段退出（当前为空实现）
 */
export class VotePhase extends GamePhase {
  /**
   * 进入投票阶段
   *
   * 完整流程：
   * 1. 从 context.extras 获取运行时上下文（VotePhaseRuntime）
   * 2. 初始化投票状态：清空 votes、设置 pkTargets（如果是重投）
   * 3. 播放投票开始旁白音效
   * 4. 等待人类玩家确认（waitForUnpause）
   * 5. 遍历所有需要投票的 AI 玩家，逐个调用 generateAIVote 生成投票
   *    - PK 投票中，PK 候选人不参与投票
   *    - 已翻牌白痴不参与投票（节省 AI 调用）
   * 6. 每次 AI 投票后同步更新 gameState，使 UI 实时显示投票进度
   * 7. 如果人类玩家已死亡或是已翻牌白痴，直接进入计票结算（resolveVotes）
   * 8. 否则等待人类玩家在 UI 上点击投票后，通过 handleAction 触发结算
   */
  async onEnter(context: GameContext): Promise<void> {
    // 从 context.extras 提取运行时上下文，若不存在或关键字段缺失则中止
    const runtime = this.getRuntime(context);
    if (!runtime) return;

    const { t } = getI18n();
    const uiText = getUiText();
    const systemMessages = getSystemMessages();
    const speakerHost = t("speakers.host");
    const speakerHint = t("speakers.hint");

    const { humanPlayer, setDialogue, setGameState, setIsWaitingForAI, waitForUnpause, isTokenValid, token } = runtime;
    const isRevote = runtime.isRevote === true;

    // 将游戏状态转换到 DAY_VOTE 阶段，清空上一轮投票数据
    let currentState = transitionPhase(context.state, "DAY_VOTE");
    currentState = {
      ...currentState,
      currentSpeakerSeat: null,          // 投票阶段不需要当前发言人
      nextSpeakerSeatOverride: null,     // 清除发言座位覆盖
      votes: {},                         // 清空投票记录（voterId → targetSeat）
      voteReasons: {},                   // 清空投票理由（voterId → reason 文本）
      pkTargets: isRevote ? context.state.pkTargets : undefined,  // 重投时保留 PK 候选人
      pkSource: isRevote ? "vote" : undefined,                     // 重投时标记 PK 来源为投票
    };
    // 添加"投票开始"系统消息到对话历史
    currentState = addSystemMessage(currentState, systemMessages.voteStart);
    // 检查人类玩家是否为已翻牌白痴（已翻牌白痴不能投票）
    const isRevealedIdiot = humanPlayer?.role === "Idiot" && currentState.roleAbilities.idiotRevealed;
    // 根据人类玩家状态显示不同的主持人提示语
    setDialogue(speakerHost, humanPlayer?.alive && !isRevealedIdiot ? uiText.votePrompt : uiText.aiVoting, false);
    setGameState(currentState);

    // 播放"投票开始"旁白音效
    await playNarrator("voteStart");
    // 等待人类玩家点击"继续"以确认进入投票
    await waitForUnpause();

    // 如果人类玩家存活且不是已翻牌白痴，提示玩家点击投票
    if (humanPlayer?.alive && !isRevealedIdiot) {
      setDialogue(speakerHint, uiText.clickToVote, false);
    }

    // 确定 PK 候选人列表：仅在 PK 投票（pkSource === "vote"）时生效
    // PK 投票中，参与 PK 的候选人不能投票给自己或他人
    const pkTargets = currentState.pkSource === "vote" && Array.isArray(currentState.pkTargets) ? currentState.pkTargets : [];
    // 已翻牌白痴不参与投票（节省 AI 调用开销）
    const revealedIdiotId = currentState.roleAbilities.idiotRevealed
      ? currentState.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;
    // 筛选需要投票的 AI 玩家：存活、非人类、非 PK 候选人、非已翻牌白痴
    const aiPlayers = currentState.players.filter((p) => p.alive && !p.isHuman && !pkTargets.includes(p.seat) && p.playerId !== revealedIdiotId);
    const aliveCount = currentState.players.filter((p) => p.alive).length;
    const pkLabel = pkTargets.length > 0 ? ` (PK投票, 候选:${pkTargets.map(s => s + 1).join(",")}号)` : "";
    // 记录投票阶段开始日志，包含天数、投票人数、PK 信息
    gameLogger.votePhaseStart(`第${currentState.day}天 ${aliveCount}人投票${pkLabel}`);
    let tokenInvalidated = false;
    // 标记进入 AI 投票阶段（UI 可显示加载动画）
    setIsWaitingForAI(true);
    try {
      // 依次让每个 AI 玩家投票
      for (const aiPlayer of aiPlayers) {
        // 每次循环开始时检查令牌有效性（游戏可能被重置）
        if (!isTokenValid(token)) {
          tokenInvalidated = true;
          break;
        }
        // 调用 game-master 的 generateAIVote，通过 LLM 生成投票目标和理由
        const vote = await generateAIVote(currentState, aiPlayer);
        // AI 投票完成后再次检查令牌（LLM 调用耗时较长，期间可能被中断）
        if (!isTokenValid(token)) {
          tokenInvalidated = true;
          break;
        }

        // 记录投票日志：投票人座位、名字 → 目标座位、名字，以及是否为警长投票
        const voteTarget = currentState.players.find((p) => p.seat === vote.seat);
        const isSheriff = currentState.badge.holderSeat === aiPlayer.seat;
        gameLogger.voteCast(aiPlayer.seat, aiPlayer.displayName, vote.seat, voteTarget?.displayName || "", false, isSheriff);

        // 通过函数式更新将投票结果写入 gameState（确保 React 状态正确合并）
        setGameState((prevState) => ({
          ...prevState,
          votes: { ...prevState.votes, [aiPlayer.playerId]: vote.seat },
          voteReasons: { ...(prevState.voteReasons || {}), [aiPlayer.playerId]: vote.reason },
        }));
        // 同步更新本地 currentState 持有最新数据，供后续 AI 投票参考
        currentState = {
          ...currentState,
          votes: { ...currentState.votes, [aiPlayer.playerId]: vote.seat },
          voteReasons: { ...(currentState.voteReasons || {}), [aiPlayer.playerId]: vote.reason },
        };
      }
    } finally {
      // 无论成功或异常，退出 AI 投票等待状态
      setIsWaitingForAI(false);
    }
    // 如果游戏在 AI 投票过程中被重置，直接返回不继续处理
    if (tokenInvalidated) return;

    // 如果人类玩家已死亡或是已翻牌白痴（不需要等待人类投票），直接进入计票结算
    if (!humanPlayer?.alive || isRevealedIdiot) {
      await this.resolveVotes(currentState, runtime);
    }
    // 否则函数返回，等待人类玩家在 UI 上点击投票 → 触发 handleAction(RESOLVE_VOTES)
  }

  /**
   * 构建投票决策的 LLM 提示词
   *
   * 为 AI 玩家生成投票决策所需的 system + user 提示词。
   * 关键逻辑：
   * - 如果当前是 PK 投票（pkSource === "vote"），则投票选项仅限 PK 候选人
   * - 否则投票选项为所有存活的其他玩家
   * - 提示词包含角色信息、胜利条件、今日发言记录、投票选项列表
   */
  getPrompt(context: GameContext, player: Player): PromptResult {
    const state = context.state;
    const gameContext = buildGameContext(state, player);
    // PK 投票约束：如果当前是 PK 轮次，只允许投给 PK 候选人
    const eligibleSeats =
      state.pkSource === "vote" && state.pkTargets && state.pkTargets.length > 0
        ? new Set(state.pkTargets)
        : null;
    // 筛选可投票的目标玩家：存活、非自己、符合 PK 约束
    const alivePlayers = state.players.filter(
      (p) =>
        p.alive &&
        p.playerId !== player.playerId &&
        (!eligibleSeats || eligibleSeats.has(p.seat))
    );

    // 构建今日发言记录（排除当前玩家自己的发言，避免自我引用）
    const todayTranscript = buildTodayTranscript(state, { excludePlayerId: player.playerId });
    // 构建当前玩家今日发言摘要
    const selfSpeech = buildPlayerTodaySpeech(state, player);

    const { t } = getI18n();
    // system 提示词的可缓存部分：角色身份、胜利条件（不随每轮变化，可利用 prompt caching）
    const cacheableContent = t("prompts.vote.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText(player.role),
      winCondition: getWinCondition(player.role),
    });
    // system 提示词的动态部分：投票选项列表（每轮可能不同）
    const dynamicContent = t("prompts.vote.task", {
      options: alivePlayers.map((p) => t("prompts.vote.option", { seat: p.seat + 1, name: p.displayName })).join(", "),
    });
    // 拆分为可缓存和不可缓存两部分，优化 LLM API 的 prompt caching 命中率
    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    // user 提示词：包含游戏上下文、今日发言记录、自己的发言、JSON 格式要求
    const user = t("prompts.vote.user", {
      gameContext,
      todayTranscript: todayTranscript || t("prompts.vote.userNoTranscript"),
      selfSpeech: selfSpeech || t("prompts.vote.userNoSelfSpeech"),
      voteJsonFormat: JSON.stringify({ seat: 3, reason: t("prompts.vote.reasonExample") }),
    });

    return { system, user, systemParts };
  }

  /**
   * 处理投票阶段的动作事件
   *
   * 当人类玩家在 UI 上完成投票后，外部 hook 会派发 RESOLVE_VOTES 动作，
   * 此方法接收该动作并触发计票结算流程。
   */
  async handleAction(_context: GameContext, _action: GameAction): Promise<void> {
    // 仅处理 RESOLVE_VOTES 类型的动作，忽略其他类型
    if (_action.type !== "RESOLVE_VOTES") return;
    const runtime = this.getRuntime(_context);
    if (!runtime) return;
    // 进入计票与结算流程
    await this.resolveVotes(_context.state, runtime);
  }

  /**
   * 退出投票阶段
   *
   * 当前为空实现。投票阶段的清理工作（如清空 pkTargets、更新 badge 等）
   * 均在 resolveVotes 内完成，无需额外处理。
   */
  async onExit(): Promise<void> {
    return;
  }

  /**
   * 从 GameContext 中提取投票阶段运行时上下文
   *
   * extras 由外部 hook（如 useGameLogic）在调用 PhaseManager.runPhase 时传入。
   * 若 extras 不存在或缺少关键回调，则返回 null 表示无法执行投票逻辑。
   */
  private getRuntime(context: GameContext): VotePhaseRuntime | null {
    const raw = context.extras as VotePhaseRuntime | undefined;
    if (!raw) return null;
    // 校验关键回调是否齐全，缺失则无法正常运行
    if (!raw.setGameState || !raw.setDialogue || !raw.waitForUnpause || !raw.isTokenValid) return null;
    return raw;
  }

  /**
   * 计算每个座位的得票数
   *
   * 计票规则：
   * 1. 警长（badge holder）的票权重为 1.5 票，普通玩家为 1 票
   * 2. 已翻牌白痴（Idiot）的投票不计入（虽然仍记录在 votes 中，但计票时跳过）
   * 3. 已死亡玩家的投票不计入
   * 4. 目标座位已死亡的投票不计入
   *
   * @returns 以座位号为 key、得票数为 value 的映射
   */
  private getVoteCounts(state: GameState): Record<number, number> {
    const counts: Record<number, number> = {};
    // 获取警长信息，用于计算 1.5 票权重
    const sheriffSeat = state.badge.holderSeat;
    const sheriffPlayer =
      sheriffSeat !== null ? state.players.find((p) => p.seat === sheriffSeat && p.alive) : null;
    const sheriffPlayerId = sheriffPlayer?.playerId;
    // 构建存活玩家的 playerId 和 seat 集合，用于快速查找
    const aliveById = new Set(state.players.filter((p) => p.alive).map((p) => p.playerId));
    const aliveBySeat = new Set(state.players.filter((p) => p.alive).map((p) => p.seat));

    // 已翻牌白痴的投票不计入有效票数
    const revealedIdiotId = state.roleAbilities.idiotRevealed
      ? state.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;

    for (const [voterId, targetSeat] of Object.entries(state.votes)) {
      // 跳过已死亡投票者的票
      if (!aliveById.has(voterId)) continue;
      // 跳过目标已死亡的票
      if (!aliveBySeat.has(targetSeat)) continue;
      // 跳过已翻牌白痴的票（白痴免死后失去投票权，但 votes 记录仍保留）
      if (voterId === revealedIdiotId) continue;
      // 警长票权重 1.5，普通票权重 1
      const weight = voterId === sheriffPlayerId ? 1.5 : 1;
      counts[targetSeat] = (counts[targetSeat] || 0) + weight;
    }
    return counts;
  }

  /**
   * 生成投票详情的结构化文本
   *
   * 将投票数据格式化为 [VOTE_RESULT] 前缀的 JSON 字符串，用于：
   * 1. 添加到系统消息历史，供后续 LLM 调用参考投票结果
   * 2. 在对话界面中展示投票分布
   *
   * 输出格式：`[VOTE_RESULT]{"title":"...","results":[{targetSeat, targetName, voterSeats, voteCount}, ...]}`
   * results 按得票数从高到低排序。
   *
   * 计票时同样应用警长 1.5 票权重，并排除已死亡玩家的投票。
   */
  private generateVoteDetails(
    votes: Record<string, number>,
    players: Player[],
    title: string,
    sheriffSeat: number | null
  ): string {
    const { t } = getI18n();
    // 获取警长信息用于计算 1.5 票权重
    const sheriffPlayer =
      sheriffSeat !== null ? players.find((p) => p.seat === sheriffSeat && p.alive) : null;
    const sheriffPlayerId = sheriffPlayer?.playerId;
    // 构建存活玩家集合，排除已死亡玩家的投票
    const aliveById = new Set(players.filter((p) => p.alive).map((p) => p.playerId));
    const aliveBySeat = new Set(players.filter((p) => p.alive).map((p) => p.seat));

    // 按被投票目标分组：voteGroups[targetSeat] = [voterSeat1, voterSeat2, ...]
    const voteGroups: Record<number, number[]> = {};
    Object.entries(votes).forEach(([playerId, targetSeat]) => {
      if (!aliveById.has(playerId)) return;
      if (!aliveBySeat.has(targetSeat)) return;
      const voter = players.find((p) => p.playerId === playerId);
      if (voter) {
        if (!voteGroups[targetSeat]) voteGroups[targetSeat] = [];
        voteGroups[targetSeat].push(voter.seat);
      }
    });

    // 将分组数据转换为结果数组，计算每个目标的加权得票数
    const voteResults = Object.entries(voteGroups)
      .map(([targetSeat, voterSeats]) => {
        const target = players.find((p) => p.seat === Number(targetSeat));
        let voteCount = 0;
        voterSeats.forEach((voterSeat) => {
          const voter = players.find((p) => p.seat === voterSeat);
          if (voter) {
            // 警长票 1.5 票，普通票 1 票
            voteCount += voter.playerId === sheriffPlayerId ? 1.5 : 1;
          }
        });
        return {
          targetSeat: Number(targetSeat),
          targetName: target?.displayName || t("devConsole.unknown"),
          voterSeats,
          voteCount,
        };
      })
      // 按得票数从高到低排序，方便阅读
      .sort((a, b) => b.voteCount - a.voteCount);

    return `[VOTE_RESULT]${JSON.stringify({ title, results: voteResults })}`;
  }

  /**
   * 投票计票与结算的核心方法
   *
   * 完整结算流程：
   * 1. 将当前投票记录存入 voteHistory（按天归档）
   * 2. 调用 tallyVotes 计算最高票玩家（考虑警长 1.5 票权重）
   * 3. 如果有明确最高票者：
   *    a. 检查是否为白痴免疫（Idiot 免死但翻牌失去投票权）
   *    b. 如果是猎人（Hunter），延迟胜负判定到开枪之后
   *    c. 否则直接处决并检查胜负条件
   * 4. 如果平票：
   *    a. 首次平票 → 进入 PK 发言环节（DAY_PK_SPEECH），PK 后重投
   *    b. PK 后仍平票 → 无人被处决
   */
  private async resolveVotes(state: GameState, runtime: VotePhaseRuntime): Promise<void> {
    const { t } = getI18n();
    const uiText = getUiText();
    const systemMessages = getSystemMessages();
    const speakerHost = t("speakers.host");
    const speakerHint = t("speakers.hint");

    // 将游戏状态转换到 DAY_RESOLVE 阶段
    let currentState = transitionPhase(state, "DAY_RESOLVE");

    // 将本轮投票记录归档到 voteHistory（按天数索引）
    const currentVotes = { ...state.votes };
    const newHistory = { ...state.voteHistory, [state.day]: currentVotes };
    currentState = { ...currentState, voteHistory: newHistory };

    runtime.setGameState(currentState);
    await runtime.waitForUnpause();

    // 调用 game-master 的 tallyVotes 进行计票
    // 返回 { seat, count } 表示被处决者座位和票数，null 表示平票
    const result = tallyVotes(currentState);

    // 记录投票结果到 dayHistory（供游戏回顾、回放使用）
    const prevDayRecord = (currentState.dayHistory || {})[currentState.day] || {};
    if (result) {
      // 有明确被处决者：记录座位、票数，标记非平票
      currentState = {
        ...currentState,
        dayHistory: {
          ...(currentState.dayHistory || {}),
          [currentState.day]: { ...prevDayRecord, executed: { seat: result.seat, votes: result.count }, voteTie: false },
        },
      };
    } else {
      // 平票：标记无人被处决
      currentState = {
        ...currentState,
        dayHistory: {
          ...(currentState.dayHistory || {}),
          [currentState.day]: { ...prevDayRecord, executed: undefined, voteTie: true },
        },
      };
    }

    runtime.setGameState(currentState);

    // 构建投票分布数据并记录到回放系统
    // 将投票数据按目标座位分组，格式：{ "目标座位号": [投票人座位1, 投票人座位2, ...] }
    const voteDistForRecord: Record<string, number[]> = {};
    for (const [voterId, targetSeat] of Object.entries(currentVotes)) {
      const k = String(targetSeat);
      if (!voteDistForRecord[k]) voteDistForRecord[k] = [];
      const voter = currentState.players.find((p) => p.playerId === voterId);
      if (voter) voteDistForRecord[k].push(voter.seat);
    }
    const isTie = !result;
    const isPK = currentState.pkSource === "vote";
    // 调用回放记录回调，记录投票最终结果（供游戏回放功能使用）
    runtime.onRecordVoteResult?.(
      result?.seat ?? null,        // 被处决者座位，null 表示无人被处决
      voteDistForRecord,           // 投票分布
      isTie,                       // 是否平票
      isPK,                        // 是否为 PK 轮次
      currentState.badge.revoteCount ?? 0,  // PK 重投轮数
      "DAY_RESOLVE",               // 阶段标识
      currentState.day,            // 天数
    );

    // 生成投票详情文本（结构化 JSON），添加到系统消息历史
    const voteDetailMessage = this.generateVoteDetails(
      currentVotes,
      currentState.players,
      t("votePhase.voteDetailTitle"),
      currentState.badge.holderSeat
    );
    currentState = addSystemMessage(currentState, voteDetailMessage);

    if (result) {
      // 有明确被处决者
      const executed = currentState.players.find((p) => p.seat === result.seat);

      // === 白痴（Idiot）免疫机制 ===
      // 如果被处决者是白痴且尚未翻牌，则触发免疫：免死但翻牌，失去投票权
      if (executed?.role === "Idiot" && !currentState.roleAbilities.idiotRevealed) {
        // 记录白痴免疫触发日志
        gameLogger.voteResult(`${executed.displayName}(座位${result.seat + 1}) 被投票处决但触发白痴免疫，免死但失去投票权`);
        const idiotMsg = t("system.idiotRevealed", { seat: result.seat + 1, name: executed.displayName });
        currentState = addSystemMessage(currentState, idiotMsg);
        // 更新 dayHistory 记录白痴翻牌事件
        const prevDayRec = currentState.dayHistory?.[currentState.day] || {};
        currentState = {
          ...currentState,
          roleAbilities: { ...currentState.roleAbilities, idiotRevealed: true },  // 标记白痴已翻牌
          dayHistory: {
            ...(currentState.dayHistory || {}),
            [currentState.day]: { ...prevDayRec, idiotRevealed: { seat: result.seat } },
          },
          pkTargets: undefined,  // 清除 PK 状态
          pkSource: undefined,
        };
        runtime.setDialogue(speakerHost, idiotMsg, false);
        runtime.setGameState(currentState);

        // 白痴免疫后跳过处决，但仍需检查胜负条件
        const winner = checkWinCondition(currentState);
        if (winner) {
          await runtime.onGameEnd(currentState, winner);
          return;
        }
        // 无人被处决（白痴免死），传入 null 表示本次投票未导致死亡
        await runtime.onVoteComplete(currentState, null);
        return;
      }

      // 记录正常处决日志
      gameLogger.voteResult(`${executed?.displayName || ""}(座位${result.seat + 1}) 被投票处决 (${result.count}票)`);

      // 添加"玩家被处决"系统消息并显示主持人对话
      currentState = addSystemMessage(
        currentState,
        systemMessages.playerExecuted(result.seat + 1, executed?.displayName || "", result.count)
      );
      runtime.setDialogue(
        speakerHost,
        systemMessages.playerExecuted(result.seat + 1, executed?.displayName || "", result.count),
        false
      );

      // 播放该座位对应的死亡旁白音效
      const diedKey = getPlayerDiedKey(result.seat);
      if (diedKey) await playNarrator(diedKey);

      // 处决完成后清除 PK 状态
      currentState = {
        ...currentState,
        pkTargets: undefined,
        pkSource: undefined,
      };
    } else {
      // === 平票处理 ===
      // 使用 getVoteCounts 重新计票（应用警长权重和白痴排除规则）
      const voteCounts = this.getVoteCounts(currentState);
      const maxVotes = Math.max(0, ...Object.values(voteCounts));
      // 找出所有最高票的座位（可能多人平票）
      const topSeats = Object.entries(voteCounts)
        .filter(([, c]) => c === maxVotes)
        .map(([s]) => Number(s));

      // 首次平票且非 PK 轮次：进入 PK 发言环节
      if (topSeats.length > 1 && currentState.pkSource !== "vote") {
        // 记录平票进入 PK 的日志
        gameLogger.voteResult(`平票! 进入PK发言: ${topSeats.map(s => `座位${s + 1}`).join(", ")}`);
        // 设置 PK 状态：标记 PK 候选人和来源
        const pkState = {
          ...currentState,
          pkTargets: topSeats,          // PK 候选人座位列表
          pkSource: "vote" as const,    // PK 来源为投票平票
        };
        // 转换到 PK 发言阶段
        let nextState = transitionPhase(pkState, "DAY_PK_SPEECH");
        const firstSeat = topSeats[0] ?? null;
        nextState = {
          ...nextState,
          currentSpeakerSeat: firstSeat,      // 设置第一个 PK 发言者
          daySpeechStartSeat: firstSeat,      // 记录发言起始座位
        };
        // 添加平票 PK 系统消息
        nextState = addSystemMessage(nextState, t("votePhase.tiePk"));
        runtime.setGameState(nextState);
        runtime.setDialogue(speakerHost, t("votePhase.tiePk"), false);

        // 等待对话展示时间后暂停，等待用户确认
        await delay(DELAY_CONFIG.DIALOGUE);
        await runtime.waitForUnpause();

        // PK 发言：第一个发言人如果是 AI 则自动发言，如果是人类则提示操作
        const firstSpeaker = nextState.players.find((p) => p.seat === firstSeat);
        if (firstSpeaker && !firstSpeaker.isHuman) {
          await runtime.runAISpeech(nextState, firstSpeaker);
        } else if (firstSpeaker?.isHuman) {
          runtime.setDialogue(speakerHint, uiText.yourTurn, false);
        }
        // 返回后，PK 发言完成后会重新触发投票（isRevote=true）
        return;
      }

      // PK 后仍平票或多人同票：无人被处决
      // 记录平票无人处决日志
      gameLogger.voteResult("平票，无人被处决");
      currentState = {
        ...currentState,
        pkTargets: undefined,
        pkSource: undefined,
      };
      currentState = addSystemMessage(currentState, systemMessages.voteTie);
      runtime.setDialogue(speakerHost, systemMessages.voteTie, false);
    }

    runtime.setGameState(currentState);

    // === 猎人（Hunter）开枪延迟判定 ===
    // 如果被处决者是猎人且可以开枪，延迟胜负判定到猎人开枪完成之后
    // 因为猎人开枪可能改变存活人数，从而影响胜负结果
    const executed =
      result ? currentState.players.find((p) => p.seat === result.seat) : null;
    if (result && executed?.role === "Hunter" && currentState.roleAbilities.hunterCanShoot) {
      // 延迟胜负检查：将控制权交回上层，由 HunterPhase 处理开枪后再检查胜负
      await runtime.onVoteComplete(currentState, result);
      return;
    }

    // === 胜负条件检查 ===
    // 检查当前存活人数是否满足某一方的胜利条件
    const winner = checkWinCondition(currentState);
    if (winner) {
      // 有胜出方：触发游戏结束流程
      await runtime.onGameEnd(currentState, winner);
      return;
    }

    // 游戏继续：将控制权交回上层，进入下一个阶段（通常是夜晚）
    await runtime.onVoteComplete(currentState, result);
  }
}
