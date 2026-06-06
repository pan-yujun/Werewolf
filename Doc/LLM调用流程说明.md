# LLM 调用流程说明

本文档详细记录了 Wolfcha（AI 狼人杀）游戏中所有需要 LLM 参与的场景，包括每个场景的触发时机、输入输出、所在文件和函数。

---

## 目录

1. [基础设施层](#一基础设施层)
2. [游戏前准备阶段](#二游戏前准备阶段)
3. [夜晚阶段](#三夜晚阶段)
4. [白天阶段](#四白天阶段)
5. [特殊事件阶段](#五特殊事件阶段)
6. [游戏结算与复盘阶段](#六游戏结算与复盘阶段)
7. [提示词构建架构](#七提示词构建架构)
8. [调用量估算](#八调用量估算)

---

## 一、基础设施层

### 1.1 LLM 调用入口

**文件**: `src/lib/llm.ts`

提供三种核心调用方式，所有上层场景均通过此层调用 LLM：

| 函数名 | 用途 | 返回类型 |
|--------|------|----------|
| `generateCompletion()` | 非流式单次调用，用于结构化决策（投票、技能、总结等） | `{content, reasoning_details, raw}` |
| `generateCompletionStream()` | 流式调用，用于 AI 发言（逐字输出到 UI） | `AsyncGenerator<string>` |
| `generateJSON<T>()` | 在 `generateCompletion` 之上加 JSON 格式约束 + 容错解析 | `T` |
| `generateCompletionBatch()` | 批量调用（已定义但当前未被主要流程使用） | `BatchCompletionResult[]` |

**调用链路**:
```
上层函数 → generateCompletion/generateCompletionStream/generateJSON
         → fetchWithRetry()（带重试的 HTTP 请求）
         → POST /api/chat（服务端代理路由）
         → ZenMux / Dashscope / Mimo / Modelscope（实际 LLM Provider）
```

### 1.2 AI 温度配置

**文件**: `src/lib/ai-config.ts`

| 场景 | 温度值 | 常量名 | 说明 |
|------|--------|--------|------|
| 角色生成 | 1.2 | `AI_TEMPERATURE.WILD` | 追求极度多样性和创意 |
| 玩家发言 | 1.1 | `AI_TEMPERATURE.CREATIVE` | 鼓励自然表达，模拟真人说话 |
| 警长竞选报名 | 0.7 | `AI_TEMPERATURE.BALANCED` | 平衡模式 |
| 投票/技能决策 | 0.4 | `AI_TEMPERATURE.LOGIC` | 偏逻辑，核心决策不能崩坏 |
| 游戏总结 | 0.1 | `AI_TEMPERATURE.STRICT` | 追求绝对准确 |

**文件**: `src/lib/ai-config.ts` 中的 `GAME_TEMPERATURE` 对象将上述温度映射到具体游戏行为。

### 1.3 API Key 解析

**文件**: `src/lib/llm.ts` → `resolveApiKeySource()`

根据模型的 provider 决定使用用户自定义 Key 还是项目内置 Key：
- `zenmux` → 检查 `getZenmuxApiKey()`
- `dashscope` → 检查 `getDashscopeApiKey()`
- `mimo` → 检查 `getMimoApiKey()`
- `modelscope` → 检查 `getModelscopeApiKey()`
- `tokendance` → 始终使用项目 Key

### 1.4 错误处理与重试

**文件**: `src/lib/llm.ts` → `fetchWithRetry()`

- 最多重试 4 次（流式）或 3 次（批量）
- 可重试状态码：`429, 500, 502, 503, 504`
- 指数退避 + 随机抖动
- 支持 `Retry-After` 头解析
- 配额耗尽（`402` 或余额不足关键词）标记为 `[QUOTA_EXHAUSTED]`

### 1.5 JSON 容错解析

**文件**: `src/lib/llm.ts` → `parseJsonTolerant()`

LLM 返回的 JSON 可能不规范，解析流程：
1. 剥离 Markdown 代码围栏（` ```json ... ``` `）
2. 调用 `parseLLMJson()` 修复常见 JSON 错误
3. 标准化引号（中文引号 → 英文引号）
4. 提取第一个完整的 JSON 块
5. 转义字符串内的悬空引号

---

## 二、游戏前准备阶段

### 2.1 AI 角色生成（2 次 LLM 调用）

**文件**: `src/lib/character-generator.ts` → `generateCharacters()`

**触发时机**: 游戏开始前，`startGame()` 调用 `generateCharacters(count, scenario)`

#### 阶段 1：生成基础档案（Base Profiles）

| 项目 | 内容 |
|------|------|
| **调用函数** | `generateJSON()` |
| **模型** | `getGeneratorModel()`（GENERATOR_MODEL） |
| **温度** | 1.2（WILD） |
| **输入** | 系统提示（要求生成 N 个角色的基础信息） + 场景描述（scenario） |
| **输出** | JSON 数组，每个元素包含 `{displayName, gender, age, mbti, basicInfo}` |
| **超时** | 30 秒 |
| **重试** | 最多 2 次，失败时回退到内置角色（`generateBuiltinCharacters()`） |

**提示词构建**: `buildBaseProfilesPrompt(count, scenario)` → 使用 i18n 模板 `characterGenerator.baseProfilesPrompt`

#### 阶段 2：生成完整人设（Full Personas）

| 项目 | 内容 |
|------|------|
| **调用函数** | `generateCompletionStream()`（流式） |
| **模型** | `getGeneratorModel()`（GENERATOR_MODEL） |
| **温度** | 1.2（WILD） |
| **输入** | 系统提示 + 阶段 1 生成的基础档案列表 + 场景描述 |
| **输出** | 流式 JSON，逐个角色解析，每个包含完整 `Persona` 和 `PlayerMind` |
| **超时** | 30 秒内无数据则超时 |

**提示词构建**: `buildFullPersonasPrompt(scenario, allProfiles)` → 使用 i18n 模板 `characterGenerator.fullPersonasPrompt`

**流式解析逻辑**:
- 使用正则匹配 `{"displayName": "...", "persona": {...}, "playerMind": {...}}` 结构
- 每解析出一个完整角色立即回调 `onCharacter()`
- 流式结束后检查是否所有角色都已生成，未生成的回退到完整解析

**Persona 字段说明**:
```
persona: {
  styleLabel,        // 性格标签
  voiceRules,        // 语音规则
  mbti,              // MBTI 类型
  gender,            // 性别
  age,               // 年龄
  voiceId,           // 语音 ID
  werewolfExperience,// 狼人杀经验
  vocabularyStyle,   // 词汇风格
  reasoningStyle,    // 推理风格
  speechLengthHabit, // 发言长度习惯
  pressureStyle,     // 压力反应风格
  uncertaintyStyle,  // 不确定性处理风格
  mistakePattern,    // 犯错模式
  wolfDeceptionStyle,// 狼人欺骗风格
}
```

**PlayerMind 字段说明**:
```
playerMind: {
  courage,           // 勇气
  memoryBias,        // 记忆偏差
  suspicionThreshold,// 怀疑阈值
  selfProtection,    // 自我保护
  logicDepth,        // 逻辑深度
  tablePresence,     // 桌面存在感
}
```

---

## 三、夜晚阶段

**文件**: `src/game/phases/NightPhase.ts`（阶段编排）+ `src/lib/game-master.ts`（LLM 调用）

夜晚按固定顺序执行 4 个子阶段。每个子阶段中，如果该角色是 AI 玩家，就调用 LLM 生成决策。

### 3.1 守卫守护（NIGHT_GUARD_ACTION）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateGuardAction(state, player)` |
| **提示词生成** | `PhaseManager.getPrompt("NIGHT_GUARD_ACTION", ...)` → `NightPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef`（通过 `mergeOptionsFromModelRef()` 合并） |
| **温度** | 0.4（ACTION） |
| **输出格式** | JSON `{seat: N}`，表示守护目标座位号（显示座位，1-indexed） |
| **重试** | 最多 2 次（`generateCompletionWithParseRetry`） |

**输入提示词结构**:
- System: 守卫身份信息（座位、名字、角色、胜利条件）+ 守护任务描述（可选目标列表，排除上晚守护目标）
- User: 游戏上下文 + 今天白天讨论记录 + 自身发言记录 + JSON 格式示例

**解析逻辑**:
- 尝试从 JSON 中提取 `seat/targetSeat/target/protect` 字段
- 验证座位号在有效范围内（排除上晚守护目标）
- 解析失败时重试，最终失败返回 `undefined`

### 3.2 狼人出刀（NIGHT_WOLF_ACTION）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateWolfAction(state, player, existingVotes)` |
| **提示词生成** | `PhaseManager.getPrompt("NIGHT_WOLF_ACTION", ...)` → `NightPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | JSON `{seat: N}`，表示击杀目标座位号 |

**特殊处理**:
- 如果有多个狼人，第一个狼人的决策作为共识，其他狼人自动跟随
- `existingVotes` 参数传递其他狼人的投票意向，供当前狼人参考

**解析逻辑**:
- 尝试从 JSON 中提取 `seat/targetSeat/target/kill` 字段
- 验证座位号在存活玩家范围内

### 3.3 女巫用药（NIGHT_WITCH_ACTION）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateWitchAction(state, player, wolfTarget)` |
| **提示词生成** | `PhaseManager.getPrompt("NIGHT_WITCH_ACTION", ...)` → `NightPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | `WitchAction` 类型 |

**WitchAction 类型**:
```typescript
type WitchAction =
  | { type: "save" }                    // 使用解药
  | { type: "poison"; target: number }  // 使用毒药（target 为座位号）
  | { type: "pass" }                    // 不操作
```

**输入提示词结构**:
- System: 女巫身份信息 + 药水状态（解药/毒药可用性）+ 今晚情况（谁被刀了）+ 三种选项说明
- User: 游戏上下文 + 今天讨论记录 + 自身发言

**解析逻辑**:
- 从 `action/type` 字段判断操作类型
- `save/heal` → 使用解药（需检查 `canSave`）
- `poison` → 使用毒药（需检查 `canPoison` + 有效目标）
- `pass/skip/none` 或 `seat === 0` → 不操作
- 默认返回 `{ type: "pass" }`

### 3.4 预言家查验（NIGHT_SEER_ACTION）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateSeerAction(state, player)` |
| **提示词生成** | `PhaseManager.getPrompt("NIGHT_SEER_ACTION", ...)` → `NightPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | JSON `{seat: N}`，表示查验目标座位号 |

**输入提示词结构**:
- System: 预言家身份信息 + 查验任务描述（已查验列表 + 未查验优先推荐 + 可选目标）
- User: 游戏上下文 + 今天讨论记录 + 自身发言 + JSON 格式示例

---

## 四、白天阶段

### 4.1 警长竞选报名决策（DAY_BADGE_SIGNUP）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateAIBadgeSignupBatch(state, players)` |
| **模型** | `getSummaryModel()`（SUMMARY_MODEL） |
| **温度** | 0.7（BADGE_SIGNUP） |
| **输出格式** | JSON，多种格式兼容 |

**特殊**: 使用 SUMMARY_MODEL **一次性批量判断**所有 AI 玩家是否上警，而非逐个调用。

**输入提示词结构**:
- System: 任务描述（要求判断每个玩家是否参加警长竞选）
- User: 所有玩家信息摘要（座位、名字、角色、性格、第一晚行动信息）+ 座位列表

**输出格式兼容**:
```json
// 格式 1
{"decisions": {"1": true, "2": false, ...}}
// 格式 2
{"signup": [1, 3, 5]}
// 格式 3
{"1": true, "2": false, ...}
```

**提示词构建**: 使用 i18n 模板 `gameMaster.badgeSignup.systemPrompt` 和 `gameMaster.badgeSignup.userPrompt`

### 4.2 警长竞选发言（DAY_BADGE_SPEECH）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateAISpeechSegmentsStream(state, player, options)` |
| **提示词生成** | `PhaseManager.getPrompt("DAY_BADGE_SPEECH", ...)` → `DaySpeechPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 1.1（SPEECH） |
| **输出格式** | 流式文本发言（逐段输出到 UI） |

**流式解析**:
- 使用 `StreamingSpeechParser` 实时解析段落
- 每完成一段发言立即通过 `onSegmentReceived` 回调通知 UI
- 支持 JSON 数组格式和纯文本格式
- 流式结束后回退到传统解析（如果流式未产生结果）

### 4.3 警长投票（DAY_BADGE_ELECTION）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateAIBadgeVote(state, player)` |
| **提示词生成** | `BadgePhase.buildBadgeElectionPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | JSON `{seat: N}`，表示投票目标 |

**解析逻辑**:
- 使用 `parseLLMDisplaySeat()` 从 JSON 中提取座位号
- 验证座位号在候选人范围内
- 解析失败返回 `BADGE_VOTE_ABSTAIN`（-1）

### 4.4 白天自由讨论发言（DAY_SPEECH）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateAISpeechSegmentsStream(state, player, options)` |
| **提示词生成** | `PhaseManager.getPrompt("DAY_SPEECH", ...)` → `DaySpeechPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 1.1（SPEECH） |
| **输出格式** | 流式文本发言 |

**输入提示词结构**:
- System: 角色身份 + 胜利条件 + 人设信息 + 讨论任务描述 + 发言顺序信息 + 视角提示（focusAngle）+ 发言指南
- User: 游戏上下文 + 今天讨论记录（排除自己）+ 自身发言 + 阶段提示

### 4.5 遗言发言（DAY_LAST_WORDS）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateAISpeechSegmentsStream(state, player, options)` |
| **提示词生成** | `PhaseManager.getPrompt("DAY_LAST_WORDS", ...)` → `DaySpeechPhase.getPrompt()` |
| **温度** | 1.1（SPEECH） |
| **输出格式** | 流式文本遗言 |

与自由讨论类似，但任务描述切换为遗言场景（被处决/被杀后的遗言）。

### 4.6 PK 发言（DAY_PK_SPEECH）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateAISpeechSegmentsStream(state, player, options)` |
| **提示词生成** | `PhaseManager.getPrompt("DAY_PK_SPEECH", ...)` → `DaySpeechPhase.getPrompt()` |
| **温度** | 1.1（SPEECH） |
| **输出格式** | 流式文本发言 |

平票后进入 PK 环节，限定 PK 候选人发言。

### 4.7 白天投票（DAY_VOTE）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateAIVote(state, player)` |
| **提示词生成** | `VotePhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | JSON `{seat: N, reason: "投票理由"}` |

**解析逻辑**:
- 尝试从 `seat/targetSeat/target/vote` 字段提取座位号
- `reason` 字段提取投票理由
- PK 时限定投票目标为 PK 候选人
- 解析失败返回 `AI_VOTE_ABSTAIN`（-1）

---

## 五、特殊事件阶段

### 5.1 猎人开枪（HUNTER_SHOOT）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateHunterShoot(state, player)` |
| **提示词生成** | `HunterPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | JSON `{seat: N}`（开枪目标）或 `{action: "pass"}`（不开枪） |

**解析逻辑**:
- `action` 包含 `pass/skip/不开` 或 `seat === 0/null` → 不开枪（返回 `null`）
- 否则提取目标座位号

### 5.2 白狼王自爆（WHITE_WOLF_KING_BOOM）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateWhiteWolfKingBoomDecision(state, player)` |
| **提示词生成** | `WhiteWolfKingBoomPhase.getPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | 目标座位号（自爆）或 `null`（不自爆） |

**解析逻辑**:
- `action` 包含 `pass/skip/none` 或 `seat === 0/null` → 不自爆（返回 `null`）
- `action` 包含 `boom/explode/self` → 自爆，提取目标座位号

### 5.3 警徽移交（BADGE_TRANSFER）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateBadgeTransfer(state, player)` |
| **提示词生成** | `BadgePhase.buildBadgeTransferPrompt()` |
| **模型** | AI 玩家各自的 `modelRef` |
| **温度** | 0.4（ACTION） |
| **输出格式** | 目标座位号（移交）或 `-1`（撕毁警徽） |

**特殊处理**:
- 如果是预言家且已确认狼人座位，会避免移交给狼人
- 解析失败默认撕毁警徽（`BADGE_TRANSFER_TORN`）

---

## 六、游戏结算与复盘阶段

### 6.1 每日总结（Daily Summary）

| 项目 | 内容 |
|------|------|
| **调用函数** | `game-master.ts` → `generateDailySummary(state)` |
| **模型** | `getSummaryModel()`（SUMMARY_MODEL） |
| **温度** | 0.1（STRICT） |
| **输出格式** | JSON `{bullets: ["要点1", "要点2", ...]}` |

**触发时机**: 每天白天结束时（投票/处决后）

**输入**:
- System: "你是狼人杀游戏总结助手"（i18n 模板 `gameMaster.dailySummary.systemPrompt`）
- User: 第 N 天的完整讨论记录（最多 15000 字符）

**返回**: `{bullets: string[], voteData?: DailySummaryVoteData}`

### 6.2 游戏复盘分析 -- AI 发言摘要

**文件**: `src/lib/game-analysis.ts` → `generateAISpeechSummaries(state, model)`

| 项目 | 内容 |
|------|------|
| **调用函数** | `generateJSON()` |
| **模型** | `getSummaryModel()` |
| **温度** | 0.3 |
| **输出格式** | JSON `{electionSummaries, discussionSummaries, daySummary}` |

**触发时机**: 游戏结束后的复盘分析页面

**输入**:
- System: "你是狼人杀游戏记录员，擅长分析场上局势和压缩玩家发言。"
- User: 按天分组的竞选发言 + 讨论发言，要求生成每个玩家的第一人称摘要和当天整体概括

**输出结构**:
```json
{
  "electionSummaries": [{"seat": 1, "content": "第一人称摘要"}],
  "discussionSummaries": [{"seat": 1, "content": "第一人称摘要"}],
  "daySummary": "一段话概括（50-80字，只用座位号）"
}
```

### 6.3 游戏复盘分析 -- MVP/SVP/评价/评分

**文件**: `src/lib/game-analysis.ts` → `generateAIAnalysisData(state, humanPlayer, model)`

| 项目 | 内容 |
|------|------|
| **调用函数** | `generateJSON()` |
| **模型** | `getSummaryModel()` |
| **温度** | 0.7 |
| **输出格式** | JSON `AIAnalysisResult` |

**输入**:
- System: "你是专业的狼人杀游戏分析师，擅长评价玩家表现并生成有趣的复盘内容。"
- User: 完整游戏历史（结构化事实）+ 玩家列表 + 被评价玩家信息（角色、阵营、队友、对手）+ 被评价玩家的全部发言

**输出结构**:
```typescript
interface AIAnalysisResult {
  awards: {
    mvp: PlayerAward;   // 获胜方最佳
    svp: PlayerAward;   // 失败方最佳
  };
  highlightQuote: string; // 精彩一句话
  reviews: PlayerReview[]; // 2条队友评价 + 1条对手评价
  speechScores: {
    logic: number;    // 逻辑严密度 0-100
    clarity: number;  // 表达清晰度 0-100
  };
}
```

**结果校正**: `correctAIResult()` 确保 playerId、avatar 与实际玩家匹配

### 6.4 按需增量分析

**文件**: `src/lib/game-analysis.ts` → `enrichAnalysisWithAI(type, state, model)`

| 项目 | 内容 |
|------|------|
| **type 参数** | `"awards"` / `"reviews"` / `"speechScores"` / `"speeches"` |
| **触发时机** | 复盘页面按需加载 |

- `type === "speeches"` → 调用 `generateAISpeechSummaries()`
- 其他 type → 调用 `generateAIAnalysisData()`，按 type 过滤返回字段

---

## 七、提示词构建架构

### 7.1 提示词分层结构

所有游戏阶段的提示词均遵循统一的分层模式：

```
System Prompt = [可缓存部分] + [动态部分]
  - 可缓存部分 (cacheable, ttl=1h):
    · 角色身份（座位、名字、角色）
    · 胜利条件
    · 人设信息（Persona + PlayerMind）
    · 发言指南
  - 动态部分:
    · 任务描述
    · 可选目标列表
    · 当前状态信息

User Prompt = 游戏上下文 + 今日讨论记录 + 自身发言 + JSON 格式示例
```

### 7.2 提示词构建流程

**文件**: `src/game/core/PhaseManager.ts` → `getPrompt(phase, context, player)`

1. `PhaseManager` 根据 `Phase` 枚举找到对应的 `GamePhase` 子类
2. 调用子类的 `getPrompt(context, player)` 方法
3. 返回 `PromptResult`:
   ```typescript
   interface PromptResult {
     systemParts: SystemPromptPart[];  // 可缓存的系统提示部分
     system: string;                    // 完整系统提示（后备）
     user: string;                      // 用户提示
   }
   ```
4. `buildMessagesForPrompt()` 将 `PromptResult` 转换为 `LLMMessage[]`

### 7.3 游戏上下文构建

**文件**: `src/lib/prompt-utils.ts` → `buildGameContext()`

每次 LLM 调用的 User Prompt 中都会包含标准化的游戏上下文：
- 当前天数和阶段
- 存活/死亡玩家列表及其座位号
- 警长信息
- 角色能力使用状态
- 历史投票记录
- 查验历史（仅对预言家可见）

### 7.4 座位号处理

**显示座位 vs 内部座位**:
- 内部座位（`seat`）：0-indexed，从 0 开始
- 显示座位：1-indexed，从 1 开始
- LLM 输入/输出使用显示座位（1-indexed）
- 解析时通过 `parseDisplaySeatValue()` 将显示座位转换为内部座位（`displaySeat - 1`）

---

## 八、调用量估算

一局 **10 人游戏、持续 3 天**的粗略统计：

| 类别 | 调用次数 | 说明 |
|------|----------|------|
| 角色生成 | 2 次 | 基础档案 + 完整个人设 |
| 夜晚行动 | 12 次 | 4 次/晚 × 3 天 |
| 警长竞选 | ~10 次 | 报名 1 + 发言 N + 投票 N |
| 白天发言 | ~30 次 | 每天每位 AI 玩家轮流发言 |
| 白天投票 | ~20 次 | 每天每位 AI 玩家投票 |
| 特殊事件 | 0-3 次 | 猎人/白狼王/警徽移交 |
| 每日总结 | 3 次 | 每天 1 次 |
| 复盘分析 | 2 次 | 发言摘要 + MVP/评价/评分 |
| **合计** | **约 70+ 次** | |

---

## 附录：关键文件索引

| 文件 | 职责 |
|------|------|
| `src/lib/llm.ts` | LLM 调用基础设施（生成、流式、JSON、重试、错误处理） |
| `src/lib/ai-config.ts` | AI 温度配置 |
| `src/lib/game-master.ts` | 游戏逻辑主控（所有 LLM 调用的入口函数） |
| `src/lib/character-generator.ts` | AI 角色生成 |
| `src/lib/game-analysis.ts` | 游戏复盘分析 |
| `src/lib/prompt-utils.ts` | 提示词构建工具 |
| `src/lib/streaming-speech-parser.ts` | 流式发言段落解析器 |
| `src/lib/llm-json.ts` | LLM JSON 容错解析 |
| `src/game/core/PhaseManager.ts` | 阶段提示词管理器 |
| `src/game/phases/*.ts` | 各阶段提示词生成类 |
| `src/hooks/useGameLogic.ts` | 游戏逻辑主循环 |
| `src/hooks/game-phases/*.ts` | 各阶段子 hook |
| `src/app/api/chat/route.ts` | LLM API 代理路由 |
