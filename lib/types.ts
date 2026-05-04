export type TemplateMode = "simple" | "technical" | "startup";

export type ConversationPhase = "brief" | "techstack" | "questions" | "result";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

export type ChatQuestion = {
  id?: string;
  text: string;
  options?: string[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
};

export type ConversationSnapshot = {
  sessionId: string;
  title: string;
  projectIdea: string;
  phase: ConversationPhase;
  templateMode: TemplateMode;
  messages: ChatMessage[];
  lastQuestions: ChatQuestion[];
  markdown: string;
  readyToGenerate: boolean;
  nextStep: string;
  updatedAt: string;
};

export type PrdHistoryItem = {
  id: string;
  title: string;
  projectIdea: string;
  markdown: string;
  createdAt: string;
};

export type ChatApiResponse = {
  message: string;
  questions: ChatQuestion[];
  nextStep: string;
  readyToGenerate: boolean;
};

export type GenerateApiResponse = {
  markdown: string;
};
