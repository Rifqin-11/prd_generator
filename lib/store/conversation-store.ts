import type { ConversationSnapshot, PrdHistoryItem, TemplateMode } from "@/lib/types";
import { createEmptyStructuredAnswers } from "@/lib/phase-context";

const STORAGE_KEY = "prd-generator:conversation";
const HISTORY_KEY = "prd-generator:history";

export interface ConversationStore {
  load(): ConversationSnapshot | null;
  save(snapshot: ConversationSnapshot): void;
  clear(): void;
  loadHistory(): PrdHistoryItem[];
  saveHistory(items: PrdHistoryItem[]): void;
}

export class SessionConversationStore implements ConversationStore {
  load() {
    if (typeof window === "undefined") return null;

    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as ConversationSnapshot;
    } catch {
      this.clear();
      return null;
    }
  }

  save(snapshot: ConversationSnapshot) {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }

  clear() {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(STORAGE_KEY);
  }

  loadHistory() {
    if (typeof window === "undefined") return [];

    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];

    try {
      return JSON.parse(raw) as PrdHistoryItem[];
    } catch {
      window.localStorage.removeItem(HISTORY_KEY);
      return [];
    }
  }

  saveHistory(items: PrdHistoryItem[]) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 12)));
  }
}

export function createEmptyConversation(templateMode: TemplateMode): ConversationSnapshot {
  const now = new Date().toISOString();

  return {
    sessionId: crypto.randomUUID(),
    title: "",
    projectIdea: "",
    phase: "brief",
    currentPhase: "discovery",
    questionMode: "adaptive",
    templateMode,
    messages: [],
    lastQuestions: [],
    summary: "",
    structuredAnswers: createEmptyStructuredAnswers(),
    markdown: "",
    readyToGenerate: false,
    nextStep: "Project brief",
    updatedAt: now,
  };
}
