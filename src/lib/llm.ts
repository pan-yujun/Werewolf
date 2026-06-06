/**
 * LLM 调用基础设施层
 *
 * 本文件是所有 LLM 调用的底层入口，提供以下核心功能：
 * 1. generateCompletion()     — 非流式单次调用，用于结构化决策（投票、技能、总结等）
 * 2. generateCompletionStream() — 流式调用，用于 AI 发言（逐字输出到 UI）
 * 3. generateJSON<T>()       — 在 generateCompletion 之上加 JSON 格式约束 + 容错解析
 * 4. generateCompletionBatch() — 批量调用（当前未被主要流程使用）
 *
 * 所有调用均通过 POST /api/chat 发送到服务端代理，支持多家 Provider：
 * - zenmux（默认）
 * - dashscope（阿里云）
 * - mimo（MiniMax）
 * - modelscope
 * - tokendance
 *
 * 错误处理：
 * - 指数退避重试（最多 4 次）
 * - 配额耗尽检测（[QUOTA_EXHAUSTED] 标记）
 * - JSON 容错解析（处理 LLM 返回的不规范 JSON）
 */

import { getDashscopeApiKey, getMimoApiKey, getModelscopeApiKey, getZenmuxApiKey, isCustomKeyEnabled } from "@/lib/api-keys";
import { ALL_MODELS, AVAILABLE_MODELS, PROJECT_MODELS, type ModelRef } from "@/types/game";
import { gameStatsTracker } from "@/hooks/useGameStats";
import { gameSessionTracker } from "@/lib/game-session-tracker";
import { getAuthHeaders } from "@/lib/auth-headers";
import { parseLLMJson } from "./llm-json";

/** LLM 消息内容部分类型：支持文本、图片、音频 */
export type LLMContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "mp3" | "wav" } };

/** API Key 来源：用户自定义 或 项目内置 */
export type ApiKeySource = "user" | "project";

/** LLM 消息结构：角色（system/user/assistant）+ 内容 + 推理详情 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string | LLMContentPart[];
  reasoning_details?: unknown;
}

/** 支持的 LLM 提供商类型 */
type Provider = "zenmux" | "dashscope" | "tokendance" | "mimo" | "modelscope";

/** 类型守卫：检查值是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


/**
 * 根据模型名称获取对应的 Provider
 * 优先从 PROJECT_MODELS 中查找，其次从 ALL_MODELS 中查找，默认返回 "zenmux"
 */
function getProviderForModel(model: string): Provider {
   const modelRef =
     ALL_MODELS.find((ref) => ref.model === model) ??
     PROJECT_MODELS.find((ref) => ref.model === model);
   return modelRef?.provider ?? "zenmux";
 }

/**
 * 当使用内置 Key（自定义 Key 关闭）时，将模型解析为内置可用模型
 * 游戏状态可能包含自定义 Key 游戏的 modelRef，需要映射回内置模型
 * 优先使用 mimo，其次 zenmux，最后回退到第一个可用模型
 */
function resolveModelForBuiltin(model: string): string {
  if (PROJECT_MODELS.some((r) => r.model === model)) return model;
  // Prefer mimo if available, then zenmux, then first available
  const m =
    AVAILABLE_MODELS.find((r) => r.provider === "mimo") ??
    AVAILABLE_MODELS.find((r) => r.provider === "zenmux") ??
    AVAILABLE_MODELS[0];
  return m?.model ?? model;
}

/**
 * 解析 API Key 来源
 * 根据模型的 provider 决定使用用户自定义 Key 还是项目内置 Key
 * - 自定义 Key 关闭时 → 返回 "project"
 * - 自定义 Key 开启时 → 根据 provider 检查对应 Key 是否存在
 */
export function resolveApiKeySource(model: string): ApiKeySource {
   const customEnabled = isCustomKeyEnabled();
   if (!customEnabled) return "project";

   const provider = getProviderForModel(model);
   if (provider === "dashscope") {
     return getDashscopeApiKey() ? "user" : "project";
   }
   if (provider === "tokendance") {
     return "project";
   }
   if (provider === "mimo") {
     return getMimoApiKey() ? "user" : "project";
   }
   if (provider === "modelscope") {
     return getModelscopeApiKey() ? "user" : "project";
   }
   return getZenmuxApiKey() ? "user" : "project";
 }

export interface ChatCompletionResponse {
  id: string;
  choices: {
    message: {
      role: "assistant";
      content: string;
      reasoning_details?: unknown;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      strict?: boolean;
      json_schema: {
        name: string;
        description?: string;
        schema: unknown;
        // Note: 'strict' is not supported by ZenMux, use json_object for simple cases
      };
    };

// ZenMux reasoning: enabled, effort (minimal|low|medium|high), max_tokens (optional). No exclude.
export interface ReasoningOptions {
  enabled: boolean;
  effort?: "minimal" | "low" | "medium" | "high";
  max_tokens?: number;
}

export interface GenerateOptions {
  model: string;
  provider?: Provider;
  messages: LLMMessage[];
  temperature?: number;
  max_tokens?: number;
  reasoning?: ReasoningOptions;
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
  response_format?: ResponseFormat;
}

/**
 * 合并 modelRef 的覆盖参数（temperature, reasoning）到 options 中
 * modelRef 中的值会覆盖调用时传入的值
 * 用于将 AI 玩家各自的模型配置应用到 LLM 调用
 */
export function mergeOptionsFromModelRef<T extends GenerateOptions>(
  modelRef: ModelRef | undefined,
  options: T
): T {
  if (!modelRef) return options;
  const out = { ...options } as T;
  (out as GenerateOptions).provider = modelRef.provider;
  if (modelRef.temperature !== undefined) (out as GenerateOptions).temperature = modelRef.temperature;
  if (modelRef.reasoning !== undefined) (out as GenerateOptions).reasoning = modelRef.reasoning;
  return out;
}

export type BatchCompletionResult =
  | { ok: true; content: string; reasoning_details?: unknown; raw: ChatCompletionResponse }
  | { ok: false; error: string; status?: number };

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function parseRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);

  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  const diff = dateMs - Date.now();
  return diff > 0 ? diff : null;
}

const QUOTA_EXHAUSTED_MARKER = "[QUOTA_EXHAUSTED]";

function isQuotaExhaustedError(status: number, errorText: string): boolean {
  if (status === 402) return true;
  const lower = errorText.toLowerCase();
  return (
    lower.includes("insufficient") ||
    lower.includes("quota") ||
    lower.includes("balance") ||
    lower.includes("余额") ||
    lower.includes("欠费") ||
    lower.includes("arrearage") ||
    (status === 401 && lower.includes("已启用自定义 key"))
  );
}

function formatApiError(status: number, errorText: string): string {
  let msg = `API error: ${status}`;
  try {
    const errorJson: unknown = JSON.parse(errorText);
    if (isRecord(errorJson)) {
      if (typeof errorJson.error === "string" && errorJson.error.trim()) {
        msg = errorJson.error.trim();
      }

      const details = errorJson.details;
      if (isRecord(details)) {
        const nestedError = details.error;
        if (isRecord(nestedError) && typeof nestedError.message === "string" && nestedError.message.trim()) {
          msg = `${msg} - ${nestedError.message.trim()}`;
        }
      }
    }
  } catch {
    const trimmed = (errorText || "").trim();
    msg = trimmed ? `${msg} - ${trimmed.slice(0, 600)}` : msg;
  }

  if (isQuotaExhaustedError(status, errorText)) {
    return `${QUOTA_EXHAUSTED_MARKER} ${msg}`;
  }
  return msg;
}

export function isQuotaExhaustedMessage(message: string): boolean {
  return message.includes(QUOTA_EXHAUSTED_MARKER);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的 HTTP 请求
 * - 可重试状态码：429（限流）、500/502/503/504（服务器错误）
 * - 指数退避 + 随机抖动（避免雪崩）
 * - 支持 Retry-After 头解析
 * - 最多重试 maxAttempts 次
 */
async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  maxAttempts: number,
  timeoutMs: number = 30000
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timerId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timerId);
      lastResponse = response;

      if (response.ok) return response;

      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(response);
      const base = response.status === 429 ? 1000 : 400;
      const jitter = Math.floor(Math.random() * 200);
      const backoffMs =
        (retryAfterMs !== null ? Math.min(15000, Math.max(0, retryAfterMs)) : base * 2 ** (attempt - 1)) +
        jitter;
      await sleep(backoffMs);
    } catch (err) {
      clearTimeout(timerId);
      lastError = err;
      if (attempt === maxAttempts) break;
      const base = 400;
      const jitter = Math.floor(Math.random() * 200);
      const backoffMs = base * 2 ** (attempt - 1) + jitter;
      await sleep(backoffMs);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 剥离 MiniMax 等模型在 content 中嵌入的 <think>...</think> 思考块 */
const REASONING_TAG_NAMES = ["think", "thinking", "analysis", "reasoning", "thought"];
const REASONING_TAG_PATTERN = REASONING_TAG_NAMES.join("|");

/** Remove model reasoning artifacts that may be embedded in assistant content. */
export function stripReasoningArtifacts(text: string): string {
  return stripReasoningArtifactsPreserveWhitespace(text).trim();
}

function stripReasoningArtifactsPreserveWhitespace(text: string): string {
  if (!text) return text;

  return text
    .replace(
      new RegExp(
        `<\\s*(${REASONING_TAG_PATTERN})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>\\s*`,
        "gi"
      ),
      ""
    )
    .replace(new RegExp(`<\\s*\\/?\\s*(${REASONING_TAG_PATTERN})\\b[^>]*>`, "gi"), "");
}

function findReasoningEnd(text: string): { end: number } | null {
  const match = new RegExp(`<\\s*\\/\\s*(${REASONING_TAG_PATTERN})\\s*>`, "i").exec(text);
  return match ? { end: match.index + match[0].length } : null;
}

function couldBeReasoningStart(text: string): boolean {
  if (!text.startsWith("<")) return false;
  const lowered = text.toLowerCase();
  return REASONING_TAG_NAMES.some((name) => `<${name}`.startsWith(lowered) || lowered.startsWith(`<${name}`));
}

export function stripMarkdownCodeFences(text: string): string {
  let t = text.trim();

  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z0-9_-]*\s*/m, "");
    t = t.replace(/\s*```\s*$/m, "");
  }

  return t.trim();
}

function stripJsonPrefix(text: string): string {
  const t = text.trimStart();
  if (/^json\s*[\[{]/i.test(t)) {
    return t.replace(/^json\s*/i, "");
  }
  return text;
}

function extractFirstJsonBlock(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  const start =
    startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
  if (start === -1) return null;

  const opening = text[start];
  const expectedClosing = opening === "{" ? "}" : "]";

  let i = start;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opening) {
      depth += 1;
      continue;
    }
    if (ch === expectedClosing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      continue;
    }

    if (opening === "{" && ch === "[") {
      depth += 1;
      continue;
    }
    if (opening === "{" && ch === "]") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      continue;
    }
    if (opening === "[" && ch === "{") {
      depth += 1;
      continue;
    }
    if (opening === "[" && ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      continue;
    }
  }

  return null;
}

function normalizeJsonText(text: string): string {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function escapeDanglingQuotesInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaping = false;

  const nextNonWs = (idx: number): string | null => {
    for (let j = idx; j < text.length; j += 1) {
      const c = text[j];
      if (!/\s/.test(c)) return c;
    }
    return null;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }

    if (escaping) {
      escaping = false;
      out += ch;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      out += ch;
      continue;
    }

    if (ch === '"') {
      const n = nextNonWs(i + 1);
      const isTerminator = n === null || n === "," || n === "}" || n === "]" || n === ":";
      if (isTerminator) {
        inString = false;
        out += ch;
        continue;
      }
      out += "\\\"";
      continue;
    }

    out += ch;
  }

  return out;
}

function parseJsonTolerant<T>(raw: string): T {
  const trimmed = stripJsonPrefix(stripMarkdownCodeFences(raw));
  const repairedJson = parseLLMJson<T>(trimmed);
  if (repairedJson !== null) return repairedJson;

  const direct = normalizeJsonText(trimmed);
  try {
    return JSON.parse(direct) as T;
  } catch {
    // continue
  }

  const extracted = extractFirstJsonBlock(direct) ?? extractFirstJsonBlock(trimmed);
  if (!extracted) {
    throw new Error(`Failed to parse JSON response: ${raw}`);
  }

  const normalized = normalizeJsonText(extracted);
  try {
    return JSON.parse(normalized) as T;
  } catch {
    // continue
  }

  const repaired = escapeDanglingQuotesInStrings(normalized);
  try {
    return JSON.parse(repaired) as T;
  } catch {
    throw new Error(`Failed to parse JSON response: ${raw}`);
  }
}


/**
 * 非流式 LLM 调用（核心函数）
 *
 * 用于结构化决策场景：投票、技能使用、总结等
 * 返回完整的响应内容，而非流式片段
 *
 * @param options - 调用选项（模型、消息、温度、格式等）
 * @returns 包含 content（已剥离思考块）、reasoning_details、raw 响应
 *
 * 调用链路：
 * generateCompletion() → fetchWithRetry() → POST /api/chat → LLM Provider
 *
 * 使用场景：
 * - 夜晚行动决策（守卫/狼人/女巫/预言家）
 * - 投票决策（白天投票/警长投票）
 * - 特殊事件（猎人开枪/白狼王自爆/警徽移交）
 * - 每日总结
 */
export async function generateCompletion(
  options: GenerateOptions
): Promise<{ content: string; reasoning_details?: unknown; raw: ChatCompletionResponse }> {
  const maxTokens =
    typeof options.max_tokens === "number" && Number.isFinite(options.max_tokens)
      ? Math.max(16, Math.floor(options.max_tokens))
      : undefined;

  const customEnabled = isCustomKeyEnabled();
  const headerApiKey = customEnabled ? getZenmuxApiKey() : "";
  const dashscopeApiKey = customEnabled ? getDashscopeApiKey() : "";
  const mimoApiKey = customEnabled ? getMimoApiKey() : "";
  const modelscopeApiKey = customEnabled ? getModelscopeApiKey() : "";
  const modelToUse = customEnabled
    ? options.model
    : resolveModelForBuiltin(options.model);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (headerApiKey) {
    headers["X-Zenmux-Api-Key"] = headerApiKey;
  }
  if (dashscopeApiKey) {
    headers["X-Dashscope-Api-Key"] = dashscopeApiKey;
  }
  if (mimoApiKey) {
    headers["X-Mimo-Api-Key"] = mimoApiKey;
  }
  if (modelscopeApiKey) {
    headers["X-Modelscope-Api-Key"] = modelscopeApiKey;
  }

  Object.assign(headers, await getAuthHeaders());

  console.log("[LLM] generateCompletion:", {
    customEnabled,
    hasZenmuxKey: !!headerApiKey,
    hasDashscopeKey: !!dashscopeApiKey,
    model: modelToUse,
  });

  const requestBody = {
    model: modelToUse,
    ...(options.provider ? { provider: options.provider } : {}),
    messages: options.messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: maxTokens,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.reasoning_effort ? { reasoning_effort: options.reasoning_effort } : {}),
    ...(options.response_format ? { response_format: options.response_format } : {}),
  };

  console.log("[LLM] Request body:", JSON.stringify(requestBody).slice(0, 1000));

  const response = await fetchWithRetry(
    "/api/chat",
    {
      method: "POST",
      headers: {
        ...headers,
      },
      body: JSON.stringify(requestBody),
    },
    4
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(formatApiError(response.status, errorText));
  }

  const result: ChatCompletionResponse = await response.json();
  const choice = result.choices?.[0];
  const assistantMessage = choice?.message;

  if (!assistantMessage) {
    throw new Error(
      `No response from model. Raw response: ${JSON.stringify(result).slice(0, 500)}`
    );
  }

  // Warn if output was truncated due to max_tokens
  if (choice.finish_reason === "length") {
    console.warn(
      `[LLM] Output truncated (finish_reason=length). Consider increasing max_tokens.`
    );
  }

  // 统计 AI 调用
  const inputChars = options.messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s, p) => s + ("text" in p ? p.text.length : 0), 0);
    }
    return sum;
  }, 0);
  gameStatsTracker.addAiCall({
    inputChars,
    outputChars: assistantMessage.content.length,
    promptTokens: result.usage?.prompt_tokens,
    completionTokens: result.usage?.completion_tokens,
  });
  gameSessionTracker.addAiCall({
    inputChars,
    outputChars: assistantMessage.content.length,
    promptTokens: result.usage?.prompt_tokens,
    completionTokens: result.usage?.completion_tokens,
  });

  return {
    content: stripReasoningArtifacts(assistantMessage.content),
    reasoning_details: assistantMessage.reasoning_details,
    raw: result,
  };
}

export async function generateCompletionBatch(
  requests: GenerateOptions[]
): Promise<BatchCompletionResult[]> {
  if (!Array.isArray(requests) || requests.length === 0) return [];

  const customEnabled = isCustomKeyEnabled();
  const headerApiKey = customEnabled ? getZenmuxApiKey() : "";
  const dashscopeApiKey = customEnabled ? getDashscopeApiKey() : "";
  const mimoApiKey = customEnabled ? getMimoApiKey() : "";
  const modelscopeApiKey = customEnabled ? getModelscopeApiKey() : "";
  const resolvedRequests = customEnabled
    ? requests
    : requests.map((r) => ({ ...r, model: resolveModelForBuiltin(r.model) }));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (headerApiKey) {
    headers["X-Zenmux-Api-Key"] = headerApiKey;
  }
  if (dashscopeApiKey) {
    headers["X-Dashscope-Api-Key"] = dashscopeApiKey;
  }
  if (mimoApiKey) {
    headers["X-Mimo-Api-Key"] = mimoApiKey;
  }
  if (modelscopeApiKey) {
    headers["X-Modelscope-Api-Key"] = modelscopeApiKey;
  }

  Object.assign(headers, await getAuthHeaders());

  const response = await fetchWithRetry(
    "/api/chat",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requests: resolvedRequests }),
    },
    3
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(formatApiError(response.status, errorText));
  }

  const data: unknown = await response.json();
  const results = isRecord(data) && Array.isArray(data.results) ? data.results : [];

  return results.map((item): BatchCompletionResult => {
    if (!isRecord(item) || item.ok !== true) {
      return {
        ok: false,
        error: String(isRecord(item) ? (item.error ?? "Unknown error") : "Unknown error"),
        status: isRecord(item) && typeof item.status === "number" ? item.status : undefined,
      };
    }
    const raw = item.data as ChatCompletionResponse;
    const choice = raw?.choices?.[0];
    const assistantMessage = choice?.message;
    if (!assistantMessage) {
      return { ok: false, error: "No response from model" };
    }
    return {
      ok: true,
      content: stripReasoningArtifacts(assistantMessage.content),
      reasoning_details: assistantMessage.reasoning_details,
      raw,
    };
  });
}

/**
 * 流式 LLM 调用（核心函数）
 *
 * 用于需要逐字输出的场景：AI 玩家发言
 * 返回 AsyncGenerator，每次 yield 一个文本片段
 *
 * 特殊处理：
 * - 自动剥离 MiniMax 等模型嵌入的 <think>...</think> 思考块
 * - 使用状态机处理流式思考块（thinkStripped/thinkBuffer）
 * - 流式结束后统计 AI 调用（字符数）
 *
 * @param options - 调用选项
 * @returns AsyncGenerator<string>，每次 yield 一个文本片段
 *
 * 使用场景：
 * - 警长竞选发言
 * - 白天自由讨论发言
 * - 遗言发言
 * - PK 发言
 * - 角色生成（阶段 2）
 */
export async function* generateCompletionStream(
  options: GenerateOptions
): AsyncGenerator<string, void, unknown> {
  const maxTokens =
    typeof options.max_tokens === "number" && Number.isFinite(options.max_tokens)
      ? Math.max(16, Math.floor(options.max_tokens))
      : undefined;

  const customEnabled = isCustomKeyEnabled();
  const headerApiKey = customEnabled ? getZenmuxApiKey() : "";
  const dashscopeApiKey = customEnabled ? getDashscopeApiKey() : "";
  const mimoApiKey = customEnabled ? getMimoApiKey() : "";
  const modelscopeApiKey = customEnabled ? getModelscopeApiKey() : "";
  const modelToUse = customEnabled
    ? options.model
    : resolveModelForBuiltin(options.model);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (headerApiKey) {
    headers["X-Zenmux-Api-Key"] = headerApiKey;
  }
  if (dashscopeApiKey) {
    headers["X-Dashscope-Api-Key"] = dashscopeApiKey;
  }
  if (mimoApiKey) {
    headers["X-Mimo-Api-Key"] = mimoApiKey;
  }
  if (modelscopeApiKey) {
    headers["X-Modelscope-Api-Key"] = modelscopeApiKey;
  }

  Object.assign(headers, await getAuthHeaders());

  const response = await fetchWithRetry(
    "/api/chat",
    {
      method: "POST",
      headers: {
        ...headers,
      },
      body: JSON.stringify({
        model: modelToUse,
        ...(options.provider ? { provider: options.provider } : {}),
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: maxTokens,
        stream: true,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        ...(options.reasoning_effort ? { reasoning_effort: options.reasoning_effort } : {}),
        ...(options.response_format ? { response_format: options.response_format } : {}),
      }),
    },
    4
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(formatApiError(response.status, errorText));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let totalOutputChars = 0;

  // <think> 块剥离状态机（用于 MiniMax 等把思考嵌在 content 里的模型）
  let thinkStripped = false;
  let thinkBuffer = "";

  // 计算输入字符数
  const inputChars = options.messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s, p) => s + ("text" in p ? p.text.length : 0), 0);
    }
    return sum;
  }, 0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (thinkStripped) {
            const cleaned = stripReasoningArtifactsPreserveWhitespace(delta);
            totalOutputChars += cleaned.length;
            if (cleaned) yield cleaned;
          } else {
            thinkBuffer += delta;
            const reasoningEnd = findReasoningEnd(thinkBuffer);
            if (reasoningEnd) {
              // 找到 </think>，丢弃之前内容，从之后开始输出
              const after = stripReasoningArtifactsPreserveWhitespace(thinkBuffer.slice(reasoningEnd.end).replace(/^\n+/, ""));
              thinkStripped = true;
              thinkBuffer = "";
              if (after) {
                totalOutputChars += after.length;
                yield after;
              }
            } else if (!couldBeReasoningStart(thinkBuffer) && thinkBuffer.length >= 1) {
              // 确认不是 <think> 块，直接透传
              thinkStripped = true;
              const cleaned = stripReasoningArtifactsPreserveWhitespace(thinkBuffer);
              totalOutputChars += cleaned.length;
              if (cleaned) yield cleaned;
              thinkBuffer = "";
            }
            // 否则继续缓冲，等待 </think> 或确认非 think 块
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  // 流式结束后统计 AI 调用
  gameStatsTracker.addAiCall({
    inputChars,
    outputChars: totalOutputChars,
  });
  gameSessionTracker.addAiCall({
    inputChars,
    outputChars: totalOutputChars,
  });
}

/**
 * JSON 格式的 LLM 调用（核心函数）
 *
 * 在 generateCompletion 之上增加：
 * 1. 自动在 user prompt 末尾添加 JSON 格式要求
 * 2. 对 zenmux provider 自动启用 json_object 响应格式
 * 3. 容错解析：多层 fallback 处理不规范的 JSON
 * 4. 解析失败时自动重试一次（将上次响应作为 assistant 消息，要求修正）
 *
 * @param options - 调用选项（可选 schema 字段）
 * @returns 解析后的 JSON 对象
 *
 * 使用场景：
 * - 角色生成（基础档案 + 完整个人设）
 * - 游戏复盘分析（发言摘要、MVP/评价/评分）
 */
export async function generateJSON<T>(
  options: GenerateOptions & { schema?: string }
): Promise<T> {
  const messagesWithFormat = [...options.messages];

  const lastMessage = messagesWithFormat[messagesWithFormat.length - 1];
  if (lastMessage && lastMessage.role === "user") {
    const suffix =
      "\n\nRespond with valid JSON only. No markdown, no code blocks, just raw JSON. If you need to include double quotes inside string values, escape them as \\\".";
    if (typeof lastMessage.content === "string") {
      lastMessage.content += suffix;
    } else if (Array.isArray(lastMessage.content)) {
      const parts = lastMessage.content;
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.type === "text") {
        lastPart.text += suffix;
      } else {
        parts.push({ type: "text", text: suffix });
      }
    }
  }

  const shouldForceJsonObject =
    !options.response_format && getProviderForModel(options.model) === "zenmux";

  const result = await generateCompletion({
    ...options,
    ...(shouldForceJsonObject ? { response_format: { type: "json_object" as const } } : {}),
    messages: messagesWithFormat,
  });

  try {
    return parseJsonTolerant<T>(result.content);
  } catch (firstError) {
    const retryMessages: LLMMessage[] = [
      ...messagesWithFormat,
      { role: "assistant", content: result.content.slice(0, 4000) },
      {
        role: "user",
        content: "The previous response was not valid JSON for the requested schema. Return valid JSON only, with no markdown and no extra text.",
      },
    ];

    const retryResult = await generateCompletion({
      ...options,
      ...(shouldForceJsonObject ? { response_format: { type: "json_object" as const } } : {}),
      messages: retryMessages,
    });

    try {
      return parseJsonTolerant<T>(retryResult.content);
    } catch {
      throw firstError;
    }
  }
}
