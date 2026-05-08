import { NextResponse } from "next/server";
import { generateWithOpenRouter } from "@/lib/ai/openrouter";
import { buildChatSystemPrompt, buildChatUserPrompt } from "@/lib/prompts";
import {
  normalizePhase,
  normalizeStructuredAnswers,
  resolveNextPhase,
} from "@/lib/phase-context";
import type {
  ChatApiResponse,
  ChatQuestion,
  Phase,
  QuestionMode,
  StructuredAnswers,
} from "@/lib/types";
import { isTemplateMode, sanitizeMessages } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const templateMode = isTemplateMode(body.templateMode)
      ? body.templateMode
      : "simple";
    const phase = normalizePhase(body.phase, "discovery");
    const questionMode = normalizeQuestionMode(body.questionMode);
    const structuredAnswers = normalizeStructuredAnswers(
      body.structuredAnswers,
    );
    const messages = sanitizeMessages(body.messages);

    if (messages.length === 0) {
      return NextResponse.json(
        { error: "Kirim minimal satu pesan user untuk memulai sesi PRD." },
        { status: 400 },
      );
    }

    const raw = await generateWithOpenRouter({
      systemInstruction: buildChatSystemPrompt(
        templateMode,
        phase,
        questionMode,
      ),
      prompt: buildChatUserPrompt({ phase, messages, structuredAnswers }),
      responseMimeType: "application/json",
      // 5 opsi × 80 char × 3 pertanyaan + JSON skeleton ≈ 1500 tokens minimal.
      // Naikkan generous supaya tidak ke-truncate di tengah array options.
      maxOutputTokens: questionMode === "fast" ? 4000 : 2400,
    });

    if (process.env.NODE_ENV !== "production") {
      console.log("\n[chat] === RAW AI RESPONSE ===");
      console.log(raw);
      console.log("[chat] === END RAW ===\n");
    }

    const parsed = parseChatResponse(
      raw,
      phase,
      structuredAnswers,
      questionMode,
    );

    if (process.env.NODE_ENV !== "production") {
      console.log(
        "[chat] parsed questions:",
        JSON.stringify(
          parsed.questions.map((q) => ({ text: q.text, options: q.options })),
          null,
          2,
        ),
      );
    }

    return NextResponse.json(parsed);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Gagal memproses chat PRD. Coba lagi sebentar.",
      },
      { status: 500 },
    );
  }
}

function parseChatResponse(
  raw: string,
  currentPhase: Phase,
  structuredAnswers: StructuredAnswers,
  questionMode: QuestionMode,
): ChatApiResponse {
  try {
    const parsed = parseJsonLoose(raw) as Partial<ChatApiResponse>;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Parsed value is not an object");
    }
    let questions = normalizeQuestions(parsed.questions);
    let message =
      typeof parsed.message === "string" ? parsed.message.trim() : "";
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const requestedPhase = normalizePhase(parsed.nextPhase, currentPhase);
    const nextPhase = resolveNextPhase(
      currentPhase,
      requestedPhase,
      structuredAnswers,
    );

    if (questions.length === 0 && message) {
      const nested = tryParseNestedQuestions(message);
      if (nested.length > 0) {
        questions = normalizeQuestions(nested);
        message = "";
      }
    }

    if (questions.length === 0) {
      const extracted = extractQuestionTextsFromRaw(raw);
      if (extracted.length > 0) questions = normalizeQuestions(extracted);
    }

    return {
      message,
      questions: normalizeQuestionLimit(questions, nextPhase, questionMode),
      summary: nextPhase === "validation" ? summary || message : "",
      nextPhase,
      readyToGenerate:
        nextPhase === "generation" &&
        (questionMode === "fast" || Boolean(parsed.readyToGenerate)),
    };
  } catch {
    const extracted = extractQuestionTextsFromRaw(raw);
    const questions = normalizeQuestions(extracted);
    const nextPhase = resolveNextPhase(
      currentPhase,
      currentPhase,
      structuredAnswers,
    );

    return {
      message: "",
      questions: normalizeQuestionLimit(questions, nextPhase, questionMode),
      summary: "",
      nextPhase,
      readyToGenerate: questionMode === "fast" && questions.length > 0,
    };
  }
}

function stripJsonFence(value: string) {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

/**
 * Parse JSON yang toleran terhadap prose/markdown di sekeliling object.
 * Banyak free model (Ring-2.6-1T, Nemotron, Laguna) menambah teks pengantar
 * atau memotong response di tengah jalan kalau token budget habis.
 */
function parseJsonLoose(value: string): unknown {
  const cleaned = stripJsonFence(value);

  // 1) Coba parse langsung.
  try {
    return JSON.parse(cleaned);
  } catch {
    // lanjut ke fallback
  }

  // 2) Cari JSON object terbesar lewat first '{' .. last '}'.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // lanjut
    }
  }

  // 3) JSON kemungkinan terpotong di tengah (truncation karena max_tokens).
  // Cari first '{' dan repair dengan menutup brace/bracket yang masih open.
  if (start >= 0) {
    const repaired = repairTruncatedJson(cleaned.slice(start));
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        // ignore
      }
    }
  }

  // 4) Coba JSON array (kalau model lupa wrap di object).
  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    const candidate = cleaned.slice(arrStart, arrEnd + 1);
    try {
      const arr = JSON.parse(candidate);
      if (Array.isArray(arr)) return { questions: arr };
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Tutup brace/bracket yang masih open setelah model memotong response di tengah.
 * Strategi: cari titik aman terakhir (sehabis koma atau closing bracket di
 * level array/object), truncate ke titik itu, lalu append closing bracket
 * sesuai stack yang masih open.
 */
function repairTruncatedJson(input: string): string | null {
  if (!input.startsWith("{") && !input.startsWith("[")) return null;

  let inString = false;
  let escape = false;
  // Stack berisi karakter penutup yang dibutuhkan ('}' atau ']').
  const stack: string[] = [];
  // Posisi terakhir yang aman untuk dipotong (= setelah value lengkap).
  let lastSafeCut = -1;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      stack.pop();
      lastSafeCut = i; // setelah closing brace/bracket = boundary aman
    } else if (c === "," && stack.length > 0) {
      // Koma di dalam array/object yang masih open → titik aman sebelum koma.
      lastSafeCut = i - 1;
    }
  }

  if (stack.length === 0) {
    return input;
  }
  if (lastSafeCut < 0) {
    return null;
  }

  // Truncate ke titik aman lalu re-walk untuk hitung stack yang tersisa.
  let truncated = input.slice(0, lastSafeCut + 1);

  const closingStack: string[] = [];
  let s2 = false;
  let e2 = false;
  for (let i = 0; i < truncated.length; i++) {
    const c = truncated[i];
    if (e2) {
      e2 = false;
      continue;
    }
    if (s2) {
      if (c === "\\") {
        e2 = true;
        continue;
      }
      if (c === '"') s2 = false;
      continue;
    }
    if (c === '"') {
      s2 = true;
      continue;
    }
    if (c === "{") closingStack.push("}");
    else if (c === "[") closingStack.push("]");
    else if (c === "}" || c === "]") closingStack.pop();
  }

  while (closingStack.length > 0) {
    truncated += closingStack.pop();
  }

  return truncated;
}

function extractQuestions(value: string) {
  const text = cleanupRawMessage(value);
  const matches = Array.from(
    text.matchAll(
      /(?:^|\n)\s*(?:\d+[\).]|[-*])\s+([\s\S]+?)(?=\n\s*(?:\d+[\).]|[-*])\s+|\n{2,}|$)/g,
    ),
  )
    .map((match) => match[1].trim())
    .filter((line) => line && !isNoiseLine(line));

  if (matches.length > 0) return matches;

  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[\).]|[-*])\s+/, "").trim())
    .filter((line) => line && !isNoiseLine(line));
}

function normalizeQuestions(value: unknown): ChatQuestion[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item): ChatQuestion | null => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        if (looksLikeJson(text)) return null;
        return {
          text,
          options: ["Lainnya"],
          multiSelect: true,
          allowFreeText: true,
        };
      }

      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) return null;
      if (looksLikeJson(text)) return null;

      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => (typeof option === "string" ? option.trim() : ""))
            .filter(Boolean)
        : [];

      return {
        id: typeof record.id === "string" ? record.id.trim() : undefined,
        text,
        options: options.length > 0 ? options : ["Lainnya"],
        multiSelect:
          record.multiSelect === undefined ? true : Boolean(record.multiSelect),
        allowFreeText:
          record.allowFreeText === undefined
            ? true
            : Boolean(record.allowFreeText),
      };
    })
    .filter((item): item is ChatQuestion => item !== null);
}

function extractQuestionTextsFromRaw(raw: string): string[] {
  const cleaned = stripJsonFence(raw);
  const textMatches = Array.from(cleaned.matchAll(/"text"\s*:\s*"([\s\S]*?)"/g))
    .map((match) => match[1].replace(/\\"/g, '"').trim())
    .filter((text) => text && !looksLikeJson(text));

  if (textMatches.length > 0) return textMatches;

  const questionsBlock = cleaned.match(/"questions"\s*:\s*\[([\s\S]*?)\]/);
  if (questionsBlock?.[1]) {
    const inline = Array.from(questionsBlock[1].matchAll(/"([\s\S]*?)"/g))
      .map((match) => match[1].replace(/\\"/g, '"').trim())
      .filter((text) => text && !looksLikeJson(text));
    if (inline.length > 0) return inline;
  }

  return extractQuestions(cleaned);
}

function isNoiseLine(line: string) {
  const trimmed = line.trim();
  return (
    trimmed === "{" ||
    trimmed === "}" ||
    trimmed === "[" ||
    trimmed === "]" ||
    trimmed.startsWith('"message"') ||
    trimmed.startsWith('"questions"') ||
    trimmed.startsWith('"summary"') ||
    trimmed.startsWith('"nextPhase"') ||
    trimmed.startsWith('"readyToGenerate"') ||
    (trimmed.startsWith('"') && trimmed.endsWith('":'))
  );
}

function looksLikeJson(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.includes('"message"') ||
    trimmed.includes('"questions"') ||
    trimmed.includes('"nextPhase"')
  );
}

function tryParseNestedQuestions(message: string): unknown[] {
  try {
    const nested = JSON.parse(
      stripJsonFence(message),
    ) as Partial<ChatApiResponse>;
    return Array.isArray(nested.questions) ? nested.questions : [];
  } catch {
    return [];
  }
}

function shouldAskQuestions(phase: Phase) {
  return phase === "discovery" || phase === "refinement";
}

function normalizeQuestionLimit(
  questions: ChatQuestion[],
  phase: Phase,
  questionMode: QuestionMode,
) {
  if (questionMode === "fast") return questions.slice(0, 10);
  return shouldAskQuestions(phase) ? questions.slice(0, 3) : [];
}

function normalizeQuestionMode(value: unknown): QuestionMode {
  return value === "fast" ? "fast" : "adaptive";
}

function cleanupRawMessage(value: string) {
  const cleaned = stripJsonFence(value);
  return cleaned.trim();
}
