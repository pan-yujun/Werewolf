"use client";

import { useState, useEffect, useMemo, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Play, Pause, SkipBack, Speedometer, Upload } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useReplayPlayer } from "@/hooks/useReplayPlayer";
import { getReplayById, getReplayIndex } from "@/lib/game-replay-recorder";
import { DialogArea } from "@/components/game/DialogArea";
import { PlayerCardCompact } from "@/components/game/PlayerCardCompact";
import { GameBackground } from "@/components/game/GameBackground";
import { buildSimpleAvatarUrl } from "@/lib/avatar-config";
import type { GameReplayData } from "@/types/replay";
import type { Player } from "@/types/game";

function ReplayContent() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const gameId = searchParams.get("gameId");

  const [replayData, setReplayData] = useState<GameReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载回放数据
  useEffect(() => {
    if (gameId) {
      const data = getReplayById(gameId);
      if (data) {
        setReplayData(data);
      } else {
        setError(t("replay.notFound"));
      }
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [gameId, t]);

  // 文件上传处理
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as GameReplayData;
        if (data.meta && data.players && data.timeline) {
          setReplayData(data);
          setError(null);
        } else {
          setError(t("replay.invalidFile"));
        }
      } catch {
        setError(t("replay.parseError"));
      }
    };
    reader.readAsText(file);
  };

  const player = useReplayPlayer(replayData);

  // 设置深色主题
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    return () => {
      document.documentElement.setAttribute("data-theme", "light");
    };
  }, []);

  // 下载回放文件
  const handleDownloadReplay = useCallback(() => {
    if (!replayData) return;
    const json = JSON.stringify(replayData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wolfcha-replay-${replayData.meta.gameId ?? "unknown"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [replayData]);

  // 计算 UI 派生状态
  const isNight = useMemo(() => {
    const phase = player.gameState.phase ?? "";
    return phase.includes("NIGHT") || phase === "NIGHT_START" || phase === "NIGHT_RESOLVE";
  }, [player.gameState.phase]);

  const visualIsNight = isNight;

  // 构建玩家座位列表（左右各半）
  const allPlayers = player.gameState.players ?? [];
  const mid = Math.ceil(allPlayers.length / 2);
  const leftPlayers = allPlayers.slice(0, mid);
  const rightPlayers = allPlayers.slice(mid);

  // 人类玩家是否可见角色
  const canShowRole = player.gameState.phase === "GAME_END" || player.gameState.phase === "LOBBY";

  // 速度选项
  const speedOptions = [0.5, 1, 2, 4];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--bg-main)]">
        <div className="animate-spin w-8 h-8 border-2 border-[var(--color-gold)]/30 border-t-[var(--color-gold)] rounded-full" />
      </div>
    );
  }

  if (!replayData) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[var(--bg-main)] gap-6">
        <div className="text-[var(--text-secondary)] text-center">
          {error ? (
            <p className="text-red-400">{error}</p>
          ) : (
            <>
              <p className="text-lg mb-2">{t("replay.selectFile")}</p>
              <p className="text-sm text-[var(--text-muted)]">{t("replay.selectFileHint")}</p>
            </>
          )}
        </div>
        <label className="wc-action-btn wc-action-btn--primary text-sm h-10 px-6 flex items-center gap-2 cursor-pointer">
          <Upload size={16} />
          {t("replay.uploadFile")}
          <input type="file" accept=".json" onChange={handleFileUpload} className="hidden" />
        </label>
        <button
          onClick={() => router.push("/")}
          className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          {t("replay.backToHome")}
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-main)] overflow-hidden">
      <GameBackground isNight={visualIsNight} />

      {/* 顶部栏 */}
      <div className="relative z-10 flex items-center justify-between px-4 py-2 bg-[var(--bg-main)]/80 backdrop-blur-md border-b border-white/5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 bg-black/20 hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={16} className="text-[var(--color-gold)]" />
          </button>
          <div className="text-sm text-[var(--color-gold)] font-medium">
            {t("replay.title")}
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            {replayData.meta.config.playerCount}{t("replay.players")} · {t("replay.day")} {player.gameState.day}
          </div>
        </div>

        {/* 播放控制 */}
        <div className="flex items-center gap-2">
          {/* 速度 */}
          <div className="flex items-center gap-1 mr-2">
            <Speedometer size={14} className="text-[var(--text-muted)]" />
            {speedOptions.map((s) => (
              <button
                key={s}
                onClick={() => player.setSpeed(s)}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                  player.speed === s
                    ? "bg-[var(--color-gold)]/20 text-[var(--color-gold)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>

          {/* 重新开始 */}
          <button
            onClick={player.restart}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/5 transition-colors"
            title={t("replay.restart")}
          >
            <SkipBack size={16} />
          </button>

          {/* 播放/暂停 */}
          <button
            onClick={player.isPlaying ? player.pause : player.play}
            className="w-10 h-10 flex items-center justify-center rounded-full bg-[var(--color-gold)]/20 text-[var(--color-gold)] hover:bg-[var(--color-gold)]/30 transition-colors"
          >
            {player.isPlaying ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
          </button>

          {/* 进度 */}
          <div className="text-xs text-[var(--text-muted)] ml-2 min-w-[60px] text-right">
            {player.currentEventIndex}/{player.totalEvents}
          </div>
        </div>
      </div>

      {/* 进度条 */}
      <div className="relative z-10 h-1 bg-black/30">
        <motion.div
          className="h-full bg-[var(--color-gold)]/60"
          animate={{ width: `${player.progress * 100}%` }}
          transition={{ duration: 0.2 }}
        />
        <input
          type="range"
          min={0}
          max={player.totalEvents - 1}
          value={player.currentEventIndex}
          onChange={(e) => player.seekTo(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>

      {/* 主内容区 */}
      <div className="relative z-10 flex-1 flex gap-4 lg:gap-6 lg:px-6 lg:py-4 overflow-hidden w-full justify-center min-h-0">
        {/* 左侧玩家卡片 */}
        <div className="hidden md:flex w-[200px] lg:w-[220px] xl:w-[240px] flex-col gap-2 shrink-0 overflow-y-auto scrollbar-hide pt-1 pb-1">
          {leftPlayers.map((p, index) => (
            <PlayerCardCompact
              key={p.playerId}
              player={p}
              isSpeaking={player.gameState.currentSpeakerSeat === p.seat}
              canClick={false}
              isSelected={false}
              onClick={() => {}}
              animationDelay={index * 0.05}
              isNight={visualIsNight}
              isGenshinMode={false}
              humanPlayer={player.humanPlayer}
              seerCheckResult={null}
              isBadgeHolder={player.gameState.badge.holderSeat === p.seat}
              isBadgeCandidate={false}
              showRoleBadge={canShowRole}
              showModel={player.gameState.phase === "GAME_END"}
              selectionTone={undefined}
              isInSelectionPhase={false}
            />
          ))}
        </div>

        {/* 中间对话区 */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full max-w-[900px] overflow-hidden">
          <DialogArea
            gameState={player.gameState}
            humanPlayer={player.humanPlayer}
            isNight={visualIsNight}
            isSoundEnabled={false}
            isAiVoiceEnabled={false}
            currentDialogue={player.currentDialogue}
            displayedText={player.displayedText}
            isTyping={player.isTyping}
            onAdvanceDialogue={player.advanceDialogue}
            isHumanTurn={false}
            waitingForNextRound={false}
            isWaitingForAI={false}
            onRestart={() => router.push("/")}
            onDownloadReplay={handleDownloadReplay}
          />
        </div>

        {/* 右侧玩家卡片 */}
        <div className="hidden md:flex w-[200px] lg:w-[220px] xl:w-[240px] flex-col gap-2 shrink-0 overflow-y-auto scrollbar-hide pt-1 pb-1">
          {rightPlayers.map((p, index) => (
            <PlayerCardCompact
              key={p.playerId}
              player={p}
              isSpeaking={player.gameState.currentSpeakerSeat === p.seat}
              canClick={false}
              isSelected={false}
              onClick={() => {}}
              animationDelay={index * 0.05}
              isNight={visualIsNight}
              isGenshinMode={false}
              humanPlayer={player.humanPlayer}
              seerCheckResult={null}
              isBadgeHolder={player.gameState.badge.holderSeat === p.seat}
              isBadgeCandidate={false}
              showRoleBadge={canShowRole}
              showModel={player.gameState.phase === "GAME_END"}
              selectionTone={undefined}
              isInSelectionPhase={false}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ReplayPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen bg-[var(--bg-main)]">
          <div className="animate-spin w-8 h-8 border-2 border-[var(--color-gold)]/30 border-t-[var(--color-gold)] rounded-full" />
        </div>
      }
    >
      <ReplayContent />
    </Suspense>
  );
}
