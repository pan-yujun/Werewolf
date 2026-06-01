import { NextResponse } from "next/server";

/**
 * Returns pre-configured API keys from .env.local (server-side only).
 * These are used to auto-fill the "用自己的Key玩" page on first load.
 * Keys from localStorage take precedence (user can override).
 */
export async function GET() {
  const keys: Record<string, string> = {};

  const envMap: Record<string, string> = {
    zenmux: "ZENMUX_API_KEY",
    dashscope: "DASHSCOPE_API_KEY",
    mimo: "MIMO_API_KEY",
    modelscope: "MODELSCOPE_API_KEY",
    minimax: "MINIMAX_API_KEY",
    minimaxGroupId: "MINIMAX_GROUP_ID",
  };

  for (const [key, envVar] of Object.entries(envMap)) {
    const value = process.env[envVar]?.trim();
    if (value) {
      keys[key] = value;
    }
  }

  return NextResponse.json({ keys });
}
