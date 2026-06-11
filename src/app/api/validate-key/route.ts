import { NextRequest, NextResponse } from "next/server";
import { DASHSCOPE_VALIDATION_MODEL, MIMO_VALIDATION_MODEL, MODELSCOPE_VALIDATION_MODEL, VOLCENGINE_VALIDATION_MODEL, ZENMUX_VALIDATION_MODEL } from "@/types/game";

const ZENMUX_API_URL = "https://zenmux.ai/api/v1/chat/completions";
const DASHSCOPE_CHAT_COMPLETIONS_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const MIMO_DEFAULT_API_URL = "https://api.mimo.xiaomi.com/v1/chat/completions";
const MODELSCOPE_CHAT_COMPLETIONS_URL = "https://api-inference.modelscope.cn/v1/chat/completions";
// 火山引擎 API URL 解析（与 chat/route.ts 保持一致）
const VOLCENGINE_DEFAULT_API_URL = "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions";

function getVolcengineUrl(): string {
  const envBase = process.env.VOLCENGINE_BASE_URL?.trim();
  if (!envBase) return VOLCENGINE_DEFAULT_API_URL;
  if (envBase.includes("/chat/completions")) return envBase;
  const withoutTrailingSlash = envBase.replace(/\/+$/, "");
  return `${withoutTrailingSlash}/chat/completions`;
}

const VALIDATION_TIMEOUT_MS = 15000;

function getMimoUrl(): string {
  const envBase = process.env.MIMO_API_BASE_URL?.trim();
  if (!envBase) return MIMO_DEFAULT_API_URL;
  if (envBase.includes("/chat/completions")) return envBase;
  const withoutTrailingSlash = envBase.replace(/\/+$/, "");
  return `${withoutTrailingSlash}/chat/completions`;
}

type Provider = "zenmux" | "dashscope" | "tokendance" | "mimo" | "modelscope" | "volcengine";

interface ValidationResult {
  provider: Provider;
  valid: boolean;
  error?: string;
  errorCode?: string;
}

async function validateZenmuxKey(apiKey: string): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(ZENMUX_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ZENMUX_VALIDATION_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { provider: "zenmux", valid: true };
    }

    const errorText = await response.text().catch(() => "");
    let errorCode = "";
    let errorMessage = "";

    try {
      const errorJson = JSON.parse(errorText);
      errorCode = errorJson?.error?.code || errorJson?.code || "";
      errorMessage = errorJson?.error?.message || errorJson?.message || "";
    } catch {
      errorMessage = errorText;
    }

    if (response.status === 401 || response.status === 403) {
      return {
        provider: "zenmux",
        valid: false,
        error: "API Key 无效或已过期",
        errorCode: "invalid_key",
      };
    }

    if (response.status === 402 || response.status === 429) {
      const isQuotaError =
        errorCode.includes("insufficient") ||
        errorCode.includes("quota") ||
        errorCode.includes("balance") ||
        errorMessage.includes("insufficient") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("余额");

      if (isQuotaError || response.status === 402) {
        return {
          provider: "zenmux",
          valid: false,
          error: "API Key 余额不足，请前往 zenmux.ai 充值",
          errorCode: "insufficient_quota",
        };
      }

      return {
        provider: "zenmux",
        valid: false,
        error: "请求频率超限，请稍后再试",
        errorCode: "rate_limit",
      };
    }

    return {
      provider: "zenmux",
      valid: false,
      error: `验证失败: ${response.status} - ${errorMessage || errorText}`,
      errorCode: "unknown",
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        provider: "zenmux",
        valid: false,
        error: "验证超时，请检查网络连接",
        errorCode: "timeout",
      };
    }
    return {
      provider: "zenmux",
      valid: false,
      error: `网络错误: ${String(error)}`,
      errorCode: "network_error",
    };
  }
}

function getTokendanceUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  return `${withoutTrailingSlash}/chat/completions`;
}

async function validateTokendanceKey(apiKey: string, baseUrl: string): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  const tokendanceUrl = getTokendanceUrl(baseUrl);
  if (!tokendanceUrl) {
    return {
      provider: "tokendance",
      valid: false,
      error: "无效的 Base URL",
      errorCode: "invalid_base_url",
    };
  }

  try {
    const response = await fetch(tokendanceUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "minimax-m2.7",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { provider: "tokendance", valid: true };
    }

    const errorText = await response.text().catch(() => "");
    let errorCode = "";
    let errorMessage = "";

    try {
      const errorJson = JSON.parse(errorText);
      errorCode = errorJson?.error?.code || errorJson?.code || "";
      errorMessage = errorJson?.error?.message || errorJson?.message || "";
    } catch {
      errorMessage = errorText;
    }

    if (response.status === 401 || response.status === 403) {
      return {
        provider: "tokendance",
        valid: false,
        error: "API Key 无效或已过期",
        errorCode: "invalid_key",
      };
    }

    if (response.status === 402 || response.status === 429) {
      const isQuotaError =
        errorCode.includes("insufficient") ||
        errorCode.includes("quota") ||
        errorCode.includes("balance") ||
        errorMessage.includes("insufficient") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("余额");

      if (isQuotaError || response.status === 402) {
        return {
          provider: "tokendance",
          valid: false,
          error: "API Key 余额不足",
          errorCode: "insufficient_quota",
        };
      }

      return {
        provider: "tokendance",
        valid: false,
        error: "请求频率超限，请稍后再试",
        errorCode: "rate_limit",
      };
    }

    return {
      provider: "tokendance",
      valid: false,
      error: `验证失败: ${response.status} - ${errorMessage || errorText}`,
      errorCode: "unknown",
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        provider: "tokendance",
        valid: false,
        error: "验证超时，请检查网络连接或 Base URL 是否正确",
        errorCode: "timeout",
      };
    }
    return {
      provider: "tokendance",
      valid: false,
      error: `网络错误: ${String(error)}`,
      errorCode: "network_error",
    };
  }
}

async function validateDashscopeKey(apiKey: string): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(DASHSCOPE_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DASHSCOPE_VALIDATION_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { provider: "dashscope", valid: true };
    }

    const errorText = await response.text().catch(() => "");
    let errorCode = "";
    let errorMessage = "";

    try {
      const errorJson = JSON.parse(errorText);
      errorCode = errorJson?.error?.code || errorJson?.code || "";
      errorMessage = errorJson?.error?.message || errorJson?.message || "";
    } catch {
      errorMessage = errorText;
    }

    if (response.status === 401 || response.status === 403) {
      return {
        provider: "dashscope",
        valid: false,
        error: "百炼 API Key 无效或已过期",
        errorCode: "invalid_key",
      };
    }

    if (response.status === 402 || response.status === 429) {
      const isQuotaError =
        errorCode.includes("insufficient") ||
        errorCode.includes("quota") ||
        errorCode.includes("Arrearage") ||
        errorMessage.includes("insufficient") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("余额") ||
        errorMessage.includes("欠费");

      if (isQuotaError || response.status === 402) {
        return {
          provider: "dashscope",
          valid: false,
          error: "百炼 API Key 余额不足，请前往阿里云百炼控制台充值",
          errorCode: "insufficient_quota",
        };
      }

      return {
        provider: "dashscope",
        valid: false,
        error: "请求频率超限，请稍后再试",
        errorCode: "rate_limit",
      };
    }

    return {
      provider: "dashscope",
      valid: false,
      error: `验证失败: ${response.status} - ${errorMessage || errorText}`,
      errorCode: "unknown",
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        provider: "dashscope",
        valid: false,
        error: "验证超时，请检查网络连接",
        errorCode: "timeout",
      };
    }
    return {
      provider: "dashscope",
      valid: false,
      error: `网络错误: ${String(error)}`,
      errorCode: "network_error",
    };
  }
}

async function validateMimoKey(apiKey: string): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(getMimoUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MIMO_VALIDATION_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { provider: "mimo", valid: true };
    }

    const errorText = await response.text().catch(() => "");
    let errorCode = "";
    let errorMessage = "";

    try {
      const errorJson = JSON.parse(errorText);
      errorCode = errorJson?.error?.code || errorJson?.code || "";
      errorMessage = errorJson?.error?.message || errorJson?.message || "";
    } catch {
      errorMessage = errorText;
    }

    if (response.status === 401 || response.status === 403) {
      return {
        provider: "mimo",
        valid: false,
        error: "Mimo API Key 无效或已过期",
        errorCode: "invalid_key",
      };
    }

    if (response.status === 402 || response.status === 429) {
      const isQuotaError =
        errorCode.includes("insufficient") ||
        errorCode.includes("quota") ||
        errorCode.includes("balance") ||
        errorMessage.includes("insufficient") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("余额");

      if (isQuotaError || response.status === 402) {
        return {
          provider: "mimo",
          valid: false,
          error: "Mimo API Key 余额不足",
          errorCode: "insufficient_quota",
        };
      }

      return {
        provider: "mimo",
        valid: false,
        error: "请求频率超限，请稍后再试",
        errorCode: "rate_limit",
      };
    }

    return {
      provider: "mimo",
      valid: false,
      error: `验证失败: ${response.status} - ${errorMessage || errorText}`,
      errorCode: "unknown",
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        provider: "mimo",
        valid: false,
        error: "验证超时，请检查网络连接",
        errorCode: "timeout",
      };
    }
    return {
      provider: "mimo",
      valid: false,
      error: `网络错误: ${String(error)}`,
      errorCode: "network_error",
    };
  }
}

async function validateModelscopeKey(apiKey: string): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    console.log("[validate-modelscope] Validating with model:", MODELSCOPE_VALIDATION_MODEL, "url:", MODELSCOPE_CHAT_COMPLETIONS_URL);
    const response = await fetch(MODELSCOPE_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELSCOPE_VALIDATION_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    console.log("[validate-modelscope] Response status:", response.status);

    if (response.ok) {
      return { provider: "modelscope", valid: true };
    }

    const errorText = await response.text().catch(() => "");
    console.log("[validate-modelscope] Error response:", errorText.slice(0, 500));
    let errorCode = "";
    let errorMessage = "";

    try {
      const errorJson = JSON.parse(errorText);
      errorCode = errorJson?.error?.code || errorJson?.code || "";
      errorMessage = errorJson?.error?.message || errorJson?.message || "";
    } catch {
      errorMessage = errorText;
    }

    if (response.status === 401 || response.status === 403) {
      return {
        provider: "modelscope",
        valid: false,
        error: "魔搭 API Token 无效或已过期",
        errorCode: "invalid_key",
      };
    }

    if (response.status === 402 || response.status === 429) {
      const isQuotaError =
        errorCode.includes("insufficient") ||
        errorCode.includes("quota") ||
        errorCode.includes("balance") ||
        errorMessage.includes("insufficient") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("余额");

      if (isQuotaError || response.status === 402) {
        return {
          provider: "modelscope",
          valid: false,
          error: "魔搭 API 额度不足，请前往 modelscope.cn 充值",
          errorCode: "insufficient_quota",
        };
      }

      return {
        provider: "modelscope",
        valid: false,
        error: "请求频率超限，请稍后再试",
        errorCode: "rate_limit",
      };
    }

    return {
      provider: "modelscope",
      valid: false,
      error: `验证失败: ${response.status} - ${errorMessage || errorText}`,
      errorCode: "unknown",
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[validate-modelscope] Exception:", error);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        provider: "modelscope",
        valid: false,
        error: "验证超时，请检查网络连接",
        errorCode: "timeout",
      };
    }
    return {
      provider: "modelscope",
      valid: false,
      error: `网络错误: ${String(error)}`,
      errorCode: "network_error",
    };
  }
}

// 验证火山引擎 API Key — 发送 "hi" 测试连通性，使用 VOLCENGINE_VALIDATION_MODEL
async function validateVolcengineKey(apiKey: string): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(getVolcengineUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOLCENGINE_VALIDATION_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { provider: "volcengine", valid: true };
    }

    const errorText = await response.text().catch(() => "");
    let errorCode = "";
    let errorMessage = "";

    try {
      const errorJson = JSON.parse(errorText);
      errorCode = errorJson?.error?.code || errorJson?.code || "";
      errorMessage = errorJson?.error?.message || errorJson?.message || "";
    } catch {
      errorMessage = errorText;
    }

    if (response.status === 401 || response.status === 403) {
      return {
        provider: "volcengine",
        valid: false,
        error: "火山引擎 API Key 无效或已过期",
        errorCode: "invalid_key",
      };
    }

    if (response.status === 402 || response.status === 429) {
      const isQuotaError =
        errorCode.includes("insufficient") ||
        errorCode.includes("quota") ||
        errorCode.includes("balance") ||
        errorMessage.includes("insufficient") ||
        errorMessage.includes("quota") ||
        errorMessage.includes("余额");

      if (isQuotaError || response.status === 402) {
        return {
          provider: "volcengine",
          valid: false,
          error: "火山引擎 API 额度不足，请前往火山引擎控制台充值",
          errorCode: "insufficient_quota",
        };
      }

      return {
        provider: "volcengine",
        valid: false,
        error: "请求频率超限，请稍后再试",
        errorCode: "rate_limit",
      };
    }

    return {
      provider: "volcengine",
      valid: false,
      error: `验证失败: ${response.status} - ${errorMessage || errorText}`,
      errorCode: "unknown",
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        provider: "volcengine",
        valid: false,
        error: "验证超时，请检查网络连接",
        errorCode: "timeout",
      };
    }
    return {
      provider: "volcengine",
      valid: false,
      error: `网络错误: ${String(error)}`,
      errorCode: "network_error",
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const zenmuxKey = request.headers.get("x-zenmux-api-key")?.trim() || "";
    const dashscopeKey = request.headers.get("x-dashscope-api-key")?.trim() || "";
    const tokendanceKey = request.headers.get("x-tokendance-api-key")?.trim() || "";
    const tokendanceBaseUrl = request.headers.get("x-tokendance-base-url")?.trim() || "";
    const mimoKey = request.headers.get("x-mimo-api-key")?.trim() || "";
    const modelscopeKey = request.headers.get("x-modelscope-api-key")?.trim() || "";
    const volcengineKey = request.headers.get("x-volcengine-api-key")?.trim() || "";

    if (!zenmuxKey && !dashscopeKey && !tokendanceKey && !mimoKey && !modelscopeKey && !volcengineKey) {
      return NextResponse.json(
        { error: "未提供任何 API Key", valid: false },
        { status: 400 }
      );
    }

    const results: ValidationResult[] = [];
    const validationPromises: Promise<ValidationResult>[] = [];

    if (zenmuxKey) {
      validationPromises.push(validateZenmuxKey(zenmuxKey));
    }
    if (dashscopeKey) {
      validationPromises.push(validateDashscopeKey(dashscopeKey));
    }
    if (tokendanceKey && tokendanceBaseUrl) {
      validationPromises.push(validateTokendanceKey(tokendanceKey, tokendanceBaseUrl));
    } else if (tokendanceKey && !tokendanceBaseUrl) {
      results.push({
        provider: "tokendance",
        valid: false,
        error: "未提供 TokenDance Base URL",
        errorCode: "missing_base_url",
      });
    }
    if (mimoKey) {
      validationPromises.push(validateMimoKey(mimoKey));
    }
    if (modelscopeKey) {
      validationPromises.push(validateModelscopeKey(modelscopeKey));
    }
    if (volcengineKey) {
      validationPromises.push(validateVolcengineKey(volcengineKey));
    }

    const settled = await Promise.all(validationPromises);
    results.push(...settled);

    const hasValidKey = results.some((r) => r.valid);
    const errors = results.filter((r) => !r.valid);

    if (hasValidKey) {
      return NextResponse.json({
        valid: true,
        results,
      });
    }

    const primaryError = errors.find((e) => e.errorCode === "insufficient_quota") || errors[0];

    return NextResponse.json({
      valid: false,
      error: primaryError?.error || "API Key 验证失败",
      errorCode: primaryError?.errorCode || "unknown",
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: String(error ?? "Unknown error"), valid: false },
      { status: 500 }
    );
  }
}
