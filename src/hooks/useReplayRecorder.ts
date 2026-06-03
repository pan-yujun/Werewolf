/**
 * useReplayRecorder — 回放记录器 React Hook
 *
 * 提供 GameReplayRecorder 实例和便捷方法，供 useGameLogic 等 Hook 调用。
 * Recorder 实例通过 ref 保持跨渲染稳定。
 */

import { useRef, useCallback } from "react";
import { GameReplayRecorder, buildReplayPlayers, buildReplayConfig } from "@/lib/game-replay-recorder";
import type { GameState, Phase, Alignment } from "@/types/game";
import type { ReplayPlayer } from "@/types/replay";

export function useReplayRecorder() {
  const recorderRef = useRef<GameReplayRecorder>(new GameReplayRecorder());

  // === 生命周期 ===

  const startRecording = useCallback((state: GameState) => {
    const config = buildReplayConfig(state);
    const players = buildReplayPlayers(state.players);
    recorderRef.current.start(config, players);
  }, []);

  const finishRecording = useCallback((gameId: string, winner: Alignment, state: GameState) => {
    recorderRef.current.finish(gameId, winner, state);
  }, []);

  // === 阶段记录 ===

  const recordPhaseEnter = useCallback((phase: Phase, day: number) => {
    recorderRef.current.pushEventWithState("PHASE_ENTER", { type: "PHASE_ENTER", phase, day }, phase, day);
  }, []);

  const recordPhaseExit = useCallback((phase: Phase, day: number) => {
    recorderRef.current.pushEventWithState("PHASE_EXIT", { type: "PHASE_EXIT", phase }, phase, day);
  }, []);

  // === 夜晚行动 ===

  const recordGuardProtect = useCallback((guardSeat: number, targetSeat: number, isHuman: boolean, day: number) => {
    recorderRef.current.pushEventWithState(
      "NIGHT_GUARD_PROTECT",
      { type: "NIGHT_GUARD_PROTECT", guardSeat, targetSeat, isHuman },
      "NIGHT_GUARD_ACTION",
      day,
    );
  }, []);

  const recordWolfKill = useCallback(
    (wolfVotes: Array<{ wolfSeat: number; targetSeat: number; isHuman: boolean }>, finalTarget: number, day: number) => {
      recorderRef.current.pushEventWithState(
        "NIGHT_WOLF_KILL",
        { type: "NIGHT_WOLF_KILL", wolfVotes, finalTarget },
        "NIGHT_WOLF_ACTION",
        day,
      );
    },
    [],
  );

  const recordWitchSave = useCallback((witchSeat: number, targetSeat: number, isHuman: boolean, day: number) => {
    recorderRef.current.pushEventWithState(
      "NIGHT_WITCH_SAVE",
      { type: "NIGHT_WITCH_SAVE", witchSeat, targetSeat, isHuman },
      "NIGHT_WITCH_ACTION",
      day,
    );
  }, []);

  const recordWitchPoison = useCallback((witchSeat: number, targetSeat: number, isHuman: boolean, day: number) => {
    recorderRef.current.pushEventWithState(
      "NIGHT_WITCH_POISON",
      { type: "NIGHT_WITCH_POISON", witchSeat, targetSeat, isHuman },
      "NIGHT_WITCH_ACTION",
      day,
    );
  }, []);

  const recordWitchSkip = useCallback((witchSeat: number, reason: "pass" | "no_potions", day: number) => {
    recorderRef.current.pushEventWithState(
      "NIGHT_WITCH_SKIP",
      { type: "NIGHT_WITCH_SKIP", witchSeat, reason },
      "NIGHT_WITCH_ACTION",
      day,
    );
  }, []);

  const recordSeerCheck = useCallback(
    (seerSeat: number, targetSeat: number, result: "wolf" | "good", isHuman: boolean, day: number) => {
      recorderRef.current.pushEventWithState(
        "NIGHT_SEER_CHECK",
        { type: "NIGHT_SEER_CHECK", seerSeat, targetSeat, result, isHuman },
        "NIGHT_SEER_ACTION",
        day,
      );
    },
    [],
  );

  const recordNightResolve = useCallback((deaths: Array<{ seat: number; reason: "wolf" | "poison" | "milk" }>, day: number) => {
    recorderRef.current.pushEventWithState(
      "NIGHT_RESOLVE",
      { type: "NIGHT_RESOLVE", deaths, isPeaceNight: deaths.length === 0 },
      "NIGHT_RESOLVE",
      day,
    );
  }, []);

  // === 白天记录 ===

  const recordSpeechSegment = useCallback(
    (
      speakerSeat: number,
      speakerName: string,
      content: string,
      segmentIndex: number,
      isHuman: boolean,
      isLastWords: boolean,
      phase: Phase,
      day: number,
    ) => {
      recorderRef.current.pushEventWithState(
        "SPEECH_SEGMENT",
        { type: "SPEECH_SEGMENT", speakerSeat, speakerName, content, segmentIndex, isHuman, isLastWords },
        phase,
        day,
      );
    },
    [],
  );

  const recordSystemAnnouncement = useCallback((content: string, phase: Phase, day: number) => {
    recorderRef.current.pushEventWithState(
      "SYSTEM_ANNOUNCEMENT",
      { type: "SYSTEM_ANNOUNCEMENT", content },
      phase,
      day,
    );
  }, []);

  const recordDeathAnnouncement = useCallback(
    (deaths: Array<{ seat: number; name: string; reason: string }>, isPeaceNight: boolean, phase: Phase, day: number) => {
      recorderRef.current.pushEventWithState(
        "DEATH_ANNOUNCEMENT",
        { type: "DEATH_ANNOUNCEMENT", deaths, isPeaceNight },
        phase,
        day,
      );
    },
    [],
  );

  // === 投票记录 ===

  const recordVoteCast = useCallback(
    (voterSeat: number, targetSeat: number, reason: string | undefined, isHuman: boolean, isSheriffVote: boolean, phase: Phase, day: number) => {
      recorderRef.current.pushEventWithState(
        "VOTE_CAST",
        { type: "VOTE_CAST", voterSeat, targetSeat, reason, isHuman, isSheriffVote },
        phase,
        day,
      );
    },
    [],
  );

  const recordVoteResult = useCallback(
    (
      eliminated: number | null,
      voteDistribution: Record<string, number[]>,
      isTie: boolean,
      isPK: boolean,
      pkRound: number,
      phase: Phase,
      day: number,
    ) => {
      recorderRef.current.pushEventWithState(
        "VOTE_RESULT",
        { type: "VOTE_RESULT", eliminated, voteDistribution, isTie, isPK, pkRound },
        phase,
        day,
      );
    },
    [],
  );

  // === 警长竞选 ===

  const recordBadgeSignupDecision = useCallback((seat: number, signedUp: boolean, isHuman: boolean, day: number) => {
    recorderRef.current.pushEventWithState(
      "BADGE_SIGNUP_DECISION",
      { type: "BADGE_SIGNUP_DECISION", seat, signedUp, isHuman },
      "DAY_BADGE_SIGNUP",
      day,
    );
  }, []);

  const recordBadgeElectionVote = useCallback((voterSeat: number, candidateSeat: number, isHuman: boolean, day: number) => {
    recorderRef.current.pushEventWithState(
      "BADGE_ELECTION_VOTE",
      { type: "BADGE_ELECTION_VOTE", voterSeat, candidateSeat, isHuman },
      "DAY_BADGE_ELECTION",
      day,
    );
  }, []);

  const recordBadgeElected = useCallback((seat: number, voteDistribution: Record<string, number[]>, day: number) => {
    recorderRef.current.pushEventWithState(
      "BADGE_ELECTED",
      { type: "BADGE_ELECTED", seat, voteDistribution },
      "DAY_BADGE_ELECTION",
      day,
    );
  }, []);

  const recordBadgeTransfer = useCallback((fromSeat: number, toSeat: number, isHuman: boolean, phase: Phase, day: number) => {
    recorderRef.current.pushEventWithState(
      "BADGE_TRANSFER",
      { type: "BADGE_TRANSFER", fromSeat, toSeat, isHuman },
      phase,
      day,
    );
  }, []);

  const recordBadgeTorn = useCallback((fromSeat: number, isHuman: boolean, phase: Phase, day: number) => {
    recorderRef.current.pushEventWithState("BADGE_TORN", { type: "BADGE_TORN", fromSeat, isHuman }, phase, day);
  }, []);

  // === 特殊事件 ===

  const recordHunterShoot = useCallback(
    (hunterSeat: number, targetSeat: number | null, diedAtNight: boolean, isHuman: boolean, phase: Phase, day: number) => {
      recorderRef.current.pushEventWithState(
        "HUNTER_SHOOT",
        { type: "HUNTER_SHOOT", hunterSeat, targetSeat, diedAtNight, isHuman },
        phase,
        day,
      );
    },
    [],
  );

  const recordWhiteWolfKingBoom = useCallback((wwkSeat: number, targetSeat: number, isHuman: boolean, phase: Phase, day: number) => {
    recorderRef.current.pushEventWithState(
      "WHITE_WOLF_KING_BOOM",
      { type: "WHITE_WOLF_KING_BOOM", wwkSeat, targetSeat, isHuman },
      phase,
      day,
    );
  }, []);

  const recordIdiotRevealed = useCallback((seat: number, phase: Phase, day: number) => {
    recorderRef.current.pushEventWithState("IDIOT_REVEALED", { type: "IDIOT_REVEALED", seat }, phase, day);
  }, []);

  // === 导出 ===

  const exportReplay = useCallback(() => {
    return recorderRef.current.export();
  }, []);

  const downloadReplay = useCallback(() => {
    recorderRef.current.downloadJSON();
  }, []);

  return {
    recorder: recorderRef.current,
    // 生命周期
    startRecording,
    finishRecording,
    // 阶段
    recordPhaseEnter,
    recordPhaseExit,
    // 夜晚
    recordGuardProtect,
    recordWolfKill,
    recordWitchSave,
    recordWitchPoison,
    recordWitchSkip,
    recordSeerCheck,
    recordNightResolve,
    // 白天
    recordSpeechSegment,
    recordSystemAnnouncement,
    recordDeathAnnouncement,
    // 投票
    recordVoteCast,
    recordVoteResult,
    // 警长
    recordBadgeSignupDecision,
    recordBadgeElectionVote,
    recordBadgeElected,
    recordBadgeTransfer,
    recordBadgeTorn,
    // 特殊事件
    recordHunterShoot,
    recordWhiteWolfKingBoom,
    recordIdiotRevealed,
    // 导出
    exportReplay,
    downloadReplay,
  };
}
