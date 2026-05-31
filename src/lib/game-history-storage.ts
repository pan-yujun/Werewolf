/**
 * 对局记录本地存储模块
 *
 * 存储策略：
 *   - wolfcha_game_history_index  → GameHistoryIndexItem[]  轻量索引
 *   - wolfcha_game_history_{id}   → GameAnalysisData        完整数据
 *
 * 最多保留 MAX_HISTORY_COUNT 局，超出时淘汰最旧的。
 */

import type { GameAnalysisData, GameHistoryIndexItem } from "@/types/analysis";

const INDEX_KEY = "wolfcha_game_history_index";
const DATA_PREFIX = "wolfcha_game_history_";
const MAX_HISTORY_COUNT = 20;

// ── SSR 安全 ──────────────────────────────────────────────

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

// ── 索引操作 ──────────────────────────────────────────────

function readIndex(): GameHistoryIndexItem[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(index: GameHistoryIndexItem[]): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // localStorage 满或不可用时静默失败
  }
}

// ── 完整数据操作 ──────────────────────────────────────────

function dataKey(gameId: string): string {
  return `${DATA_PREFIX}${gameId}`;
}

function readData(gameId: string): GameAnalysisData | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(dataKey(gameId));
    if (!raw) return null;
    return JSON.parse(raw) as GameAnalysisData;
  } catch {
    return null;
  }
}

function writeData(gameId: string, data: GameAnalysisData): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(dataKey(gameId), JSON.stringify(data));
  } catch {
    // 静默失败
  }
}

function removeData(gameId: string): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(dataKey(gameId));
  } catch {
    // 静默失败
  }
}

// ── 索引条目构建 ──────────────────────────────────────────

function buildIndexItem(analysis: GameAnalysisData): GameHistoryIndexItem {
  const human = analysis.players.find((p) => p.isHumanPlayer);
  return {
    gameId: analysis.gameId,
    timestamp: analysis.timestamp,
    duration: analysis.duration,
    playerCount: analysis.playerCount,
    result: analysis.result,
    humanRole: human?.role ?? analysis.personalStats.role,
    humanName: human?.name ?? analysis.personalStats.userName,
    totalScore: analysis.personalStats.totalScore,
    tags: analysis.personalStats.tags,
  };
}

// ── 公开 API ──────────────────────────────────────────────

/** 保存一局分析数据到历史记录 */
export function saveGameToHistory(analysis: GameAnalysisData): void {
  const index = readIndex();

  // 如果已存在（同一 gameId），先移除旧条目
  const existingIdx = index.findIndex((item) => item.gameId === analysis.gameId);
  if (existingIdx !== -1) {
    index.splice(existingIdx, 1);
  }

  // 插入到最前面（最新的在前）
  const item = buildIndexItem(analysis);
  index.unshift(item);

  // LRU 淘汰：超出上限时删除最旧的
  while (index.length > MAX_HISTORY_COUNT) {
    const removed = index.pop();
    if (removed) removeData(removed.gameId);
  }

  writeIndex(index);
  writeData(analysis.gameId, analysis);
}

/** 获取所有对局记录索引（按时间倒序） */
export function getGameHistoryIndex(): GameHistoryIndexItem[] {
  return readIndex();
}

/** 根据 gameId 获取完整分析数据 */
export function getGameHistoryById(gameId: string): GameAnalysisData | null {
  return readData(gameId);
}

/** 删除单条对局记录 */
export function deleteGameHistory(gameId: string): void {
  const index = readIndex();
  const filtered = index.filter((item) => item.gameId !== gameId);
  if (filtered.length !== index.length) {
    writeIndex(filtered);
    removeData(gameId);
  }
}

/** 清空所有对局记录 */
export function clearGameHistory(): void {
  const index = readIndex();
  for (const item of index) {
    removeData(item.gameId);
  }
  writeIndex([]);
}
