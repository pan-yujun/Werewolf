"use client";

import { Sparkle, RefreshCw } from "lucide-react";

interface AnalysisButtonProps {
  label: string;
  loading?: boolean;
  error?: string;
  onClick: () => void;
}

export function AnalysisButton({ label, loading, error, onClick }: AnalysisButtonProps) {
  if (loading) {
    return (
      <button
        disabled
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-gold)]/10 text-[var(--color-gold)]/60 border border-[var(--color-gold)]/20 cursor-wait"
      >
        <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
        {label}中...
      </button>
    );
  }

  if (error) {
    return (
      <button
        onClick={onClick}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        重试 {label}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-gold)]/10 text-[var(--color-gold)] border border-[var(--color-gold)]/20 hover:bg-[var(--color-gold)]/20 hover:border-[var(--color-gold)]/40 transition-colors"
    >
      <Sparkle className="w-3 h-3" />
      {label}
    </button>
  );
}
