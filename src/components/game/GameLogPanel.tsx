/**
 * @file GameLogPanel 游戏日志面板组件
 *
 * 本组件用于展示狼人杀游戏的实时日志信息。日志来源于 gameLogger 单例，
 * 通过 onLogsChange 回调订阅日志变更，实现自动刷新显示。
 *
 * 主要功能：
 * - 实时显示 gameLogger 中的中文游戏日志，按时间顺序排列
 * - 根据日志类别（系统/夜晚/白天/投票/警长/特殊/胜负）以不同颜色高亮
 * - 自动滚动至最新日志条目
 * - 区分普通日志条目与分隔线（章节标题），分别以不同样式渲染
 * - 游戏结束时提供日志下载功能，导出为格式化的 .txt 文本文件
 * - 支持夜间/白天两种视觉主题，通过 isNight 属性切换
 */

"use client";

// React 核心 hooks：useEffect 处理副作用订阅、useRef 引用滚动容器、
// useState 管理日志状态、useCallback 缓存下载回调
import { useEffect, useRef, useState, useCallback } from "react";

// next-intl 国际化 hook，用于获取翻译文本（如标题、按钮文案等）
import { useTranslations } from "next-intl";

// Phosphor 图标库：X 用于关闭按钮、DownloadSimple 用于下载按钮
import { X, DownloadSimple } from "@phosphor-icons/react";

// gameLogger 游戏日志单例，以及日志条目和日志类别的类型定义
import { gameLogger, type LogEntry, type LogCategory } from "@/lib/game-logger";

// cn 工具函数，用于合并 Tailwind CSS 类名（条件拼接）
import { cn } from "@/lib/utils";

/**
 * GameLogPanel 组件的 Props 接口
 * @property isNight - 当前是否为夜晚阶段，控制面板的视觉主题（夜间为深色系）
 * @property isGameEnd - 游戏是否已结束，控制下载按钮的显示（仅游戏结束时可下载）
 * @property onClose - 关闭面板的回调函数，由父组件传入
 */
interface GameLogPanelProps {
  isNight?: boolean;
  isGameEnd?: boolean;
  onClose?: () => void;
}

/**
 * 日志类别与文字颜色的映射表。
 * 每种日志类别对应一个 Tailwind CSS 文字颜色类，用于在日志列表中
 * 以不同颜色区分日志类型，提升可读性：
 * - 系统：次要灰色，用于系统级提示
 * - 夜晚：蓝色，对应夜间阶段的视觉氛围
 * - 白天：琥珀色，对应日间阶段的暖色调
 * - 投票：红色，突出投票行为的紧张感
 * - 警长：黄色，突出警长选举的重要性
 * - 特殊：紫色，标识特殊事件（如猎人开枪、白狼王自爆等）
 * - 胜负：翠绿色，标识游戏结果
 */
const categoryColors: Record<LogCategory, string> = {
  系统: "text-[var(--text-secondary)]",
  夜晚: "text-blue-400",
  白天: "text-amber-400",
  投票: "text-red-400",
  警长: "text-yellow-400",
  特殊: "text-purple-400",
  胜负: "text-emerald-400",
};

/**
 * 将时间戳（毫秒）格式化为 HH:MM:SS 格式的中文时间字符串。
 * 使用 padStart 补零确保时、分、秒均为两位数。
 * @param ts - Unix 时间戳（毫秒）
 * @returns 格式化后的时间字符串，如 "14:05:09"
 */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * 判断一条日志是否为分隔线（章节标题）。
 * 游戏日志中使用 "════" 开头的 Unicode 粗横线字符作为阶段分隔标记，
 * 例如 "════ 夜晚 第1天 ════" 表示夜晚阶段的开始。
 * 分隔线在渲染时会被特殊处理为居中加粗标题，而非普通日志条目。
 * @param entry - 日志条目
 * @returns 如果是分隔线则返回 true
 */
function isSeparator(entry: LogEntry): boolean {
  return entry.message.startsWith("════");
}

/**
 * 将游戏日志导出为纯文本文件并触发浏览器下载。
 *
 * 文件格式说明：
 * - 文件头包含居中的 "狼人杀 · 游戏日志" 标题框
 * - 包含导出时间和日志条数的元信息
 * - 每条日志格式为：[HH:MM:SS] emoji 消息内容
 * - 分隔线条目不加缩进前缀，普通条目加两个空格缩进
 * - 文件尾以 "日志结束" 标记收尾
 *
 * 下载机制：通过 Blob 创建内存中的文本文件，利用动态创建的 <a> 标签
 * 触发浏览器下载，下载完成后清理 DOM 和 Object URL 以释放内存。
 * 文件名格式为 wolfcha-log-{YYYY-MM-DD-HH-mm-ss}.txt。
 *
 * @param logs - 待导出的日志条目数组
 */
function downloadLog(logs: LogEntry[]) {
  const lines = [
    "╔══════════════════════════════════════╗",
    "║        狼人杀 · 游戏日志             ║",
    "╚══════════════════════════════════════╝",
    "",
    `导出时间: ${new Date().toLocaleString("zh-CN")}`,
    `日志条数: ${logs.length}`,
    "",
    "────────────────────────────────────────",
    "",
  ];

  for (const entry of logs) {
    const time = formatTimestamp(entry.timestamp);
    const prefix = isSeparator(entry) ? "" : `  `;
    lines.push(`[${time}] ${prefix}${entry.emoji} ${entry.message}`);
  }

  lines.push("");
  lines.push("────────────────────────────────────────");
  lines.push("日志结束");

  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wolfcha-log-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * GameLogPanel 游戏日志面板组件
 *
 * 整体布局为垂直 flex 容器：
 * - 顶部 Header 区域：显示标题、日志条数、下载按钮（仅游戏结束时）、关闭按钮
 * - 中间日志列表区域：可滚动的日志条目列表，自动滚动至底部
 */
export function GameLogPanel({ isNight, isGameEnd, onClose }: GameLogPanelProps) {
  // 获取国际化翻译函数
  const t = useTranslations();

  // 日志状态：初始化时从 gameLogger 获取已有日志，后续通过订阅实时更新
  const [logs, setLogs] = useState<LogEntry[]>(() => gameLogger.getLogs());

  // 滚动容器的 ref，用于在新日志到达时自动滚动到底部
  const scrollRef = useRef<HTMLDivElement>(null);

  // 订阅 gameLogger 的日志变更事件。
  // 当游戏逻辑产生新日志时，onLogsChange 回调被触发，
  // 通过展开运算符创建新数组引用以确保 React 检测到状态变更并重新渲染。
  // 组件卸载时调用 unsubscribe 清理订阅，防止内存泄漏。
  useEffect(() => {
    const unsubscribe = gameLogger.onLogsChange(() => {
      setLogs([...gameLogger.getLogs()]);
    });
    return unsubscribe;
  }, []);

  // 自动滚动效果：每当 logs 数组更新时，将滚动容器的 scrollTop
  // 设置为 scrollHeight，使最新日志始终可见。
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // 缓存下载回调，仅在 logs 引用变化时重新创建
  const handleDownload = useCallback(() => {
    downloadLog(logs);
  }, [logs]);

  return (
    <div className="flex flex-col h-full">
      {/* ========== 顶部 Header 区域 ========== */}
      {/* 包含：左侧标题+日志条数，右侧下载按钮+关闭按钮 */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        {/* 标题文本：显示"游戏日志"及当前日志总条数 */}
        <span className={cn(
          "text-sm font-semibold",
          isNight ? "text-white/90" : "text-[var(--text-primary)]"
        )}>
          {t("gameLog.title")}
          <span className={cn(
            "ml-2 text-xs font-normal",
            isNight ? "text-white/50" : "text-[var(--text-secondary)]"
          )}>
            {t("gameLog.entryCount", { count: logs.length })}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          {/* 下载按钮：仅在游戏结束且存在日志时显示 */}
          {isGameEnd && logs.length > 0 && (
            <button
              type="button"
              onClick={handleDownload}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium shadow-sm backdrop-blur-sm transition-all",
                isNight
                  ? "border-white/15 bg-black/25 text-white/75 hover:bg-black/35 hover:text-white"
                  : "border-[var(--border-color)] bg-white/75 text-[var(--text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              )}
            >
              <DownloadSimple size={12} />
              <span>{t("gameLog.download")}</span>
            </button>
          )}
          {/* 关闭按钮：调用父组件传入的 onClose 回调 */}
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full transition-all",
              isNight
                ? "text-white/50 hover:bg-white/10 hover:text-white/80"
                : "text-[var(--text-secondary)] hover:bg-black/5 hover:text-[var(--text-primary)]"
            )}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ========== 日志列表区域 ========== */}
      {/* 可滚动容器，通过 ref 绑定实现自动滚动 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 pb-3 scrollbar-hide"
      >
        {logs.length === 0 ? (
          /* 空状态：无日志时显示占位提示文本 */
          <div className={cn(
            "flex items-center justify-center h-full text-sm",
            isNight ? "text-white/40" : "text-[var(--text-secondary)]"
          )}>
            {t("gameLog.empty")}
          </div>
        ) : (
          /* 日志列表：遍历每条日志条目进行渲染 */
          <div className="space-y-0.5">
            {logs.map((entry, index) => {
              if (isSeparator(entry)) {
                /* 分隔线渲染：居中加粗显示，去除 "═" 装饰字符后仅保留文本内容
                   例如 "════ 夜晚 第1天 ════" 渲染为 "夜晚 第1天" */
                return (
                  <div
                    key={index}
                    className={cn(
                      "py-2 text-center text-xs font-bold tracking-wider",
                      isNight ? "text-[var(--color-gold)]/80" : "text-[var(--color-accent)]"
                    )}
                  >
                    {entry.message.replace(/[═]/g, "").trim()}
                  </div>
                );
              }
              /* 普通日志条目渲染：三列布局
                 - 左侧：格式化的时间戳（HH:MM:SS），等宽数字对齐
                 - 中间：日志类别的 emoji 图标
                 - 右侧：日志消息文本，颜色由 categoryColors 映射决定 */
              return (
                <div
                  key={index}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1 text-xs transition-colors",
                    isNight
                      ? "hover:bg-white/5"
                      : "hover:bg-black/[0.03]"
                  )}
                >
                  <span className={cn(
                    "shrink-0 w-14 tabular-nums",
                    isNight ? "text-white/30" : "text-[var(--text-secondary)]/50"
                  )}>
                    {formatTimestamp(entry.timestamp)}
                  </span>
                  <span className="shrink-0 w-4 text-center">{entry.emoji}</span>
                  <span className={cn(
                    "flex-1 leading-relaxed",
                    categoryColors[entry.category] ?? (isNight ? "text-white/80" : "text-[var(--text-primary)]")
                  )}>
                    {entry.message}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
