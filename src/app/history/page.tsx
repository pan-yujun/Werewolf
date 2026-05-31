"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Scroll, Trash2, ArrowLeft, Trophy, Clock, Users, ChevronRight } from "lucide-react";
import { getGameHistoryIndex, deleteGameHistory } from "@/lib/game-history-storage";
import { ROLE_NAMES, ROLE_ICONS } from "@/components/analysis/constants";
import type { GameHistoryIndexItem } from "@/types/analysis";
import type { Role } from "@/types/game";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}秒`;
  return `${m}分${s > 0 ? `${s}秒` : ""}`;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function HistoryPage() {
  const router = useRouter();
  const [records, setRecords] = useState<GameHistoryIndexItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setRecords(getGameHistoryIndex());
    setLoaded(true);
  }, []);

  const handleDelete = useCallback((e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    deleteGameHistory(gameId);
    setRecords((prev) => prev.filter((r) => r.gameId !== gameId));
  }, []);

  const handleView = useCallback((gameId: string) => {
    router.push(`/analysis?gameId=${gameId}`);
  }, [router]);

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]" data-theme="dark">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[var(--bg-main)]/90 backdrop-blur-md border-b border-[var(--color-gold)]/20 px-5 py-4 flex items-center gap-4 shadow-lg">
        <button
          onClick={() => router.push("/")}
          className="w-9 h-9 border border-[var(--color-gold)]/30 rounded flex items-center justify-center bg-black/20 hover:bg-white/5 transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-[var(--color-gold)]" />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 border border-[var(--color-gold)]/30 rounded flex items-center justify-center bg-black/20">
            <Scroll className="w-5 h-5 text-[var(--color-gold)]" />
          </div>
          <h1 className="font-bold text-xl text-[var(--color-gold)] tracking-wider drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            对局记录
          </h1>
        </div>
        <div className="ml-auto text-xs text-[var(--color-gold)]/60 tracking-widest border border-[var(--color-gold)]/20 px-2 py-1 rounded">
          {records.length} 局
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 py-8">
        {!loaded ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin w-8 h-8 border-4 border-[var(--color-gold)]/30 border-t-[var(--color-gold)] rounded-full" />
          </div>
        ) : records.length === 0 ? (
          <div className="text-center py-20">
            <Trophy className="w-12 h-12 text-[var(--color-gold)]/20 mx-auto mb-4" />
            <p className="text-[var(--text-secondary)] text-sm">暂无对局记录</p>
            <p className="text-[var(--text-muted)] text-xs mt-1">完成一局游戏后将自动保存</p>
          </div>
        ) : (
          <div className="space-y-3">
            {records.map((record) => {
              const isWin = record.result === "village_win";
              const roleName = ROLE_NAMES[record.humanRole] ?? record.humanRole;
              const roleIcon = ROLE_ICONS[record.humanRole as Role];

              return (
                <div
                  key={record.gameId}
                  onClick={() => handleView(record.gameId)}
                  className="group relative bg-white/5 hover:bg-white/8 border border-white/10 hover:border-[var(--color-gold)]/30 rounded-xl p-4 cursor-pointer transition-all duration-200"
                >
                  <div className="flex items-start gap-4">
                    {/* Role Icon */}
                    <div className="w-12 h-12 rounded-lg bg-black/30 border border-white/10 flex items-center justify-center shrink-0 overflow-hidden">
                      {roleIcon ? (
                        <img src={roleIcon} alt={roleName} className="w-10 h-10 object-contain" />
                      ) : (
                        <span className="text-lg font-bold text-[var(--color-gold)]">{roleName}</span>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded ${
                            isWin
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-red-500/20 text-red-400"
                          }`}
                        >
                          {isWin ? "好人胜" : "狼人胜"}
                        </span>
                        <span className="text-xs text-[var(--text-muted)]">{roleName}</span>
                        {record.tags.length > 0 && (
                          <span className="text-xs text-[var(--color-gold)]/60 bg-[var(--color-gold)]/10 px-1.5 py-0.5 rounded">
                            {record.tags[0]}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-4 text-xs text-[var(--color-gold)]">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(record.timestamp)}
                        </span>
                        <span>{formatDuration(record.duration)}</span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {record.playerCount}人
                        </span>
                        <span className="text-[var(--color-gold)] font-bold">{record.totalScore}分</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={(e) => handleDelete(e, record.gameId)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                        title="删除记录"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--color-gold)] transition-colors" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
