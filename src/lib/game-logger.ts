/**
 * game-logger — 游戏流程中文日志工具
 *
 * ## 模块概述
 * 本模块是狼人杀游戏的日志记录系统，采用"控制台输出 + 内存存储 + 订阅通知"三层架构。
 * 所有日志使用中文记录，方便开发调试时追踪游戏流程，同时也供 UI 组件展示和下载。
 *
 * ## 架构设计
 * 1. **控制台输出层**：在非生产环境下，所有日志会输出到浏览器控制台，使用 [游戏] 前缀标识
 * 2. **内存存储层**：所有日志条目存入内存数组 `_logs`，支持通过 `getLogs()` 读取和 `clearLogs()` 清空
 * 3. **订阅通知层**：通过监听器模式（`_listeners` 数组），当日志发生变化时通知所有订阅者，便于 UI 实时更新
 *
 * ## 日志分类体系
 * 系统类：游戏生命周期（开始/重启/阶段转换/检查点恢复）
 * 夜晚类：夜晚行动（守卫/狼人/女巫/预言家/结算）
 * 白天类：白天流程（天亮/发言/遗言）
 * 投票类：投票流程（投票阶段/单票/结果）
 * 警长类：警长竞选（报名/演讲/选举/徽章流转）
 * 特殊类：特殊事件（猎人开枪/白狼王自爆）
 * 胜负类：游戏结果（胜利方/胜因）
 *
 * ## 使用场景
 * - `src/hooks/useGameLogic.ts`：游戏主循环中调用各阶段日志
 * - `src/hooks/game-phases/`：各阶段子 hook 中记录具体行动
 * - UI 组件：通过 `getLogs()` 和 `onLogsChange()` 获取日志用于展示
 * - 下载功能：通过 `getLogs()` 导出完整日志
 */

const PREFIX = "[游戏]";

// ─── 日志条目类型定义 ───────────────────────────────────
// 定义日志的分类枚举和条目结构，用于类型安全的日志记录

/** 日志分类枚举，覆盖游戏所有阶段类型 */
export type LogCategory = "系统" | "夜晚" | "白天" | "投票" | "警长" | "特殊" | "胜负";

/** 单条日志条目的数据结构 */
export interface LogEntry {
  /** 日志记录的时间戳（毫秒） */
  timestamp: number;
  /** 日志条目对应的 emoji 图标，用于 UI 展示时的视觉区分 */
  emoji: string;
  /** 日志所属分类，用于 UI 中的筛选和分组显示 */
  category: LogCategory;
  /** 日志的具体文本内容 */
  message: string;
}

// ─── 内存存储与订阅机制 ───────────────────────────────────────
// 采用发布-订阅模式（Pub-Sub Pattern）实现日志变更通知
// _logs 数组是所有日志的唯一数据源（Single Source of Truth）
// _listeners 数组存储所有订阅者的回调函数，当日志变更时逐一通知

/** 日志存储数组，存储游戏中产生的所有日志条目 */
const _logs: LogEntry[] = [];

/**
 * 订阅者回调函数列表（监听器池）
 * 当日志发生变更（新增或清空）时，会遍历调用所有注册的回调函数
 * 这种模式使得 UI 组件可以在日志更新时自动重新渲染
 */
const _listeners: Array<() => void> = [];

/**
 * 内部方法：向日志数组追加新条目并通知所有订阅者
 * 这是所有日志写入的唯一入口，确保日志变更的一致性和可追溯性
 *
 * @param emoji - 日志条目的 emoji 图标
 * @param category - 日志所属分类
 * @param message - 日志的具体文本内容
 */
function _addEntry(emoji: string, category: LogCategory, message: string) {
  _logs.push({ timestamp: Date.now(), emoji, category, message });
  // 通知所有订阅者：遍历监听器池，调用每个回调函数
  // 这会触发 UI 组件的重新渲染，实现日志的实时展示
  for (const cb of _listeners) cb();
}

/**
 * 检查当前环境是否启用控制台日志输出
 * 仅在非生产环境下启用，避免在生产环境中输出调试信息
 * 如果 `process` 对象不存在（如浏览器环境），默认启用
 *
 * @returns 是否启用控制台输出
 */
function isEnabled(): boolean {
  return typeof process === "undefined" || process.env.NODE_ENV !== "production";
}

/**
 * 格式化座位号为中文显示格式
 * 将内部的 0-based 索引转换为用户友好的 1-based 座位号
 *
 * @param seat - 座位索引（从 0 开始）
 * @returns 格式化后的座位字符串，如 "座位1"
 */
function fmtSeat(seat: number): string {
  return `座位${seat + 1}`;
}

/**
 * 格式化玩家信息为"座位-名称"格式
 * 用于日志中统一展示玩家标识
 *
 * @param seat - 座位索引（从 0 开始）
 * @param name - 玩家名称
 * @returns 格式化后的玩家标识，如 "座位1-张三"
 */
function fmtPlayer(seat: number, name: string): string {
  return `${fmtSeat(seat)}-${name}`;
}

// ─── 游戏日志记录器（公开 API）───────────────────────────────
// 所有游戏日志的记录入口，按功能分组组织方法
// UI 组件通过 getLogs() 和 onLogsChange() 获取和监听日志
// 游戏逻辑通过 flow/phase/nightStart 等方法记录日志

export const gameLogger = {
  // ─── 订阅与读取接口 ──────────────────────────────────
  // 供 UI 组件使用的日志访问接口

  /**
   * 获取所有日志条目（只读访问）
   * 供 UI 组件渲染日志列表、导出日志文件等场景使用
   * 返回的是内部数组的引用，调用者不应修改
   *
   * @returns 包含所有日志条目的数组
   */
  getLogs(): LogEntry[] {
    return _logs;
  },

  /**
   * 清空所有日志条目
   * 在游戏重启时调用，清除上一局游戏的日志记录
   * 清空后会通知所有订阅者，触发 UI 更新
   */
  clearLogs() {
    _logs.length = 0;
    // 通知所有订阅者日志已清空
    for (const cb of _listeners) cb();
  },

  /**
   * 注册日志变更监听器（订阅机制）
   * 当日志发生变化（新增或清空）时，会调用传入的回调函数
   * 返回一个取消订阅的函数，调用后停止接收日志变更通知
   *
   * 使用示例：
   * ```ts
   * const unsubscribe = gameLogger.onLogsChange(() => {
   *   // 重新渲染日志列表
   *   setLogs([...gameLogger.getLogs()]);
   * });
   * // 组件卸载时取消订阅
   * return () => unsubscribe();
   * ```
   *
   * @param callback - 日志变更时调用的回调函数
   * @returns 取消订阅的函数
   */
  onLogsChange(callback: () => void): () => void {
    _listeners.push(callback);
    return () => {
      const idx = _listeners.indexOf(callback);
      if (idx >= 0) _listeners.splice(idx, 1);
    };
  },

  // ─── 系统类日志 ───────────────────────────────────────
  // 记录游戏生命周期相关的系统事件：通用流程、阶段转换、游戏开始/重启等

  /**
   * 记录通用流程日志
   * 用于记录不属于特定阶段的通用游戏流程信息
   *
   * @param message - 日志消息内容
   */
  flow(message: string) {
    _addEntry("📋", "系统", message);
    if (!isEnabled()) return;
    console.log(`${PREFIX} ${message}`);
  },

  /**
   * 记录阶段转换事件
   * 当游戏从一个阶段切换到另一个阶段时调用
   * 在 src/hooks/useGameLogic.ts 的阶段切换逻辑中触发
   *
   * @param from - 源阶段名称
   * @param to - 目标阶段名称
   * @param day - 当前天数（0 表示准备阶段）
   */
  phase(from: string, to: string, day: number) {
    const dayLabel = day > 0 ? `第${day}天` : "准备阶段";
    const msg = `阶段转换 [${dayLabel}]: ${from} → ${to}`;
    _addEntry("🔄", "系统", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🔄 ${msg}`);
  },

  // ─── 夜晚类日志 ───────────────────────────────────────
  // 记录夜晚阶段的所有行动：守卫守护、狼人袭击、女巫用药、预言家查验、夜晚结算
  // 这些方法在 src/hooks/game-phases/ 下的各阶段子 hook 中调用

  /**
   * 记录夜晚开始
   * 在夜晚阶段开始时调用，标记新夜晚的开始
   *
   * @param day - 当前天数
   */
  nightStart(day: number) {
    const msg = `════ 第${day}晚 开始 ════`;
    _addEntry("🌙", "夜晚", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🌙 ${msg}`);
  },

  /**
   * 记录守卫行动
   * 在守卫选择守护目标后调用
   *
   * @param detail - 行动详情，如 "守护了座位3-张三"
   */
  guardAction(detail: string) {
    _addEntry("🛡️", "夜晚", `守卫行动 → ${detail}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🛡️ 守卫行动 → ${detail}`);
  },

  /**
   * 记录狼人行动
   * 在狼人选择袭击目标后调用
   *
   * @param detail - 行动详情，如 "袭击了座位5-李四"
   */
  wolfAction(detail: string) {
    _addEntry("🐺", "夜晚", `狼人行动 → ${detail}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🐺 狼人行动 → ${detail}`);
  },

  /**
   * 记录女巫行动
   * 在女巫使用解药或毒药后调用
   *
   * @param detail - 行动详情，如 "使用解药救活了座位3"
   */
  witchAction(detail: string) {
    _addEntry("🧪", "夜晚", `女巫行动 → ${detail}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🧪 女巫行动 → ${detail}`);
  },

  /**
   * 记录预言家查验
   * 在预言家查验某位玩家身份后调用
   *
   * @param detail - 查验详情，如 "查验座位2-王五 为好人"
   */
  seerAction(detail: string) {
    _addEntry("🔮", "夜晚", `预言家查验 → ${detail}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🔮 预言家查验 → ${detail}`);
  },

  /**
   * 记录夜晚结算结果
   * 在夜晚所有行动处理完毕后调用，汇总本晚的死亡情况
   *
   * @param day - 当前天数
   * @param deaths - 死亡信息，如 "座位3-张三 被狼人袭击" 或 "平安夜"
   */
  nightResolve(day: number, deaths: string) {
    const msg = `夜晚结算 → ${deaths}`;
    _addEntry("🌅", "夜晚", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🌅 ${msg}`);
  },

  // ─── 白天类日志 ───────────────────────────────────────
  // 记录白天阶段的所有事件：天亮公告、发言阶段、玩家发言、遗言

  /**
   * 记录白天开始
   * 在白天阶段开始时调用，包含夜晚死亡公告
   *
   * @param day - 当前天数
   * @param deaths - 夜晚死亡信息，如 "昨晚死亡: 座位3-张三"
   */
  dayStart(day: number, deaths: string) {
    const msg = `════ 第${day}天 开始 ════ ${deaths}`;
    _addEntry("☀️", "白天", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} ☀️ ${msg}`);
  },

  /**
   * 记录发言阶段开始
   * 在发言阶段开始时调用，标注发言顺序
   *
   * @param detail - 发言阶段详情，如 "从座位1开始顺时针发言"
   */
  speechPhase(detail: string) {
    _addEntry("📢", "白天", detail);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 📢 ${detail}`);
  },

  /**
   * 记录单个玩家开始发言
   * 在玩家发言开始时调用，区分人类玩家和 AI 玩家
   *
   * @param seat - 发言玩家的座位索引
   * @param name - 发言玩家的名称
   * @param isHuman - 是否为人类玩家（true 显示 👤人类，false 显示 🤖AI）
   */
  speech(seat: number, name: string, isHuman: boolean) {
    const tag = isHuman ? "👤人类" : "🤖AI";
    const msg = `${tag} ${fmtPlayer(seat, name)} 开始发言`;
    _addEntry("💬", "白天", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 💬 ${msg}`);
  },

  /**
   * 记录玩家发表遗言
   * 在玩家死亡后发表遗言时调用
   *
   * @param seat - 发言玩家的座位索引
   * @param name - 发言玩家的名称
   * @param isHuman - 是否为人类玩家
   */
  lastWords(seat: number, name: string, isHuman: boolean) {
    const tag = isHuman ? "👤人类" : "🤖AI";
    const msg = `${tag} ${fmtPlayer(seat, name)} 发表遗言`;
    _addEntry("💀", "白天", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 💀 ${msg}`);
  },

  // ─── 投票类日志 ───────────────────────────────────────
  // 记录投票阶段的所有事件：投票开始、单票记录、投票结果

  /**
   * 记录投票阶段开始
   * 在投票阶段启动时调用
   *
   * @param detail - 投票阶段详情，如 "开始投票淘汰"
   */
  votePhaseStart(detail: string) {
    _addEntry("🗳️", "投票", `投票阶段开始 → ${detail}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🗳️ 投票阶段开始 → ${detail}`);
  },

  /**
   * 记录单张选票
   * 在每个玩家投票后调用，记录投票人和投票目标
   * 警长投票时会额外标注 1.5 票权
   *
   * @param voterSeat - 投票人座位索引
   * @param voterName - 投票人名称
   * @param targetSeat - 投票目标座位索引
   * @param targetName - 投票目标名称
   * @param isHuman - 投票人是否为人类玩家
   * @param isSheriff - 投票人是否为警长（警长票权为 1.5 票）
   */
  voteCast(voterSeat: number, voterName: string, targetSeat: number, targetName: string, isHuman: boolean, isSheriff: boolean) {
    const tag = isHuman ? "👤人类" : "🤖AI";
    const sheriffTag = isSheriff ? " [警长1.5票]" : "";
    const msg = `${tag} ${fmtPlayer(voterSeat, voterName)} 投票 → ${fmtPlayer(targetSeat, targetName)}${sheriffTag}`;
    _addEntry("🗳️", "投票", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🗳️ ${msg}`);
  },

  /**
   * 记录投票结果
   * 在投票统计完成后调用，包含得票最多的玩家信息
   *
   * @param detail - 投票结果详情，如 "座位3-张三 以4票被淘汰" 或 "平票，无人出局"
   */
  voteResult(detail: string) {
    _addEntry("📊", "投票", `投票结果 → ${detail}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 📊 投票结果 → ${detail}`);
  },

  // ─── 警长竞选类日志 ───────────────────────────────────
  // 记录警长竞选的完整流程：报名、演讲、选举投票、当选、徽章流转

  /**
   * 记录警长竞选报名开始
   * 在警长竞选阶段开始时调用
   *
   * @param day - 当前天数
   */
  badgeSignupStart(day: number) {
    const msg = `警长竞选报名开始 (第${day}天)`;
    _addEntry("⭐", "警长", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} ⭐ ${msg}`);
  },

  /**
   * 记录警长竞选报名结果
   * 在报名阶段结束后调用，汇总报名情况
   *
   * @param detail - 报名结果详情，如 "3人报名: 座位1, 座位3, 座位5" 或 "无人报名，跳过竞选"
   */
  badgeSignupResult(detail: string) {
    _addEntry("⭐", "警长", `报名结果 → ${detail}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} ⭐ 报名结果 → ${detail}`);
  },

  /**
   * 记录警长竞选演讲
   * 在候选人发表竞选演讲时调用
   *
   * @param detail - 演讲详情，如 "座位1-张三 发表竞选演讲"
   */
  badgeSpeech(detail: string) {
    _addEntry("🎤", "警长", detail);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🎤 ${detail}`);
  },

  /**
   * 记录警长选举投票
   * 在玩家对候选人投票后调用
   *
   * @param voterSeat - 投票人座位索引
   * @param voterName - 投票人名称
   * @param candidateSeat - 候选人座位索引
   * @param candidateName - 候选人名称
   * @param isHuman - 投票人是否为人类玩家
   */
  badgeElectionVote(voterSeat: number, voterName: string, candidateSeat: number, candidateName: string, isHuman: boolean) {
    const tag = isHuman ? "👤人类" : "🤖AI";
    const msg = `${tag} ${fmtPlayer(voterSeat, voterName)} 选举投票 → ${fmtPlayer(candidateSeat, candidateName)}`;
    _addEntry("⭐", "警长", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} ⭐ ${msg}`);
  },

  /**
   * 记录警长当选结果
   * 在选举结果确定后调用，记录当选的警长
   *
   * @param seat - 当选警长的座位索引
   * @param name - 当选警长的名称
   */
  badgeElected(seat: number, name: string) {
    const msg = `警长当选 → ${fmtPlayer(seat, name)}`;
    _addEntry("🏅", "警长", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🏅 ${msg}`);
  },

  /**
   * 记录警徽流转（移交或撕毁）
   * 在警长死亡或主动转让警徽时调用
   * 如果 toSeat 为 null，表示警徽被撕毁（不移交给任何人）
   *
   * @param fromSeat - 原警长座位索引
   * @param fromName - 原警长名称
   * @param toSeat - 新警长座位索引（null 表示撕毁警徽）
   * @param toName - 新警长名称（撕毁时为 null）
   */
  badgeTransfer(fromSeat: number, fromName: string, toSeat: number | null, toName: string | null) {
    if (toSeat !== null) {
      const msg = `警徽移交 → ${fmtPlayer(fromSeat, fromName)} → ${fmtPlayer(toSeat, toName || "")}`;
      _addEntry("🏅", "警长", msg);
      if (!isEnabled()) return;
      console.log(`${PREFIX} 🏅 ${msg}`);
    } else {
      const msg = `警徽撕毁 → ${fmtPlayer(fromSeat, fromName)} 撕毁了警徽`;
      _addEntry("🏅", "警长", msg);
      if (!isEnabled()) return;
      console.log(`${PREFIX} 🏅 ${msg}`);
    }
  },

  // ─── 特殊事件类日志 ───────────────────────────────────
  // 记录游戏中的特殊事件：猎人开枪（含选择不开枪）、白狼王自爆（含无目标自爆）

  /**
   * 记录猎人开枪事件
   * 猎人死亡时可以开枪带走一名玩家，也可以选择不开枪
   *
   * @param hunterSeat - 猎人座位索引
   * @param hunterName - 猎人名称
   * @param targetSeat - 射击目标座位索引（null 表示选择不开枪）
   * @param targetName - 射击目标名称（不开枪时为 null）
   */
  hunterShoot(hunterSeat: number, hunterName: string, targetSeat: number | null, targetName: string | null) {
    if (targetSeat !== null) {
      const msg = `猎人开枪 → ${fmtPlayer(hunterSeat, hunterName)} 射杀 ${fmtPlayer(targetSeat, targetName || "")}`;
      _addEntry("🔫", "特殊", msg);
      if (!isEnabled()) return;
      console.log(`${PREFIX} 🔫 ${msg}`);
    } else {
      const msg = `猎人开枪 → ${fmtPlayer(hunterSeat, hunterName)} 选择不开枪`;
      _addEntry("🔫", "特殊", msg);
      if (!isEnabled()) return;
      console.log(`${PREFIX} 🔫 ${msg}`);
    }
  },

  /**
   * 记录白狼王自爆事件
   * 白狼王可以在白天自爆，带走一名玩家（或无目标自爆）
   *
   * @param wwkSeat - 白狼王座位索引
   * @param wwkName - 白狼王名称
   * @param targetSeat - 自爆目标座位索引（null 表示无目标自爆）
   * @param targetName - 自爆目标名称（无目标时为 null）
   */
  whiteWolfKingBoom(wwkSeat: number, wwkName: string, targetSeat: number | null, targetName: string | null) {
    if (targetSeat !== null) {
      const msg = `白狼王自爆 → ${fmtPlayer(wwkSeat, wwkName)} 自爆带走 ${fmtPlayer(targetSeat, targetName || "")}`;
      _addEntry("💥", "特殊", msg);
      if (!isEnabled()) return;
      console.log(`${PREFIX} 💥 ${msg}`);
    } else {
      const msg = `白狼王自爆 → ${fmtPlayer(wwkSeat, wwkName)} 自爆（无目标）`;
      _addEntry("💥", "特殊", msg);
      if (!isEnabled()) return;
      console.log(`${PREFIX} 💥 ${msg}`);
    }
  },

  // ─── 胜负类日志 ───────────────────────────────────────
  // 记录游戏的最终结果：胜利方和胜因

  /**
   * 记录游戏结束和胜利方
   * 当游戏判定出胜负后调用，会同时记录胜利方和胜因两条日志
   *
   * @param winner - 胜利方："village"（村民阵营）或 "wolf"（狼人阵营）
   * @param reason - 胜利原因描述，如 "所有狼人已被淘汰" 或 "狼人数量 >= 好人数量"
   */
  win(winner: "village" | "wolf", reason: string) {
    const emoji = winner === "village" ? "🎉" : "🐺";
    const label = winner === "village" ? "村民阵营胜利" : "狼人阵营胜利";
    _addEntry(emoji, "胜负", `════ 游戏结束 ════ ${label}`);
    _addEntry(emoji, "胜负", `胜因: ${reason}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} ${emoji} ════ 游戏结束 ════ ${label}`);
    console.log(`${PREFIX}    胜因: ${reason}`);
  },

  // ─── 游戏生命周期日志 ───────────────────────────────
  // 记录游戏整体生命周期事件：开始、角色分配、重启、检查点恢复

  /**
   * 记录游戏开始
   * 在新游戏初始化完成后调用
   *
   * @param playerCount - 玩家总人数（包含人类和 AI）
   * @param difficulty - 游戏难度设置
   */
  gameStart(playerCount: number, difficulty: string) {
    const msg = `════ 游戏开始 ════ ${playerCount}人局 难度:${difficulty}`;
    _addEntry("🎮", "系统", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🎮 ${msg}`);
  },

  /**
   * 记录角色分配完成
   * 在所有玩家角色分配完毕后调用
   *
   * @param roles - 角色分配摘要，如 "狼人x3, 预言家x1, 女巫x1, 猎人x1, 守卫x1, 村民x4"
   */
  rolesAssigned(roles: string) {
    _addEntry("🎭", "系统", `角色分配完成: ${roles}`);
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🎭 角色分配完成: ${roles}`);
  },

  /**
   * 记录游戏重启
   * 在玩家选择重新开始游戏时调用，会先清空日志再记录此条
   */
  gameRestart() {
    _addEntry("🔁", "系统", "游戏重启");
    if (!isEnabled()) return;
    console.log(`${PREFIX} 🔁 游戏重启`);
  },

  /**
   * 记录从检查点恢复
   * 当页面刷新后从 localStorage 恢复游戏状态时调用
   *
   * @param phase - 恢复时的阶段名称
   * @param day - 恢复时的天数
   */
  checkpointRestore(phase: string, day: number) {
    const msg = `从检查点恢复 → 阶段:${phase} 天数:${day}`;
    _addEntry("♻️", "系统", msg);
    if (!isEnabled()) return;
    console.log(`${PREFIX} ♻️ ${msg}`);
  },
};

// ─── 工具函数导出 ───────────────────────────────────────
// 导出格式化工具函数，供其他模块复用（如 UI 组件中的座位号显示）

export { fmtSeat, fmtPlayer };
