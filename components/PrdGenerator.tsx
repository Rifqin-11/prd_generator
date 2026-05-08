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
  AnswerState,
  ChatApiResponse,
  ChatMessage,
  ChatQuestion,
  ConversationSnapshot,
  GenerateApiResponse,
  PrdHistoryItem,
  QuestionMode,
  RoundState,
} from "@/lib/types";

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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    if (!isSidebarOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isSidebarOpen]);

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
    const structuredAnswers = mergeStructuredAnswers(
      snapshot.structuredAnswers,
      {
        projectIdea: projectIdea.trim(),
      },
    );

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

    const structuredAnswers = mergeStructuredAnswers(
      snapshot.structuredAnswers,
      {
        projectIdea: snapshot.projectIdea,
        techStackPref,
      },
    );

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
      // Reset rounds — tech stack berubah = konteks AI berubah, semua cache invalid.
      rounds: [],
      roundIndex: -1,
    };

    await sendChat(nextSnapshot, "questions");
  }

  async function handleQuestionSubmit() {
    if (isChatLoading || isGenerating) return;

    const isValidation = snapshot.currentPhase === "validation";

    // Validation phase: go straight to PRD generation. Tidak ada cache round.
    if (isValidation) {
      const userMessage = createMessage(
        "user",
        "User confirmed the validation summary and approved final PRD generation.",
      );
      const structuredAnswers = mergeStructuredAnswers(
        snapshot.structuredAnswers,
        {
          questions: snapshot.lastQuestions,
          answerText: userMessage.content,
        },
      );
      await generatePrd({
        ...snapshot,
        messages: [...snapshot.messages, userMessage],
        structuredAnswers,
        currentPhase: "generation",
        readyToGenerate: true,
        nextStep: "PRD generation",
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    // Simpan jawaban saat ini ke round aktif sebelum navigate forward.
    const updatedRounds = [...snapshot.rounds];
    if (snapshot.roundIndex >= 0 && updatedRounds[snapshot.roundIndex]) {
      updatedRounds[snapshot.roundIndex] = {
        ...updatedRounds[snapshot.roundIndex],
        answers: questionAnswers,
      };
    }

    const currentHash = hashAnswers(questionAnswers);

    // Cache hit: round berikutnya sudah ada & dihasilkan dari jawaban yang sama.
    const cachedNext = updatedRounds[snapshot.roundIndex + 1];
    if (
      cachedNext &&
      cachedNext.generatedFromAnswersHash === currentHash &&
      snapshot.questionMode !== "fast"
    ) {
      restoreRound(updatedRounds, snapshot.roundIndex + 1);
      return;
    }

    // Cache miss: drop semua round setelah current, lalu panggil AI.
    const truncatedRounds = updatedRounds.slice(0, snapshot.roundIndex + 1);

    const answerContent = buildAnswerContent(
      snapshot.lastQuestions,
      questionAnswers,
    );
    const userMessage = createMessage(
      "user",
      answerContent || "User skipped answers.",
    );
    const structuredAnswers = mergeStructuredAnswers(
      snapshot.structuredAnswers,
      {
        questions: snapshot.lastQuestions,
        answerText: userMessage.content,
      },
    );

    const nextSnapshot: ConversationSnapshot = {
      ...snapshot,
      messages: [...snapshot.messages, userMessage],
      structuredAnswers,
      rounds: truncatedRounds,
      updatedAt: new Date().toISOString(),
    };

    if (snapshot.questionMode === "fast") {
      await generatePrd(nextSnapshot);
      return;
    }

    await sendChat(nextSnapshot, "questions", currentHash);
  }

  function handleBackRound() {
    if (isChatLoading || isGenerating) return;

    // Round pertama (atau belum ada round) → balik ke step Tech Stack.
    if (snapshot.roundIndex <= 0) {
      handleBack("techstack");
      return;
    }

    // Simpan jawaban saat ini ke round aktif sebelum mundur.
    const updatedRounds = [...snapshot.rounds];
    if (updatedRounds[snapshot.roundIndex]) {
      updatedRounds[snapshot.roundIndex] = {
        ...updatedRounds[snapshot.roundIndex],
        answers: questionAnswers,
      };
    }

    restoreRound(updatedRounds, snapshot.roundIndex - 1);
  }

  /** Restore conversation state ke round tertentu di stack tanpa memanggil AI. */
  function restoreRound(rounds: RoundState[], targetIndex: number) {
    const round = rounds[targetIndex];
    if (!round) return;

    setError("");
    setSnapshot({
      ...snapshot,
      rounds,
      roundIndex: targetIndex,
      lastQuestions: round.questions,
      summary: round.summary,
      readyToGenerate: round.readyToGenerate,
      currentPhase: round.currentPhase,
      messages: round.messagesAtEnd,
      structuredAnswers: round.structuredAnswersAtEnd,
      nextStep: getPhaseStep(round.currentPhase),
      updatedAt: new Date().toISOString(),
    });
    setQuestionAnswers(
      round.answers.length > 0
        ? round.answers
        : Array.from({ length: round.questions.length }, () => ({
            selected: [],
            note: "",
          })),
    );
  }

  async function sendChat(
    nextSnapshot: ConversationSnapshot,
    nextPhase: ConversationSnapshot["phase"],
    generatedFromAnswersHash = "",
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

      const currentPhase = normalizePhase(
        data.nextPhase,
        nextSnapshot.currentPhase,
      );

      const assistantMessage = createMessage(
        "assistant",
        formatAssistantMessage(
          data.message || "",
          data.questions || [],
          data.summary || "",
        ),
      );
      const newMessages = [...nextSnapshot.messages, assistantMessage];
      const questions = data.questions || [];
      const readyToGenerate =
        nextSnapshot.questionMode === "fast" || Boolean(data.readyToGenerate);

      const newRound: RoundState = {
        questions,
        answers: [],
        summary: data.summary || "",
        readyToGenerate,
        currentPhase,
        generatedFromAnswersHash,
        messagesAtEnd: newMessages,
        structuredAnswersAtEnd: nextSnapshot.structuredAnswers,
      };

      const newRounds = [...nextSnapshot.rounds, newRound];

      setSnapshot({
        ...nextSnapshot,
        phase: nextPhase,
        currentPhase,
        messages: newMessages,
        readyToGenerate,
        summary: data.summary || "",
        nextStep: getPhaseStep(currentPhase),
        lastQuestions: questions,
        rounds: newRounds,
        roundIndex: newRounds.length - 1,
        updatedAt: new Date().toISOString(),
      });
      setQuestionAnswers(
        Array.from({ length: questions.length }, () => ({
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
    setIsSidebarOpen(false);
    store.clear();
  }

  function handleBack(targetPhase: ConversationSnapshot["phase"]) {
    if (isChatLoading || isGenerating) return;
    setError("");
    setSnapshot({
      ...snapshot,
      phase: targetPhase,
      updatedAt: new Date().toISOString(),
    });
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
    setIsSidebarOpen(false);
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
    <main className="relative min-h-screen text-stone-950">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-stone-900/10 bg-paper-soft/80 px-4 py-3 backdrop-blur-md lg:hidden">
        <button
          type="button"
          onClick={() => setIsSidebarOpen(true)}
          className="ring-focus inline-flex h-10 w-10 items-center justify-center rounded-xl border border-stone-900/10 bg-white text-stone-700 transition hover:border-stone-900/30 hover:text-stone-950"
          aria-label="Open menu"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <BrandMark />
        <button
          type="button"
          onClick={startNewPrd}
          className="ring-focus inline-flex h-10 items-center gap-1.5 rounded-xl bg-stone-950 px-3 text-xs font-semibold text-white transition hover:bg-stone-800"
          aria-label="New PRD"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New
        </button>
      </header>

      <div className="lg:grid lg:min-h-screen lg:grid-cols-[300px_1fr]">
        {/* Sidebar drawer (mobile) + sticky panel (desktop) */}
        {isSidebarOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 z-40 bg-stone-950/40 backdrop-blur-sm lg:hidden"
          />
        ) : null}

        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-[88%] max-w-[320px] flex-col border-r border-stone-900/10 bg-paper-soft/95 px-5 py-6 transition-transform duration-300 ease-out lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-screen lg:w-auto lg:max-w-none lg:translate-x-0 lg:bg-paper-soft/60 lg:backdrop-blur ${
            isSidebarOpen
              ? "translate-x-0"
              : "-translate-x-full lg:translate-x-0"
          }`}
        >
          <div className="mb-6 flex items-center justify-between gap-3">
            <BrandMark />
            <button
              type="button"
              onClick={() => setIsSidebarOpen(false)}
              className="ring-focus inline-flex h-9 w-9 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-900/5 hover:text-stone-900 lg:hidden"
              aria-label="Close menu"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <button
            type="button"
            onClick={startNewPrd}
            className={`ring-focus group mb-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-3 text-sm font-semibold transition ${
              snapshot.phase === "brief" && !snapshot.sessionId
                ? "border-stone-900 bg-white text-stone-950"
                : "border-stone-900/20 bg-white/60 text-stone-600 hover:border-stone-900/40 hover:bg-white hover:text-stone-950"
            }`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New PRD
          </button>

          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-stone-500">
              History
            </p>
            <span className="text-[11px] font-medium text-stone-400">
              {history.length}
            </span>
          </div>

          <div className="-mr-2 flex-1 space-y-1.5 overflow-y-auto pr-2 pb-4">
            {history.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-900/15 bg-white/40 px-3 py-6 text-center text-xs text-stone-500">
                Belum ada PRD tersimpan.
              </p>
            ) : (
              history.map((item) => {
                const active = snapshot.sessionId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openHistory(item)}
                    className={`ring-focus group block w-full rounded-xl border px-3 py-3 text-left transition ${
                      active
                        ? "border-stone-950 bg-stone-950 text-white shadow-sm"
                        : "border-transparent bg-white/60 text-stone-800 hover:border-stone-900/15 hover:bg-white"
                    }`}
                  >
                    <span className="block truncate text-sm font-semibold">
                      {item.title}
                    </span>
                    <span
                      className={`mt-0.5 block truncate text-xs ${active ? "text-stone-300" : "text-stone-500"}`}
                    >
                      {item.projectIdea || "—"}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <p className="mt-2 hidden text-[11px] leading-5 text-stone-500 lg:block">
            Powered by Gemini · Output disimpan lokal di browser kamu.
          </p>
        </aside>

        <section className="flex min-h-[calc(100vh-57px)] items-start justify-center px-4 py-8 sm:px-6 lg:min-h-screen lg:items-center lg:px-10 lg:py-12">
          <div className="w-full max-w-4xl">
            <StepIndicator phase={snapshot.phase} />

            <div key={snapshot.phase} className="animate-rise">
              {snapshot.phase === "brief" ? (
                <BriefStep
                  projectIdea={projectIdea}
                  error={error}
                  onProjectIdeaChange={setProjectIdea}
                  onSubmit={handleBriefSubmit}
                />
              ) : null}

              {snapshot.phase === "mode" ? (
                <QuestionModeStep
                  initialMode={snapshot.questionMode}
                  error={error}
                  onSubmit={handleQuestionModeSubmit}
                  onBack={() => handleBack("brief")}
                />
              ) : null}

              {snapshot.phase === "techstack" ? (
                <TechStackStep
                  projectIdea={snapshot.projectIdea}
                  initialTechStackPref={extractTechStackPref(
                    snapshot.structuredAnswers.constraints,
                  )}
                  isLoading={isChatLoading}
                  error={error}
                  onSubmit={handleTechStackSubmit}
                  onBack={() => handleBack("mode")}
                />
              ) : null}

              {snapshot.phase === "questions" ? (
                isGenerating || isChatLoading ? (
                  <LoadingStep
                    title={
                      isGenerating
                        ? "Menyusun PRD Final..."
                        : "Menganalisis jawaban..."
                    }
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
                    onBack={handleBackRound}
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
          </div>
        </section>
      </div>
    </main>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="grid h-9 w-9 place-items-center rounded-xl bg-stone-950 text-white shadow-sm"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="13" x2="15" y2="13" />
          <line x1="9" y1="17" x2="13" y2="17" />
        </svg>
      </span>
      <div className="leading-tight">
        <p className="font-display text-lg font-black tracking-[-0.03em] text-stone-950">
          PRD Generator
        </p>
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
          AI · Gemini
        </p>
      </div>
    </div>
  );
}

function LoadingStep(props: { title?: string; description?: string }) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[2rem] border border-stone-900/10 bg-white/80 p-12 text-center shadow-[0_30px_80px_-40px_rgba(20,18,15,0.25)] backdrop-blur">
      <div className="relative mb-6 h-14 w-14">
        <div className="absolute inset-0 animate-ping rounded-full bg-orange-500/20" />
        <div className="relative h-14 w-14 animate-spin rounded-full border-4 border-stone-200 border-t-orange-500" />
      </div>
      <h2 className="font-display text-3xl font-black tracking-[-0.03em] text-stone-900">
        {props.title || "Memproses..."}
      </h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-stone-500">
        {props.description || "Harap tunggu sebentar."}
      </p>
    </div>
  );
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

function BriefStep(props: {
  projectIdea: string;
  error: string;
  onProjectIdeaChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const trimmed = props.projectIdea.trim();
  const charCount = props.projectIdea.length;

  return (
    <form onSubmit={props.onSubmit} className={cardClass}>
      <StepBadge index={1} label="Project brief" />
      <h2 className="mt-4 font-display text-4xl font-black tracking-[-0.04em] text-stone-950 sm:text-5xl">
        Project apa yang ingin dibuat?
      </h2>
      <p className="mt-4 max-w-2xl text-[15px] leading-7 text-stone-600">
        Tulis ide project dulu. Setelah itu pilih mode pertanyaan, preferensi
        teknologi, lalu AI menyusun requirement.
      </p>

      <div className="mt-8">
        <div className="flex items-center justify-between">
          <label
            className="text-sm font-semibold text-stone-800"
            htmlFor="projectIdea"
          >
            Brief
          </label>
          <span className="text-xs font-medium text-stone-400">
            {charCount} chars
          </span>
        </div>
        <textarea
          id="projectIdea"
          value={props.projectIdea}
          onChange={(event) => props.onProjectIdeaChange(event.target.value)}
          rows={7}
          placeholder="Contoh: Aplikasi web untuk generate PRD dari ide produk, dengan proses tanya jawab dan export Markdown."
          className="ring-focus mt-2 w-full resize-none rounded-3xl border border-stone-900/10 bg-stone-50/70 p-5 text-base leading-7 text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-stone-900/30 focus:bg-white"
        />
      </div>

      {props.error ? <ErrorMessage message={props.error} /> : null}

      <div className="mt-8 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-stone-500 sm:text-sm">
          Tip: makin detail brief, makin akurat pertanyaan AI.
        </p>
        <button
          type="submit"
          disabled={!trimmed}
          className="ring-focus group inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
        >
          Lanjut
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition group-hover:translate-x-0.5"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      </div>
    </form>
  );
}

const cardClass =
  "rounded-[2rem] border border-stone-900/10 bg-white/85 p-6 shadow-[0_30px_80px_-40px_rgba(20,18,15,0.25)] backdrop-blur sm:p-9";

function StepBadge({ index, label }: { index: number; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-50 px-3 py-1">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-stone-950 text-[10px] font-bold text-white">
        {index}
      </span>
      <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-stone-700">
        {label}
      </span>
    </div>
  );
}

function QuestionModeStep(props: {
  initialMode?: QuestionMode;
  error: string;
  onSubmit: (questionMode: QuestionMode) => void;
  onBack: () => void;
}) {
  const [questionMode, setQuestionMode] = useState<QuestionMode>(
    props.initialMode ?? "adaptive",
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit(questionMode);
  }

  return (
    <form onSubmit={handleSubmit} className={cardClass}>
      <StepBadge index={2} label="Question mode" />
      <h2 className="mt-4 font-display text-4xl font-black tracking-[-0.04em] text-stone-950 sm:text-5xl">
        Pilih cara AI bertanya
      </h2>
      <p className="mt-4 max-w-2xl text-[15px] leading-7 text-stone-600">
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
            <div
              className={`rounded-lg p-1.5 ${questionMode === "fast" ? "text-orange-500" : "text-stone-500"}`}
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
                <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"></path>
              </svg>
            </div>
            <span className="text-base font-bold">Cepat</span>
          </div>
          <p
            className={`text-sm ${questionMode === "fast" ? "text-stone-300" : "text-stone-500"}`}
          >
            Sekali submit, AI membuat maksimal 10 pertanyaan lalu langsung
            lanjut generate PRD setelah dijawab
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
            <div
              className={`rounded-lg p-1.5 ${questionMode === "adaptive" ? "text-orange-500" : "text-stone-500"}`}
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
                <path d="M8 10h8"></path>
                <path d="M8 14h5"></path>
              </svg>
            </div>
            <span className="text-base font-bold">Adaptive</span>
          </div>
          <p
            className={`text-sm ${questionMode === "adaptive" ? "text-stone-300" : "text-stone-500"}`}
          >
            AI bertanya maksimal 3 pertanyaan per tahap dan menyesuaikan
            pertanyaan dari jawaban terbaru
          </p>
        </label>
      </div>

      {props.error ? <ErrorMessage message={props.error} /> : null}

      <div className="mt-8 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <BackButton onClick={props.onBack} />
        <button
          type="submit"
          className="ring-focus group inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-stone-800"
        >
          Lanjut
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition group-hover:translate-x-0.5"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      </div>
    </form>
  );
}

function BackButton({
  onClick,
  disabled,
  label = "Kembali",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="ring-focus group inline-flex items-center justify-center gap-2 rounded-full border border-stone-900/15 bg-white px-5 py-3 text-sm font-semibold text-stone-700 transition hover:-translate-y-0.5 hover:border-stone-900/30 hover:text-stone-950 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="transition group-hover:-translate-x-0.5"
      >
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </svg>
      {label}
    </button>
  );
}

function TechStackStep(props: {
  projectIdea: string;
  initialTechStackPref?: string;
  isLoading: boolean;
  error: string;
  onSubmit: (techStackPref: string) => void;
  onBack: () => void;
}) {
  const initialChoice = useMemo<"ai" | "manual">(() => {
    const pref = props.initialTechStackPref?.trim();
    if (!pref) return "ai";
    return pref.startsWith("Biarkan AI memilih") ? "ai" : "manual";
  }, [props.initialTechStackPref]);

  const initialManual = useMemo(() => {
    const pref = props.initialTechStackPref?.trim() ?? "";
    if (!pref || pref.startsWith("Biarkan AI memilih")) return "";
    if (pref.startsWith("Bebas, tetapi user")) return "";
    return pref;
  }, [props.initialTechStackPref]);

  const [techStackChoice, setTechStackChoice] = useState<"ai" | "manual">(
    initialChoice,
  );
  const [manualTechStack, setManualTechStack] = useState(initialManual);

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
    <form onSubmit={handleSubmit} className={cardClass}>
      <StepBadge index={3} label="Tech preference" />
      <h2 className="mt-4 font-display text-4xl font-black tracking-[-0.04em] text-stone-950 sm:text-5xl">
        Preferensi teknologi
      </h2>
      <p className="mt-4 max-w-2xl text-[15px] leading-7 text-stone-600">
        Pilihan ini dipakai AI untuk membuat pertanyaan yang lebih pas, jadi
        halaman berikutnya tidak perlu mengulang pertanyaan dasar soal framework
        atau database.
      </p>

      {props.projectIdea ? (
        <div className="mt-6 rounded-3xl border border-stone-900/10 bg-stone-50/80 p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-stone-500">
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
          className="ring-focus mt-4 w-full resize-none rounded-2xl border border-stone-900/15 bg-white p-4 text-sm leading-7 outline-none transition placeholder:text-stone-400 focus:border-stone-900/40"
        />
      ) : null}

      {props.error ? <ErrorMessage message={props.error} /> : null}

      <div className="mt-8 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <BackButton onClick={props.onBack} disabled={props.isLoading} />
        <button
          type="submit"
          disabled={props.isLoading}
          className="ring-focus group inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
        >
          {props.isLoading ? (
            <>
              <Spinner />
              <span>AI menyusun pertanyaan...</span>
            </>
          ) : (
            <>
              <span>Lanjut</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition group-hover:translate-x-0.5"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </>
          )}
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
  onBack: () => void;
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

  const progress = totalCount > 0 ? (answeredCount / totalCount) * 100 : 0;

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-900/10 pb-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StepBadge
              index={4}
              label={isValidation ? "Validation" : "Questions"}
            />
            {!isFastMode && props.snapshot.rounds.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-900/10 bg-orange-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-orange-700">
                Round {props.snapshot.roundIndex + 1} /{" "}
                {props.snapshot.rounds.length}
              </span>
            ) : null}
          </div>
          <h2 className="mt-4 font-display text-3xl font-black tracking-[-0.03em] text-stone-950 sm:text-4xl">
            {isValidation ? "Validasi requirement" : "Beberapa pertanyaan"}
          </h2>
          <p className="mt-2 text-[15px] leading-7 text-stone-600">
            {isValidation
              ? "Review ringkasan requirement sebelum PRD final dibuat."
              : isFastMode
                ? "Jawab pertanyaan lengkap di bawah, lalu AI langsung membuat PRD final."
                : "Biar PRD-nya lebih akurat. Jawab pertanyaan adaptif di bawah."}
          </p>
        </div>
        {hasQuestions && !isValidation ? (
          <div className="shrink-0 rounded-2xl border border-stone-900/10 bg-stone-50 px-3 py-2 text-right">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-stone-500">
              Answered
            </p>
            <p className="font-display text-xl font-black text-stone-950">
              {answeredCount}
              <span className="text-sm font-bold text-stone-400">
                /{totalCount}
              </span>
            </p>
          </div>
        ) : null}
      </div>

      {hasQuestions && !isValidation ? (
        <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
          <div
            className="h-full rounded-full bg-gradient-to-r from-orange-500 to-orange-400 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-6">
        {isValidation ? (
          <div className="rounded-3xl border border-stone-900/10 bg-gradient-to-br from-stone-50 to-white p-6">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-stone-950 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Summary
            </div>
            <p className="whitespace-pre-wrap text-[15px] leading-7 text-stone-700">
              {props.snapshot.summary ||
                "Requirement sudah cukup jelas untuk dibuat menjadi PRD final."}
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

                const isAnswered =
                  answer.selected.length > 0 || answer.note.trim() !== "";
                return (
                  <div
                    key={`${question.text}-${index}`}
                    className="border-b border-stone-900/10 pb-6 last:border-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          aria-hidden
                          className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold transition ${
                            isAnswered
                              ? "bg-stone-950 text-white"
                              : "bg-stone-100 text-stone-500"
                          }`}
                        >
                          {isAnswered ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            index + 1
                          )}
                        </span>
                        <label
                          className="block text-base font-semibold leading-7 text-stone-900"
                          htmlFor={`answer-${index}`}
                        >
                          {question.text}
                        </label>
                      </div>
                      {isAnswered ? (
                        <button
                          type="button"
                          onClick={() => clearAnswer(index)}
                          className="shrink-0 text-xs font-medium text-stone-400 transition hover:text-stone-900"
                        >
                          Reset
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => clearAnswer(index)}
                          className="shrink-0 text-xs font-medium text-stone-400 transition hover:text-stone-900"
                        >
                          Lewati
                        </button>
                      )}
                    </div>

                    <div className="mt-4 ml-10 flex flex-wrap gap-2">
                      {options.map((option) => {
                        const isSelected = answer.selected.includes(option);
                        return (
                          <button
                            key={`${option}-${index}`}
                            type="button"
                            onClick={() =>
                              toggleOption(index, option, multiSelect)
                            }
                            className={`ring-focus inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                              isSelected
                                ? "border-orange-500 bg-orange-50 text-orange-700"
                                : "border-stone-900/15 bg-white text-stone-700 hover:border-stone-900/30 hover:text-stone-950"
                            }`}
                          >
                            {isSelected ? (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : null}
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
                        className="ring-focus mt-3 ml-10 w-[calc(100%-2.5rem)] resize-none rounded-2xl border border-stone-900/10 bg-stone-50/70 p-4 text-sm leading-7 outline-none transition placeholder:text-stone-400 focus:border-stone-900/30 focus:bg-white"
                      />
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="rounded-3xl border border-dashed border-stone-900/15 bg-stone-50/60 p-8 text-center text-sm text-stone-500">
                Tidak ada pertanyaan baru. Kamu bisa lanjut ke validasi
                requirement.
              </div>
            )}
          </div>
        )}

        {props.error ? <ErrorMessage message={props.error} /> : null}

        <div className="mt-8 flex flex-col-reverse items-stretch gap-3 border-t border-stone-900/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <BackButton
            onClick={props.onBack}
            disabled={props.isChatLoading}
            label={
              props.snapshot.roundIndex > 0
                ? "Pertanyaan sebelumnya"
                : "Kembali ke Tech Stack"
            }
          />
          <button
            type="submit"
            disabled={props.isChatLoading}
            className="ring-focus group inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-7 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {props.isChatLoading ? (
              <>
                <Spinner />
                <span>Memproses...</span>
              </>
            ) : (
              <>
                <span>
                  {isValidation || isFastMode ? "Generate PRD" : "Lanjut"}
                </span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition group-hover:translate-x-0.5"
                >
                  {isValidation || isFastMode ? (
                    <>
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </>
                  ) : (
                    <>
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </>
                  )}
                </svg>
              </>
            )}
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
  const ready = Boolean(props.snapshot.markdown);

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <StepBadge index={5} label="Result" />
          <h2 className="mt-4 font-display text-4xl font-black tracking-[-0.04em] text-stone-950 sm:text-5xl">
            Final PRD
          </h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-stone-600">
            Output PRD dalam Bahasa Indonesia, siap diunduh sebagai Markdown
            atau dibagikan.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={props.onCopy}
            disabled={!ready}
            className="ring-focus inline-flex items-center gap-1.5 rounded-full border border-stone-900/15 bg-white px-4 py-2.5 text-sm font-semibold text-stone-800 transition hover:border-stone-900/40 hover:bg-stone-950 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {props.copied ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {props.copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={props.onShare}
            disabled={!ready}
            className="ring-focus inline-flex items-center gap-1.5 rounded-full border border-stone-900/15 bg-white px-4 py-2.5 text-sm font-semibold text-stone-800 transition hover:border-stone-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            Share
          </button>
          <button
            type="button"
            onClick={props.onDownload}
            disabled={!ready}
            className="ring-focus inline-flex items-center gap-1.5 rounded-full bg-stone-950 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download .md
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

  const currentIndex = steps.findIndex((step) => step.id === phase);
  const totalSteps = steps.length;

  return (
    <nav aria-label="Progress" className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-stone-500">
          Step {Math.max(currentIndex + 1, 1)} of {totalSteps}
        </p>
        <p className="font-display text-sm font-semibold text-stone-700">
          {steps[currentIndex]?.label ?? steps[0].label}
        </p>
      </div>
      <ol className="flex gap-1.5 sm:gap-2">
        {steps.map((step, index) => {
          const isActive = index === currentIndex;
          const isComplete = index < currentIndex;
          return (
            <li
              key={step.id}
              className="group flex-1"
              aria-current={isActive ? "step" : undefined}
            >
              <div
                className={`relative h-1.5 overflow-hidden rounded-full transition-colors ${
                  isActive
                    ? "bg-stone-200"
                    : isComplete
                      ? "bg-stone-900"
                      : "bg-stone-200/70"
                }`}
              >
                {isActive ? (
                  <span className="absolute inset-y-0 left-0 w-2/3 rounded-full bg-gradient-to-r from-orange-500 to-orange-400" />
                ) : null}
              </div>
              <span
                className={`mt-2 hidden text-[11px] font-semibold uppercase tracking-[0.12em] sm:block ${
                  isActive
                    ? "text-stone-950"
                    : isComplete
                      ? "text-stone-700"
                      : "text-stone-400"
                }`}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
    >
      <svg
        aria-hidden
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 shrink-0"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span className="leading-6">{message}</span>
    </div>
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

/**
 * Hash deterministik untuk daftar jawaban; dipakai cache invalidation saat
 * user navigate forward antar round. Sort selected supaya urutan klik tidak
 * memengaruhi hash.
 */
function hashAnswers(answers: AnswerState[]): string {
  return JSON.stringify(
    answers.map((answer) => ({
      selected: [...answer.selected].sort(),
      note: answer.note.trim(),
    })),
  );
}

/**
 * Tech stack pref disimpan di structuredAnswers.constraints sebagai entry
 * dengan prefix "Tech stack: ". Ekstrak kembali untuk pre-fill UI saat user
 * navigasi back ke step Tech Stack.
 */
function extractTechStackPref(constraints: string[] | undefined): string {
  if (!Array.isArray(constraints)) return "";
  const prefix = "Tech stack: ";
  for (let i = constraints.length - 1; i >= 0; i--) {
    const entry = constraints[i];
    if (typeof entry === "string" && entry.startsWith(prefix)) {
      return entry.slice(prefix.length).trim();
    }
  }
  return "";
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
          if (!response)
            return `Question: ${question.text}\nAnswer: Not answered.`;

          const selected =
            response.selected.length > 0 ? response.selected.join(", ") : "-";
          const note = response.note.trim() ? response.note.trim() : "-";
          return `Question: ${question.text}\nAnswer: ${selected}\nNotes: ${note}`;
        })
        .join("\n\n")
    : answers
        .map((item) =>
          [item.selected.join(", "), item.note.trim()]
            .filter(Boolean)
            .join("\n"),
        )
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

function formatAssistantMessage(
  message: string,
  questions: ChatQuestion[],
  summary = "",
) {
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
    currentPhase: normalizePhase(
      snapshot.currentPhase,
      snapshot.readyToGenerate ? "generation" : "discovery",
    ),
    questionMode: snapshot.questionMode || "adaptive",
    lastQuestions: snapshot.lastQuestions || [],
    summary: snapshot.summary || "",
    structuredAnswers: normalizeStructuredAnswers(snapshot.structuredAnswers),
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
    rounds: Array.isArray(snapshot.rounds) ? snapshot.rounds : [],
    roundIndex:
      typeof snapshot.roundIndex === "number" ? snapshot.roundIndex : -1,
  };
}
