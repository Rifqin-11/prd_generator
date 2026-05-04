import type { ChatMessage, TemplateMode } from "@/lib/types";

const validModes: TemplateMode[] = ["simple", "technical", "startup"];

export function isTemplateMode(value: unknown): value is TemplateMode {
  return typeof value === "string" && validModes.includes(value as TemplateMode);
}

export function sanitizeText(value: unknown, maxLength = 4000) {
  if (typeof value !== "string") return "";

  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function sanitizeMessages(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .slice(-24)
    .map((item): ChatMessage | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const role = record.role === "assistant" ? "assistant" : "user";
      const content = sanitizeText(record.content, 6000);

      if (!content) return null;

      return {
        id: sanitizeText(record.id, 120) || crypto.randomUUID(),
        role,
        content,
        createdAt: sanitizeText(record.createdAt, 80) || new Date().toISOString(),
      };
    })
    .filter((message): message is ChatMessage => Boolean(message));
}
