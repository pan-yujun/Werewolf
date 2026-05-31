"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PostGameAnalysisPage } from "@/components/analysis";
import { useGameAnalysis } from "@/hooks/useGameAnalysis";
import { getGameHistoryById } from "@/lib/game-history-storage";
import type { GameAnalysisData } from "@/types/analysis";
import { createInitialEnrichmentState } from "@/types/analysis";

export default function AnalysisPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const gameId = searchParams.get("gameId");

  // 历史复盘模式：从 localStorage 加载指定 gameId 的数据
  const [historyData, setHistoryData] = useState<GameAnalysisData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(!!gameId);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // 当前游戏复盘模式：从 atom 读取
  const { analysisData, enrichmentState, enrichAnalysis } = useGameAnalysis();

  useEffect(() => {
    if (!gameId) return;
    setHistoryLoading(true);
    try {
      const data = getGameHistoryById(gameId);
      if (data) {
        setHistoryData(data);
      } else {
        setHistoryError("未找到该对局记录");
      }
    } catch {
      setHistoryError("加载对局记录失败");
    } finally {
      setHistoryLoading(false);
    }
  }, [gameId]);

  const handleReturn = () => {
    router.push(gameId ? "/?open=history" : "/");
  };

  // 历史复盘模式（数据已完整，无需 enrich）
  if (gameId) {
    if (historyLoading) {
      return (
        <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin w-12 h-12 border-4 border-[var(--color-gold)]/30 border-t-[var(--color-gold)] rounded-full mx-auto mb-4" />
            <p className="text-[var(--text-secondary)]">加载对局记录...</p>
          </div>
        </div>
      );
    }

    if (historyError || !historyData) {
      return (
        <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
          <div className="text-center max-w-sm mx-auto px-4">
            <p className="text-red-400 text-sm mb-4">{historyError ?? "数据加载失败"}</p>
            <button
              onClick={handleReturn}
              className="px-5 py-2.5 rounded-lg text-sm border border-[var(--color-gold)]/20 text-[var(--text-secondary)] hover:bg-white/5 transition-colors"
            >
              返回对局记录
            </button>
          </div>
        </div>
      );
    }

    return (
      <PostGameAnalysisPage
        data={historyData}
        onReturn={handleReturn}
      />
    );
  }

  // 当前游戏复盘模式
  if (!analysisData) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="text-center max-w-sm mx-auto px-4">
          <p className="text-[var(--text-secondary)] text-sm mb-4">暂无分析数据，请先完成一局游戏</p>
          <button
            onClick={handleReturn}
            className="px-5 py-2.5 rounded-lg text-sm border border-[var(--color-gold)]/20 text-[var(--text-secondary)] hover:bg-white/5 transition-colors"
          >
            返回首页
          </button>
        </div>
      </div>
    );
  }

  return (
    <PostGameAnalysisPage
      data={analysisData}
      onReturn={handleReturn}
      enrichmentState={enrichmentState}
      onEnrich={enrichAnalysis}
    />
  );
}
