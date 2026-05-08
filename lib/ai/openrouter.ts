const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// OpenRouter membatasi `models` array maksimal 3 entri (1 primary + 2 fallback).
const MAX_MODELS_IN_REQUEST = 3;

const DEFAULT_MODEL = "inclusionai/ring-2.6-1t:free";

const DEFAULT_FALLBACKS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "poolside/laguna-xs.2:free",
  // Cadangan tambahan; tidak ikut dikirim karena cap 3 model per request.
  "baidu/cobuddy:free",
];

export function getOpenRouterModel() {
  return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
}

export function getOpenRouterFallbacks(primary: string) {
  const raw = process.env.OPENROUTER_FALLBACK_MODELS?.trim();
  const list = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : DEFAULT_FALLBACKS;
  return list.filter((model) => model !== primary);
}

function getOpenRouterApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY belum diatur di environment server.");
  }
  return apiKey;
}

type GenerateOptions = {
  systemInstruction: string;
  prompt: string;
  /** "application/json" akan mengaktifkan JSON mode di OpenRouter. */
  responseMimeType?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Override model utama untuk satu panggilan. */
  model?: string;
  /** Override fallback chain untuk satu panggilan. */
  fallbackModels?: string[];
};

type OpenRouterChoice = {
  message?: {
    role?: string;
    content?: string | null;
  };
  finish_reason?: string;
};

type OpenRouterResponse = {
  id?: string;
  model?: string;
  choices?: OpenRouterChoice[];
  error?: { message?: string; code?: number | string };
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bersihkan artefak reasoning model (Ring-2.6-1T, Nemotron, dll) yang sering
 * meng-output blok <think>...</think> atau <reasoning>...</reasoning> sebelum
 * konten utama. Tanpa ini, JSON.parse di downstream akan gagal dan field
 * `options` tidak ikut terbawa ke UI.
 */
function sanitizeReasoningArtifacts(
  content: string | null | undefined,
): string {
  if (!content) return "";

  const stripped = content
    // Hilangkan blok thinking/reasoning lengkap.
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    // Beberapa model mengirim tag pembuka tanpa penutup di awal stream.
    .replace(/^<think>[\s\S]*$/i, "")
    .replace(/^<thinking>[\s\S]*$/i, "")
    .replace(/^<reasoning>[\s\S]*$/i, "")
    // Marker reasoning ala Llama Nemotron / DeepSeek-R1 (jarang, tapi defensif).
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, "")
    .replace(/<\|reasoning\|>[\s\S]*?<\|\/reasoning\|>/gi, "")
    .trim();

  return stripped;
}

function friendlyErrorMessage(status: number, detail: string) {
  if (status === 429) {
    return `OpenRouter rate-limited (429) di semua model gratis. Penyebab biasanya quota harian habis atau provider sedang sibuk. Coba: (1) tunggu ~1 menit, (2) ganti OPENROUTER_MODEL, atau (3) tambahkan credit $10 di https://openrouter.ai/credits untuk unlock 1000 req/hari. Detail: ${detail}`;
  }
  if (status === 401 || status === 403) {
    return `OpenRouter auth gagal (${status}). Cek OPENROUTER_API_KEY di .env.local. Detail: ${detail}`;
  }
  return `OpenRouter error (${status}): ${detail}`;
}

export async function generateWithOpenRouter(options: GenerateOptions) {
  const apiKey = getOpenRouterApiKey();
  const primary = options.model?.trim() || getOpenRouterModel();
  const fallbacks = (options.fallbackModels ?? getOpenRouterFallbacks(primary))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const wantsJson = options.responseMimeType === "application/json";

  const body: Record<string, unknown> = {
    model: primary,
    messages: [
      { role: "system", content: options.systemInstruction },
      { role: "user", content: options.prompt },
    ],
    temperature: options.temperature ?? 0.45,
    max_tokens: options.maxOutputTokens ?? 1800,
  };

  // OpenRouter native fallback: kalau model utama 429/error, otomatis coba model berikut.
  // Hard-cap 3 entri (1 primary + 2 fallback) sesuai limit API OpenRouter.
  if (fallbacks.length > 0) {
    body.models = [primary, ...fallbacks].slice(0, MAX_MODELS_IN_REQUEST);
  }

  if (wantsJson) {
    body.response_format = { type: "json_object" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const referer = process.env.OPENROUTER_SITE_URL?.trim();
  const title = process.env.OPENROUTER_APP_NAME?.trim() || "PRD Generator";
  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-Title"] = title;

  const maxAttempts = 2;
  let lastError = "";
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      if (attempt < maxAttempts) {
        await sleep(800);
        continue;
      }
      throw new Error(`Gagal menghubungi OpenRouter: ${reason}`);
    }

    const rawText = await response.text();
    let payload: OpenRouterResponse | null = null;
    try {
      payload = rawText ? (JSON.parse(rawText) as OpenRouterResponse) : null;
    } catch {
      payload = null;
    }

    if (response.ok && payload && !payload.error?.message) {
      const rawContent = payload.choices?.[0]?.message?.content;
      const text = sanitizeReasoningArtifacts(rawContent);
      if (!text) {
        throw new Error("OpenRouter tidak mengembalikan teks.");
      }
      return text;
    }

    lastStatus = response.status;
    lastError =
      payload?.error?.message ||
      rawText ||
      `${response.status} ${response.statusText}`;

    if (attempt < maxAttempts && RETRYABLE_STATUSES.has(response.status)) {
      // Exponential-ish backoff: 1.2s, lalu jika perlu lebih.
      await sleep(1200);
      continue;
    }

    break;
  }

  throw new Error(friendlyErrorMessage(lastStatus, lastError));
}
