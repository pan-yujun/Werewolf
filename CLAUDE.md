# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start dev server (webpack mode) at localhost:3000
pnpm build        # Production build (webpack mode)
pnpm start        # Start production server
pnpm lint         # Run ESLint
```

> Note: The project explicitly uses `--webpack` flag (not Turbopack) for both dev and build.

## Environment Setup

Copy `.env.example` to `.env.local` and fill in:
- `ZENMUX_API_KEY` — primary AI provider (ZenMux unified LLM gateway)
- `MINIMAX_API_KEY` / `MINIMAX_GROUP_ID` — TTS voice synthesis
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — auth & database
- `DASHSCOPE_API_KEY` — Alibaba Cloud model support
- `VOLCENGINE_API_KEY` / `VOLCENGINE_BASE_URL` — 火山引擎 Agent Plan（默认 `https://ark.cn-beijing.volces.com/api/plan/v3`）
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_ID` — payments
- `NEXT_PUBLIC_WATCHA_CLIENT_ID` / `WATCHA_CLIENT_SECRET` — optional OAuth
- `NEWAPI_API_KEY` / `NEWAPI_BASE_URL` — optional custom model endpoint

## Architecture Overview

Wolfcha is an AI-powered Werewolf (社交推理) game built with **Next.js 16 App Router**. Every non-human player is controlled by an LLM, with the player competing against AI characters.

### State Management

Game state is managed with **Jotai atoms** (`src/store/game-machine.ts`):
- `gameStateAtom` — the single source of truth for all game state, persisted to `localStorage` (24h TTL) for page refresh recovery
- `src/store/settings.ts` — user settings atom

### Game Logic Layer

The game logic is split across several layers:

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Game Master | `src/lib/game-master.ts` | Pure functions: player setup, phase transitions, win condition checks, kill resolution |
| Flow Controller | `src/lib/game-flow-controller.ts` | `AsyncFlowController` — interrupt/pause/resume async game flows; `FlowToken` pattern prevents stale callbacks |
| Phase Manager | `src/game/core/PhaseManager.ts` | Maps each `Phase` enum value to a `GamePhase` class that generates LLM prompts |
| Game Phases (classes) | `src/game/phases/` | `NightPhase`, `DaySpeechPhase`, `VotePhase`, `BadgePhase`, `HunterPhase`, `WhiteWolfKingBoomPhase` |
| Game Logic Hook | `src/hooks/useGameLogic.ts` | React hook that orchestrates the full game loop; delegates to sub-hooks |
| Phase Sub-hooks | `src/hooks/game-phases/` | `useDayPhase`, `useBadgePhase`, `useSpecialEvents` |
| Dialogue Manager | `src/hooks/useDialogueManager.ts` | Streaming AI speech management, typewriter effect |

### Game Phases (type `Phase`)

Defined in `src/types/game.ts`. Night: `NIGHT_START → NIGHT_GUARD_ACTION → NIGHT_WOLF_ACTION → NIGHT_WITCH_ACTION → NIGHT_SEER_ACTION → NIGHT_RESOLVE`. Day: `DAY_START → DAY_BADGE_SIGNUP → DAY_BADGE_SPEECH → DAY_BADGE_ELECTION → DAY_SPEECH → DAY_VOTE → DAY_RESOLVE`. Special: `HUNTER_SHOOT`, `WHITE_WOLF_KING_BOOM`, `BADGE_TRANSFER`, `GAME_END`.

### AI Integration

- All LLM calls go through the **`/api/chat`** route (`src/app/api/chat/route.ts`), which proxies to ZenMux, Dashscope, MiMo, ModelScope, Volcengine, or a custom NewAPI endpoint based on the model's provider
- Models are registered in `src/types/game.ts` as `ALL_MODELS` and `PROJECT_MODELS` (each as `ModelRef` with `provider`, `model`, optional `temperature`/`reasoning`)
- **Provider list**: `"zenmux" | "dashscope" | "tokendance" | "mimo" | "modelscope" | "volcengine"`
- Prompt construction per phase is handled by `GamePhase` subclasses via `getPrompt(context, player): PromptResult`
- `src/lib/llm.ts` — low-level streaming fetch helper
- `src/lib/character-generator.ts` — generates AI player personas (MBTI, background, style); supports Genshin mode
- `src/lib/ai-config.ts` — routing for GENERATOR / SUMMARY / REVIEW model roles

### Audio

- `src/lib/audio-manager.ts` — `AudioManager` singleton; task-based sequential audio queue
- `src/lib/narrator-audio-player.ts` — narrator TTS playback
- `src/lib/narrator-voice.ts` — voice selection logic
- `/api/tts` route — calls MiniMax TTS API for character speech synthesis

### i18n

`next-intl` with messages defined in `src/i18n/messages.ts`. Locale stored via `src/i18n/locale-store.ts`. The `src/i18n/translator.ts` provides `getI18n()` for use outside React components.

### API Routes (`src/app/api/`)

| Route | Purpose |
|-------|---------|
| `/api/chat` | LLM proxy (ZenMux / Dashscope / MiMo / ModelScope / Volcengine / NewAPI) |
| `/api/validate-key` | Validate user API keys for each provider |
| `/api/list-models` | Fetch available models from provider's `/v1/models` endpoint |
| `/api/verify-models` | Verify which fetched models are actually usable |
| `/api/tts` | MiniMax TTS synthesis |
| `/api/stt` | Speech-to-text |
| `/api/credits/*` | Credit consumption, daily bonus, referral, redeem |
| `/api/game-sessions` | Session tracking (Supabase) |
| `/api/stripe/*` | Payment link & webhook |
| `/api/auth/watcha/*` | Watcha OAuth2 callback |

### Key Conventions

- **`FlowToken` pattern**: Before any async operation, capture `flowController.getToken()`. After `await`, call `token.isValid()` to abort if the flow was interrupted (e.g., game reset mid-speech).
- **Phase prompt generation**: Add a new phase by creating/extending a `GamePhase` subclass in `src/game/phases/`, then register it in `PhaseManager`.
- **Model routing**: Built-in models use ZenMux or MiMo providers. Custom user API keys route through provider-specific paths. See `src/lib/api-keys.ts` for key resolution.
- **Adding a new provider**: ① `ModelRef.provider` 联合类型新增 → ② `MODEL_IDS` / `ALL_MODELS` / `PROJECT_MODELS` 新增 → ③ `api-keys.ts` 新增 get/set/has 函数 → ④ `llm.ts` 新增 header 传递 → ⑤ `chat/route.ts` 新增 provider 分支 → ⑥ `validate-key` / `list-models` / `verify-models` 新增 → ⑦ `UserProfileContent.tsx` 新增 UI 区块 → ⑧ `character-generator.ts` 新增 `has<Key>Key()` 判断 → ⑨ i18n 新增翻译
- Uses **pnpm** as package manager.
