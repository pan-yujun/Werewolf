"use client";

/**
 * useReplayPlayer — 回放播放器 Hook
 *
 * 从 GameReplayData.timeline 中逐步重建 GameState，
 * 产出与 useGameLogic 相同的 prop 形状，驱动 DialogArea 复用全部游戏 UI。
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import type { GameReplayData, ReplayEvent } from "@/types/replay";
import type { GameState, Player, Phase, Alignment, Role, ChatMessage } from "@/types/game";
import type { DialogueState } from "@/store/game-machine";
import { getI18n } from "@/i18n/translator";
import { getSystemMessages, getUiText } from "@/lib/game-texts";

// ── 预计算的翻译文本类型 ──────────────────────────────────

type ReplayTexts = {
  system: ReturnType<typeof getSystemMessages>;
  ui: ReturnType<typeof getUiText>;
  t: ReturnType<typeof getI18n>["t"];
};

// ── 每种事件的基础延迟（ms） ──────────────────────────────

const EVENT_BASE_DELAY: Record<string, number> = {
  PHASE_ENTER: 800,
  PHASE_EXIT: 300,
  NIGHT_GUARD_PROTECT: 1000,
  NIGHT_WOLF_KILL: 1200,
  NIGHT_WITCH_SAVE: 1000,
  NIGHT_WITCH_POISON: 1000,
  NIGHT_WITCH_SKIP: 800,
  NIGHT_SEER_CHECK: 1000,
  NIGHT_RESOLVE: 2000,
  SPEECH_SEGMENT: 1500,
  SYSTEM_ANNOUNCEMENT: 2000,
  DEATH_ANNOUNCEMENT: 2500,
  VOTE_CAST: 500,
  VOTE_RESULT: 3000,
  BADGE_SIGNUP_DECISION: 600,
  BADGE_ELECTION_VOTE: 500,
  BADGE_ELECTED: 2000,
  BADGE_TRANSFER: 2000,
  BADGE_TORN: 2000,
  HUNTER_SHOOT: 2000,
  WHITE_WOLF_KING_BOOM: 2000,
  IDIOT_REVEALED: 2000,
  GAME_START: 500,
  GAME_END: 3000,
};

// ── 打字机速度 ──────────────────────────────────────────

const TYPEWRITER_CHAR_MS = 30;

// ── 从 ReplayPlayer[] 构建 Player[] ──────────────────────

function buildPlayersFromReplay(replayData: GameReplayData): Player[] {
  return replayData.players.map((rp) => ({
    playerId: rp.playerId,
    seat: rp.seat,
    displayName: rp.displayName,
    avatarSeed: rp.avatarSeed,
    alive: true,
    role: rp.role,
    alignment: rp.alignment,
    isHuman: rp.isHuman,
    agentProfile: rp.agentProfile
      ? {
          modelRef: rp.agentProfile.model,
          persona: {
            mbti: rp.agentProfile.persona.mbti,
            gender: rp.agentProfile.persona.gender as "male" | "female" | "nonbinary",
            age: rp.agentProfile.persona.age,
            styleLabel: rp.agentProfile.persona.styleLabel,
            voiceRules: rp.agentProfile.persona.voiceRules,
            basicInfo: rp.agentProfile.persona.basicInfo,
          },
          playerMind: rp.agentProfile.playerMind,
        }
      : undefined,
  }));
}

// ── 构建初始 GameState ──────────────────────────────────

function buildInitialGameState(replayData: GameReplayData): GameState {
  return {
    gameId: replayData.meta.gameId,
    phase: "NIGHT_START",
    day: 1,
    startTime: replayData.meta.startTime,
    difficulty: "normal",
    isGenshinMode: false,
    isSpectatorMode: false,
    players: buildPlayersFromReplay(replayData),
    events: [],
    messages: [],
    currentSpeakerSeat: null,
    nextSpeakerSeatOverride: null,
    daySpeechStartSeat: null,
    speechDirection: "clockwise",
    pkTargets: undefined,
    pkSource: undefined,
    badge: {
      holderSeat: null,
      candidates: [],
      signup: {},
      votes: {},
      allVotes: {},
      history: {},
      revoteCount: 0,
    },
    votes: {},
    voteReasons: {},
    lastVoteReasons: {},
    voteHistory: {},
    dailySummaries: {},
    dailySummaryFacts: {},
    dailySummaryVoteData: {},
    nightActions: {},
    roleAbilities: {
      witchHealUsed: false,
      witchPoisonUsed: false,
      hunterCanShoot: true,
      idiotRevealed: false,
      whiteWolfKingBoomUsed: false,
    },
    winner: null,
  };
}

// ── 辅助：创建系统消息 ──────────────────────────────────

function makeSystemMsg(content: string, ts: number, day: number, phase: Phase): ChatMessage {
  return {
    id: uuidv4(),
    playerId: "system",
    playerName: "系统",
    content,
    timestamp: ts,
    day,
    phase,
    isSystem: true,
  };
}

// ── 应用单个事件到 GameState ──────────────────────────────

function applyEvent(state: GameState, event: ReplayEvent, texts?: ReplayTexts): GameState {
  const d = event.data;
  switch (d.type) {
    case "PHASE_ENTER": {
      const newState = { ...state, phase: d.phase, day: d.day };
      if (!texts) return newState;
      // 为夜晚阶段和关键白天阶段生成法官旁白系统消息
      const narrationMsgs: ChatMessage[] = [];
      switch (d.phase) {
        case "NIGHT_START":
          narrationMsgs.push(makeSystemMsg(texts.system.nightFall(d.day), event.ts, d.day, d.phase));
          break;
        case "NIGHT_GUARD_ACTION":
          narrationMsgs.push(makeSystemMsg(texts.system.guardActionStart, event.ts, d.day, d.phase));
          break;
        case "NIGHT_WOLF_ACTION":
          narrationMsgs.push(makeSystemMsg(texts.system.wolfActionStart, event.ts, d.day, d.phase));
          break;
        case "NIGHT_WITCH_ACTION":
          narrationMsgs.push(makeSystemMsg(texts.system.witchActionStart, event.ts, d.day, d.phase));
          break;
        case "NIGHT_SEER_ACTION":
          narrationMsgs.push(makeSystemMsg(texts.system.seerActionStart, event.ts, d.day, d.phase));
          break;
        case "DAY_START":
          narrationMsgs.push(makeSystemMsg(texts.system.dayBreak, event.ts, d.day, d.phase));
          break;
        case "DAY_SPEECH":
          narrationMsgs.push(makeSystemMsg(texts.system.dayDiscussion, event.ts, d.day, d.phase));
          break;
        case "DAY_VOTE":
          narrationMsgs.push(makeSystemMsg(texts.system.voteStart, event.ts, d.day, d.phase));
          break;
        case "DAY_BADGE_SIGNUP":
          narrationMsgs.push(makeSystemMsg(texts.t("badgePhase.signupStart"), event.ts, d.day, d.phase));
          break;
        case "DAY_BADGE_SPEECH": {
          // 显示报名结果：多少人上警（时间戳稍早，确保排序在前）
          const candidateCount = state.badge.candidates.length;
          if (candidateCount > 0) {
            const signupResultMsg = texts.t("badgePhase.signupResult", { count: candidateCount });
            narrationMsgs.push(makeSystemMsg(signupResultMsg, event.ts - 1, d.day, d.phase));
          }
          narrationMsgs.push(makeSystemMsg(texts.system.badgeSpeechStart, event.ts, d.day, d.phase));
          break;
        }
        case "DAY_BADGE_ELECTION":
          narrationMsgs.push(makeSystemMsg(texts.system.badgeElectionStart, event.ts, d.day, d.phase));
          break;
      }
      if (narrationMsgs.length > 0) {
        return { ...newState, messages: [...newState.messages, ...narrationMsgs] };
      }
      return newState;
    }

    case "NIGHT_GUARD_PROTECT":
      return { ...state, nightActions: { ...state.nightActions, guardTarget: d.targetSeat } };

    case "NIGHT_WOLF_KILL":
      return { ...state, nightActions: { ...state.nightActions, wolfTarget: d.finalTarget } };

    case "NIGHT_WITCH_SAVE":
      return { ...state, nightActions: { ...state.nightActions, witchSave: true } };

    case "NIGHT_WITCH_POISON":
      return { ...state, nightActions: { ...state.nightActions, witchPoison: d.targetSeat } };

    case "NIGHT_SEER_CHECK":
      return {
        ...state,
        nightActions: {
          ...state.nightActions,
          seerTarget: d.targetSeat,
          seerResult: { targetSeat: d.targetSeat, isWolf: d.result === "wolf" },
        },
      };

    case "NIGHT_RESOLVE": {
      const updatedPlayers = state.players.map((p) => {
        const death = d.deaths.find((death) => death.seat === p.seat);
        return death ? { ...p, alive: false } : p;
      });
      const nightRecord = {
        guardTarget: state.nightActions.guardTarget,
        wolfTarget: state.nightActions.wolfTarget,
        witchSave: state.nightActions.witchSave,
        witchPoison: state.nightActions.witchPoison,
        seerTarget: state.nightActions.seerTarget,
        seerResult: state.nightActions.seerResult,
        deaths: d.deaths,
      };
      return {
        ...state,
        players: updatedPlayers,
        nightHistory: { ...(state.nightHistory ?? {}), [state.day]: nightRecord },
        nightActions: { lastGuardTarget: state.nightActions.guardTarget },
      };
    }

    case "SPEECH_SEGMENT": {
      const msg: ChatMessage = {
        id: uuidv4(),
        playerId: state.players.find((p) => p.seat === d.speakerSeat)?.playerId ?? "unknown",
        playerName: d.speakerName,
        content: d.content,
        timestamp: event.ts,
        day: state.day,
        phase: state.phase,
        isSystem: false,
        isLastWords: d.isLastWords,
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        currentSpeakerSeat: d.speakerSeat,
      };
    }

    case "SYSTEM_ANNOUNCEMENT": {
      const msg: ChatMessage = {
        id: uuidv4(),
        playerId: "system",
        playerName: "系统",
        content: d.content,
        timestamp: event.ts,
        day: state.day,
        phase: state.phase,
        isSystem: true,
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case "DEATH_ANNOUNCEMENT": {
      let content: string;
      if (d.isPeaceNight) {
        content = texts?.system.peacefulNight ?? "平安夜，无人死亡";
      } else {
        content = d.deaths
          .map((death) => texts?.system.playerKilled(death.seat + 1, death.name) ?? `${death.seat + 1}号 ${death.name} 倒下了`)
          .join("\n");
      }
      const msg: ChatMessage = {
        id: uuidv4(),
        playerId: "system",
        playerName: "系统",
        content,
        timestamp: event.ts,
        day: state.day,
        phase: state.phase,
        isSystem: true,
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case "VOTE_CAST":
      return { ...state, votes: { ...state.votes, [String(d.voterSeat)]: d.targetSeat } };

    case "VOTE_RESULT": {
      const updatedPlayers = d.eliminated !== null
        ? state.players.map((p) => (p.seat === d.eliminated ? { ...p, alive: false } : p))
        : state.players;
      const dayRecord = {
        executed: d.eliminated !== null ? { seat: d.eliminated, votes: 0 } : undefined,
        voteTie: d.isTie,
      };
      let newState: GameState = {
        ...state,
        players: updatedPlayers,
        votes: {},
        voteHistory: { ...state.voteHistory, [state.day]: { ...state.votes } },
        dayHistory: { ...(state.dayHistory ?? {}), [state.day]: dayRecord },
        pkTargets: undefined,
        pkSource: undefined,
      };

      // 生成投票详情消息（与 VotePhase.generateVoteDetails 格式一致）
      if (texts && d.voteDistribution) {
        const voteResults = Object.entries(d.voteDistribution)
          .map(([targetSeat, voterSeats]) => {
            const target = state.players.find((p) => p.seat === Number(targetSeat));
            return {
              targetSeat: Number(targetSeat),
              targetName: target?.displayName ?? `${Number(targetSeat) + 1}号`,
              voterSeats: voterSeats as number[],
              voteCount: (voterSeats as number[]).length,
            };
          })
          .sort((a, b) => b.voteCount - a.voteCount);

        if (voteResults.length > 0) {
          const voteDetailMsg = `[VOTE_RESULT]${JSON.stringify({
            title: texts.t("votePhase.voteDetailTitle") ?? "投票详情",
            results: voteResults,
          })}`;
          newState = {
            ...newState,
            messages: [...newState.messages, makeSystemMsg(voteDetailMsg, event.ts, state.day, state.phase)],
          };
        }
      }

      return newState;
    }

    case "BADGE_SIGNUP_DECISION":
      return {
        ...state,
        badge: {
          ...state.badge,
          signup: { ...state.badge.signup, [String(d.signedUp ? d.seat : -1)]: d.signedUp },
          candidates: d.signedUp
            ? [...new Set([...state.badge.candidates, d.seat])]
            : state.badge.candidates,
        },
      };

    case "BADGE_ELECTION_VOTE":
      return {
        ...state,
        badge: {
          ...state.badge,
          votes: { ...state.badge.votes, [String(d.voterSeat)]: d.candidateSeat },
        },
      };

    case "BADGE_ELECTED": {
      // voteDistribution is Record<string, number[]>, convert to Record<string, number> for badge.history
      const convertedHistory: Record<string, number> = {};
      for (const [targetSeat, voterSeats] of Object.entries(d.voteDistribution)) {
        // Use the first voter as representative (badge.history format is simplified)
        if (voterSeats.length > 0) convertedHistory[targetSeat] = voterSeats[0];
      }
      let badgeState: GameState = {
        ...state,
        badge: {
          ...state.badge,
          holderSeat: d.seat,
          votes: {},
          allVotes: {},
          candidates: [],
          history: { ...state.badge.history, [state.day]: convertedHistory },
        },
      };

      // 生成警长竞选投票详情消息
      if (texts && d.voteDistribution) {
        const badgeVoteResults = Object.entries(d.voteDistribution)
          .map(([targetSeat, voterSeats]) => {
            const target = state.players.find((p) => p.seat === Number(targetSeat));
            return {
              targetSeat: Number(targetSeat),
              targetName: target?.displayName ?? `${Number(targetSeat) + 1}号`,
              voterSeats: voterSeats as number[],
              voteCount: (voterSeats as number[]).length,
            };
          })
          .sort((a, b) => b.voteCount - a.voteCount);

        if (badgeVoteResults.length > 0) {
          const badgeVoteDetailMsg = `[VOTE_RESULT]${JSON.stringify({
            title: texts.t("badgePhase.voteDetailTitle") ?? "警长竞选投票详情",
            results: badgeVoteResults,
          })}`;
          badgeState = {
            ...badgeState,
            messages: [...badgeState.messages, makeSystemMsg(badgeVoteDetailMsg, event.ts, state.day, state.phase)],
          };
        }

        // 添加当选消息
        const winner = state.players.find((p) => p.seat === d.seat);
        const votedCount = d.voteDistribution[String(d.seat)]?.length ?? 0;
        const electedMsg = texts.system.badgeElected(d.seat + 1, winner?.displayName ?? "", votedCount);
        badgeState = {
          ...badgeState,
          messages: [...badgeState.messages, makeSystemMsg(electedMsg, event.ts, state.day, state.phase)],
        };
      }

      return badgeState;
    }

    case "BADGE_TRANSFER":
      return {
        ...state,
        badge: { ...state.badge, holderSeat: d.toSeat },
      };

    case "BADGE_TORN":
      return {
        ...state,
        badge: { ...state.badge, holderSeat: null },
      };

    case "HUNTER_SHOOT": {
      if (d.targetSeat === null) return state;
      const updatedPlayers = state.players.map((p) =>
        p.seat === d.targetSeat ? { ...p, alive: false } : p
      );
      const shot = { hunterSeat: d.hunterSeat, targetSeat: d.targetSeat };
      if (d.diedAtNight) {
        const prev = (state.nightHistory ?? {})[state.day] ?? {};
        return {
          ...state,
          players: updatedPlayers,
          nightHistory: { ...(state.nightHistory ?? {}), [state.day]: { ...prev, hunterShot: shot } },
        };
      }
      const prev = (state.dayHistory ?? {})[state.day] ?? {};
      return {
        ...state,
        players: updatedPlayers,
        dayHistory: { ...(state.dayHistory ?? {}), [state.day]: { ...prev, hunterShot: shot } },
      };
    }

    case "WHITE_WOLF_KING_BOOM": {
      const updatedPlayers = state.players.map((p) =>
        p.seat === d.wwkSeat || p.seat === d.targetSeat ? { ...p, alive: false } : p
      );
      const prev = (state.dayHistory ?? {})[state.day] ?? {};
      return {
        ...state,
        players: updatedPlayers,
        dayHistory: {
          ...(state.dayHistory ?? {}),
          [state.day]: { ...prev, whiteWolfKingBoom: { boomSeat: d.wwkSeat, targetSeat: d.targetSeat } },
        },
        roleAbilities: { ...state.roleAbilities, whiteWolfKingBoomUsed: true },
      };
    }

    case "IDIOT_REVEALED":
      return {
        ...state,
        roleAbilities: { ...state.roleAbilities, idiotRevealed: true },
        dayHistory: {
          ...(state.dayHistory ?? {}),
          [state.day]: { ...(state.dayHistory ?? {})[state.day], idiotRevealed: { seat: d.seat } },
        },
      };

    case "GAME_END": {
      let endState: GameState = { ...state, winner: d.winner, phase: "GAME_END" as Phase };

      if (texts) {
        // 胜负公告
        const winMsg = d.winner === "village" ? texts.system.villageWin : texts.system.wolfWin;
        endState = {
          ...endState,
          messages: [...endState.messages, makeSystemMsg(winMsg, event.ts, state.day, "GAME_END" as Phase)],
        };

        // 身份揭晓
        const roleRevealPlayers = d.finalPlayers
          .sort((a, b) => a.seat - b.seat)
          .map((fp) => {
            const player = state.players.find((p) => p.seat === fp.seat);
            return {
              playerId: player?.playerId ?? `seat-${fp.seat}`,
              seat: fp.seat,
              name: player?.displayName ?? `${fp.seat + 1}号`,
              role: fp.role,
              isHuman: player?.isHuman ?? false,
              modelRef: player?.agentProfile?.modelRef,
            };
          });
        const roleRevealMsg = `[ROLE_REVEAL]${JSON.stringify({
          title: texts.t("specialEvents.roleRevealTitle") ?? "身份揭晓",
          players: roleRevealPlayers,
        })}`;
        endState = {
          ...endState,
          messages: [...endState.messages, makeSystemMsg(roleRevealMsg, event.ts, state.day, "GAME_END" as Phase)],
        };
      }

      return endState;
    }

    default:
      return state;
  }
}

// ── Hook ──────────────────────────────────────────────

export function useReplayPlayer(replayData: GameReplayData | null) {
  const [gameState, setGameState] = useState<GameState>(() =>
    replayData ? buildInitialGameState(replayData) : ({
      gameId: "",
      phase: "LOBBY" as Phase,
      day: 0,
      difficulty: "normal",
      players: [],
      events: [],
      messages: [],
      currentSpeakerSeat: null,
      nextSpeakerSeatOverride: null,
      daySpeechStartSeat: null,
      speechDirection: "clockwise",
      badge: { holderSeat: null, candidates: [], signup: {}, votes: {}, allVotes: {}, history: {}, revoteCount: 0 },
      votes: {},
      voteReasons: {},
      lastVoteReasons: {},
      voteHistory: {},
      dailySummaries: {},
      dailySummaryFacts: {},
      nightActions: {},
      roleAbilities: { witchHealUsed: false, witchPoisonUsed: false, hunterCanShoot: true, idiotRevealed: false, whiteWolfKingBoomUsed: false },
      winner: null,
    } as GameState)
  );
  const [currentDialogue, setCurrentDialogue] = useState<DialogueState | null>(null);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const stateRef = useRef<GameState>(gameState);
  const indexRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typewriterRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(false);
  const textsRef = useRef<ReplayTexts | null>(null);

  // 同步 ref
  useEffect(() => { stateRef.current = gameState; }, [gameState]);
  useEffect(() => { indexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // 当 replayData 从 null 变为已加载时，重新初始化状态
  useEffect(() => {
    if (!replayData) return;
    // 初始化翻译文本
    const { t } = getI18n();
    textsRef.current = { system: getSystemMessages(), ui: getUiText(), t };
    const initial = buildInitialGameState(replayData);
    stateRef.current = initial;
    setGameState(initial);
    setCurrentIndex(0);
    indexRef.current = 0;
    setCurrentDialogue(null);
    setDisplayedText("");
    setIsTyping(false);
    setIsPlaying(false);
    isPlayingRef.current = false;
  }, [replayData]);

  const timeline = replayData?.timeline ?? [];
  const totalEvents = timeline.length;

  const humanPlayer = replayData?.players.find((p) => p.isHuman) ?? null;

  // 清除定时器
  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (typewriterRef.current) { clearTimeout(typewriterRef.current); typewriterRef.current = null; }
  }, []);

  // 打字机效果
  const playTypewriter = useCallback((fullText: string, speaker: string, onDone: () => void) => {
    setCurrentDialogue({ speaker, text: fullText, isStreaming: true });
    setIsTyping(true);
    let charIndex = 0;
    const tick = () => {
      charIndex++;
      setDisplayedText(fullText.slice(0, charIndex));
      if (charIndex >= fullText.length) {
        setIsTyping(false);
        setCurrentDialogue({ speaker, text: fullText, isStreaming: false });
        onDone();
        return;
      }
      typewriterRef.current = setTimeout(tick, TYPEWRITER_CHAR_MS / speed);
    };
    typewriterRef.current = setTimeout(tick, TYPEWRITER_CHAR_MS / speed);
  }, [speed]);

  // 处理单个事件
  const processEvent = useCallback((index: number, onDone: () => void) => {
    if (index >= timeline.length) { setIsPlaying(false); return; }
    const event = timeline[index];
    const texts = textsRef.current ?? undefined;
    const newState = applyEvent(stateRef.current, event, texts);
    stateRef.current = newState;
    setGameState(newState);
    setCurrentIndex(index);

    // SPEECH_SEGMENT 特殊处理：打字机效果
    if (event.data.type === "SPEECH_SEGMENT") {
      const d = event.data;
      playTypewriter(d.content, d.speakerName, onDone);
      return;
    }

    // PHASE_ENTER 夜晚阶段：显示法官旁白到对话区
    if (event.data.type === "PHASE_ENTER" && texts) {
      const d = event.data;
      const narratorMap: Record<string, string> = {
        NIGHT_START: texts.system.nightFall(d.day),
        NIGHT_GUARD_ACTION: texts.system.guardActionStart,
        NIGHT_WOLF_ACTION: texts.system.wolfActionStart,
        NIGHT_WITCH_ACTION: texts.system.witchActionStart,
        NIGHT_SEER_ACTION: texts.system.seerActionStart,
        DAY_START: texts.system.dayBreak,
        DAY_SPEECH: texts.system.dayDiscussion,
        DAY_VOTE: texts.system.voteStart,
        DAY_BADGE_SIGNUP: texts.t("badgePhase.signupStart"),
        DAY_BADGE_SPEECH: (() => {
          const candidateCount = stateRef.current.badge.candidates.length;
          const signupLine = candidateCount > 0 ? texts.t("badgePhase.signupResult", { count: candidateCount }) + "\n" : "";
          return signupLine + texts.system.badgeSpeechStart;
        })(),
        DAY_BADGE_ELECTION: texts.system.badgeElectionStart,
      };
      const narrationText = narratorMap[d.phase];
      if (narrationText) {
        setCurrentDialogue({ speaker: texts.t("speakers.host"), text: narrationText, isStreaming: false });
        setDisplayedText(narrationText);
        setIsTyping(false);
      }
    }

    // GAME_END：显示胜负结果到对话区
    if (event.data.type === "GAME_END" && texts) {
      const d = event.data;
      const winLine = d.winner === "village"
        ? texts.t("specialEvents.villageWinLine")
        : texts.t("specialEvents.wolfWinLine");
      if (winLine) {
        setCurrentDialogue({ speaker: texts.t("speakers.host"), text: winLine, isStreaming: false });
        setDisplayedText(winLine);
        setIsTyping(false);
      }
    }

    // 其他事件：清除对话，等待延迟后继续
    if (event.data.type !== "SYSTEM_ANNOUNCEMENT" && event.data.type !== "DEATH_ANNOUNCEMENT" && event.data.type !== "PHASE_ENTER" && event.data.type !== "GAME_END") {
      setCurrentDialogue(null);
      setDisplayedText("");
      setIsTyping(false);
    }

    const delay = (EVENT_BASE_DELAY[event.data.type] ?? 1000) / speed;
    timerRef.current = setTimeout(onDone, delay);
  }, [timeline, speed, playTypewriter]);

  // 播放循环
  const playNext = useCallback(() => {
    if (!isPlayingRef.current) return;
    const idx = indexRef.current;
    if (idx >= timeline.length) { setIsPlaying(false); return; }
    processEvent(idx, () => {
      indexRef.current = idx + 1;
      setCurrentIndex(idx + 1);
      // 继续下一个
      timerRef.current = setTimeout(() => {
        if (isPlayingRef.current) playNext();
      }, 0);
    });
  }, [timeline.length, processEvent]);

  // 播放
  const play = useCallback(() => {
    if (indexRef.current >= timeline.length) return;
    setIsPlaying(true);
    isPlayingRef.current = true;
    playNext();
  }, [timeline.length, playNext]);

  // 暂停
  const pause = useCallback(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    clearTimers();
  }, [clearTimers]);

  // 跳转
  const seekTo = useCallback((targetIndex: number) => {
    clearTimers();
    setIsPlaying(false);
    isPlayingRef.current = false;
    setCurrentDialogue(null);
    setDisplayedText("");
    setIsTyping(false);

    // 从头重建到 targetIndex
    const texts = textsRef.current ?? undefined;
    let state = buildInitialGameState(replayData!);
    for (let i = 0; i < targetIndex; i++) {
      state = applyEvent(state, timeline[i], texts);
    }
    stateRef.current = state;
    setGameState(state);
    setCurrentIndex(targetIndex);
    indexRef.current = targetIndex;
  }, [replayData, timeline, clearTimers]);

  // 重新开始
  const restart = useCallback(() => {
    clearTimers();
    setIsPlaying(false);
    isPlayingRef.current = false;
    setCurrentDialogue(null);
    setDisplayedText("");
    setIsTyping(false);
    const initial = buildInitialGameState(replayData!);
    stateRef.current = initial;
    setGameState(initial);
    setCurrentIndex(0);
    indexRef.current = 0;
  }, [replayData, clearTimers]);

  // 手动推进对话
  const advanceDialogue = useCallback(() => {
    if (isTyping) {
      // 跳过打字机，直接显示完整文本
      if (typewriterRef.current) clearTimeout(typewriterRef.current);
      const event = timeline[indexRef.current];
      if (event?.data.type === "SPEECH_SEGMENT") {
        setDisplayedText(event.data.content);
        setIsTyping(false);
        setCurrentDialogue({ speaker: event.data.speakerName, text: event.data.content, isStreaming: false });
      }
    }
  }, [isTyping, timeline]);

  // cleanup
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  return {
    gameState,
    currentDialogue,
    displayedText,
    isTyping,
    isWaitingForAI: false,
    waitingForNextRound: false,
    humanPlayer: humanPlayer
      ? {
          ...humanPlayer,
          alive: true,
          agentProfile: humanPlayer.agentProfile
            ? {
                modelRef: humanPlayer.agentProfile.model,
                persona: {
                  mbti: humanPlayer.agentProfile.persona.mbti,
                  gender: humanPlayer.agentProfile.persona.gender as "male" | "female" | "nonbinary",
                  age: humanPlayer.agentProfile.persona.age,
                  styleLabel: humanPlayer.agentProfile.persona.styleLabel,
                  voiceRules: humanPlayer.agentProfile.persona.voiceRules,
                  basicInfo: humanPlayer.agentProfile.persona.basicInfo,
                },
                playerMind: humanPlayer.agentProfile.playerMind,
              }
            : undefined,
        } as Player
      : null,
    isPlaying,
    isPaused: !isPlaying,
    progress: totalEvents > 0 ? currentIndex / totalEvents : 0,
    totalEvents,
    currentEventIndex: currentIndex,
    play,
    pause,
    seekTo,
    restart,
    speed,
    setSpeed,
    advanceDialogue,
  };
}
