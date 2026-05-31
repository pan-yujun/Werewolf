/**
 * 游戏分析生成 Hook
 * 游戏结束后立即生成基础分析（纯计算），AI 内容按需触发
 */

import { useEffect, useCallback, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  gameStateAtom,
  gameAnalysisAtom,
  analysisErrorAtom,
} from "@/store/game-machine";
import {
  GAME_ANALYSIS_VERSION,
  generateBasicGameAnalysis,
  enrichAnalysisWithAI,
  getGameAnalysisSourceFingerprint,
} from "@/lib/game-analysis";
import { gameStatsTracker } from "@/hooks/useGameStats";
import { getReviewModel } from "@/lib/api-keys";
import { saveGameToHistory } from "@/lib/game-history-storage";
import type { EnrichmentType, EnrichmentState, GameAnalysisData } from "@/types/analysis";
import { createInitialEnrichmentState } from "@/types/analysis";

const ENRICH_TIMEOUT_MS = 120_000;

export function useGameAnalysis() {
  const gameState = useAtomValue(gameStateAtom);
  const [analysisData, setAnalysisData] = useAtom(gameAnalysisAtom);
  const [, setError] = useAtom(analysisErrorAtom);
  const [enrichmentState, setEnrichmentState] = useState<EnrichmentState>(createInitialEnrichmentState);

  // 用 ref 跟踪最新 gameState
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;

  // 游戏结束时立即生成基础分析（纯计算，无 LLM）
  const triggerBasicAnalysis = useCallback(() => {
    const state = gameStateRef.current;
    if (state.phase !== "GAME_END" || !state.winner) return;

    try {
      const winner = state.winner === "wolf" ? "wolf" : "villager";
      let durationSeconds = 0;
      if (state.startTime) {
        durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
      } else {
        const statsSummary = gameStatsTracker.getSummary(winner, true);
        durationSeconds = statsSummary?.durationSeconds ?? 0;
      }

      const data = generateBasicGameAnalysis(state, durationSeconds);
      setAnalysisData(data);
      saveGameToHistory(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "分析生成失败";
      setError(errorMessage);
      console.error("Basic analysis generation failed:", err);
    }
  }, [setAnalysisData, setError]);

  // 用 ref 跟踪，避免 effect 依赖回调
  const triggerRef = useRef(triggerBasicAnalysis);
  triggerRef.current = triggerBasicAnalysis;

  useEffect(() => {
    const sourceFingerprint = gameState.phase === "GAME_END"
      ? getGameAnalysisSourceFingerprint(gameState)
      : null;

    const needsAnalysis = gameState.phase === "GAME_END" &&
      gameState.winner &&
      (
        !analysisData ||
        analysisData.gameId !== gameState.gameId ||
        analysisData.analysisVersion !== GAME_ANALYSIS_VERSION ||
        analysisData.sourceFingerprint !== sourceFingerprint
      );

    if (needsAnalysis) {
      triggerRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, analysisData]);

  // 按需触发 AI 分析
  const enrichAnalysis = useCallback(async (type: EnrichmentType) => {
    const state = gameStateRef.current;
    if (state.phase !== "GAME_END") return;

    setEnrichmentState(prev => ({
      ...prev,
      [type]: { loading: true, loaded: false, error: undefined },
    }));

    const timeoutId = setTimeout(() => {
      setEnrichmentState(prev => ({
        ...prev,
        [type]: { loading: false, loaded: false, error: "请求超时" },
      }));
    }, ENRICH_TIMEOUT_MS);

    try {
      const reviewModel = getReviewModel();
      const result = await enrichAnalysisWithAI(type, state, reviewModel);
      clearTimeout(timeoutId);

      // 合并结果到 analysisData
      setAnalysisData(prev => {
        if (!prev) return prev;
        const updated: GameAnalysisData = { ...prev };

        if (result.awards) {
          updated.awards = result.awards;
        }
        if (result.reviews) {
          updated.reviews = result.reviews;
        }
        if (result.speechScores) {
          updated.personalStats = {
            ...updated.personalStats,
            radarStats: {
              ...updated.personalStats.radarStats,
              logic: result.speechScores.logic,
              speech: result.speechScores.clarity,
            },
            highlightQuote: result.highlightQuote ?? updated.personalStats.highlightQuote,
            totalScore: calculateTotalScore({
              ...updated.personalStats.radarStats,
              logic: result.speechScores.logic,
              speech: result.speechScores.clarity,
            }),
          };
        }
        if (result.speeches) {
          updated.timeline = result.speeches.timeline;
        }

        // 保存更新后的完整数据到历史记录
        saveGameToHistory(updated);
        return updated;
      });

      setEnrichmentState(prev => ({
        ...prev,
        [type]: { loading: false, loaded: true },
      }));
    } catch (err) {
      clearTimeout(timeoutId);
      const errorMessage = err instanceof Error ? err.message : "AI 分析失败";
      setEnrichmentState(prev => ({
        ...prev,
        [type]: { loading: false, loaded: false, error: errorMessage },
      }));
      console.error(`Enrichment ${type} failed:`, err);
    }
  }, [setAnalysisData]);

  const clearAnalysis = useCallback(() => {
    setAnalysisData(null);
    setError(null);
    setEnrichmentState(createInitialEnrichmentState());
  }, [setAnalysisData, setError]);

  return {
    analysisData,
    enrichmentState,
    enrichAnalysis,
    triggerBasicAnalysis,
    clearAnalysis,
  };
}

// 辅助：计算总分
function calculateTotalScore(radarStats: { logic: number; speech: number; survival: number; skillOrHide: number; voteOrTicket: number }): number {
  const weights = [0.25, 0.2, 0.15, 0.25, 0.15];
  const values = [radarStats.logic, radarStats.speech, radarStats.survival, radarStats.skillOrHide, radarStats.voteOrTicket];
  return Math.round(values.reduce((sum, v, i) => sum + v * weights[i], 0));
}

export function useAnalysisData() {
  return useAtomValue(gameAnalysisAtom);
}
