import { NextRequest, NextResponse } from "next/server";

const PROVIDER_MODELS_URL: Record<string, string> = {
  modelscope: "https://api-inference.modelscope.cn/v1/models",
  zenmux: "https://zenmux.ai/api/v1/models",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
  mimo: "https://api.mimo.xiaomi.com/v1/models",
};

const TIMEOUT_MS = 15000;

export async function POST(request: NextRequest) {
  try {
    const provider = request.headers.get("x-provider")?.trim() || "";
    const apiKey = request.headers.get("x-api-key")?.trim() || "";

    if (!provider || !PROVIDER_MODELS_URL[provider]) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 400 }
      );
    }

    const url = PROVIDER_MODELS_URL[provider];
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Some providers need auth, some don't
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

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return NextResponse.json(
        { error: `Provider returned ${response.status}: ${errorText.slice(0, 200)}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const models: string[] = Array.isArray(data?.data)
      ? data.data
          .map((m: { id?: string }) => m?.id)
          .filter((id: string | undefined): id is string => typeof id === "string" && id.length > 0)
      : [];

    return NextResponse.json({ models });
  } catch (error) {
    return NextResponse.json(
      { error: String(error ?? "Unknown error") },
      { status: 500 }
    );
  }
}
