"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Scroll, Trash2, Trophy, Clock, Users, ChevronRight, Play, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";
import { getGameHistoryIndex, deleteGameHistory } from "@/lib/game-history-storage";
import { getReplayIndex, importReplayFromJSON, deleteReplay, type ReplayIndexItem } from "@/lib/game-replay-recorder";
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

interface HistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HistoryDialog({ open, onOpenChange }: HistoryDialogProps) {
  const router = useRouter();
  const t = useTranslations();
  const [historyRecords, setHistoryRecords] = useState<GameHistoryIndexItem[]>([]);
  const [replayOnlyRecords, setReplayOnlyRecords] = useState<ReplayIndexItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [replayGameIds, setReplayGameIds] = useState<Set<string>>(new Set());

  const refreshData = useCallback(() => {
    const history = getGameHistoryIndex();
    const replayIndex = getReplayIndex();
    const replayIds = new Set(replayIndex.map((r) => r.gameId));
    const historyIds = new Set(history.map((r) => r.gameId));
    // 回放-only：有回放数据但没有对局分析记录的
    const replayOnly = replayIndex.filter((r) => !historyIds.has(r.gameId));
    setHistoryRecords(history);
    setReplayOnlyRecords(replayOnly);
    setReplayGameIds(replayIds);
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshData();
    setLoaded(true);
  }, [open, refreshData]);

  const handleDelete = useCallback((e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    deleteGameHistory(gameId);
    deleteReplay(gameId);
    refreshData();
  }, [refreshData]);

  const handleView = useCallback((gameId: string) => {
    onOpenChange(false);
    router.push(`/analysis?gameId=${gameId}`);
  }, [router, onOpenChange]);

  const handleReplay = useCallback((e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    onOpenChange(false);
    router.push(`/replay?gameId=${gameId}`);
  }, [router, onOpenChange]);

  // 导入回放文件
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const handleImportReplay = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const json = reader.result as string;
      const gameId = importReplayFromJSON(json);
      if (gameId) {
        refreshData();
      } else {
        setImportError(t("replay.invalidFile"));
      }
    };
    reader.onerror = () => setImportError(t("replay.parseError"));
    reader.readAsText(file);
    e.target.value = "";
  }, [refreshData, t]);

  // 合并列表：对局记录在前，回放-only 在后
  const totalCount = historyRecords.length + replayOnlyRecords.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scroll size={20} />
            {t("welcome.gameHistory")}
          </DialogTitle>
          <DialogDescription>
            {totalCount > 0 ? t("historyDialog.description", { count: totalCount }) : t("historyDialog.empty")}
          </DialogDescription>
        </DialogHeader>

        {/* 导入回放 */}
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border border-[var(--color-gold)]/30 bg-[var(--color-gold)]/5 text-[var(--color-gold)] hover:bg-[var(--color-gold)]/10 cursor-pointer transition-colors">
            <Upload size={14} />
            {t("replay.importReplay")}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImportReplay}
              className="hidden"
            />
          </label>
          {importError && (
            <span className="text-xs text-red-400">{importError}</span>
          )}
        </div>

        {!loaded ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-6 h-6 border-2 border-[var(--color-gold)]/30 border-t-[var(--color-gold)] rounded-full" />
          </div>
        ) : totalCount === 0 ? (
          <div className="text-center py-12">
            <Trophy className="w-10 h-10 text-[var(--color-gold)]/20 mx-auto mb-3" />
            <p className="text-[var(--text-secondary)] text-sm">{t("historyDialog.empty")}</p>
            <p className="text-[var(--text-muted)] text-xs mt-1">{t("historyDialog.emptyHint")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* 对局分析记录（有完整数据） */}
            {historyRecords.map((record) => {
              const isWin = record.result === "village_win";
              const roleName = ROLE_NAMES[record.humanRole] ?? record.humanRole;
              const roleIcon = ROLE_ICONS[record.humanRole as Role];

              return (
                <div
                  key={record.gameId}
                  onClick={() => handleView(record.gameId)}
                  className="group relative bg-white/5 hover:bg-white/8 border border-white/10 hover:border-[var(--color-gold)]/30 rounded-xl p-3 cursor-pointer transition-all duration-200"
                >
                  <div className="flex items-start gap-3">
                    {/* Role Icon */}
                    <div className="w-10 h-10 rounded-lg bg-black/30 border border-white/10 flex items-center justify-center shrink-0 overflow-hidden">
                      {roleIcon ? (
                        <img src={roleIcon} alt={roleName} className="w-8 h-8 object-contain" />
                      ) : (
                        <span className="text-sm font-bold text-[var(--color-gold)]">{roleName}</span>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                            isWin
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-red-500/20 text-red-400"
                          }`}
                        >
                          {isWin ? t("historyDialog.villageWin") : t("historyDialog.wolfWin")}
                        </span>
                        <span className="text-xs text-[var(--text-muted)]">{roleName}</span>
                        {record.tags.length > 0 && (
                          <span className="text-xs text-[var(--color-gold)]/60 bg-[var(--color-gold)]/10 px-1.5 py-0.5 rounded">
                            {record.tags[0]}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs text-[var(--color-gold)]">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(record.timestamp)}
                        </span>
                        <span>{formatDuration(record.duration)}</span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {record.playerCount}{t("historyDialog.players")}
                        </span>
                        <span className="text-[var(--color-gold)] font-bold">{record.totalScore}{t("historyDialog.points")}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      {replayGameIds.has(record.gameId) && (
                        <button
                          onClick={(e) => handleReplay(e, record.gameId)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--color-gold)] hover:bg-[var(--color-gold)]/10 opacity-0 group-hover:opacity-100 transition-all"
                          title={t("historyDialog.replay")}
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => handleDelete(e, record.gameId)}
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                        title={t("historyDialog.delete")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--color-gold)] transition-colors" />
                    </div>
                  </div>
                </div>
              );
            })}

            {/* 仅有回放数据的记录（导入的回放） */}
            {replayOnlyRecords.map((record) => {
              const isWin = record.result === "village_win";
              const roleName = ROLE_NAMES[record.humanRole] ?? record.humanRole;
              const roleIcon = ROLE_ICONS[record.humanRole as Role];

              return (
                <div
                  key={`replay-${record.gameId}`}
                  onClick={(e) => handleReplay(e, record.gameId)}
                  className="group relative bg-[var(--color-gold)]/5 hover:bg-[var(--color-gold)]/10 border border-[var(--color-gold)]/20 hover:border-[var(--color-gold)]/40 rounded-xl p-3 cursor-pointer transition-all duration-200"
                >
                  <div className="flex items-start gap-3">
                    {/* Role Icon */}
                    <div className="w-10 h-10 rounded-lg bg-black/30 border border-[var(--color-gold)]/20 flex items-center justify-center shrink-0 overflow-hidden">
                      {roleIcon ? (
                        <img src={roleIcon} alt={roleName} className="w-8 h-8 object-contain" />
                      ) : (
                        <span className="text-sm font-bold text-[var(--color-gold)]">{roleName}</span>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                            isWin
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-red-500/20 text-red-400"
                          }`}
                        >
                          {isWin ? t("historyDialog.villageWin") : t("historyDialog.wolfWin")}
                        </span>
                        <span className="text-xs text-[var(--text-muted)]">{roleName}</span>
                        <span className="text-xs text-[var(--color-gold)]/60 bg-[var(--color-gold)]/10 px-1.5 py-0.5 rounded">
                          {t("historyDialog.replayOnly")}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-[var(--color-gold)]">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(record.timestamp)}
                        </span>
                        {record.duration > 0 && <span>{formatDuration(record.duration)}</span>}
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {record.playerCount}{t("historyDialog.players")}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => handleReplay(e, record.gameId)}
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--color-gold)] hover:bg-[var(--color-gold)]/20 transition-all"
                        title={t("historyDialog.replay")}
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, record.gameId)}
                        className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                        title={t("historyDialog.delete")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--color-gold)] transition-colors" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
