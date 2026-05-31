/**
 * 数据迁移工具 — 导出 / 导入自定义角色与对局记录
 *
 * 所有数据均存储在 localStorage 中，key 前缀为 wolfcha_。
 */

const DEV_CHARACTERS_KEY = "wolfcha_dev_custom_characters";
const HISTORY_INDEX_KEY = "wolfcha_game_history_index";
const HISTORY_DATA_PREFIX = "wolfcha_game_history_";
const CHAR_SELECTION_PREFIX = "wolfcha_custom_character_selection";

interface MigrationPayload {
  version: 1;
  exportedAt: string;
  data: Record<string, string>;
}

/** 收集所有 wolfcha_ 开头的 localStorage 数据 */
function collectAllData(): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("wolfcha_")) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** 导出为 JSON 文件并下载 */
export function exportData(): { count: number } {
  const data = collectAllData();
  const payload: MigrationPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data,
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `wolfcha-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}.json`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { count: Object.keys(data).length };
}

/** 从文件内容导入数据 */
export function importData(jsonText: string): { imported: number; skipped: number; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { imported: 0, skipped: 0, error: "文件格式无效，无法解析 JSON" };
  }

  const payload = parsed as Partial<MigrationPayload>;

  // 兼容两种格式：带 version 包装 或 直接的 key-value
  let data: Record<string, string>;
  if (payload.version === 1 && payload.data && typeof payload.data === "object") {
    data = payload.data;
  } else if (typeof payload === "object" && payload !== null) {
    // 尝试当作直接的 key-value 对象
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length === 0) {
      return { imported: 0, skipped: 0, error: "文件中没有可导入的数据" };
    }
    data = {};
    for (const [k, v] of entries) {
      if (typeof v === "string") {
        data[k] = v;
      } else {
        data[k] = JSON.stringify(v);
      }
    }
  } else {
    return { imported: 0, skipped: 0, error: "不支持的文件格式" };
  }

  let imported = 0;
  let skipped = 0;

  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("wolfcha_")) {
      skipped++;
      continue;
    }
    try {
      localStorage.setItem(key, value);
      imported++;
    } catch {
      skipped++;
    }
  }

  return { imported, skipped };
}

/** 获取导出数据的摘要信息 */
export function getDataSummary(): { customCharacters: number; gameHistory: number; other: number } {
  let customCharacters = 0;
  let gameHistory = 0;
  let other = 0;

  // 统计自定义角色
  try {
    const raw = localStorage.getItem(DEV_CHARACTERS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) customCharacters = arr.length;
    }
  } catch { /* ignore */ }

  // 统计对局记录
  try {
    const raw = localStorage.getItem(HISTORY_INDEX_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) gameHistory = arr.length;
    }
  } catch { /* ignore */ }

  // 统计其他 wolfcha_ 数据
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("wolfcha_") && key !== DEV_CHARACTERS_KEY && key !== HISTORY_INDEX_KEY && !key.startsWith(HISTORY_DATA_PREFIX)) {
      other++;
    }
  }

  return { customCharacters, gameHistory, other };
}
