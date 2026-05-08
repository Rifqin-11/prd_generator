import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { generateWithOpenRouter } from "@/lib/ai/openrouter";
import {
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
} from "@/lib/prompts";
import { isTemplateMode, sanitizeMessages } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const templateMode = isTemplateMode(body.templateMode)
      ? body.templateMode
      : "simple";
    const messages = sanitizeMessages(body.messages);

    if (messages.length < 2) {
      return NextResponse.json(
        {
          error:
            "Butuh minimal ide produk dan satu balasan lanjutan sebelum generate PRD.",
        },
        { status: 400 },
      );
    }

    const templateContent = fs.readFileSync(
      path.join(process.cwd(), "contoh.md"),
      "utf-8",
    );

    const markdown = await generateWithOpenRouter({
      systemInstruction: buildGenerateSystemPrompt(
        templateMode,
        templateContent,
      ),
      prompt: buildGenerateUserPrompt(messages),
      responseMimeType: "text/plain",
      temperature: 0.35,
      maxOutputTokens: 4200,
    });

    return NextResponse.json({ markdown: cleanupMarkdown(markdown) });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Gagal membuat PRD final. Coba lagi sebentar.",
      },
      { status: 500 },
    );
  }
}

function cleanupMarkdown(value: string) {
  return value
    .replace(/^```markdown\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}
