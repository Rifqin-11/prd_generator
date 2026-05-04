import { NextResponse } from "next/server";
import { generateWithGemini } from "@/lib/ai/gemini";
import { buildChatSystemPrompt, buildChatUserPrompt } from "@/lib/prompts";
import {
  normalizePhase,
  normalizeStructuredAnswers,
  resolveNextPhase,
} from "@/lib/phase-context";
import type { ChatApiResponse, ChatQuestion, Phase, QuestionMode, StructuredAnswers } from "@/lib/types";
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
    const structuredAnswers = normalizeStructuredAnswers(body.structuredAnswers);
    const messages = sanitizeMessages(body.messages);

    if (messages.length === 0) {
      return NextResponse.json(
        { error: "Kirim minimal satu pesan user untuk memulai sesi PRD." },
        { status: 400 },
      );
    }

    const raw = await generateWithGemini({
      systemInstruction: buildChatSystemPrompt(templateMode, phase, questionMode),
      prompt: buildChatUserPrompt({ phase, messages, structuredAnswers }),
      responseMimeType: "application/json",
      maxOutputTokens: questionMode === "fast" ? 1400 : 900,
    });

    const parsed = parseChatResponse(raw, phase, structuredAnswers, questionMode);
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
    const parsed = JSON.parse(stripJsonFence(raw)) as Partial<ChatApiResponse>;
    let questions = normalizeQuestions(parsed.questions);
    let message =
      typeof parsed.message === "string" ? parsed.message.trim() : "";
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const requestedPhase = normalizePhase(parsed.nextPhase, currentPhase);
    const nextPhase = resolveNextPhase(currentPhase, requestedPhase, structuredAnswers);

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
        nextPhase === "generation" && (questionMode === "fast" || Boolean(parsed.readyToGenerate)),
    };
  } catch {
    const extracted = extractQuestionTextsFromRaw(raw);
    const questions = normalizeQuestions(extracted);
    const nextPhase = resolveNextPhase(currentPhase, currentPhase, structuredAnswers);

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

function normalizeQuestionLimit(questions: ChatQuestion[], phase: Phase, questionMode: QuestionMode) {
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
