import { NextResponse } from "next/server";
import { generateWithGemini } from "@/lib/ai/gemini";
import { buildChatSystemPrompt, buildChatUserPrompt } from "@/lib/prompts";
import type { ChatApiResponse, ChatQuestion } from "@/lib/types";
import { isTemplateMode, sanitizeMessages } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const templateMode = isTemplateMode(body.templateMode) ? body.templateMode : "simple";
    const messages = sanitizeMessages(body.messages);

    if (messages.length === 0) {
      return NextResponse.json(
        { error: "Kirim minimal satu pesan user untuk memulai sesi PRD." },
        { status: 400 },
      );
    }

    const raw = await generateWithGemini({
      systemInstruction: buildChatSystemPrompt(templateMode),
      prompt: buildChatUserPrompt(messages),
      responseMimeType: "application/json",
      maxOutputTokens: 900,
    });

    const parsed = parseChatResponse(raw);
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

function parseChatResponse(raw: string): ChatApiResponse {
  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as Partial<ChatApiResponse>;
    let questions = normalizeQuestions(parsed.questions);
    let message = typeof parsed.message === "string" ? parsed.message.trim() : "";

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
      questions,
      nextStep:
        typeof parsed.nextStep === "string" && parsed.nextStep.trim()
          ? parsed.nextStep.trim()
          : "Pendalaman requirement",
      readyToGenerate: Boolean(parsed.readyToGenerate) || questions.length === 0,
    };
  } catch {
    const extracted = extractQuestionTextsFromRaw(raw);
    const questions = normalizeQuestions(extracted);

    return {
      message: "",
      questions,
      nextStep: "Pendalaman requirement",
      readyToGenerate: questions.length === 0,
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
    text.matchAll(/(?:^|\n)\s*(?:\d+[\).]|[-*])\s+([\s\S]+?)(?=\n\s*(?:\d+[\).]|[-*])\s+|\n{2,}|$)/g),
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
    .map((item) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        if (looksLikeJson(text)) return null;
        return { text, options: ["Lainnya"], multiSelect: true, allowFreeText: true } satisfies ChatQuestion;
      }

      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) return null;
      if (looksLikeJson(text)) return null;

      const options = Array.isArray(record.options)
        ? record.options.map((option) => (typeof option === "string" ? option.trim() : "")).filter(Boolean)
        : [];

      return {
        id: typeof record.id === "string" ? record.id.trim() : undefined,
        text,
        options: options.length > 0 ? options : ["Lainnya"],
        multiSelect: record.multiSelect === undefined ? true : Boolean(record.multiSelect),
        allowFreeText: record.allowFreeText === undefined ? true : Boolean(record.allowFreeText),
      } satisfies ChatQuestion;
    })
    .filter((item): item is ChatQuestion => Boolean(item));
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
    trimmed.startsWith('"nextStep"') ||
    trimmed.startsWith('"readyToGenerate"') ||
    trimmed.startsWith('"') && trimmed.endsWith('":')
  );
}

function looksLikeJson(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.includes('"message"') ||
    trimmed.includes('"questions"')
  );
}

function tryParseNestedQuestions(message: string): unknown[] {
  try {
    const nested = JSON.parse(stripJsonFence(message)) as Partial<ChatApiResponse>;
    return Array.isArray(nested.questions) ? nested.questions : [];
  } catch {
    return [];
  }
}

function cleanupRawMessage(value: string) {
  const cleaned = stripJsonFence(value);
  return cleaned.trim();
}
