import { NextRequest, NextResponse } from "next/server";

const PROVIDER_CHAT_URL: Record<string, string> = {
  modelscope: "https://api-inference.modelscope.cn/v1/chat/completions",
  zenmux: "https://zenmux.ai/api/v1/chat/completions",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
};

function getVolcengineChatUrl(): string {
  const envBase = process.env.VOLCENGINE_BASE_URL?.trim();
  if (!envBase) return "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions";
  if (envBase.includes("/chat/completions")) return envBase;
  const withoutTrailingSlash = envBase.replace(/\/+$/, "");
  return `${withoutTrailingSlash}/chat/completions`;
}

function getMimoChatUrl(): string {
  const envBase = process.env.MIMO_API_BASE_URL?.trim();
  if (!envBase) return "https://api.mimo.xiaomi.com/v1/chat/completions";
  if (envBase.includes("/chat/completions")) return envBase;
  const withoutTrailingSlash = envBase.replace(/\/+$/, "");
  return `${withoutTrailingSlash}/chat/completions`;
}

const VERIFY_TIMEOUT_MS = 10000;
const CONCURRENCY = 5;

async function verifyOneModel(
  chatUrl: string,
  apiKey: string,
  modelId: string,
  provider: string,
): Promise<{ model: string; valid: boolean }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json().catch(() => null);
      // Check if response has actual content
      const hasContent = data?.choices?.[0]?.message?.content?.length > 0
        || data?.choices?.[0]?.text?.length > 0;
      return { model: modelId, valid: hasContent || response.status === 200 };
    }

    return { model: modelId, valid: false };
  } catch {
    clearTimeout(timeoutId);
    return { model: modelId, valid: false };
  }
}

export async function POST(request: NextRequest) {
  try {
    const provider = request.headers.get("x-provider")?.trim() || "";
    const apiKey = request.headers.get("x-api-key")?.trim() || "";
    const body = await request.json().catch(() => ({}));
    const models: string[] = Array.isArray(body?.models) ? body.models : [];

    if (!provider || models.length === 0) {
      return NextResponse.json({ error: "Missing provider or models" }, { status: 400 });
    }

    const chatUrl = provider === "mimo" ? getMimoChatUrl() : (PROVIDER_CHAT_URL[provider] || "");
    if (!chatUrl) {
      return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
    }

    console.log(`[verify-models] Verifying ${models.length} models for ${provider}`);

    // Run with concurrency limit
    const results: Record<string, boolean> = {};
    for (let i = 0; i < models.length; i += CONCURRENCY) {
      const batch = models.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((modelId) => verifyOneModel(chatUrl, apiKey, modelId, provider))
      );
      for (const r of batchResults) {
        results[r.model] = r.valid;
      }
    }

    const validCount = Object.values(results).filter(Boolean).length;
    console.log(`[verify-models] ${provider}: ${validCount}/${models.length} models verified`);

    return NextResponse.json({ results });
  } catch (error) {
    console.error("[verify-models] Error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
