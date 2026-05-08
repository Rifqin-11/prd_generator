export type TemplateMode = "simple" | "technical" | "startup";

export type ConversationPhase =
  | "brief"
  | "mode"
  | "techstack"
  | "questions"
  | "result";

export type Phase = "discovery" | "refinement" | "validation" | "generation";

export type QuestionMode = "fast" | "adaptive";

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

export type StructuredAnswers = {
  productIdea: string;
  targetUser: string;
  platform: string;
  features: string[];
  userFlow: string;
  constraints: string[];
};

export type AnswerState = {
  selected: string[];
  note: string;
};

/**
 * Snapshot satu "round" pertanyaan AI di mode adaptive.
 * Disimpan agar user bisa Back/Next antar round tanpa memanggil AI ulang
 * selama jawaban di round sebelumnya tidak berubah.
 */
export type RoundState = {
  questions: ChatQuestion[];
  /** Jawaban user untuk round ini (terisi setelah submit Next dari round ini). */
  answers: AnswerState[];
  summary: string;
  readyToGenerate: boolean;
  currentPhase: Phase;
  /**
   * Hash JSON jawaban round sebelumnya yang menghasilkan round ini.
   * Dipakai cache invalidation: kalau hash berubah saat user navigate forward,
   * artinya user mengedit jawaban sebelumnya → harus call AI ulang.
   */
  generatedFromAnswersHash: string;
  /** Snapshot conversation messages SETELAH round ini di-generate. */
  messagesAtEnd: ChatMessage[];
  /** Snapshot structuredAnswers SETELAH round ini di-generate. */
  structuredAnswersAtEnd: StructuredAnswers;
};

export type ConversationSnapshot = {
  sessionId: string;
  title: string;
  projectIdea: string;
  phase: ConversationPhase;
  currentPhase: Phase;
  questionMode: QuestionMode;
  templateMode: TemplateMode;
  messages: ChatMessage[];
  lastQuestions: ChatQuestion[];
  summary: string;
  structuredAnswers: StructuredAnswers;
  markdown: string;
  readyToGenerate: boolean;
  nextStep: string;
  updatedAt: string;
  /** Stack of question rounds for back/forward navigation in adaptive mode. */
  rounds: RoundState[];
  /** Current index in rounds[]. -1 jika belum ada round. */
  roundIndex: number;
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
  summary: string;
  nextPhase: Phase;
  readyToGenerate: boolean;
};

export type GenerateApiResponse = {
  markdown: string;
};
