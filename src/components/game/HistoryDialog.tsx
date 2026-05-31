"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Scroll, Trash2, Trophy, Clock, Users, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";
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

interface HistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HistoryDialog({ open, onOpenChange }: HistoryDialogProps) {
  const router = useRouter();
  const t = useTranslations();
  const [records, setRecords] = useState<GameHistoryIndexItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRecords(getGameHistoryIndex());
    setLoaded(true);
  }, [open]);

  const handleDelete = useCallback((e: React.MouseEvent, gameId: string) => {
    e.stopPropagation();
    deleteGameHistory(gameId);
    setRecords((prev) => prev.filter((r) => r.gameId !== gameId));
  }, []);

  const handleView = useCallback((gameId: string) => {
    onOpenChange(false);
    router.push(`/analysis?gameId=${gameId}`);
  }, [router, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scroll size={20} />
            {t("welcome.gameHistory")}
          </DialogTitle>
          <DialogDescription>
            {records.length > 0 ? t("historyDialog.description", { count: records.length }) : t("historyDialog.empty")}
          </DialogDescription>
        </DialogHeader>

        {!loaded ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-6 h-6 border-2 border-[var(--color-gold)]/30 border-t-[var(--color-gold)] rounded-full" />
          </div>
        ) : records.length === 0 ? (
          <div className="text-center py-12">
            <Trophy className="w-10 h-10 text-[var(--color-gold)]/20 mx-auto mb-3" />
            <p className="text-[var(--text-secondary)] text-sm">{t("historyDialog.empty")}</p>
            <p className="text-[var(--text-muted)] text-xs mt-1">{t("historyDialog.emptyHint")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {records.map((record) => {
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
