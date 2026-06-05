"use client";

/**
 * DialogArea - 游戏主对话区域组件
 *
 * 这是游戏交互的核心 UI 组件，负责渲染整个对话界面。布局分为三大区域：
 *
 * 1. 【上方左侧 - 立绘区域】
 *    - 夜晚行动阶段：显示对应职业的角色立绘（狼人、女巫、预言家等），带光晕特效
 *    - 白天发言阶段：显示当前发言者的 TalkingAvatar（带嘴型动画）
 *    - 移动端隐藏，仅在 md 及以上断点显示
 *
 * 2. 【上方右侧 - 聊天历史记录区域】
 *    - 可滚动的消息列表，显示所有玩家对话和系统消息
 *    - 左上角：游戏日志按钮（GameLogPanel）- 显示实时中文游戏进程日志
 *    - 右上角：事件日志按钮（EventLog）- 显示关键事件摘要
 *    - 两个日志均为覆盖层（overlay），打开时隐藏聊天历史
 *    - 底部：新消息未读提示条（仅在用户上滚时出现）
 *
 * 3. 【下方 - 行动面板区域】
 *    - 投票进度条（VotingProgress）
 *    - 狼人协作面板（WolfPlanningPanel）
 *    - 对话气泡（AI 对话内容展示 + 打字机效果）
 *    - 人类输入区（MentionInput + 发送按钮 + 结束发言按钮 + 语音录制）
 *    - 女巫行动面板（救人/毒杀/跳过）
 *    - 警徽竞选报名面板
 *    - 游戏结束画面（角色揭晓 + 下载回放 + 重新开始）
 *    - 夜晚等待动画（AI 行动中的脉冲圆点）
 */

/* =====================================================================
 * 导入区域
 * ===================================================================== */

// React 核心 hooks
import React, { useRef, useEffect, useMemo, useState, useCallback } from "react";
// 动画库：motion 基础动画、AnimatePresence 进出场动画、LayoutGroup 布局动画
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
// Markdown 渲染：用于 AI 对话内容的富文本展示（支持加粗、斜体、列表等）
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// Phosphor 图标库：各类 UI 图标
import { ChatCircleDots, PaperPlaneTilt, CheckCircle, MoonStars, Eye, Drop, Crosshair, Skull, X, ArrowClockwise, CaretRight, UserCircle, Prohibit, ClipboardText, DownloadSimple, Scroll } from "@phosphor-icons/react";
// 自定义扁平图标：狼人、村民、投票等游戏专用图标
import { WerewolfIcon, VillagerIcon, VoteIcon } from "@/components/icons/FlatIcons";
// 游戏子组件
import { VoteResultCard } from "./VoteResultCard";       // 投票结果卡片
import { VotingProgress } from "./VotingProgress";       // 投票进度条
import { WolfPlanningPanel } from "./WolfPlanningPanel"; // 狼人夜晚协作面板
import { MentionInput } from "./MentionInput";           // 支持 @玩家 的输入框
import { TalkingAvatar } from "./TalkingAvatar";         // 带嘴型动画的头像组件
import { VoiceRecorder, type VoiceRecorderHandle } from "./VoiceRecorder"; // 语音录制器
import { EventLog } from "./EventLog";                   // 事件日志面板
import { GameLogPanel } from "./GameLogPanel";           // 游戏进程日志面板（中文实时日志）
// 工具函数：头像 URL 生成、模型 Logo
import { buildSimpleAvatarUrl, getModelLogoUrl } from "@/lib/avatar-config";
// 角色揭晓历史卡片（游戏结束时展示所有玩家的真实角色）
import { RoleRevealHistoryCard, type RoleRevealEntry } from "@/components/game/RoleRevealHistoryCard";
// 等待时的迷你小游戏（空状态展示）
import LoadingMiniGame from "./MiniGame/LoadingMiniGame";
// 游戏类型定义
import type { GameState, Player, ChatMessage, Phase } from "@/types/game";
import { isWolfRole } from "@/types/game"; // 判断是否为狼人阵营角色
// 工具：className 合并、音频管理、国际化
import { cn } from "@/lib/utils";
import { audioManager } from "@/lib/audio-manager";
import { getLocale } from "@/i18n/locale-store";
import { useTranslations } from "next-intl";
// 游戏日志单例及日志条目类型，用于游戏结束时下载日志功能
// gameLogger 是全局唯一的日志记录器，存储了本局游戏的所有流程日志
import { gameLogger, type LogEntry } from "@/lib/game-logger";

/**
 * 女巫行动类型
 * - "save"  : 使用解药救人（救被狼人击杀的玩家）
 * - "poison": 使用毒药毒杀（选择一名玩家毒杀）
 * - "pass"  : 跳过（本回合不使用任何药水）
 */
type WitchActionType = "save" | "poison" | "pass";
import type { DialogueState } from "@/store/game-machine";

const HISTORY_BOTTOM_THRESHOLD = 24;

/* =====================================================================
 * 日志下载工具函数
 *
 * 提供将游戏日志导出为格式化文本文件的功能。
 * 游戏结束时，玩家可点击"下载日志"按钮，将本局游戏的完整流程日志
 * 下载到本地，用于复盘分析或分享。
 *
 * 导出格式：
 * - 文件头：Unicode 装饰框包裹的标题
 * - 元信息：导出时间、日志总条数
 * - 日志正文：每条格式为 [HH:MM:SS] emoji 消息内容
 * - 分隔线条目（章节标题）不加缩进，普通条目加两格缩进
 * ===================================================================== */

/**
 * 将时间戳（毫秒）格式化为 HH:MM:SS 格式的时间字符串
 *
 * @param ts - Unix 时间戳（毫秒），来自 LogEntry.timestamp
 * @returns 格式化后的时间字符串，如 "14:05:09"
 *
 * @example
 * formatLogTimestamp(1717651509000) // "14:05:09"
 */
function formatLogTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * 判断日志条目是否为分隔线（章节标题）
 *
 * 游戏日志中使用 "════" 开头的 Unicode 粗横线字符作为阶段分隔标记，
 * 例如 "════ 夜晚 第1天 ════" 表示夜晚阶段的开始。
 * 分隔线在导出时不加缩进前缀，普通日志条目则加两格缩进。
 *
 * @param entry - 日志条目对象
 * @returns 如果是以 "════" 开头的分隔线则返回 true
 *
 * @example
 * isLogSeparator({ message: "════ 夜晚 第1天 ════", ... }) // true
 * isLogSeparator({ message: "狼人选择击杀 3 号玩家", ... }) // false
 */
function isLogSeparator(entry: LogEntry): boolean {
  return entry.message.startsWith("════");
}

/**
 * 将游戏日志导出为纯文本文件并触发浏览器下载
 *
 * 导出流程：
 * 1. 构建格式化的文本内容（标题框 + 元信息 + 日志正文）
 * 2. 创建 Blob 对象（UTF-8 编码的纯文本）
 * 3. 通过动态创建 <a> 标签触发浏览器下载
 * 4. 清理 DOM 和 Object URL 释放内存
 *
 * 文件命名规则：wolfcha-log-{YYYY-MM-DD-HH-mm-ss}.txt
 * 示例：wolfcha-log-2026-06-06-14-05-09.txt
 *
 * @param logs - 待导出的 LogEntry 数组，来自 gameLogger.getLogs()
 *
 * @example
 * const logs = gameLogger.getLogs();
 * downloadGameLog(logs); // 触发下载 wolfcha-log-xxxx.txt
 */
function downloadGameLog(logs: LogEntry[]) {
  // 构建文本内容：文件头标题框
  const lines = [
    "╔══════════════════════════════════════╗",
    "║        狼人杀 · 游戏日志             ║",
    "╚══════════════════════════════════════╝",
    "",
    // 元信息：导出时间和日志条数
    `导出时间: ${new Date().toLocaleString("zh-CN")}`,
    `日志条数: ${logs.length}`,
    "",
    // 分隔线：区分文件头和日志正文
    "────────────────────────────────────────",
    "",
  ];

  // 遍历日志条目，格式化为可读文本
  for (const entry of logs) {
    const time = formatLogTimestamp(entry.timestamp);
    // 分隔线条目（章节标题）不加缩进，普通条目加两格缩进
    const prefix = isLogSeparator(entry) ? "" : `  `;
    lines.push(`[${time}] ${prefix}${entry.emoji} ${entry.message}`);
  }

  // 文件尾：结束标记
  lines.push("");
  lines.push("────────────────────────────────────────");
  lines.push("日志结束");

  // 创建 Blob 并触发下载
  // 使用 UTF-8 编码确保中文字符正确显示
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  // 动态创建 <a> 标签模拟点击下载
  const a = document.createElement("a");
  a.href = url;
  // 文件名格式：wolfcha-log-{时间戳}.txt
  a.download = `wolfcha-log-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.txt`;
  document.body.appendChild(a);
  a.click();

  // 清理：移除临时 DOM 元素并释放 Object URL
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* =====================================================================
 * 职业立绘相关
 * ===================================================================== */

/** 职业英文名 -> 立绘图片路径的映射表 */
const ROLE_PORTRAIT_MAP: Record<string, string> = {
  Werewolf: '/roles/werewolf.png',
  WhiteWolfKing: '/roles/white-wolf-king.png',
  Seer: '/roles/seer.png',
  Witch: '/roles/witch.png',
  Hunter: '/roles/hunter.png',
  Guard: '/roles/guard.png',
  Idiot: '/roles/idiot.png',
  Villager: '/roles/villager.png',
};

/** 预加载所有职业立绘图片，避免夜晚阶段切换时出现图片加载延迟 */
const ALL_ROLE_PORTRAITS = Object.values(ROLE_PORTRAIT_MAP);
let portraitsPreloaded = false;

function preloadRolePortraits() {
  if (portraitsPreloaded) return;
  portraitsPreloaded = true;
  
  ALL_ROLE_PORTRAITS.forEach((src) => {
    const img = new Image();
    img.src = encodeURI(src);
  });
}

/**
 * 根据当前游戏阶段获取对应的角色标识，用于在立绘区域显示正确的角色立绘。
 * 需要 humanRole 参数来区分狼人和白狼王（两者夜晚行动阶段相同，但立绘不同）。
 */
const getPhaseRole = (phase: Phase, humanRole?: string): string | null => {
  switch (phase) {
    case 'NIGHT_GUARD_ACTION': return 'Guard';
    case 'NIGHT_WOLF_ACTION': return humanRole === 'WhiteWolfKing' ? 'WhiteWolfKing' : 'Werewolf';
    case 'NIGHT_WITCH_ACTION': return 'Witch';
    case 'NIGHT_SEER_ACTION': return 'Seer';
    case 'HUNTER_SHOOT': return 'Hunter';
    case 'WHITE_WOLF_KING_BOOM': return 'WhiteWolfKing';
    default: return null;
  }
};

/** 获取玩家头像 URL，原神模式下非人类玩家使用模型 Logo */
const getPlayerAvatarUrl = (player: Player, isGenshinMode: boolean) =>
  isGenshinMode && !player.isHuman
    ? getModelLogoUrl(player.agentProfile?.modelRef)
    : buildSimpleAvatarUrl(player.avatarSeed ?? player.playerId, { gender: player.agentProfile?.persona?.gender });

function isTurnPromptSystemMessage(content: string, t: ReturnType<typeof useTranslations>) {
  return content.includes(t("dialog.turnToSpeak")) || content.includes(t("dialog.turnToLastWords"));
}

/**
 * 将消息文本中的 "@X号" 或 "X号" 提及模式渲染为带头像的小标签。
 * 匹配到的玩家会显示头像缩略图 + @座位号，未匹配到的仅格式化文本。
 * 夜晚模式使用浅色高亮，白天模式使用强调色。
 */
function renderPlayerMentions(
  text: string,
  players: Player[],
  isNight: boolean = false,
  isGenshinMode: boolean = false
): React.ReactNode {
  // Only match @X号 or X号 pattern, don't consume any text after it
  // This prevents truncating content that follows the mention
  const regex = /@?(\d{1,2})号/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const seatNum = parseInt(match[1], 10);
    const player = players.find(p => p.seat + 1 === seatNum);
    
    // 添加匹配前的文本
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    
    // 添加标签
    if (player) {
      const isPlayerReady = player.isHuman ? !!player.displayName?.trim() : !!player.agentProfile?.persona;
      parts.push(
        <span
          key={`${match.index}-${seatNum}`}
          className={`inline-flex items-center gap-1 mx-0.5 align-baseline text-[0.85em] font-semibold ${
            isNight
              ? "text-[var(--color-accent-light)]"
              : "text-[var(--color-accent)]"
          }`}
        >
          {isPlayerReady ? (
            <img
              src={getPlayerAvatarUrl(player, isGenshinMode)}
              alt={player.displayName}
              className="w-4 h-4 rounded-full"
            />
          ) : (
            <span className="w-4 h-4 rounded-full bg-black/10" aria-hidden="true" />
          )}
          <span className={isNight ? "text-[var(--color-accent-light)]" : "text-[var(--color-accent)]"}>{`@${seatNum}`}</span>
        </span>
      );
    } else {
      // 没找到对应玩家，保持原样但格式化
      parts.push(
        <span
          key={`${match.index}-${seatNum}`}
          className={`inline-flex items-center mx-0.5 align-baseline text-[0.85em] font-semibold ${
            isNight
              ? "text-[var(--color-accent-light)]"
              : "text-[var(--color-accent)]"
          }`}
        >
          {`@${seatNum}`}
        </span>
      );
    }
    
    lastIndex = regex.lastIndex;
  }
  
  // 添加剩余文本
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  
  return parts.length > 0 ? parts : text;
}

/**
 * 流式文本渲染：在打字机效果进行中时使用。
 * 将 *...* 格式渲染为斜体，同时处理 @N号 提及标签。
 * 相比完整 Markdown 渲染，此函数更轻量，适合实时逐字展示场景。
 */
function renderStreamingMarkdown(
  text: string,
  players: Player[],
  isNight: boolean,
  isGenshinMode: boolean
): React.ReactNode {
  const parts = text.split(/\*/);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const segment = renderPlayerMentions(parts[i], players, isNight, isGenshinMode);
    if (i % 2 === 1) {
      out.push(<em key={`em-${i}`}>{segment}</em>);
    } else {
      out.push(<React.Fragment key={`n-${i}`}>{segment}</React.Fragment>);
    }
  }
  return out.length > 0 ? out : text;
}

function renderMentionsInMarkdownChildren(
  children: React.ReactNode,
  players: Player[],
  isNight: boolean,
  isGenshinMode: boolean
) {
  return React.Children.map(children, (child) => {
    if (typeof child === "string") {
      return renderPlayerMentions(child, players, isNight, isGenshinMode);
    }
    return child;
  });
}

/**
 * MentionsMarkdown - 支持 @玩家 提及的 Markdown 渲染组件
 * 完整的 Markdown 渲染（粗体、斜体、链接、列表、代码块等），
 * 同时在文本节点中注入 @玩家 标签高亮。用于静态对话内容展示。
 */
function MentionsMarkdown({
  content,
  players,
  isNight,
  isGenshinMode,
  className,
}: {
  content: string;
  players: Player[];
  isNight: boolean;
  isGenshinMode: boolean;
  className?: string;
}) {
  return (
    <div className={cn("whitespace-pre-wrap break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="m-0">
              {renderMentionsInMarkdownChildren(children, players, isNight, isGenshinMode)}
            </p>
          ),
          em: ({ children }) => (
            <em>
              {renderMentionsInMarkdownChildren(children, players, isNight, isGenshinMode)}
            </em>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">
              {renderMentionsInMarkdownChildren(children, players, isNight, isGenshinMode)}
            </strong>
          ),
          li: ({ children }) => (
            <li>
              {renderMentionsInMarkdownChildren(children, players, isNight, isGenshinMode)}
            </li>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "underline underline-offset-2",
                isNight ? "text-[var(--color-accent-light)]" : "text-[var(--color-accent)]"
              )}
            >
              {renderMentionsInMarkdownChildren(children, players, isNight, isGenshinMode)}
            </a>
          ),
          // Do not inject mentions into code blocks.
          code: ({ children }) => <code className="font-mono">{children}</code>,
          pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * DialogArea 组件的属性接口
 *
 * 属性分为以下几类：
 *
 * 【游戏状态】gameState, humanPlayer, isNight, phase 等核心游戏数据
 * 【对话与打字机】currentDialogue, displayedText, isTyping —— AI 对话的流式展示
 * 【输入相关】inputText, onInputChange, onSendMessage, onFinishSpeaking —— 人类玩家发言输入
 * 【操作回调】onNightAction, onBadgeSignup, onConfirmAction, onCancelSelection 等 —— 夜晚行动、投票、警徽等操作
 * 【游戏结束】onRestart, onDownloadReplay, onViewAnalysis —— 结束后的重开/回放/分析
 * 【日志面板开关】isEventLogOpen, onEventLogOpenChange, isGameLogOpen, onGameLogOpenChange —— 事件日志和游戏日志的显隐控制
 */
interface DialogAreaProps {
  gameState: GameState;
  humanPlayer: Player | null;
  isNight?: boolean;
  isSoundEnabled?: boolean;
  isAiVoiceEnabled?: boolean;
  currentDialogue: DialogueState | null;
  displayedText: string;
  isTyping: boolean;
  showFullHistory?: boolean;
  onAdvanceDialogue?: () => void;
  onAtBottomChange?: (isAtBottom: boolean) => void;
  isHumanTurn?: boolean; // 是否轮到人类发言
  waitingForNextRound?: boolean; // 是否等待下一轮
  tutorialHelpLabel?: string;
  showTutorialHelp?: boolean;
  onTutorialOpen?: () => void;
  // 输入相关
  inputText?: string;
  onInputChange?: (text: string) => void;
  onSendMessage?: () => void;
  onFinishSpeaking?: () => void;
  // 操作相关 (从 BottomActionPanel 合并)
  selectedSeat?: number | null;
  isWaitingForAI?: boolean;
  onConfirmAction?: () => void;
  onCancelSelection?: () => void;
  onNightAction?: (seat: number, actionType?: WitchActionType) => void;
  onBadgeSignup?: (wants: boolean) => void;
  onRestart?: () => void;
  onWhiteWolfKingBoom?: () => void;
  onViewAnalysis?: () => void;
  onDownloadReplay?: () => void;
  isAnalysisLoading?: boolean;
  isEventLogOpen?: boolean;
  onEventLogOpenChange?: (open: boolean) => void;
  isGameLogOpen?: boolean;
  onGameLogOpenChange?: (open: boolean) => void;
}

/**
 * NightActionStatus - 夜晚行动等待状态组件
 *
 * 当 AI 玩家正在执行夜晚行动时（狼人/女巫/预言家/猎人），在对话面板中显示带有
 * 神秘氛围的等待动画：角色专属颜色的脉冲光球 + 状态文字 + 装饰性闪烁星星。
 * 守卫阶段不使用此组件（守卫使用常规对话块）。
 * 当为人类玩家的行动阶段时，显示"请睁眼"而非"正在行动"。
 */
function NightActionStatus({ phase, humanRole }: { phase: string; humanRole?: string }) {
  const t = useTranslations();
  
  // Guard phase: don't show any status animation, let dialogue block handle it
  if (phase === "NIGHT_GUARD_ACTION") {
    return null;
  }

  const getStatusInfo = () => {
    // 如果是人类玩家的回合，显示“请睁眼”；否则显示“正在行动”
    const isMyPhase = 
      (phase === "NIGHT_WOLF_ACTION" && humanRole === "Werewolf") ||
      (phase === "NIGHT_WITCH_ACTION" && humanRole === "Witch") ||
      (phase === "NIGHT_SEER_ACTION" && humanRole === "Seer") ||
      (phase === "HUNTER_SHOOT" && humanRole === "Hunter");
    
    switch (phase) {
      case "NIGHT_WOLF_ACTION":
        return { icon: WerewolfIcon, text: isMyPhase ? t("dialog.nightAction.wolfAwake") : t("dialog.nightAction.wolfActing"), color: "text-red-500" };
      case "NIGHT_WITCH_ACTION":
        return { icon: Drop, text: isMyPhase ? t("dialog.nightAction.witchAwake") : t("dialog.nightAction.witchActing"), color: "text-purple-500" };
      case "NIGHT_SEER_ACTION":
        return { icon: Eye, text: isMyPhase ? t("dialog.nightAction.seerAwake") : t("dialog.nightAction.seerChecking"), color: "text-blue-500" };
      case "HUNTER_SHOOT":
        return { icon: Crosshair, text: isMyPhase ? t("dialog.nightAction.hunterAwake") : t("dialog.nightAction.hunterActing"), color: "text-orange-500" };
      default:
        return { icon: null, text: "", color: "" };
    }
  };

  const { icon: Icon, text, color } = getStatusInfo();

  if (!text) {
    return null;
  }

  return (
    <div className="flex flex-col items-center justify-center py-6">
      {/* 神秘光球效果 */}
      {Icon && (
        <div className="relative mb-4">
          <motion.div
            className={`absolute inset-0 rounded-full blur-xl opacity-30 ${color.replace('text-', 'bg-')}`}
            animate={{ scale: [1, 1.3, 1], opacity: [0.2, 0.4, 0.2] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className={`relative w-16 h-16 rounded-full flex items-center justify-center ${color.replace('text-', 'bg-')}/10 border-2 ${color.replace('text-', 'border-')}/30`}
            animate={{ rotate: [0, 5, -5, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            <Icon size={28} className={color} weight="fill" />
          </motion.div>
        </div>
      )}
      
      {/* 状态文字 */}
      <div className={`flex items-center text-base font-medium ${color}`}>
        <span>{text}</span>
      </div>
      
      {/* 装饰性星星 */}
      <div className="flex gap-3 mt-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            className="w-1 h-1 rounded-full bg-current opacity-30"
            animate={{ opacity: [0.1, 0.5, 0.1], scale: [0.8, 1.2, 0.8] }}
            transition={{ duration: 2, repeat: Infinity, delay: i * 0.3 }}
          />
        ))}
      </div>
    </div>
  );
}

export function DialogArea({
  gameState,
  humanPlayer,
  isNight = false,
  isSoundEnabled = true,
  isAiVoiceEnabled = false,
  currentDialogue,
  displayedText,
  isTyping,
  onAdvanceDialogue,
  onAtBottomChange,
  isHumanTurn = false,
  waitingForNextRound = false,
  tutorialHelpLabel,
  showTutorialHelp = false,
  onTutorialOpen,
  inputText = "",
  onInputChange,
  onSendMessage,
  onFinishSpeaking,
  // 操作相关
  selectedSeat = null,
  isWaitingForAI = false,
  onConfirmAction,
  onCancelSelection,
  onNightAction,
  onBadgeSignup,
  onRestart,
  onWhiteWolfKingBoom,
  onViewAnalysis,
  onDownloadReplay,
  isAnalysisLoading = false,
  isEventLogOpen = false,
  onEventLogOpenChange,
  isGameLogOpen = false,
  onGameLogOpenChange,
}: DialogAreaProps) {
  const t = useTranslations();
  const isGenshinMode = !!gameState.isGenshinMode;
  const phase = gameState.phase;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyContentRef = useRef<HTMLDivElement>(null);
  const lastPortraitPlayerRef = useRef<Player | null>(null);
  const voiceRecorderRef = useRef<VoiceRecorderHandle | null>(null);

  const [talkingPlayerId, setTalkingPlayerId] = useState<string | null>(null);

  // 初始化音频管理器
  useEffect(() => {
    audioManager.setCallbacks(
      (playerId) => setTalkingPlayerId(playerId),
      () => setTalkingPlayerId(null)
    );
    return () => audioManager.clearQueue();
  }, []);

  // TTS playback is now driven entirely by useDayPhase's prefetch path.
  // When a segment's audio is ready, useDayPhase calls addToQueue after prefetch completes.
  // This avoids the previous duplicate request issue (prefetch + DialogArea both hitting /api/tts).

  // 处理跳过/继续：截断语音并进入下一句
  const handleAdvance = useCallback(() => {
    audioManager.stopCurrent();
    onAdvanceDialogue?.();
  }, [onAdvanceDialogue]);

  const handleFinishSpeaking = useCallback(() => {
    if (inputText?.trim()) {
      onSendMessage?.();
    }
    onFinishSpeaking?.();
  }, [inputText, onSendMessage, onFinishSpeaking]);

  // 跳过/继续逻辑由 page.tsx 的全局按键处理负责（同时截断语音）

  // 预加载所有职业立绘
  useEffect(() => {
    preloadRolePortraits();
  }, []);
  
  /* 判断是否需要用户手动点击/按键继续（而非自动过场）
   * 需要手动继续的场景：白天发言阶段、等待下一轮、预言家查验完成后
   * 不需要的场景：AI 正在组织语言/生成语音时 */
  const needsManualContinue = useMemo(() => {
    // 正在组织语言时不需要手动继续
    const dialogueText = currentDialogue?.text || "";
    if (dialogueText.includes(t("dayPhase.organizing")) || dialogueText.includes(t("ui.generatingVoice"))) {
      return false;
    }
    // 发言阶段需要手动继续
    if (["DAY_SPEECH", "DAY_LAST_WORDS", "DAY_BADGE_SPEECH", "DAY_PK_SPEECH"].includes(phase)) {
      return true;
    }
    // 等待下一轮时需要手动继续
    if (waitingForNextRound) {
      return true;
    }
    // 预言家查验完成后需要手动确认（人类是预言家）
    if (phase === "NIGHT_SEER_ACTION" && humanPlayer?.role === "Seer" && gameState.nightActions.seerTarget !== undefined) {
      return true;
    }
    return false;
  }, [phase, waitingForNextRound, humanPlayer?.role, gameState.nightActions.seerTarget, currentDialogue?.text]);

  const visibleMessages = useMemo(() => {
    return gameState.messages.filter(
      (m) => !(m.isSystem && isTurnPromptSystemMessage(m.content, t))
    );
  }, [gameState.messages, t]);

  /* 获取当前发言者信息
   * 优先级：人类轮到发言 > 当前流式对话的说话人 > 最后一条非系统消息的发送者 */
  const currentSpeaker = useMemo(() => {
    if (isHumanTurn && humanPlayer) {
      return {
        player: humanPlayer,
        text: "",
        isStreaming: false,
      };
    }
    if (currentDialogue) {
      const player = gameState.players.find(p => p.displayName === currentDialogue.speaker);
      return {
        player,
        text: currentDialogue.isStreaming ? displayedText : currentDialogue.text,
        isStreaming: true,
      };
    }
    // 找最后一条非系统消息
    const lastMsg = [...visibleMessages].reverse().find(m => !m.isSystem);
    if (lastMsg) {
      const player = gameState.players.find(p => p.playerId === lastMsg.playerId);
      return {
        player,
        text: lastMsg.content,
        isStreaming: false,
      };
    }
    return null;
  }, [isHumanTurn, humanPlayer, currentDialogue, displayedText, visibleMessages, gameState.players]);

  const portraitPlayer = useMemo(() => {
    if (isHumanTurn && humanPlayer) return humanPlayer;
    if (typeof gameState.currentSpeakerSeat === "number") {
      return gameState.players.find((p) => p.seat === gameState.currentSpeakerSeat) || null;
    }
    return currentSpeaker?.player || null;
  }, [isHumanTurn, humanPlayer, gameState.currentSpeakerSeat, gameState.players, currentSpeaker?.player?.playerId]);

  useEffect(() => {
    if (portraitPlayer) lastPortraitPlayerRef.current = portraitPlayer;
  }, [portraitPlayer?.playerId]);

  const stablePortraitPlayer = portraitPlayer || lastPortraitPlayerRef.current;

  /* ================================================================
   * 【左侧立绘区域】
   * 夜晚行动阶段：根据当前阶段显示对应职业的角色立绘（狼人/女巫/预言家等），
   *   带有角色专属颜色的光晕背景特效和模糊进出场动画。
   * 白天发言阶段：显示当前发言玩家的 TalkingAvatar（带嘴型动画），
   *   当音频播放中或打字机效果进行中时嘴巴会动。
   * 无发言者时：夜晚显示月亮图标，白天显示聊天气泡图标。
   * ================================================================ */
  const portraitNode = (
    <AnimatePresence mode="wait" initial={false}>
      {(() => {
        // 夜晚行动阶段：显示对应职业立绘
        const phaseRole = getPhaseRole(phase, humanPlayer?.role);
        const rolePortrait = phaseRole ? encodeURI(ROLE_PORTRAIT_MAP[phaseRole]) : null;

        if (rolePortrait) {
          return (
            <motion.div
              key={`role-portrait-${phaseRole}`}
              initial={{ opacity: 0, filter: "blur(8px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(8px)" }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="relative flex flex-col items-center"
            >
              {/* 光晕效果 - 根据角色调整颜色 */}
              <motion.div 
                className={cn(
                  "absolute bottom-[20%] left-1/2 -translate-x-1/2 w-40 h-40 rounded-full blur-2xl",
                  phaseRole === 'Werewolf' && "bg-gradient-radial from-red-500/30 via-transparent to-transparent",
                  phaseRole === 'WhiteWolfKing' && "bg-gradient-radial from-red-400/30 via-transparent to-transparent",
                  phaseRole === 'Seer' && "bg-gradient-radial from-blue-500/30 via-transparent to-transparent",
                  phaseRole === 'Witch' && "bg-gradient-radial from-purple-500/30 via-transparent to-transparent",
                  phaseRole === 'Guard' && "bg-gradient-radial from-emerald-500/30 via-transparent to-transparent",
                  phaseRole === 'Hunter' && "bg-gradient-radial from-orange-500/30 via-transparent to-transparent",
                )}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.1 }}
              />
              
              {/* 职业立绘 */}
              <img
                src={rolePortrait}
                alt={phaseRole || 'Role'}
                className="relative z-10 w-[220px] lg:w-[260px] xl:w-[300px] h-auto object-contain"
                style={{ willChange: "opacity, transform, filter" }}
              />
            </motion.div>
          );
        }
        
        // 非夜晚行动阶段或白天：显示玩家头像
        if (stablePortraitPlayer) {
          return (
            <motion.div
              key={stablePortraitPlayer.playerId}
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(4px)" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="relative flex flex-col items-center"
            >
              {/* 光晕效果 */}
              <div className="absolute bottom-[20%] left-1/2 -translate-x-1/2 w-40 h-40 bg-gradient-radial from-[var(--color-accent)]/20 via-transparent to-transparent rounded-full blur-2xl" />
              
              {/* 立绘图片 - 只在字幕播放中时有嘴型动画 */}
              <TalkingAvatar
                seed={stablePortraitPlayer.avatarSeed ?? stablePortraitPlayer.playerId}
                gender={stablePortraitPlayer.agentProfile?.persona?.gender}
                modelRef={stablePortraitPlayer.agentProfile?.modelRef}
                useModelLogo={isGenshinMode && !stablePortraitPlayer.isHuman}
                isTalking={talkingPlayerId === stablePortraitPlayer.playerId || (isTyping && !talkingPlayerId)}
                alt={stablePortraitPlayer.displayName}
                className="relative z-10 w-[220px] lg:w-[260px] xl:w-[300px] h-auto object-contain"
                scale={120}
                translateY={-5}
              />
            </motion.div>
          );
        }
        
        return (
          <motion.div
            key="empty-portrait"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.3 }}
            className="flex items-end justify-center h-full pb-6"
          >
            {isNight ? (
              <MoonStars size={64} className="opacity-20 text-[var(--text-primary)]" />
            ) : (
              <ChatCircleDots size={64} className="opacity-15" />
            )}
          </motion.div>
        );
      })()}
    </AnimatePresence>
  );

  /* ================================================================
   * 【智能滚动逻辑】
   * 聊天历史区域的自动滚动管理：
   * - 当用户在底部时：新消息自动滚动到底部（自动跟随）
   * - 当用户手动上滚时：锁定滚动位置，累加未读消息数，显示"新消息"提示
   * - 用户点击"新消息"提示或滚回底部时：解除锁定，恢复自动跟随
   * - 使用 ResizeObserver 监听内容高度变化，确保流式文本也能正确滚动
   * - 区分用户主动滚动和程序自动滚动，避免互相干扰
   * ================================================================ */
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isManualScrollLocked, setIsManualScrollLocked] = useState(false);
  const manualScrollLockRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimeoutRef = useRef<number | null>(null);
  const userInteractionSuppressRef = useRef(false);
  const userInteractionSuppressTimeoutRef = useRef<number | null>(null);
  const userScrolledDuringTypingRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const prevMessageCountRef = useRef(visibleMessages.length);
  const isAutoScrollingRef = useRef(false);

  useEffect(() => {
    if (isTyping) {
      userScrolledDuringTypingRef.current = false;
    }
  }, [isTyping]);

  useEffect(() => {
    onAtBottomChange?.(!isManualScrollLocked);
  }, [isManualScrollLocked, onAtBottomChange]);

  // 滚动到底部（用户主动点击时调用，解除锁定）
  const scrollToBottom = useCallback(() => {
    if (historyRef.current) {
      const container = historyRef.current;
      
      isAutoScrollingRef.current = true;
      manualScrollLockRef.current = false;
      userScrolledDuringTypingRef.current = false;
      setIsManualScrollLocked(false);
      setUnreadCount(0);
      setIsAtBottom(true);
      
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
      
      setTimeout(() => {
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
        isAutoScrollingRef.current = false;
      }, 300);
    }
  }, []);

  // 监听滚动事件
  useEffect(() => {
    const container = historyRef.current;
    if (!container) return;

    lastScrollTopRef.current = container.scrollTop;

    const lockManualScroll = () => {
      manualScrollLockRef.current = true;
      setIsManualScrollLocked(true);

      if (isAutoScrollingRef.current) {
        isAutoScrollingRef.current = false;
      }
    };

    const markUserIntent = (event: Event) => {
      userScrollIntentRef.current = true;
      if (userScrollIntentTimeoutRef.current) {
        window.clearTimeout(userScrollIntentTimeoutRef.current);
      }
      userScrollIntentTimeoutRef.current = window.setTimeout(() => {
        userScrollIntentRef.current = false;
      }, 600);

      if (!(event instanceof WheelEvent)) {
        if (historyRef.current) {
          const distanceToBottom = historyRef.current.scrollHeight - historyRef.current.scrollTop - historyRef.current.clientHeight;
          if (distanceToBottom > HISTORY_BOTTOM_THRESHOLD) {
            userInteractionSuppressRef.current = true;
            if (userInteractionSuppressTimeoutRef.current) {
              window.clearTimeout(userInteractionSuppressTimeoutRef.current);
            }
            userInteractionSuppressTimeoutRef.current = window.setTimeout(() => {
              userInteractionSuppressRef.current = false;
            }, 900);

            lockManualScroll();
            if (isTyping) {
              userScrolledDuringTypingRef.current = true;
            }
          }
        }
        return;
      }

      if (event instanceof WheelEvent) {
        if (event.deltaY < 0) {
          lockManualScroll();
          if (isTyping) {
            userScrolledDuringTypingRef.current = true;
          }
        }
        return;
      }
    };

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceToBottom = Math.max(0, scrollHeight - scrollTop - clientHeight);
      const isNearBottom = distanceToBottom <= HISTORY_BOTTOM_THRESHOLD;
      const prevTop = lastScrollTopRef.current;
      const scrolledUp = scrollTop < prevTop - 0.5;
      lastScrollTopRef.current = scrollTop;

      setIsAtBottom(isNearBottom);

      if (isNearBottom) {
        userScrolledDuringTypingRef.current = false;
        if (manualScrollLockRef.current) {
          manualScrollLockRef.current = false;
          setIsManualScrollLocked(false);
        }
        setUnreadCount(0);
        return;
      }

      if (isAutoScrollingRef.current && !userScrollIntentRef.current) {
        if (!scrolledUp) {
          return;
        }

        lockManualScroll();
      }

      if (scrolledUp) {
        lockManualScroll();
        if (isTyping) {
          userScrolledDuringTypingRef.current = true;
        }
        return;
      }

      if (!manualScrollLockRef.current && userScrollIntentRef.current) {
        manualScrollLockRef.current = true;
        setIsManualScrollLocked(true);
      }
    };

    container.addEventListener("wheel", markUserIntent, { passive: true });
    container.addEventListener("touchstart", markUserIntent, { passive: true });
    container.addEventListener("pointerdown", markUserIntent, { passive: true });
    container.addEventListener("mousedown", markUserIntent, { passive: true });
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserIntent);
      container.removeEventListener("touchstart", markUserIntent);
      container.removeEventListener("pointerdown", markUserIntent);
      container.removeEventListener("mousedown", markUserIntent);
      container.removeEventListener("scroll", handleScroll);
      if (userScrollIntentTimeoutRef.current) {
        window.clearTimeout(userScrollIntentTimeoutRef.current);
      }
      if (userInteractionSuppressTimeoutRef.current) {
        window.clearTimeout(userInteractionSuppressTimeoutRef.current);
      }
    };
  }, [isTyping]);

  useEffect(() => {
    const container = historyRef.current;
    const content = historyContentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;

    let frameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!isAtBottom) return;
      if (manualScrollLockRef.current) return;
      if (userInteractionSuppressRef.current) return;
      if (userScrolledDuringTypingRef.current) return;

      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      frameId = requestAnimationFrame(() => {
        if (!historyRef.current) return;
        isAutoScrollingRef.current = true;
        historyRef.current.scrollTop = historyRef.current.scrollHeight;
        window.setTimeout(() => {
          isAutoScrollingRef.current = false;
        }, 60);
      });
    });

    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [isAtBottom]);

  /* 【新消息处理】当有新消息到来时：
   * - 若当前在底部且无用户交互：自动滚动到底部（自动跟随）
   * - 若已锁定（用户手动上滚过）：累加未读消息计数 */
  useEffect(() => {
    const newCount = visibleMessages.length;
    const prevCount = prevMessageCountRef.current;
    
    if (newCount > prevCount) {
      const addedCount = newCount - prevCount;

      const shouldAutoFollow =
        isAtBottom &&
        !userInteractionSuppressRef.current &&
        !userScrolledDuringTypingRef.current;

      if (shouldAutoFollow) {
        manualScrollLockRef.current = false;
        setIsManualScrollLocked(false);
        setUnreadCount(0);
        // 未锁定，自动滚动到底部
        requestAnimationFrame(() => {
          if (historyRef.current && !userInteractionSuppressRef.current && !userScrolledDuringTypingRef.current) {
            isAutoScrollingRef.current = true;
            historyRef.current.scrollTop = historyRef.current.scrollHeight;
            window.setTimeout(() => {
              isAutoScrollingRef.current = false;
            }, 100);
          }
        });
      } else {
        // 已锁定，累加未读数
        setUnreadCount((prev) => prev + addedCount);
      }
    }
    
    prevMessageCountRef.current = newCount;
  }, [visibleMessages.length, isAtBottom, isManualScrollLocked]);

  // 对话内容更新时也检查是否需要滚动
  useEffect(() => {
    if (isTyping) return;
    if (!isAtBottom) return;
    if (userScrolledDuringTypingRef.current) return;
    if (manualScrollLockRef.current) return;
    if (userInteractionSuppressRef.current) return;
    if (!historyRef.current) return;

    isAutoScrollingRef.current = true;
    historyRef.current.scrollTop = historyRef.current.scrollHeight;
    window.setTimeout(() => {
      isAutoScrollingRef.current = false;
    }, 100);
  }, [isTyping, isAtBottom]);

  /* 【空状态】游戏尚未开始时的等待画面
   * 展示旋转的狼人图标光圈动画 + "召唤中" 文案 + 迷你小游戏 */
  if (gameState.messages.length === 0 && !currentDialogue) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center text-[var(--text-muted)]">
        <div className="relative flex flex-col items-center">
          <div className="relative mb-6">
            <motion.div
              className="absolute inset-0 rounded-full border border-[var(--color-gold)]/20"
              style={{ width: 180, height: 180 }}
              animate={{ rotate: 360 }}
              transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
            />
            <motion.div
              className="absolute inset-5 rounded-full border border-dashed border-[var(--color-blood)]/30"
              animate={{ rotate: -360, opacity: [0.4, 0.8, 0.4] }}
              transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
            />
            <motion.div
              className="absolute inset-10 rounded-full border border-[var(--color-gold)]/20"
              animate={{ scale: [0.96, 1.04, 0.96], opacity: [0.35, 0.7, 0.35] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="relative flex items-center justify-center rounded-full"
              style={{ width: 180, height: 180 }}
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            >
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,rgba(197,160,89,0.12),rgba(0,0,0,0)_70%)]" />
              <WerewolfIcon size={56} className="text-[var(--color-gold)]/60 drop-shadow-[0_0_18px_rgba(197,160,89,0.3)]" />
            </motion.div>
          </div>
          <motion.div
            className="flex flex-col items-center gap-2"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <div className="text-sm font-serif tracking-[0.2em] text-[var(--color-gold)]/80 uppercase">
              {t("dialog.emptyState.summoning")}
            </div>
            <div className="text-base font-semibold text-[var(--text-primary)]/85">
              {t("dialog.emptyState.playersEntering")}
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <motion.span
                className="inline-block w-2 h-2 rounded-full bg-[var(--color-gold)]/60"
                animate={{ scale: [1, 1.4, 1], opacity: [0.4, 0.9, 0.4] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              />
              <span>{t("dialog.emptyState.recruiting")}</span>
            </div>
            <div className="mt-4">
              <LoadingMiniGame />
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  // 获取角色中文名
  const getRoleName = (role?: string) => {
    switch (role) {
      case "Werewolf": return t("roles.werewolf");
      case "WhiteWolfKing": return t("roles.whiteWolfKing");
      case "Seer": return t("roles.seer");
      case "Witch": return t("roles.witch");
      case "Hunter": return t("roles.hunter");
      case "Guard": return t("roles.guard");
      case "Idiot": return t("roles.idiot");
      default: return t("roles.villager");
    }
  };

  /* 计算对话气泡中显示的文本内容
   * 流式模式：使用打字机的 displayedText
   * 静态模式：优先使用 displayedText，其次 currentSpeaker 的文本
   * 警徽选举阶段：如人类已投票，显示"你已经投票给 x 号"替代默认文本 */
  const baseDialogueText = currentDialogue?.isStreaming
    ? displayedText
    : (displayedText || currentSpeaker?.text || "");
  // When human has voted in badge election, show "你已经投票给 x 号" instead of "点击头像投票选警徽"
  const humanBadgeVote = humanPlayer ? gameState.badge.votes[humanPlayer.playerId] : undefined;
  const dialogueText =
    phase === "DAY_BADGE_ELECTION" &&
    humanPlayer &&
    typeof humanBadgeVote === "number" &&
    humanBadgeVote >= 0
      ? (() => {
          const vp = gameState.players.find((p) => p.seat === humanBadgeVote);
          return t("dialog.alreadyVotedFor", { seat: humanBadgeVote + 1, name: vp?.displayName || "" });
        })()
      : baseDialogueText;
  const shouldShowDialogue = waitingForNextRound || dialogueText.trim().length > 0;
  const isNightActionPhase = [
    "NIGHT_GUARD_ACTION",
    "NIGHT_WOLF_ACTION",
    "NIGHT_WITCH_ACTION",
    "NIGHT_SEER_ACTION",
  ].includes(phase);

  /* 【面板显示条件计算】根据当前阶段和玩家状态决定下方行动面板中各子面板的显隐 */
  const showGameEnd = phase === "GAME_END";
  const showBadgeSignup = phase === "DAY_BADGE_SIGNUP"
    && humanPlayer?.alive
    && typeof gameState.badge.signup?.[humanPlayer.playerId] !== "boolean";
  const showBadgeSignupWaiting = phase === "DAY_BADGE_SIGNUP"
    && isWaitingForAI
    && humanPlayer?.alive
    && typeof gameState.badge.signup?.[humanPlayer.playerId] === "boolean";
  const showBadgeTransferOption = phase === "BADGE_TRANSFER"
    && humanPlayer
    && gameState.badge.holderSeat === humanPlayer.seat
    && selectedSeat === null;
  const showHunterPassOption = phase === "HUNTER_SHOOT"
    && humanPlayer?.role === "Hunter"
    && selectedSeat === null;
  const showActionConfirm = (() => {
    const badgeCandidates = gameState.badge.candidates || [];
    const humanIsCandidate = humanPlayer && badgeCandidates.includes(humanPlayer.seat);

    const isCorrectRoleForPhase =
      (phase === "DAY_VOTE" && humanPlayer?.alive) ||
      (phase === "DAY_BADGE_ELECTION" && humanPlayer?.alive && !humanIsCandidate) ||
      (phase === "NIGHT_SEER_ACTION" && humanPlayer?.role === "Seer" && humanPlayer?.alive && gameState.nightActions.seerTarget === undefined) ||
      (phase === "NIGHT_WOLF_ACTION" && humanPlayer && isWolfRole(humanPlayer.role) && humanPlayer.alive) ||
      (phase === "NIGHT_GUARD_ACTION" && humanPlayer?.role === "Guard" && humanPlayer?.alive) ||
      (phase === "HUNTER_SHOOT" && humanPlayer?.role === "Hunter") ||
      (phase === "BADGE_TRANSFER" && humanPlayer && gameState.badge.holderSeat === humanPlayer.seat) ||
      (phase === "WHITE_WOLF_KING_BOOM" && humanPlayer?.role === "WhiteWolfKing" && humanPlayer?.alive && !gameState.roleAbilities.whiteWolfKingBoomUsed);

    return Boolean(
      isCorrectRoleForPhase
        && selectedSeat !== null
        && (phase === "DAY_VOTE" || phase === "DAY_BADGE_ELECTION" || phase === "BADGE_TRANSFER" || !isWaitingForAI)
    );
  })();
  const showWitchPanel = phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && !isWaitingForAI;
  const showHumanInput = isHumanTurn && phase !== "GAME_END" && phase !== "DAY_BADGE_SIGNUP";
  const showDialogueBlock = !isHumanTurn
    && (currentSpeaker || waitingForNextRound)
    && shouldShowDialogue
    && phase !== "GAME_END"
    && selectedSeat === null
    && !(phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && !isWaitingForAI);
  const showNightWaiting = !isHumanTurn
    && !currentSpeaker
    && !waitingForNextRound
    && isNightActionPhase
    && phase !== "GAME_END"
    && selectedSeat === null
    && !(phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && !isWaitingForAI);

  /* 综合判断是否需要显示底部对话面板（任一子面板可见则显示） */
  const shouldShowDialogPanel = showGameEnd
    || showBadgeSignup
    || showBadgeSignupWaiting
    || showBadgeTransferOption
    || showHunterPassOption
    || showActionConfirm
    || showWitchPanel
    || showHumanInput
    || showDialogueBlock
    || showNightWaiting;

  return (
    <div className="wc-dialog-area h-full w-full flex flex-col min-h-0 justify-start">
      {/* ==================== 上方区域：左侧立绘 + 右侧历史记录 ==================== */}
      <div className="flex-1 min-h-0 w-full -mb-1">
        <div className="wc-dialog-main flex gap-4 lg:gap-6 px-4 lg:px-6 pt-0 pb-0 min-h-0 h-full items-stretch">
          {/* --- 左侧立绘区域（仅桌面端显示） --- */}
          <div className="wc-dialog-portrait hidden md:flex w-[220px] lg:w-[260px] xl:w-[300px] shrink-0 flex-col items-center justify-end">
            {portraitNode}
          </div>

          {/* --- 右侧：聊天历史记录区域 --- */}
          <div className="wc-dialog-history flex-1 min-w-0 min-h-0 relative">
            {/* 【游戏日志按钮】左上角，点击切换 GameLogPanel 覆盖层的显示/隐藏 */}
            <div className="absolute left-2 top-2 z-20">
              <button
                type="button"
                onClick={() => onGameLogOpenChange?.(!isGameLogOpen)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium shadow-sm backdrop-blur-sm transition-all",
                  isNight
                    ? "border-white/15 bg-black/25 text-white/75 hover:bg-black/35 hover:text-white"
                    : "border-[var(--border-color)] bg-white/75 text-[var(--text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]",
                  isGameLogOpen && (isNight
                    ? "border-[var(--color-gold)]/40 text-[var(--color-gold)]"
                    : "border-[var(--color-accent)] text-[var(--color-accent)]")
                )}
              >
                <Scroll size={14} />
                <span>{isGameLogOpen ? t("gameLog.backToHistory") : t("gameLog.buttonLabel")}</span>
              </button>
            </div>

            {/* 【事件日志按钮】右上角，点击切换 EventLog 覆盖层的显示/隐藏 */}
            <div className="absolute right-2 top-2 z-20">
              <button
                type="button"
                onClick={() => onEventLogOpenChange?.(!isEventLogOpen)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium shadow-sm backdrop-blur-sm transition-all",
                  isNight
                    ? "border-white/15 bg-black/25 text-white/75 hover:bg-black/35 hover:text-white"
                    : "border-[var(--border-color)] bg-white/75 text-[var(--text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]",
                  isEventLogOpen && (isNight
                    ? "border-[var(--color-gold)]/40 text-[var(--color-gold)]"
                    : "border-[var(--color-accent)] text-[var(--color-accent)]")
                )}
              >
                <ClipboardText size={14} />
                <span>{isEventLogOpen ? t("eventLog.backToHistory") : t("eventLog.shortTitle")}</span>
              </button>
            </div>

            {/* 【聊天消息列表】可滚动区域，展示所有玩家对话和系统消息
                当事件日志或游戏日志打开时，此区域隐藏（opacity-0 + pointer-events-none） */}
            <motion.div
              ref={historyRef}
              className={cn(
                "absolute inset-0 overflow-y-scroll pb-4 pt-10 scrollbar-hide transition-opacity duration-200",
                (isEventLogOpen || isGameLogOpen) && "pointer-events-none opacity-0"
              )}
              style={{
                scrollbarGutter: "stable",
                overflowAnchor: "none",
              }}
              layoutScroll
            >
              <div ref={historyContentRef}>
                <LayoutGroup>
                  <AnimatePresence initial={false}>
                    {visibleMessages.map((msg, index) => {
                      const prevMsg = visibleMessages[index - 1];
                      const showDivider = index > 0 && !msg.isSystem && !prevMsg?.isSystem && prevMsg?.playerId !== msg.playerId;
                      const key = msg.id || `${msg.playerId}:${msg.timestamp}:${index}`;
                      return (
                        <motion.div
                          key={key}
                          layout
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        >
                          <ChatMessageItem 
                            msg={msg} 
                            players={gameState.players}
                            humanPlayerId={humanPlayer?.playerId}
                            showDivider={showDivider}
                            isNight={isNight}
                            isGenshinMode={isGenshinMode}
                          />
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </LayoutGroup>
              </div>
            </motion.div>

            {/* 【EventLog 覆盖层】事件日志面板，打开时覆盖聊天历史，展示关键游戏事件摘要 */}
            <AnimatePresence>
              {isEventLogOpen && (
                <motion.div
                  key="event-log-history-view"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="absolute inset-0 overflow-y-auto px-3 pb-4 pt-12 scrollbar-hide"
                >
                  <EventLog gameState={gameState} />
                </motion.div>
              )}
            </AnimatePresence>

            {/* 【GameLogPanel 覆盖层】游戏进程日志面板，打开时覆盖聊天历史，
                展示实时中文游戏日志（如"夜晚降临"、"X号被击杀"等），与聊天历史互斥 */}
            <AnimatePresence>
              {isGameLogOpen && (
                <motion.div
                  key="game-log-panel-view"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="absolute inset-0 overflow-hidden pt-0 scrollbar-hide"
                >
                  <GameLogPanel
                    isNight={isNight}
                    isGameEnd={gameState.phase === "GAME_END"}
                    onClose={() => onGameLogOpenChange?.(false)}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* 【新消息未读提示】当用户上滚导致有未读消息时，在聊天区域底部显示
                "N 条新消息" 提示条，点击可平滑滚动到底部并解除锁定 */}
            <AnimatePresence>
              {unreadCount > 0 && !isAtBottom && !isEventLogOpen && !isGameLogOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.9 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  className="absolute bottom-3 left-0 right-0 z-10 px-4"
                >
                  <button
                    onClick={scrollToBottom}
                    className="w-full flex items-center gap-3 text-xs font-medium transition-colors"
                    type="button"
                  >
                    <span className={cn(
                      "h-px flex-1",
                      isNight ? "bg-white/15" : "bg-black/10"
                    )} />
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded-full border backdrop-blur-sm",
                        isNight
                          ? "text-white/80 border-white/15 bg-black/30"
                          : "text-[var(--text-secondary)] border-[var(--border-color)] bg-white/70"
                      )}
                    >
                      {t("dialog.newMessages", { count: unreadCount })}
                    </span>
                    <span className={cn(
                      "h-px flex-1",
                      isNight ? "bg-white/15" : "bg-black/10"
                    )} />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ==================== 下方：行动面板区域（固定在底部） ====================
       *  包含以下子面板（根据游戏阶段条件性显示）：
       *  1. 投票进度条 - 白天投票/警徽选举阶段
       *  2. 狼人协作面板 - 夜晚狼人行动阶段（人类为狼人时）
       *  3. 对话气泡面板 - 核心面板，内部根据阶段切换显示不同内容：
       *     - 游戏结束画面（角色揭晓 + 重开/回放/分析按钮）
       *     - 警徽竞选报名
       *     - 警长移交警徽 / 撕毁选项
       *     - 行动确认面板（选中目标后的确认/取消）
       *     - 女巫行动面板（救人/毒杀/跳过）
       *     - 人类发言输入区（MentionInput + 发送 + 结束发言）
       *     - AI 对话展示区（打字机效果 + 点击继续）
       *     - 夜晚等待动画（AI 行动中的脉冲点）
       * ===================================================================== */}
      <div className="wc-dialog-bottom mt-auto shrink-0 px-4 lg:px-6 pb-4 lg:pb-6 pt-0">
        {/* 【投票进度】白天投票或警徽选举阶段显示实时投票进度 */}
        {(gameState.phase === "DAY_VOTE" || gameState.phase === "DAY_BADGE_ELECTION") && (
          <div className="mb-3 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-3">
            <div className="text-sm font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <span className="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-pulse" />
              {gameState.phase === "DAY_BADGE_ELECTION" ? t("dialog.badgeElectionInProgress") : t("dialog.voteInProgress")}
            </div>
            <VotingProgress gameState={gameState} humanPlayer={humanPlayer} />
          </div>
        )}

        {/* 【狼人协作面板】夜晚狼人行动阶段，人类为狼人阵营时显示，用于狼人之间协商击杀目标 */}
        {gameState.phase === "NIGHT_WOLF_ACTION" && humanPlayer && isWolfRole(humanPlayer.role) && (
          <div className="mb-3">
            <WolfPlanningPanel gameState={gameState} humanPlayer={humanPlayer} />
          </div>
        )}

        {/* 对话气泡 - 简化结构，移除嵌套 */}
        <div
          className={cn(
            "wc-panel wc-panel--strong rounded-xl p-5 relative transition-opacity min-h-[160px]",
            shouldShowDialogPanel
              ? "opacity-100"
              : "opacity-0 pointer-events-none bg-transparent border-transparent shadow-none"
          )}
        >
          {showTutorialHelp && tutorialHelpLabel && (
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTutorialOpen?.();
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 p-1 px-2 rounded-full text-xs font-semibold border transition-all",
                  isNight
                    ? "bg-white/10 border-white/15 text-white/80 hover:bg-white/20"
                    : "bg-white border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                )}
              >
                {tutorialHelpLabel}
              </button>
            </div>
          )}
          {shouldShowDialogPanel && (
          <AnimatePresence mode="wait">
              {/* 【游戏结束画面】显示胜负结果、角色揭晓、下载回放按钮和重新开始按钮 */}
              {showGameEnd && (
                <motion.div
                  key="game-end"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="text-xl leading-relaxed text-[var(--text-primary)]">
                    {gameState.winner === "village" ? (
                      <>GG! <span className="text-[var(--color-success)] font-semibold">{t("alignment.village")}</span> {t("gameEnd.wins")}!</>
                    ) : (
                      <>GG! <span className="text-[var(--color-wolf)] font-semibold">{t("alignment.wolf")}</span> {t("gameEnd.wins")}!</>
                    )}
                  </div>
                  <div className={`flex items-center justify-between mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                    <span className="text-xs text-[var(--text-muted)]">{t("dialog.playAgainHint")}</span>
                    <div className="flex items-center gap-2">
                      {/* 下载回放按钮：导出游戏回放 JSON 文件，用于后续回放观看 */}
                      {onDownloadReplay && (
                        <button
                          onClick={onDownloadReplay}
                          className="wc-action-btn text-sm h-9 px-4 flex items-center gap-2"
                          type="button"
                        >
                          <DownloadSimple size={14} weight="bold" />
                          {t("ui.downloadReplay")}
                        </button>
                      )}
                      {/* 下载日志按钮：导出本局游戏的完整流程日志为 .txt 文件
                          日志包含：游戏开始、阶段转换、玩家行动、投票结果等全流程记录
                          点击时从 gameLogger 获取日志，调用 downloadGameLog 触发下载 */}
                      <button
                        onClick={() => {
                          // 从全局日志记录器获取本局游戏的所有日志
                          const logs = gameLogger.getLogs();
                          // 仅在有日志时触发下载（防止空文件）
                          if (logs.length > 0) {
                            downloadGameLog(logs);
                          }
                        }}
                        className="wc-action-btn text-sm h-9 px-4 flex items-center gap-2"
                        type="button"
                      >
                        <Scroll size={14} weight="bold" />
                        {t("ui.downloadLog")}
                      </button>
                      {getLocale() === "zh" && (
                        <button
                          onClick={onViewAnalysis}
                          className="wc-action-btn text-sm h-9 px-4 flex items-center gap-2"
                          type="button"
                        >
                          {isAnalysisLoading && (
                            <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                          )}
                          {t("ui.viewAnalysis")}
                        </button>
                      )}
                      <button
                        onClick={onRestart}
                        className="wc-action-btn wc-action-btn--primary text-sm h-9 px-4"
                        type="button"
                      >
                        <ArrowClockwise size={14} weight="bold" />
                        {t("ui.restart")}
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* 【警徽竞选报名面板】询问人类玩家是否参与警长竞选，提供"参与"和"放弃"两个选项 */}
              {showBadgeSignup && (
                <motion.div
                  key="badge-signup"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                    {t("dialog.badgeSignup.question")}
                  </div>
                  <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                    <button
                      onClick={() => onBadgeSignup?.(false)}
                      className="wc-action-btn text-sm h-9 px-4"
                      type="button"
                    >
                      {t("dialog.badgeSignup.skip")}
                    </button>
                    <button
                      onClick={() => onBadgeSignup?.(true)}
                      className="wc-action-btn wc-action-btn--primary text-sm h-9 px-4"
                      type="button"
                    >
                      {t("dialog.badgeSignup.join")}
                      <CaretRight size={14} weight="bold" />
                    </button>
                  </div>
                </motion.div>
              )}

              {/* 【警徽竞选等待提示】人类已报名，等待其他玩家报名中 */}
              {showBadgeSignupWaiting && (
                <motion.div
                  key="badge-signup-waiting"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                    {t("dialog.badgeSignupWaiting")}
                  </div>
                </motion.div>
              )}
              
              {/* 【警徽移交警徽面板】警长死亡时，选择是否撕毁警徽（不移交给其他人） */}
              {showBadgeTransferOption && (
                <motion.div
                  key="badge-tear-option"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-4"
                >
                  <div className={`text-center p-4 rounded-lg ${isNight ? "bg-yellow-500/10 border border-yellow-500/20" : "bg-yellow-50 border border-yellow-200"}`}>
                    <div className={`text-lg font-medium mb-2 ${isNight ? "text-yellow-300" : "text-yellow-700"}`}>
                      {t("dialog.badgeTransfer.title")}
                    </div>
                    <div className={`text-sm ${isNight ? "text-yellow-200/80" : "text-yellow-600"}`}>
                      {t("dialog.badgeTransfer.description")}
                    </div>
                  </div>
                  
                  <div className={`text-center text-sm ${isNight ? "text-white/60" : "text-gray-500"}`}>
                    {t("dialog.badgeTransfer.hint")}
                  </div>
                  
                  <div className={`flex items-center justify-center pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                    <button
                      onClick={() => onConfirmAction?.()}
                      className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                        isNight 
                          ? "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30" 
                          : "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100"
                      }`}
                      type="button"
                    >
                      <Prohibit size={18} weight="bold" />
                      {t("dialog.badgeTransfer.tear")}
                    </button>
                  </div>
                </motion.div>
              )}

              {/* 行动提示 */}
              {(() => {
                // 警长投票阶段，候选人不参与投票
                const badgeCandidates = gameState.badge.candidates || [];
                const humanIsCandidate = humanPlayer && badgeCandidates.includes(humanPlayer.seat);

                const isCorrectRoleForPhase =
                  (phase === "DAY_VOTE" && humanPlayer?.alive) ||
                  (phase === "DAY_BADGE_ELECTION" && humanPlayer?.alive && !humanIsCandidate) ||
                  (phase === "NIGHT_SEER_ACTION" && humanPlayer?.role === "Seer" && humanPlayer?.alive) ||
                  (phase === "NIGHT_WOLF_ACTION" && humanPlayer && isWolfRole(humanPlayer.role) && humanPlayer.alive) ||
                  (phase === "NIGHT_GUARD_ACTION" && humanPlayer?.role === "Guard" && humanPlayer?.alive) ||
                  (phase === "HUNTER_SHOOT" && humanPlayer?.role === "Hunter") ||
                  (phase === "BADGE_TRANSFER" && humanPlayer && gameState.badge.holderSeat === humanPlayer.seat);

                const shouldShowHint =
                  isCorrectRoleForPhase &&
                  selectedSeat === null &&
                  phase !== "BADGE_TRANSFER" &&
                  (phase === "DAY_VOTE" || phase === "DAY_BADGE_ELECTION" || !isWaitingForAI);

                if (!shouldShowHint) return null;

                return null;
              })()}

              {/* 【行动确认面板】当玩家选中目标座位后显示，根据当前阶段显示不同的行动描述
                  （投票/查验/击杀/守护/射击/移交警徽/自爆），提供取消和确认按钮 */}
              {(() => {
                if (!showActionConfirm || selectedSeat === null) return null;

                const targetPlayer = gameState.players.find(p => p.seat === selectedSeat);
                const targetName = targetPlayer ? t("ui.seatWithName", { seat: selectedSeat + 1, name: targetPlayer.displayName }) : t("ui.seatOnly", { seat: selectedSeat + 1 });

                const actionTextMap: Record<string, string> = {
                  DAY_VOTE: t("dialog.action.vote"),
                  DAY_BADGE_ELECTION: t("dialog.action.badgeVote"),
                  NIGHT_SEER_ACTION: t("dialog.action.seerCheck"),
                  NIGHT_WOLF_ACTION: t("dialog.action.wolfKill"),
                  NIGHT_GUARD_ACTION: t("dialog.action.guardProtect"),
                  HUNTER_SHOOT: t("dialog.action.hunterShoot"),
                  BADGE_TRANSFER: t("dialog.action.badgeTransfer"),
                  WHITE_WOLF_KING_BOOM: t("dialog.action.whiteWolfKingBoom"),
                };

                const actionColorMap: Record<string, string> = {
                  DAY_VOTE: isNight ? "text-[var(--color-accent-light)]" : "text-[var(--color-accent)]",
                  DAY_BADGE_ELECTION: isNight ? "text-[var(--color-accent-light)]" : "text-[var(--color-accent)]",
                  NIGHT_SEER_ACTION: "text-[var(--color-seer)]",
                  NIGHT_WOLF_ACTION: "text-[var(--color-danger)]",
                  NIGHT_GUARD_ACTION: "text-[var(--color-success)]",
                  HUNTER_SHOOT: "text-[var(--color-warning)]",
                  BADGE_TRANSFER: "text-[var(--color-warning)]",
                  WHITE_WOLF_KING_BOOM: "text-[var(--color-danger)]",
                };

                const actionText = actionTextMap[phase] || t("dialog.action.select");
                const actionColor = actionColorMap[phase] || "text-[var(--color-accent)]";

                return (
                  <motion.div
                    key="action-confirm"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                      {t("dialog.actionConfirmQuestion", { action: actionText })} <span className={`font-semibold ${actionColor}`}>{targetName}</span>
                    </div>
                    <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                      <button
                        onClick={onCancelSelection}
                        className="wc-action-btn text-sm h-9 px-4"
                        type="button"
                      >
                        <X size={14} weight="bold" />
                        {t("dialog.cancel")}
                      </button>
                      <button
                        onClick={onConfirmAction}
                        className={`wc-action-btn text-sm h-9 px-4 ${phase.includes("WOLF") || phase === "HUNTER_SHOOT" ? "wc-action-btn--danger" : "wc-action-btn--primary"}`}
                        type="button"
                      >
                        {t("dialog.actionConfirm", { action: actionText })}
                        <CaretRight size={14} weight="bold" />
                      </button>
                    </div>
                  </motion.div>
                );
              })()}

              {/* 【女巫行动面板】夜晚女巫行动阶段，人类为女巫时显示
                  - 未选中目标时：显示"今晚被击杀的是X号"、救人按钮（如解药可用）、毒人提示、跳过按钮
                  - 选中目标后：显示毒杀确认面板（确认/取消）
                  - 解药/毒药已使用时显示相应禁用提示 */}
              {showWitchPanel && (
                selectedSeat !== null ? (
                  <motion.div
                    key="witch-poison-confirm"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    {(() => {
                      if (gameState.roleAbilities.witchPoisonUsed) {
                        return (
                          <>
                            <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                              {t("dialog.witch.poisonUsed")}
                            </div>
                            <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                              <button
                                onClick={onCancelSelection}
                                className="wc-action-btn text-sm h-9 px-4"
                                type="button"
                              >
                                {t("dialog.back")}
                              </button>
                            </div>
                          </>
                        );
                      }
                      const targetPlayer = gameState.players.find(p => p.seat === selectedSeat);
                      const targetName = targetPlayer ? t("ui.seatWithName", { seat: selectedSeat + 1, name: targetPlayer.displayName }) : t("ui.seatOnly", { seat: selectedSeat + 1 });
                      return (
                        <>
                          <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                            {t.rich("dialog.witch.confirmPoisonPrompt", {
                              target: targetName,
                              highlight: (chunks) => (
                                <span className="text-[var(--color-danger)] font-semibold">{chunks}</span>
                              ),
                            })}
                          </div>
                          <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                            <button
                              onClick={() => onCancelSelection?.()}
                              className="wc-action-btn text-sm h-9 px-4"
                              type="button"
                            >
                              <X size={14} weight="bold" />
                              {t("dialog.cancel")}
                            </button>
                            <button
                              onClick={() => onNightAction?.(selectedSeat, "poison")}
                              className="wc-action-btn wc-action-btn--danger text-sm h-9 px-4"
                              type="button"
                            >
                              {t("dialog.confirmPoison")}
                              <CaretRight size={14} weight="bold" />
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </motion.div>
                ) : (
                  <motion.div
                    key="witch-actions"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    {(() => {
                      const wolfTarget = gameState.nightActions.wolfTarget;
                      const targetPlayer = wolfTarget !== undefined ? gameState.players.find(p => p.seat === wolfTarget) : null;
                      const targetName = targetPlayer ? t("ui.seatWithName", { seat: wolfTarget! + 1, name: targetPlayer.displayName }) : wolfTarget !== undefined ? t("ui.seatOnly", { seat: wolfTarget + 1 }) : null;
                      const healUsed = gameState.roleAbilities.witchHealUsed;
                      const poisonUsed = gameState.roleAbilities.witchPoisonUsed;

                      return (
                        <>
                          <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                            {targetName ? (
                              <>
                                {t.rich("dialog.witch.attackedTonight", {
                                  target: targetName,
                                  highlight: (chunks) => (
                                    <span className="text-[var(--color-danger)] font-semibold">{chunks}</span>
                                  ),
                                })}
                                {healUsed ? (
                                  <span className="text-[var(--text-muted)]">{t("dialog.witch.healUsedNote")}</span>
                                ) : (
                                  <>
                                    <span className="mr-2">{t("dialog.witch.youCan")}</span>
                                    <button
                                      onClick={() => onNightAction?.(wolfTarget!, "save")}
                                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-[var(--color-success)] bg-[var(--color-success)]/10 text-[var(--color-success)] font-semibold cursor-pointer hover:bg-[var(--color-success)]/20 active:scale-[0.98] transition-all text-sm"
                                      type="button"
                                    >
                                      {t("dialog.witch.saveAction")}
                                    </button>
                                    <span className="ml-2">{t("dialog.witch.saveSuffix")}</span>
                                  </>
                                )}
                              </>
                            ) : (
                              <>{t("dialog.witch.noAttackTonight")}</>
                            )}
                            {!poisonUsed && <>{t("dialog.witch.poisonHintPrefix")}<span className="text-[var(--color-danger)] font-semibold">{t("dialog.witch.poisonLabel")}</span>{t("dialog.witch.poisonHintSuffix")}</>}
                            {poisonUsed && <span className="text-[var(--text-muted)]">{t("dialog.witch.poisonUsedNote")}</span>}
                          </div>
                          <div className={`flex items-center justify-end mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                            <button
                              onClick={() => onNightAction?.(0, "pass")}
                              className="wc-action-btn text-sm h-9 px-4"
                              type="button"
                            >
                              {t("dialog.witch.doNothing")}
                              <CaretRight size={14} weight="bold" />
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </motion.div>
                )
              )}

              {/* 【人类发言输入区】轮到人类玩家发言时显示
                  - 白狼王自爆按钮（白狼王角色专用，发言阶段可触发自爆）
                  - MentionInput 输入框（支持 @玩家 提及，支持语音录制）
                  - 底部按钮栏：语音录制器、发送消息按钮、结束发言按钮
                  - 结束发言按钮：发送当前输入内容并结束本回合发言 */}
              {showHumanInput && (
                <motion.div
                  key="human-input"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-3"
                >
                  {/* 白狼王自爆按钮 - 在发言阶段显示 */}
                  {humanPlayer?.role === "WhiteWolfKing" && humanPlayer?.alive && !gameState.roleAbilities.whiteWolfKingBoomUsed && ["DAY_SPEECH", "DAY_BADGE_SPEECH", "DAY_PK_SPEECH"].includes(phase) && (
                    <div className="flex justify-end">
                      <button
                        onClick={onWhiteWolfKingBoom}
                        className="h-8 px-3 rounded text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition-all flex items-center gap-1.5 cursor-pointer"
                        type="button"
                      >
                        <Skull size={14} weight="fill" />
                        {t("bottomAction.confirmAction.whiteWolfKingBoomBtn")}
                      </button>
                    </div>
                  )}
                  <div className="wc-input-box relative" style={{ minHeight: "112px", alignItems: "flex-start", padding: "14px 16px 56px" }}>
                    <MentionInput
                      key={`mention-input-${gameState.phase}-${gameState.currentSpeakerSeat}`}
                      value={inputText}
                      onChange={(t) => onInputChange?.(t)}
                      onSend={() => onSendMessage?.()}
                      onFinishSpeaking={onFinishSpeaking}
                      onVoiceHoldPrepare={() => {
                        voiceRecorderRef.current?.prepare();
                      }}
                      onVoiceHoldStart={() => {
                        voiceRecorderRef.current?.start();
                      }}
                      onVoiceHoldEnd={() => {
                        voiceRecorderRef.current?.stop();
                      }}
                      placeholder={gameState.phase === "DAY_LAST_WORDS" ? t("dialog.input.lastWordsPlaceholder") : t("dialog.input.defaultPlaceholder")}
                      isNight={isNight}
                      isGenshinMode={isGenshinMode}
                      players={gameState.players.filter((p) => p.alive)}
                    />
                    
                    {/* 底部按钮栏 - 在输入框内部右下角 */}
                    <div className="absolute bottom-3 right-3 flex items-center gap-2">
                      <VoiceRecorder
                        ref={voiceRecorderRef}
                        disabled={!isHumanTurn}
                        isNight={isNight}
                        onTranscript={(text) => {
                          const prev = String(inputText || "");
                          const next = prev.trim().length > 0 ? `${prev.trim()} ${text}` : text;
                          onInputChange?.(next);
                        }}
                      />

                      <button
                        onClick={onSendMessage}
                        disabled={!inputText?.trim()}
                        className="h-8 px-3 rounded text-xs font-medium bg-[var(--color-gold)] text-[#1a1614] hover:bg-[#d4b06a] disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5 cursor-pointer"
                        title={t("dialog.input.send")}
                      >
                        <PaperPlaneTilt size={14} weight="fill" />
                        {t("dialog.input.send")}
                      </button>

                      <button
                        onClick={handleFinishSpeaking}
                        className="h-8 px-3 rounded text-xs font-medium border border-[var(--color-gold)]/50 text-[var(--color-gold)] bg-transparent hover:bg-[var(--color-gold)]/10 transition-all flex items-center gap-1.5 cursor-pointer"
                        title={t("dialog.input.finishSpeech")}
                      >
                        <CheckCircle size={14} weight="fill" />
                        {t("dialog.input.finishSpeech")}
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* 【AI 对话展示区】展示 AI 玩家或系统的对话内容
                  - 顶部：发言者名称（移动端内联显示头像+名称，桌面端仅显示名称）
                  - 中间：对话内容（流式打字机效果时用 renderStreamingMarkdown 渲染，
                    静态时用 MentionsMarkdown 完整 Markdown 渲染，均支持 @玩家 标签高亮）
                  - 底部信息栏：打字状态指示、猎人跳过射击按钮、"按 Enter 继续" 提示
                  - 点击整个区域可触发 handleAdvance（停止语音 + 跳到下一句） */}
              {showDialogueBlock && (
                <motion.div
                  key={`dialogue-${currentSpeaker?.player?.playerId || 'waiting'}-${gameState.currentSpeakerSeat ?? 'none'}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="cursor-pointer flex flex-col min-h-0 h-full"
                  onClick={handleAdvance}
                >
                    {currentSpeaker?.player && (
                      <>
                        <div className="md:hidden flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 bg-black/10">
                            <img
                              src={getPlayerAvatarUrl(currentSpeaker.player, isGenshinMode)}
                              alt={currentSpeaker.player.displayName}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <div className="text-sm font-semibold text-[var(--color-gold)]">
                            {currentSpeaker.player.displayName}
                          </div>
                        </div>
                        <div className="hidden md:block text-base font-bold text-[var(--color-gold)] mb-2 font-serif tracking-wide">
                          {currentSpeaker.player.displayName}
                        </div>
                      </>
                    )}
                    
                    {/* 对话内容 - 带玩家标签，逐字输入效果，文字调大；流式时也用 * 渲染斜体 */}
                    <div className="text-xl leading-relaxed text-[var(--text-primary)] flex-1 pr-1 whitespace-pre-wrap break-words overflow-y-auto" style={{ maxHeight: "50vh" }}>
                      {isTyping ? (
                        renderStreamingMarkdown(
                          waitingForNextRound ? t("dialog.nextRoundHint") : dialogueText,
                          gameState.players,
                          isNight,
                          isGenshinMode
                        )
                      ) : (
                        <MentionsMarkdown
                          content={waitingForNextRound ? t("dialog.nextRoundHint") : dialogueText}
                          players={gameState.players}
                          isNight={isNight}
                          isGenshinMode={isGenshinMode}
                        />
                      )}
                      {isTyping && <span className="wc-typing-cursor"></span>}
                    </div>
                  
                  {/* 底部信息栏 */}
                  <div className={`flex items-center justify-between mt-4 pt-3 border-t min-h-7 ${isNight ? "border-white/10" : "border-black/5"}`}> 
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      {isTyping ? (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          <span>{t("dialog.speaking")}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-end gap-3">
                      {showHunterPassOption && !isTyping && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onConfirmAction?.();
                          }}
                          className="wc-action-btn wc-action-btn--danger text-sm h-9 px-4"
                          type="button"
                        >
                          {t("dialog.hunter.skipShoot" as any)}
                          <CaretRight size={14} weight="bold" />
                        </button>
                      )}

                      <div className="h-7 flex items-center justify-end">
                      <AnimatePresence initial={false}>
                        {!isTyping && needsManualContinue ? (
                          <motion.div
                            key="enter-hint"
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 10 }}
                            transition={{ duration: 0.25, ease: "easeOut" }}
                            className={`flex items-center gap-1.5 text-xs ${isNight ? "text-white/70" : "text-[var(--text-secondary)]"}`}
                          >
                            <span>{t("dialog.advanceHintPrefix")}</span>
                            <kbd className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[11px] ${
                              isNight
                                ? "bg-white/10 border-white/20 text-white/80"
                                : "bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-primary)]"
                            }`}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 10 4 15 9 20" />
                                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                              </svg>
                              Enter
                            </kbd>
                            <span>{t("dialog.advanceHintSuffix")}</span>
                          </motion.div>
                        ) : (
                          <div key="placeholder" className="h-7" />
                        )}
                      </AnimatePresence>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* 【夜晚等待动画】当 AI 玩家正在执行夜晚行动（狼人/女巫/预言家/守卫）时显示
                  使用 NightActionStatus 组件，带有神秘光球脉冲动画和角色图标。
                  当人类玩家的行动阶段时不显示（由对应行动面板替代） */}
              {showNightWaiting && (
                <motion.div
                  key="night-waiting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <NightActionStatus phase={gameState.phase} humanRole={humanPlayer?.role} />
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ChatMessageItem - 聊天消息条目组件
 *
 * 渲染单条聊天消息，根据消息类型分为三种展示模式：
 * 1. 系统消息 - [ROLE_REVEAL] 前缀：渲染 RoleRevealHistoryCard（角色揭晓卡片）
 * 2. 系统消息 - [VOTE_RESULT] 前缀：渲染 VoteResultCard（投票结果卡片）
 * 3. 普通系统消息：居中显示，小字灰色
 * 4. 玩家消息：带头像、玩家名称、对话内容（Markdown 渲染 + @玩家标签高亮）
 *    - 人类玩家消息右对齐，AI 玩家消息左对齐
 *    - 同一玩家连续发言不重复显示头像（通过 showDivider 控制）
 */
function ChatMessageItem({
  msg, 
  players, 
  humanPlayerId,
  showDivider = false,
  isNight = false,
  isGenshinMode = false,
}: { 
  msg: ChatMessage; 
  players: Player[];
  humanPlayerId?: string;
  showDivider?: boolean;
  isNight?: boolean;
  isGenshinMode?: boolean;
}) {
  const t = useTranslations();
  const player = players.find(p => p.playerId === msg.playerId);
  const isHuman = msg.playerId === humanPlayerId;
  const isPlayerReady = player ? (player.isHuman ? !!player.displayName?.trim() : !!player.agentProfile?.persona) : false;
  const isSystem = msg.isSystem;

  if (isSystem) {
    // 检查是否是身份揭晓消息
    if (msg.content.startsWith('[ROLE_REVEAL]')) {
      try {
        const jsonData = msg.content.substring('[ROLE_REVEAL]'.length);
        const revealData = JSON.parse(jsonData) as { title?: string; players?: RoleRevealEntry[] };
        const entries = Array.isArray(revealData.players) && revealData.players.length > 0
          ? revealData.players
          : players
              .slice()
              .sort((a, b) => a.seat - b.seat)
              .map((p) => ({
                playerId: p.playerId,
                seat: p.seat,
                name: p.displayName,
                role: p.role,
                isHuman: p.isHuman,
                modelRef: p.agentProfile?.modelRef,
              }));
        return (
          <RoleRevealHistoryCard
            title={revealData.title || t("specialEvents.roleRevealTitle")}
            entries={entries}
            players={players}
            isNight={isNight}
            isGenshinMode={isGenshinMode}
          />
        );
      } catch (e) {
        console.error('Failed to parse role reveal:', e);
      }
    }
    // 检查是否是投票结果消息
    if (msg.content.startsWith('[VOTE_RESULT]')) {
      try {
        const jsonData = msg.content.substring('[VOTE_RESULT]'.length);
        const voteData = JSON.parse(jsonData) as {
          title?: string;
          results?: Array<{
            targetSeat: number;
            targetName: string;
            voterSeats: number[];
            voteCount: number;
          }>;
        };
        if (voteData.results && voteData.results.length > 0) {
          return (
            <VoteResultCard
              title={voteData.title || t("votePhase.voteDetailTitle")}
              results={voteData.results}
              players={players}
              isNight={isNight}
              isGenshinMode={isGenshinMode}
            />
          );
        }
      } catch (e) {
        console.error('Failed to parse vote result:', e);
      }
      return null;
    }
    
    return (
      <div className="flex justify-center my-3">
        <div className="text-xs text-center py-2 px-4 rounded-lg border text-[var(--text-secondary)] bg-[var(--glass-bg-weak)] border-[var(--glass-border)]">
          <MentionsMarkdown
            content={msg.content}
            players={players}
            isNight={isNight}
            isGenshinMode={isGenshinMode}
            className="text-center"
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {/* 不同用户之间的分割线 */}
      {showDivider && (
        <div className={cn(
          "my-4 border-t",
          isNight ? "border-white/10" : "border-black/8"
        )} />
      )}
      <div className={cn(
        "wc-history-item flex items-start gap-3",
        isHuman ? "wc-history-item--highlight flex-row-reverse" : "",
        showDivider ? "mt-3" : "mt-2"
      )}>
        <div className={cn(
          "w-8 h-8 rounded-full overflow-hidden shrink-0 border shadow-sm",
          isNight ? "border-white/20" : "border-[var(--border-color)]"
        )}>
          {player && isPlayerReady ? (
            <img
              src={getPlayerAvatarUrl(player, isGenshinMode)}
              alt={msg.playerName}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-black/10" aria-hidden="true" />
          )}
        </div>
        
        <div className={cn(
          "min-w-0 max-w-[80%] w-fit text-left",
          isHuman ? "mr-0" : "ml-0"
        )}>
          <div className={cn("flex items-center gap-2 mb-1 text-xs opacity-70")}>
            {player && (
              <span className="wc-seat-badge">
                {t("ui.seatOnly", { seat: player.seat + 1 })}
              </span>
            )}
            <span className="font-serif font-bold text-[var(--text-primary)]">{msg.playerName}</span>
          </div>
          
          <div className="text-base leading-relaxed text-[var(--text-primary)] text-left">
            <MentionsMarkdown
              content={msg.content}
              players={players}
              isNight={isNight}
              isGenshinMode={isGenshinMode}
            />
          </div>
        </div>
      </div>
    </>
  );
}
