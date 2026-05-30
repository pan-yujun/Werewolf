"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState, useEffect, useRef } from "react";

interface GameLoadingProgressProps {
  percent: number;
  stage: string;
}

const STAGE_ICONS: Record<string, string> = {
  init: "⚙️",
  scenario: "🎭",
  players: "👥",
  profiles: "📋",
  personas: "🎨",
  roles: "🎲",
  finalizing: "✨",
  complete: "🎉",
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m${secs}s`;
}

export function GameLoadingProgress({ percent, stage }: GameLoadingProgressProps) {
  const t = useTranslations();
  const [elapsed, setElapsed] = useState(0);
  const stageStartTimeRef = useRef<number>(Date.now());
  const prevStageRef = useRef<string>("");

  // 当阶段变化时重置计时器
  useEffect(() => {
    if (stage !== prevStageRef.current) {
      prevStageRef.current = stage;
      stageStartTimeRef.current = Date.now();
      setElapsed(0);
    }
  }, [stage]);

  // 每秒更新耗时
  useEffect(() => {
    if (!stage || percent <= 0 || percent >= 100) return;

    const timer = setInterval(() => {
      const now = Date.now();
      const seconds = Math.floor((now - stageStartTimeRef.current) / 1000);
      setElapsed(seconds);
    }, 1000);

    return () => clearInterval(timer);
  }, [stage, percent]);

  if (!stage || percent <= 0) return null;

  const stageKey = `loadingProgress.stages.${stage}`;
  const stageText = t(stageKey as any);
  const icon = STAGE_ICONS[stage] || "⏳";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="fixed bottom-0 left-0 right-0 z-50 p-4"
    >
      <div className="max-w-md mx-auto">
        <div className="glass-panel rounded-xl p-4 shadow-2xl border border-[var(--border-color)]">
          {/* Stage text and elapsed time */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">{icon}</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {stageText || stage}
            </span>
            <span className="ml-auto text-xs text-[var(--text-muted)]">
              {formatElapsed(elapsed)}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {percent}%
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-2 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{
                background: "linear-gradient(90deg, var(--color-accent), var(--color-gold))",
              }}
              initial={{ width: 0 }}
              animate={{ width: `${percent}%` }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          </div>

          {/* Decorative dots */}
          <div className="flex justify-center gap-1 mt-2">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="w-1 h-1 rounded-full bg-[var(--color-accent)]"
                animate={{
                  scale: [1, 1.5, 1],
                  opacity: [0.5, 1, 0.5],
                }}
                transition={{
                  repeat: Infinity,
                  duration: 1,
                  delay: i * 0.2,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
