"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import {
  createEmptyConversation,
  SessionConversationStore,
} from "@/lib/store/conversation-store";
import {
  getPhaseStep,
  mergeStructuredAnswers,
  normalizePhase,
  normalizeStructuredAnswers,
} from "@/lib/phase-context";
import type {
  ChatApiResponse,
  ChatMessage,
  ChatQuestion,
  ConversationSnapshot,
  GenerateApiResponse,
  PrdHistoryItem,
  QuestionMode,
} from "@/lib/types";

type AnswerState = {
  selected: string[];
  note: string;
};

export function PrdGenerator() {
  const store = useMemo(() => new SessionConversationStore(), []);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>(() =>
    createEmptyConversation("technical"),
  );
  const [history, setHistory] = useState<PrdHistoryItem[]>([]);
  const [projectIdea, setProjectIdea] = useState("");
  const [questionAnswers, setQuestionAnswers] = useState<AnswerState[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const saved = store.load();
      const savedHistory = store.loadHistory();

      if (saved) {
        const migrated = migrateSnapshot(saved);
        setSnapshot(migrated);
        setProjectIdea(migrated.projectIdea);
      }

      setHistory(savedHistory);
      setIsHydrated(true);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [store]);

  useEffect(() => {
    if (!isHydrated) return;
    store.save(snapshot);
  }, [isHydrated, snapshot, store]);

  async function handleBriefSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectIdea.trim() || isChatLoading) return;

    const title = createTitle(projectIdea);
    const structuredAnswers = mergeStructuredAnswers(snapshot.structuredAnswers, {
      projectIdea: projectIdea.trim(),
    });

    const nextSnapshot: ConversationSnapshot = {
      ...snapshot,
      title,
      projectIdea: projectIdea.trim(),
      phase: "mode",
      messages: [],
      lastQuestions: [],
      summary: "",
      structuredAnswers,
      markdown: "",
      readyToGenerate: false,
      nextStep: "Question mode",
      updatedAt: new Date().toISOString(),
    };

    setError("");
    setCopied(false);
    setQuestionAnswers([]);
    setSnapshot(nextSnapshot);
  }

  function handleQuestionModeSubmit(questionMode: QuestionMode) {
    setError("");
    setQuestionAnswers([]);
    setSnapshot({
      ...snapshot,
      phase: "techstack",
      questionMode,
      nextStep: "Technology preference",
      updatedAt: new Date().toISOString(),
    });
  }

  async function handleTechStackSubmit(techStackPref: string) {
    if (!snapshot.projectIdea.trim() || isChatLoading) return;

    const structuredAnswers = mergeStructuredAnswers(snapshot.structuredAnswers, {
      projectIdea: snapshot.projectIdea,
      techStackPref,
    });

    const nextSnapshot: ConversationSnapshot = {
      ...snapshot,
      phase: "techstack",
      currentPhase: "discovery",
      messages: [
        createMessage(
          "user",
          buildInitialBriefMessage(snapshot.projectIdea, techStackPref),
        ),
      ],
      lastQuestions: [],
      summary: "",
      structuredAnswers,
      markdown: "",
      readyToGenerate: false,
      nextStep: "AI is analyzing the brief and tech stack",
      updatedAt: new Date().toISOString(),
    };

    await sendChat(nextSnapshot, "questions");
  }

  async function handleQuestionSubmit() {
    if (isChatLoading || isGenerating) return;

    const isValidation = snapshot.currentPhase === "validation";
    const answerContent = isValidation
      ? "User confirmed the validation summary and approved final PRD generation."
      : buildAnswerContent(snapshot.lastQuestions, questionAnswers);
    const userMessage = createMessage("user", answerContent || "User skipped answers.");
    const structuredAnswers = mergeStructuredAnswers(snapshot.structuredAnswers, {
      questions: snapshot.lastQuestions,
      answerText: userMessage.content,
    });

    const nextSnapshot: ConversationSnapshot = {
      ...snapshot,
      messages: [...snapshot.messages, userMessage],
      structuredAnswers,
      updatedAt: new Date().toISOString(),
    };

    if (isValidation) {
      await generatePrd({
        ...nextSnapshot,
        currentPhase: "generation",
        readyToGenerate: true,
        nextStep: "PRD generation",
      });
      return;
    }

    if (snapshot.questionMode === "fast") {
      await generatePrd(nextSnapshot);
      return;
    }

    await sendChat(nextSnapshot, "questions");
  }

  async function sendChat(
    nextSnapshot: ConversationSnapshot,
    nextPhase: ConversationSnapshot["phase"],
  ) {
    setError("");
    setIsChatLoading(true);
    setSnapshot(nextSnapshot);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: nextSnapshot.sessionId,
          templateMode: nextSnapshot.templateMode,
          phase: nextSnapshot.currentPhase,
          questionMode: nextSnapshot.questionMode,
          structuredAnswers: nextSnapshot.structuredAnswers,
          messages: nextSnapshot.messages,
        }),
      });

      const data = (await response.json()) as Partial<ChatApiResponse> & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || "AI gagal memproses brief.");

      const currentPhase = normalizePhase(data.nextPhase, nextSnapshot.currentPhase);

      setSnapshot({
        ...nextSnapshot,
        phase: nextPhase,
        currentPhase,
        messages: [
          ...nextSnapshot.messages,
          createMessage(
            "assistant",
            formatAssistantMessage(data.message || "", data.questions || [], data.summary || ""),
          ),
        ],
        readyToGenerate: nextSnapshot.questionMode === "fast" || Boolean(data.readyToGenerate),
        summary: data.summary || "",
        nextStep: getPhaseStep(currentPhase),
        lastQuestions: data.questions || [],
        updatedAt: new Date().toISOString(),
      });
      setQuestionAnswers(
        Array.from({ length: (data.questions || []).length }, () => ({
          selected: [],
          note: "",
        })),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Terjadi error saat menghubungi AI.",
      );
    } finally {
      setIsChatLoading(false);
    }
  }

  async function generatePrd(sourceSnapshot = snapshot) {
    if (isGenerating) return;

    setError("");
    setCopied(false);
    setIsGenerating(true);

    const finalMessages = [
      ...sourceSnapshot.messages,
      createMessage("user", buildGenerationContext(sourceSnapshot)),
    ];

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sourceSnapshot.sessionId,
          templateMode: sourceSnapshot.templateMode,
          messages: finalMessages,
        }),
      });

      const data = (await response.json()) as Partial<GenerateApiResponse> & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Generate PRD gagal.");

      const nextSnapshot: ConversationSnapshot = {
        ...sourceSnapshot,
        messages: finalMessages,
        markdown: data.markdown || "",
        phase: "result",
        currentPhase: "generation",
        lastQuestions: [],
        nextStep: "Final PRD",
        updatedAt: new Date().toISOString(),
      };

      const nextHistory = upsertHistory(history, nextSnapshot);
      setSnapshot(nextSnapshot);
      setHistory(nextHistory);
      store.saveHistory(nextHistory);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Terjadi error saat generate PRD.",
      );
      // If failed, revert to questions phase so user can try again
      setSnapshot((s) => ({ ...s, phase: "questions" }));
    } finally {
      setIsGenerating(false);
    }
  }

  function startNewPrd() {
    const next = createEmptyConversation("technical");
    setSnapshot(next);
    setProjectIdea("");
    setQuestionAnswers([]);
    setError("");
    setCopied(false);
    store.clear();
  }

  function openHistory(item: PrdHistoryItem) {
    const now = new Date().toISOString();
    const next: ConversationSnapshot = {
      ...createEmptyConversation("technical"),
      sessionId: item.id,
      title: item.title,
      projectIdea: item.projectIdea,
      phase: "result",
      currentPhase: "generation",
      questionMode: "adaptive",
      markdown: item.markdown,
      lastQuestions: [],
      summary: "",
      nextStep: "History preview",
      updatedAt: now,
    };

    setSnapshot(next);
    setProjectIdea(item.projectIdea);
    setQuestionAnswers([]);
    setError("");
  }

  async function copyMarkdown() {
    if (!snapshot.markdown) return;
    await navigator.clipboard.writeText(snapshot.markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function downloadMarkdown() {
    if (!snapshot.markdown) return;

    const blob = new Blob([snapshot.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugify(snapshot.title || "prd")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function sharePrd() {
    if (!snapshot.markdown) return;

    const shareData: ShareData = {
      title: snapshot.title || "Product Requirements Document",
      text: snapshot.markdown,
    };

    try {
      if (
        navigator.share &&
        (!navigator.canShare || navigator.canShare(shareData))
      ) {
        await navigator.share({
          title: snapshot.title || "Product Requirements Document",
          text: snapshot.markdown,
        });
        return;
      }

      await copyMarkdown();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      await copyMarkdown();
    }
  }

  return (
    <main className="min-h-screen bg-stone-50 text-stone-950">
      <div className="grid min-h-screen lg:grid-cols-[320px_1fr]">
        <aside className="border-b border-stone-200 bg-white px-5 py-6 lg:border-b-0 lg:border-r lg:flex lg:flex-col lg:h-screen lg:sticky lg:top-0">
          <div className="mb-6">
            <h1 className="font-display text-2xl font-black tracking-[-0.04em] text-stone-950">
              PRD Generator
            </h1>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 pb-4">
            <button
              type="button"
              onClick={startNewPrd}
              className={`flex w-full items-center justify-center rounded-2xl border-2 border-dashed p-4 text-sm font-bold transition ${
                snapshot.phase === "brief" && !snapshot.sessionId
                  ? "border-stone-900 bg-stone-50 text-stone-950"
                  : "border-stone-200 bg-white text-stone-500 hover:border-stone-400 hover:text-stone-900"
              }`}
            >
              + New PRD
            </button>

            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openHistory(item)}
                className={`w-full rounded-2xl border p-4 text-left transition hover:border-stone-950 ${
                  snapshot.sessionId === item.id
                    ? "border-stone-950 bg-stone-950 text-white"
                    : "border-stone-200 bg-white text-stone-950"
                }`}
              >
                <span className="block truncate text-sm font-black">
                  {item.title}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-screen items-center justify-center px-5 py-8 sm:px-8">
          <div className="w-full max-w-4xl">
            <StepIndicator phase={snapshot.phase} />

            {snapshot.phase === "brief" ? (
              <BriefStep
                projectIdea={projectIdea}
                error={error}
                onProjectIdeaChange={setProjectIdea}
                onSubmit={handleBriefSubmit}
              />
            ) : null}

            {snapshot.phase === "mode" ? (
              <QuestionModeStep error={error} onSubmit={handleQuestionModeSubmit} />
            ) : null}

            {snapshot.phase === "techstack" ? (
              <TechStackStep
                projectIdea={snapshot.projectIdea}
                isLoading={isChatLoading}
                error={error}
                onSubmit={handleTechStackSubmit}
              />
            ) : null}

            {snapshot.phase === "questions" ? (
              isGenerating || isChatLoading ? (
                <LoadingStep
                  title={isGenerating ? "Menyusun PRD Final..." : "Menganalisis jawaban..."}
                  description={
                    isGenerating
                      ? "Harap tunggu sebentar sementara AI merangkum semua jawaban Anda dan menyusun PRD berdasarkan template yang ditentukan."
                      : "AI sedang membaca jawaban terbaru dan menyiapkan langkah berikutnya."
                  }
                />
              ) : (
                <QuestionsStep
                  snapshot={snapshot}
                  questionAnswers={questionAnswers}
                  isChatLoading={isChatLoading}
                  error={error}
                  onAnswerChange={setQuestionAnswers}
                  onSubmit={handleQuestionSubmit}
                />
              )
            ) : null}

            {snapshot.phase === "result" ? (
              <ResultStep
                snapshot={snapshot}
                copied={copied}
                error={error}
                onCopy={copyMarkdown}
                onDownload={downloadMarkdown}
                onShare={sharePrd}
              />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function LoadingStep(props: { title?: string; description?: string }) {
  return (
    <div className="rounded-[2rem] border border-stone-200 bg-white p-12 text-center shadow-sm flex flex-col items-center justify-center min-h-[400px]">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-stone-200 border-t-stone-900 mb-6"></div>
      <h2 className="font-display text-2xl font-black tracking-[-0.03em] text-stone-900">
        {props.title || "Memproses..."}
      </h2>
      <p className="mt-3 text-sm text-stone-500 max-w-sm mx-auto leading-relaxed">
        {props.description || "Harap tunggu sebentar."}
      </p>
    </div>
  );
}

function BriefStep(props: {
  projectIdea: string;
  error: string;
  onProjectIdeaChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      onSubmit={props.onSubmit}
      className="rounded-[2rem] border border-stone-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <p className="text-sm font-bold text-stone-500">Step 1</p>
      <h2 className="mt-3 font-display text-4xl font-black tracking-[-0.05em] sm:text-5xl">
        Project apa yang ingin dibuat?
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-500">
        Tulis ide project dulu. Setelah itu pilih mode pertanyaan, preferensi
        teknologi, lalu AI menyusun requirement.
      </p>

      <label
        className="mt-8 block text-sm font-black text-stone-800"
        htmlFor="projectIdea"
      >
        Project brief
      </label>
      <textarea
        id="projectIdea"
        value={props.projectIdea}
        onChange={(event) => props.onProjectIdeaChange(event.target.value)}
        rows={6}
        placeholder="Contoh: Aplikasi web untuk generate PRD dari ide produk, dengan proses tanya jawab dan export Markdown."
        className="mt-3 w-full resize-none rounded-3xl border border-stone-200 bg-stone-50 p-5 text-base leading-7 outline-none transition placeholder:text-stone-400 focus:border-stone-950 focus:bg-white"
      />

      {props.error ? <ErrorMessage message={props.error} /> : null}

      <div className="mt-8 flex justify-end">
        <button
          type="submit"
          disabled={!props.projectIdea.trim()}
          className="rounded-full bg-stone-950 px-6 py-4 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Lanjut
        </button>
      </div>
    </form>
  );
}

function QuestionModeStep(props: {
  error: string;
  onSubmit: (questionMode: QuestionMode) => void;
}) {
  const [questionMode, setQuestionMode] = useState<QuestionMode>("adaptive");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit(questionMode);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[2rem] border border-stone-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <p className="text-sm font-bold text-stone-500">Step 2</p>
      <h2 className="mt-3 font-display text-4xl font-black tracking-[-0.05em] sm:text-5xl">
        Pilih cara AI bertanya
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-500">
        Mode cepat membuat daftar pertanyaan lengkap sekali jalan. Mode adaptive
        bertanya bertahap berdasarkan jawaban sebelumnya.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label
          className={`cursor-pointer rounded-2xl border-2 p-5 transition-all ${
            questionMode === "fast"
              ? "border-orange-500 bg-stone-900 text-white"
              : "border-stone-200 bg-white text-stone-900 hover:border-stone-300"
          }`}
        >
          <input
            type="radio"
            name="questionMode"
            value="fast"
            className="sr-only"
            checked={questionMode === "fast"}
            onChange={() => setQuestionMode("fast")}
          />
          <div className="mb-2 flex items-center gap-3">
            <div className={`rounded-lg p-1.5 ${questionMode === "fast" ? "text-orange-500" : "text-stone-500"}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"></path></svg>
            </div>
            <span className="text-base font-bold">Cepat</span>
          </div>
          <p className={`text-sm ${questionMode === "fast" ? "text-stone-300" : "text-stone-500"}`}>
            Sekali submit, AI membuat maksimal 10 pertanyaan lalu langsung lanjut generate PRD setelah dijawab
          </p>
        </label>

        <label
          className={`cursor-pointer rounded-2xl border-2 p-5 transition-all ${
            questionMode === "adaptive"
              ? "border-orange-500 bg-stone-900 text-white"
              : "border-stone-200 bg-white text-stone-900 hover:border-stone-300"
          }`}
        >
          <input
            type="radio"
            name="questionMode"
            value="adaptive"
            className="sr-only"
            checked={questionMode === "adaptive"}
            onChange={() => setQuestionMode("adaptive")}
          />
          <div className="mb-2 flex items-center gap-3">
            <div className={`rounded-lg p-1.5 ${questionMode === "adaptive" ? "text-orange-500" : "text-stone-500"}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M8 10h8"></path><path d="M8 14h5"></path></svg>
            </div>
            <span className="text-base font-bold">Adaptive</span>
          </div>
          <p className={`text-sm ${questionMode === "adaptive" ? "text-stone-300" : "text-stone-500"}`}>
            AI bertanya maksimal 3 pertanyaan per tahap dan menyesuaikan pertanyaan dari jawaban terbaru
          </p>
        </label>
      </div>

      {props.error ? <ErrorMessage message={props.error} /> : null}

      <div className="mt-8 flex justify-end">
        <button
          type="submit"
          className="rounded-full bg-stone-950 px-6 py-4 text-sm font-black text-white transition hover:-translate-y-0.5"
        >
          Lanjut
        </button>
      </div>
    </form>
  );
}

function TechStackStep(props: {
  projectIdea: string;
  isLoading: boolean;
  error: string;
  onSubmit: (techStackPref: string) => void;
}) {
  const [techStackChoice, setTechStackChoice] = useState<"ai" | "manual">("ai");
  const [manualTechStack, setManualTechStack] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const techStackPref =
      techStackChoice === "ai"
        ? "Biarkan AI memilih tech stack yang paling sesuai dengan project ini."
        : manualTechStack.trim() ||
          "Bebas, tetapi user ingin AI membantu menentukan detail stack.";

    props.onSubmit(techStackPref);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[2rem] border border-stone-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <p className="text-sm font-bold text-stone-500">Step 3</p>
      <h2 className="mt-3 font-display text-4xl font-black tracking-[-0.05em] sm:text-5xl">
        Preferensi teknologi
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-500">
        Pilihan ini dipakai AI untuk membuat pertanyaan yang lebih pas, jadi
        halaman berikutnya tidak perlu mengulang pertanyaan dasar soal framework
        atau database.
      </p>

      {props.projectIdea ? (
        <div className="mt-6 rounded-3xl border border-stone-200 bg-stone-50 p-5">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-stone-400">
            Brief
          </p>
          <p className="mt-2 line-clamp-3 text-sm leading-7 text-stone-700">
            {props.projectIdea}
          </p>
        </div>
      ) : null}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label
          className={`cursor-pointer rounded-2xl border-2 p-5 transition-all ${
            techStackChoice === "ai"
              ? "border-orange-500 bg-stone-900 text-white"
              : "border-stone-200 bg-white text-stone-900 hover:border-stone-300"
          }`}
        >
          <input
            type="radio"
            name="techStack"
            value="ai"
            className="sr-only"
            checked={techStackChoice === "ai"}
            onChange={() => setTechStackChoice("ai")}
          />
          <div className="mb-2 flex items-center gap-3">
            <div
              className={`rounded-lg p-1.5 ${techStackChoice === "ai" ? "text-orange-500" : "text-stone-500"}`}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                <path d="M9 10h.01"></path>
                <path d="M15 10h.01"></path>
              </svg>
            </div>
            <span className="text-base font-bold">Biarkan AI pilih</span>
          </div>
          <p
            className={`text-sm ${techStackChoice === "ai" ? "text-stone-300" : "text-stone-500"}`}
          >
            AI rekomendasiin stack yang paling cocok buat project kamu
          </p>
        </label>

        <label
          className={`cursor-pointer rounded-2xl border-2 p-5 transition-all ${
            techStackChoice === "manual"
              ? "border-orange-500 bg-stone-900 text-white"
              : "border-stone-200 bg-white text-stone-900 hover:border-stone-300"
          }`}
        >
          <input
            type="radio"
            name="techStack"
            value="manual"
            className="sr-only"
            checked={techStackChoice === "manual"}
            onChange={() => setTechStackChoice("manual")}
          />
          <div className="mb-2 flex items-center gap-3">
            <div
              className={`rounded-lg p-1.5 ${techStackChoice === "manual" ? "text-orange-500" : "text-stone-500"}`}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </div>
            <span className="text-base font-bold">Pilih sendiri</span>
          </div>
          <p
            className={`text-sm ${techStackChoice === "manual" ? "text-stone-300" : "text-stone-500"}`}
          >
            Kamu tentuin teknologi yang mau dipakai
          </p>
        </label>
      </div>

      {techStackChoice === "manual" ? (
        <textarea
          value={manualTechStack}
          onChange={(event) => setManualTechStack(event.target.value)}
          rows={3}
          placeholder="Contoh: Next.js, Tailwind CSS, Supabase"
          className="mt-4 w-full resize-none rounded-2xl border-2 border-stone-200 bg-white p-4 text-sm leading-7 outline-none transition placeholder:text-stone-400 focus:border-stone-900"
        />
      ) : null}

      {props.error ? <ErrorMessage message={props.error} /> : null}

      <div className="mt-8 flex justify-end">
        <button
          type="submit"
          disabled={props.isLoading}
          className="rounded-full bg-stone-950 px-6 py-4 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.isLoading ? "AI menyusun pertanyaan..." : "Lanjut"}
        </button>
      </div>
    </form>
  );
}

function QuestionsStep(props: {
  snapshot: ConversationSnapshot;
  questionAnswers: AnswerState[];
  isChatLoading: boolean;
  error: string;
  onAnswerChange: (value: AnswerState[]) => void;
  onSubmit: () => void;
}) {
  const latestQuestions = getLatestQuestions(props.snapshot);
  const hasQuestions = latestQuestions.length > 0;
  const isValidation = props.snapshot.currentPhase === "validation";
  const isFastMode = props.snapshot.questionMode === "fast";

  const answeredCount = props.questionAnswers.filter(
    (a) => a.selected.length > 0 || a.note.trim() !== "",
  ).length;
  const totalCount = latestQuestions.length;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit();
  }

  function updateAnswer(index: number, value: string) {
    const next = [...props.questionAnswers];
    const current = next[index] || { selected: [], note: "" };
    next[index] = { ...current, note: value };
    props.onAnswerChange(next);
  }

  function toggleOption(index: number, option: string, multiSelect: boolean) {
    const next = [...props.questionAnswers];
    const current = next[index] || { selected: [], note: "" };
    const alreadySelected = current.selected.includes(option);

    const selected = multiSelect
      ? alreadySelected
        ? current.selected.filter((item) => item !== option)
        : [...current.selected, option]
      : alreadySelected
        ? []
        : [option];

    next[index] = { ...current, selected };
    props.onAnswerChange(next);
  }

  function clearAnswer(index: number) {
    const next = [...props.questionAnswers];
    next[index] = { selected: [], note: "" };
    props.onAnswerChange(next);
  }

  return (
    <div className="rounded-[2rem] border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6">
        <div>
          <p className="text-sm font-bold text-stone-500">Step 4</p>
          <h2 className="font-display text-3xl font-black tracking-[-0.03em] text-stone-900">
            {isValidation ? "Validasi requirement" : "Beberapa pertanyaan"}
          </h2>
          <p className="mt-2 text-base text-stone-500">
            {isValidation
              ? "Review ringkasan requirement sebelum PRD final dibuat."
              : isFastMode
                ? "Jawab pertanyaan lengkap di bawah, lalu AI langsung membuat PRD final."
                : "Biar PRD-nya lebih akurat. Jawab pertanyaan adaptif di bawah."}
          </p>
        </div>
        {hasQuestions && !isValidation ? (
          <div className="text-sm font-bold text-stone-500">
            {answeredCount}/{totalCount}
          </div>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="mt-6">
        {isValidation ? (
          <div className="rounded-3xl border border-stone-200 bg-stone-50 p-5">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-stone-400">
              Summary
            </p>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-stone-700">
              {props.snapshot.summary || "Requirement sudah cukup jelas untuk dibuat menjadi PRD final."}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {hasQuestions ? (
            latestQuestions.map((question, index) => {
              const answer = props.questionAnswers[index] || {
                selected: [],
                note: "",
              };
              const options =
                question.options && question.options.length > 0
                  ? question.options
                  : ["Lainnya"];
              const allowFreeText = question.allowFreeText ?? true;
              const multiSelect = question.multiSelect ?? true;

              return (
                <div
                  key={`${question.text}-${index}`}
                  className="border-b border-stone-100 pb-6 last:border-0 last:pb-0"
                >
                  <div className="flex items-start justify-between gap-4">
                    <label
                      className="block text-base font-bold leading-7 text-stone-900"
                      htmlFor={`answer-${index}`}
                    >
                      {index + 1}. {question.text}
                    </label>
                    <button
                      type="button"
                      onClick={() => clearAnswer(index)}
                      className="shrink-0 text-sm font-medium text-stone-400 transition hover:text-stone-900"
                    >
                      Lewati
                    </button>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2.5">
                    {options.map((option) => {
                      const isSelected = answer.selected.includes(option);
                      return (
                        <button
                          key={`${option}-${index}`}
                          type="button"
                          onClick={() =>
                            toggleOption(index, option, multiSelect)
                          }
                          className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                            isSelected
                              ? "border-orange-500 text-orange-600 bg-orange-50"
                              : "border-stone-200 bg-white text-stone-600 hover:border-stone-400 hover:text-stone-900"
                          }`}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                  {allowFreeText ? (
                    <textarea
                      id={`answer-${index}`}
                      value={answer.note}
                      onChange={(event) =>
                        updateAnswer(index, event.target.value)
                      }
                      rows={2}
                      placeholder="Tambahkan detail jawaban jika perlu..."
                      className="mt-4 w-full resize-none rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm leading-7 outline-none transition placeholder:text-stone-400 focus:border-stone-900 focus:bg-white"
                    />
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="rounded-3xl border border-dashed border-stone-200 bg-stone-50 p-6 text-center text-sm text-stone-500">
              Tidak ada pertanyaan baru. Kamu bisa lanjut ke validasi requirement.
            </div>
          )}
          </div>
        )}

        {props.error ? <ErrorMessage message={props.error} /> : null}

        <div className="mt-8 pt-6 flex flex-wrap justify-end gap-3">
          <button
            type="submit"
            disabled={props.isChatLoading}
            className="rounded-full bg-stone-950 px-8 py-4 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isValidation || isFastMode ? "Generate PRD" : "Lanjut"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ResultStep(props: {
  snapshot: ConversationSnapshot;
  copied: boolean;
  error: string;
  onCopy: () => void;
  onDownload: () => void;
  onShare: () => void;
}) {
  return (
    <div className="rounded-[2rem] border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-stone-500">Step 5</p>
          <h2 className="mt-3 font-display text-4xl font-black tracking-[-0.05em]">
            Final PRD
          </h2>
          <p className="mt-3 text-sm leading-7 text-stone-500">
            Output PRD dibuat dalam Bahasa Indonesia dan bisa didownload sebagai
            Markdown.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={props.onCopy}
            disabled={!props.snapshot.markdown}
            className="rounded-full border border-stone-300 px-4 py-3 text-sm font-black transition hover:border-stone-950 hover:bg-stone-950 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {props.copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={props.onDownload}
            disabled={!props.snapshot.markdown}
            className="rounded-full bg-stone-950 px-4 py-3 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Download .md
          </button>
          <button
            type="button"
            onClick={props.onShare}
            disabled={!props.snapshot.markdown}
            className="rounded-full border border-stone-300 px-4 py-3 text-sm font-black transition hover:border-stone-950"
          >
            Share
          </button>
        </div>
      </div>

      {props.error ? <ErrorMessage message={props.error} /> : null}

      <div className="mt-8">
        <MarkdownPreview markdown={props.snapshot.markdown} />
      </div>
    </div>
  );
}

function StepIndicator({ phase }: { phase: ConversationSnapshot["phase"] }) {
  const steps: Array<{ id: ConversationSnapshot["phase"]; label: string }> = [
    { id: "brief", label: "Brief" },
    { id: "mode", label: "Mode" },
    { id: "techstack", label: "Tech Stack" },
    { id: "questions", label: "Questions" },
    { id: "result", label: "Result" },
  ];

  return (
    <div className="mb-6 flex gap-2">
      {steps.map((step) => {
        const active = phase === step.id;
        return (
          <div
            key={step.id}
            className={`h-2 flex-1 rounded-full transition ${active ? "bg-stone-950" : "bg-stone-200"}`}
            aria-label={step.label}
          />
        );
      })}
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

function createMessage(
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };
}

function buildInitialBriefMessage(projectIdea: string, techStackPref: string) {
  return [
    `Project idea: ${projectIdea.trim()}`,
    `Tech Stack Preference: ${techStackPref.trim()}`,
    "Before creating the final PRD, analyze this project and tech stack preference, then ask the most important requirement questions.",
    "Do not ask for technology choices that are already answered by the tech stack preference.",
  ].join("\n");
}

function buildAnswerContent(questions: ChatQuestion[], answers: AnswerState[]) {
  return questions.length
    ? questions
        .map((question, index) => {
          const response = answers[index];
          if (!response) return `Question: ${question.text}\nAnswer: Not answered.`;

          const selected = response.selected.length > 0 ? response.selected.join(", ") : "-";
          const note = response.note.trim() ? response.note.trim() : "-";
          return `Question: ${question.text}\nAnswer: ${selected}\nNotes: ${note}`;
        })
        .join("\n\n")
    : answers
        .map((item) => [item.selected.join(", "), item.note.trim()].filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n\n");
}

function buildGenerationContext(snapshot: ConversationSnapshot) {
  return [
    "Proceed with final PRD generation.",
    snapshot.summary ? `Validation summary:\n${snapshot.summary}` : "",
    "Structured answers:",
    JSON.stringify(snapshot.structuredAnswers, null, 2),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatAssistantMessage(message: string, questions: ChatQuestion[], summary = "") {
  if (summary.trim()) return summary.trim();

  const normalizedQuestions =
    questions.length > 0
      ? questions.map((question) => question.text)
      : extractQuestions(message);
  if (normalizedQuestions.length === 0) return message.trim();

  return normalizedQuestions
    .map((question, index) => `${index + 1}. ${question}`)
    .join("\n");
}

function getLatestQuestions(snapshot: ConversationSnapshot) {
  return snapshot.lastQuestions || [];
}

function extractQuestions(value: string) {
  const jsonQuestions = extractJsonQuestions(value);
  if (jsonQuestions.length > 0) return jsonQuestions;

  const matches = Array.from(
    value.matchAll(
      /(?:^|\n)\s*(?:\d+[\).]|[-*])\s+([\s\S]+?)(?=\n\s*(?:\d+[\).]|[-*])\s+|\n{2,}|$)/g,
    ),
  )
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (matches.length > 0) return matches;

  return value
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[\).]|[-*])\s+/, "").trim())
    .filter(Boolean);
}

function extractJsonQuestions(value: string) {
  const questionsBlock = value.match(/"questions"\s*:\s*\[([\s\S]*?)\]/);
  if (!questionsBlock?.[1]) return [];

  return Array.from(questionsBlock[1].matchAll(/"([\s\S]*?)"/g))
    .map((match) => match[1].replace(/\\"/g, '"').trim())
    .filter(Boolean);
}

function createTitle(projectIdea: string) {
  const clean = projectIdea.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled PRD";
  return clean.length > 58 ? `${clean.slice(0, 58).trim()}...` : clean;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "prd"
  );
}

function upsertHistory(
  history: PrdHistoryItem[],
  snapshot: ConversationSnapshot,
) {
  const item: PrdHistoryItem = {
    id: snapshot.sessionId,
    title: snapshot.title || createTitle(snapshot.projectIdea),
    projectIdea: snapshot.projectIdea,
    markdown: snapshot.markdown,
    createdAt: new Date().toISOString(),
  };

  return [item, ...history.filter((entry) => entry.id !== item.id)].slice(
    0,
    12,
  );
}

function migrateSnapshot(snapshot: ConversationSnapshot) {
  const fallback = createEmptyConversation("technical");
  const phase =
    snapshot.phase ||
    (snapshot.markdown
      ? "result"
      : snapshot.messages.length > 0
        ? "questions"
        : "brief");

  return {
    ...fallback,
    ...snapshot,
    title:
      snapshot.title ||
      createTitle(snapshot.projectIdea || snapshot.messages[0]?.content || ""),
    projectIdea: snapshot.projectIdea || "",
    phase,
    currentPhase: normalizePhase(snapshot.currentPhase, snapshot.readyToGenerate ? "generation" : "discovery"),
    questionMode: snapshot.questionMode || "adaptive",
    lastQuestions: snapshot.lastQuestions || [],
    summary: snapshot.summary || "",
    structuredAnswers: normalizeStructuredAnswers(snapshot.structuredAnswers),
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
  };
}
