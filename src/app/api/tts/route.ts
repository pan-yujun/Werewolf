import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, requireCredits } from "@/lib/api-auth";
import type { IncomingHttpHeaders } from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import * as zlib from "node:zlib";
import { DEFAULT_VOICE_ID, isMimoVoiceId } from "@/lib/voice-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MiMo TTS API 配置
const MIMO_TTS_DEFAULT_API_URL = "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";

function getMimoTtsUrl(): string {
  const envBase = process.env.MIMO_API_BASE_URL?.trim();
  if (!envBase) return MIMO_TTS_DEFAULT_API_URL;
  // If the env var already includes the full endpoint, use it directly
  if (envBase.includes("/chat/completions")) return envBase;
  // Otherwise append /chat/completions to the base URL
  const withoutTrailingSlash = envBase.replace(/\/+$/, "");
  return `${withoutTrailingSlash}/chat/completions`;
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req as unknown as Request);
  if ("error" in auth) return auth.error;

  const headerApiKey = req.headers.get("x-minimax-api-key")?.trim();
  const headerMimoKey = req.headers.get("x-mimo-api-key")?.trim();
  if (!headerApiKey && !headerMimoKey) {
    const hasCredits = await requireCredits(auth.user.id);
    if (!hasCredits) {
      return NextResponse.json({ error: "Insufficient credits" }, { status: 403 });
    }
  }

  try {
    const parsed = await req.json().catch(() => ({} as any));
    const text = typeof parsed?.text === "string" ? parsed.text : String(parsed?.text ?? "");
    const voiceId = typeof parsed?.voiceId === "string" ? parsed.voiceId : String(parsed?.voiceId ?? "");

    const normText = text.trim();
    const normVoiceId = voiceId.trim();

    if (!normText || !normVoiceId) {
      return NextResponse.json({ error: "Missing text or voiceId" }, { status: 400 });
    }

    // 检测使用哪个 TTS 提供商
    const useMimoTts = isMimoVoiceId(normVoiceId) || !!headerMimoKey;

    if (useMimoTts) {
      // 使用 MiMo TTS
      return await handleMimoTts(normText, normVoiceId, headerMimoKey ?? null);
    } else {
      // 使用 MiniMax TTS
      return await handleMinimaxTts(normText, normVoiceId, req);
    }
  } catch (error) {
    console.error("TTS API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// MiMo TTS 处理函数
async function handleMimoTts(text: string, voiceId: string, headerMimoKey: string | null): Promise<NextResponse> {
  const mimoApiKey = headerMimoKey || process.env.MIMO_API_KEY;
  if (!mimoApiKey) {
    console.error("Missing MiMo API key");
    return NextResponse.json({ error: "Server configuration error: Missing MiMo API key" }, { status: 500 });
  }

  const mimoTtsUrl = getMimoTtsUrl();

  // MiMo TTS 请求格式
  const payload = {
    model: "mimo-v2.5-tts",
    messages: [
      { role: "user", content: `请用语音说：${text}` },
      { role: "assistant", content: text }
    ],
    max_tokens: 100,
  };

  try {
    const response = await fetch(mimoTtsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mimoApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("MiMo TTS API Error:", response.status, errorText);
      return NextResponse.json({ error: `MiMo TTS API error: ${errorText}` }, { status: response.status || 502 });
    }

    const result = await response.json();

    // 提取音频数据
    const audioData = result?.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
      console.error("MiMo TTS: No audio data in response");
      return NextResponse.json({ error: "MiMo TTS: No audio data in response" }, { status: 502 });
    }

    // 解码 base64 音频数据
    const audioBuffer = Buffer.from(audioData, "base64");

    // 返回音频
    return new NextResponse(audioBuffer, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": audioBuffer.length.toString(),
        "X-Mimo-Voice-Id": voiceId,
      },
    });
  } catch (error) {
    console.error("MiMo TTS fetch error:", error);
    return NextResponse.json({ error: "MiMo TTS fetch failed" }, { status: 502 });
  }
}

// MiniMax TTS 处理函数
async function handleMinimaxTts(text: string, voiceId: string, req: NextRequest): Promise<NextResponse> {
  const headerApiKey = req.headers.get("x-minimax-api-key")?.trim();
  const headerGroupId = req.headers.get("x-minimax-group-id")?.trim();
  const apiKey = headerApiKey || process.env.MINIMAX_API_KEY;
  const groupId = headerGroupId || process.env.MINIMAX_GROUP_ID;

  if (!apiKey || !groupId) {
    console.error("Missing MiniMax credentials");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  // MiniMax T2A V2 API Endpoint
  const baseUrlFromEnv = process.env.MINIMAX_API_BASE_URL;
  const primaryBaseUrl = baseUrlFromEnv || "https://api.minimax.chat";

  const candidateBaseUrls = [primaryBaseUrl];
  if (!baseUrlFromEnv) {
    candidateBaseUrls.push(
      primaryBaseUrl.includes("minimaxi.com")
        ? "https://api.minimax.chat"
        : "https://api.minimaxi.com"
    );
  }

  const payload = {
    model: process.env.MINIMAX_TTS_MODEL || "speech-01-turbo",
    text: text,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
  };

  const requestBuffer = async (inputUrl: string, init: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> => {
    const u = new URL(inputUrl);
    if (u.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${u.protocol}`);
    }

    return await new Promise((resolve, reject) => {
      const req2 = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port ? Number(u.port) : 443,
          path: `${u.pathname}${u.search}`,
          method: init.method,
          headers: init.headers,
          family: 4,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);

            const enc = res.headers["content-encoding"];
            const encStr = Array.isArray(enc) ? enc.join(",") : enc;

            let body = raw;
            try {
              if (typeof encStr === "string" && encStr) {
                const e = encStr.toLowerCase();
                if (e.includes("br")) body = zlib.brotliDecompressSync(raw);
                else if (e.includes("gzip")) body = zlib.gunzipSync(raw);
                else if (e.includes("deflate")) body = zlib.inflateSync(raw);
              }
            } catch (decompressErr) {
              console.error("MiniMax response decompress failed:", decompressErr);
              body = raw;
            }

            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body,
            });
          });
        }
      );

      req2.on("error", reject);
      req2.setTimeout(init.timeoutMs, () => {
        req2.destroy(new Error("RequestTimeout"));
      });

      if (init.body) req2.write(init.body);
      req2.end();
    });
  };

  const bufferToArrayBuffer = (b: Buffer): ArrayBuffer => {
    const ab = new ArrayBuffer(b.byteLength);
    new Uint8Array(ab).set(b);
    return ab;
  };

  const sniffAudioMime = (b: Buffer): { mime: string | null; reason?: string } => {
    if (!b || b.length < 4) return { mime: null, reason: "empty_or_too_short" };

    if (b.length >= 12 && b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WAVE") {
      return { mime: "audio/wav" };
    }

    if (b.slice(0, 4).toString("ascii") === "OggS") {
      return { mime: "audio/ogg" };
    }

    if (b.slice(0, 3).toString("ascii") === "ID3") {
      return { mime: "audio/mpeg" };
    }
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
      return { mime: "audio/mpeg" };
    }

    const head = b.slice(0, 64).toString("utf8").trim();
    if (head.startsWith("{") || head.startsWith("[") || head.toLowerCase().includes("error")) {
      return { mime: null, reason: "looks_like_text_or_json" };
    }

    return { mime: null, reason: "unknown_format" };
  };

  const respondAudio = (b: Buffer, extraHeaders?: Record<string, string>) => {
    const sniff = sniffAudioMime(b);
    if (!sniff.mime) {
      const preview = b.slice(0, 400).toString("utf8");
      return NextResponse.json(
        {
          error: "TTS audio is not in a supported format.",
          reason: sniff.reason,
          byteLength: b.length,
          preview,
        },
        { status: 502 }
      );
    }

    return new NextResponse(bufferToArrayBuffer(b), {
      headers: {
        "Content-Type": sniff.mime,
        "Content-Length": b.length.toString(),
        ...(extraHeaders ?? {}),
      },
    });
  };

  const pickFallbackVoiceId = (badVoiceId: string) => {
    const v = badVoiceId.toLowerCase();
    if (v.startsWith("female") || v.includes("female")) return DEFAULT_VOICE_ID.female;
    return DEFAULT_VOICE_ID.male;
  };

  const requestMiniMax = async (voiceIdForRequest: string) => {
    payload.voice_setting.voice_id = voiceIdForRequest;
    let response: { statusCode: number; headers: IncomingHttpHeaders; body: Buffer } | null = null;
    let lastError: unknown = null;

    for (const baseUrl of candidateBaseUrls) {
      const url = `${baseUrl}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;

      try {
        response = await requestBuffer(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            GroupId: groupId,
            "Accept-Encoding": "identity",
          },
          body: JSON.stringify(payload),
          timeoutMs: 30000,
        });
        break;
      } catch (e) {
        lastError = e;
        continue;
      }
    }

    if (!response) {
      const attempted = candidateBaseUrls.join(", ");
      console.error("MiniMax fetch failed. attempted base urls:", attempted, lastError);
    }

    return response;
  };

  let usedVoiceId = voiceId;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await requestMiniMax(usedVoiceId);

    if (!response) {
      return NextResponse.json(
        {
          error:
            "MiniMax fetch failed (connect timeout / network). Please set MINIMAX_API_BASE_URL to the correct domain.",
          attemptedBaseUrls: candidateBaseUrls,
        },
        { status: 502 }
      );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errorText = response.body.toString("utf8");
      console.error("MiniMax API Error:", response.statusCode, errorText);
      return NextResponse.json({ error: `MiniMax API error: ${errorText}` }, { status: response.statusCode || 502 });
    }

    const contentType = response.headers["content-type"];

    if (typeof contentType === "string" && contentType.includes("application/json")) {
      let json: any;
      try {
        json = JSON.parse(response.body.toString("utf8"));
      } catch (e) {
        const preview = response.body.slice(0, 600).toString("utf8");
        console.error("MiniMax JSON parse failed:", e, { preview });
        return NextResponse.json(
          { error: "MiniMax JSON parse failed", preview },
          { status: 502 }
        );
      }

      if (json.base_resp && json.base_resp.status_code !== 0) {
        const code = Number(json.base_resp.status_code);
        const msg = String(json.base_resp.status_msg || "");

        if (code === 2054 && attempt === 0) {
          const fallback = pickFallbackVoiceId(usedVoiceId);
          if (fallback !== usedVoiceId) {
            usedVoiceId = fallback;
            continue;
          }
        }

        console.error("MiniMax base_resp error:", {
          status_code: code,
          status_msg: msg,
          voiceId: usedVoiceId,
          textPreview: String(text).slice(0, 200),
        });
        return NextResponse.json(
          {
            error: "MiniMax base_resp error",
            status_code: code,
            status_msg: msg,
            voiceId: usedVoiceId,
            textPreview: String(text).slice(0, 200),
          },
          { status: 502 }
        );
      }

      const dataStr: unknown =
        (typeof json.data === "string" ? json.data : undefined) ??
        json.data?.audio ??
        json.data?.data ??
        json.audio?.data ??
        json.audio_data;

      const audioUrl: unknown = json.audio?.url ?? json.data?.url ?? json.url;

      if (typeof audioUrl === "string" && audioUrl.startsWith("http")) {
        const audioResp = await requestBuffer(audioUrl, {
          method: "GET",
          headers: {
            "Accept-Encoding": "identity",
          },
          timeoutMs: 30000,
        });
        if (audioResp.statusCode < 200 || audioResp.statusCode >= 300) {
          return NextResponse.json({ error: `MiniMax audio url fetch failed: ${audioResp.statusCode}` }, { status: 502 });
        }

        return respondAudio(audioResp.body, {
          "X-Minimax-Voice-Id-Requested": voiceId,
          "X-Minimax-Voice-Id-Used": usedVoiceId,
        });
      }

      if (typeof dataStr === "string" && dataStr.trim()) {
        const t = dataStr.trim();

        const maybeB64 = t.startsWith("data:") ? t.split(",").slice(1).join(",") : t;
        const looksLikeBase64 = /[+/=]/.test(maybeB64);
        const looksLikeHex = !looksLikeBase64 && /^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0;

        let buffer: Buffer;
        let altBuffer: Buffer | null = null;

        if (looksLikeHex) {
          buffer = Buffer.from(t, "hex");
          try {
            altBuffer = Buffer.from(maybeB64, "base64");
          } catch {
            altBuffer = null;
          }
        } else {
          buffer = Buffer.from(maybeB64, "base64");
          if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) {
            try {
              altBuffer = Buffer.from(t, "hex");
            } catch {
              altBuffer = null;
            }
          }
        }

        const primarySniff = sniffAudioMime(buffer);
        if (!primarySniff.mime && altBuffer) {
          const altSniff = sniffAudioMime(altBuffer);
          if (altSniff.mime) {
            buffer = altBuffer;
          }
        }

        return respondAudio(buffer, {
          "X-Minimax-Voice-Id-Requested": voiceId,
          "X-Minimax-Voice-Id-Used": usedVoiceId,
        });
      }
    }

    return respondAudio(response.body, {
      "X-Minimax-Voice-Id-Requested": voiceId,
      "X-Minimax-Voice-Id-Used": usedVoiceId,
    });
  }

  return NextResponse.json(
    {
      error: "MiniMax voiceId retry exhausted",
      voiceId: usedVoiceId,
      textPreview: String(text).slice(0, 200),
    },
    { status: 502 }
  );
}
