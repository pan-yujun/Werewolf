import { NextRequest, NextResponse } from "next/server";

const PROVIDER_MODELS_URL: Record<string, string> = {
  modelscope: "https://api-inference.modelscope.cn/v1/models",
  zenmux: "https://zenmux.ai/api/v1/models",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
};

function getVolcengineModelsUrl(): string {
  const envBase = process.env.VOLCENGINE_BASE_URL?.trim();
  if (!envBase) return "https://ark.cn-beijing.volces.com/api/plan/v3/models";
  const withoutTrailingSlash = envBase.replace(/\/+$/, "");
  const baseUrl = withoutTrailingSlash.replace(/\/chat\/completions$/, "");
  return `${baseUrl}/models`;
}

function getMimoModelsUrl(): string {
  const envBase = process.env.MIMO_API_BASE_URL?.trim();
  if (!envBase) return "https://api.mimo.xiaomi.com/v1/models";
  const withoutTrailingSlash = envBase.replace(/\/+$/, "");
  const baseUrl = withoutTrailingSlash.replace(/\/chat\/completions$/, "");
  return `${baseUrl}/models`;
}

const TIMEOUT_MS = 15000;

// Patterns that indicate a model is NOT a general chat model
const EXCLUDE_PATTERNS = [
  /image/i, /edit/i, /vl\b/i, /vision/i,
  /coder/i, /code\b/i,
  /embed/i, /rerank/i,
  /tts/i, /asr/i, /whisper/i,
  /ocr/i, /translate/i,
  /det/i, /seg/i, /cls/i,
  /audio/i, /music/i, /speech/i,
  /diffusion/i, /flux/i, /stable/i,
  /gui-owl/i, /compass/i,
  /antangel/i, /medical/i,
  /sql/i, /math/i,
];

// Known non-chat models on ModelScope
const EXCLUDE_IDS = new Set([
  "MiniMax/MiniMax-M1-80k",
  "MiniMax/MiniMax-M2.5",
  "MiniMax/MiniMax-M2.7",
  "Qwen/QVQ-72B-Preview",
  "Qwen/Qwen-Image-Edit",
  "MusePublic/Qwen-Image-Edit",
]);

function isChatModel(id: string): boolean {
  if (EXCLUDE_IDS.has(id)) return false;
  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(id)) return false;
  }
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const provider = request.headers.get("x-provider")?.trim() || "";
    const apiKey = request.headers.get("x-api-key")?.trim() || "";

    if (!provider || (provider !== "mimo" && !PROVIDER_MODELS_URL[provider])) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 400 }
      );
    }

    const url = provider === "mimo" ? getMimoModelsUrl() : PROVIDER_MODELS_URL[provider];

    console.log(`[list-models] Fetching models for ${provider} from ${url}`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey && provider !== "modelscope") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      const isAbort =
        fetchError instanceof Error && fetchError.name === "AbortError";
      console.error(`[list-models] ${provider} fetch error:`, fetchError);
      return NextResponse.json(
        {
          error: isAbort
            ? `Request timeout after ${TIMEOUT_MS / 1000}s`
            : `Network error: ${String(fetchError)}`,
        },
        { status: isAbort ? 504 : 502 }
      );
    }

    clearTimeout(timeoutId);
    console.log(`[list-models] ${provider} response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[list-models] ${provider} error:`, errorText.slice(0, 300));
      return NextResponse.json(
        { error: `Provider returned ${response.status}: ${errorText.slice(0, 200)}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    let models: string[] = Array.isArray(data?.data)
      ? data.data
          .map((m: { id?: string }) => m?.id)
          .filter((id: string | undefined): id is string => typeof id === "string" && id.length > 0)
      : [];

    // For ModelScope: filter to chat-capable models only
    if (provider === "modelscope") {
      const before = models.length;
      models = models.filter(isChatModel);
      console.log(`[list-models] modelscope filtered: ${before} → ${models.length} chat models`);
    }

    console.log(`[list-models] ${provider} returned ${models.length} models`);
    return NextResponse.json({ models });
  } catch (error) {
    console.error("[list-models] Unexpected error:", error);
    return NextResponse.json(
      { error: String(error ?? "Unknown error") },
      { status: 500 }
    );
  }
}
