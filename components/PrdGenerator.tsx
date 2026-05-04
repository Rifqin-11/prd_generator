"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { createEmptyConversation, SessionConversationStore } from "@/lib/store/conversation-store";
import type {
  ChatApiResponse,
  ChatMessage,
  ChatQuestion,
  ConversationSnapshot,
  GenerateApiResponse,
  PrdHistoryItem,
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

  const answeredQuestionCount = Math.max(
    0,
    snapshot.messages.filter((message) => message.role === "user").length - 1,
  );
  const canGenerate = snapshot.readyToGenerate || answeredQuestionCount >= 1;

  async function handleBriefSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectIdea.trim() || isChatLoading) return;

    const title = createTitle(projectIdea);
    const briefText = [
      `Project idea: ${projectIdea.trim()}`,
      "Before creating the final PRD, analyze this project and ask the most important requirement questions.",
    ].join("\n");

    const nextSnapshot: ConversationSnapshot = {
      ...snapshot,
      title,
      projectIdea: projectIdea.trim(),
      phase: "brief",
      messages: [createMessage("user", briefText)],
      lastQuestions: [],
      markdown: "",
      readyToGenerate: false,
      nextStep: "AI is analyzing the brief",
      updatedAt: new Date().toISOString(),
    };

    await sendChat(nextSnapshot, "questions");
  }

  async function handleQuestionSubmit(event: FormEvent<HTMLFormElement>) {
    // This is no longer used since we go straight to generate
    event.preventDefault();
  }

  async function sendChat(nextSnapshot: ConversationSnapshot, nextPhase: ConversationSnapshot["phase"]) {
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
          messages: nextSnapshot.messages,
        }),
      });

      const data = (await response.json()) as Partial<ChatApiResponse> & { error?: string };
      if (!response.ok) throw new Error(data.error || "AI gagal memproses brief.");

      setSnapshot({
        ...nextSnapshot,
        phase: nextPhase,
        messages: [
          ...nextSnapshot.messages,
          createMessage("assistant", formatAssistantMessage(data.message || "", data.questions || [])),
        ],
        readyToGenerate: Boolean(data.readyToGenerate),
        nextStep: data.nextStep || "Requirement questions",
        lastQuestions: data.questions || [],
        updatedAt: new Date().toISOString(),
      });
      setQuestionAnswers(
        Array.from({ length: (data.questions || []).length }, () => ({ selected: [], note: "" })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Terjadi error saat menghubungi AI.");
    } finally {
      setIsChatLoading(false);
    }
  }

  async function generatePrd(techStackPref?: string) {
    if (isGenerating) return;

    setError("");
    setCopied(false);
    setIsGenerating(true);

    const latestQuestions = getLatestQuestions(snapshot);
    const hasAnswer = questionAnswers.some((item) => item.selected.length > 0 || item.note.trim());

    let finalMessages = snapshot.messages;

    if (hasAnswer || techStackPref) {
      const answerContent = latestQuestions.length
        ? latestQuestions
            .map((question, index) => {
              const response = questionAnswers[index];
              if (!response) return `Question: ${question.text}\nAnswer: Not answered.`;

              const selected = response.selected.length > 0 ? response.selected.join(", ") : "-";
              const note = response.note.trim() ? response.note.trim() : "-";
              return `Question: ${question.text}\nAnswer: ${selected}\nNotes: ${note}`;
            })
            .join("\n\n")
        : questionAnswers
            .map((item) => [item.selected.join(", "), item.note.trim()].filter(Boolean).join("\n"))
            .filter(Boolean)
            .join("\n\n");

      let userMessageContent = answerContent || "User skipped answers.";
      if (techStackPref) {
        userMessageContent += `\n\nTech Stack Preference: ${techStackPref}`;
      }

      finalMessages = [...snapshot.messages, createMessage("user", userMessageContent)];
    }

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: snapshot.sessionId,
          templateMode: snapshot.templateMode,
          messages: finalMessages,
        }),
      });

      const data = (await response.json()) as Partial<GenerateApiResponse> & { error?: string };
      if (!response.ok) throw new Error(data.error || "Generate PRD gagal.");

      const nextSnapshot: ConversationSnapshot = {
        ...snapshot,
        messages: finalMessages,
        markdown: data.markdown || "",
        phase: "result",
        lastQuestions: [],
        nextStep: "Final PRD",
        updatedAt: new Date().toISOString(),
      };

      const nextHistory = upsertHistory(history, nextSnapshot);
      setSnapshot(nextSnapshot);
      setHistory(nextHistory);
      store.saveHistory(nextHistory);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Terjadi error saat generate PRD.");
      // If failed, revert to questions phase so user can try again
      setSnapshot(s => ({...s, phase: "questions"}));
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
      markdown: item.markdown,
      lastQuestions: [],
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

    const blob = new Blob([snapshot.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugify(snapshot.title || "prd")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function sharePrd() {
    if (!snapshot.markdown) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: snapshot.title || "Product Requirements Document",
          text: snapshot.markdown,
        });
      } catch (error) {
        // user aborted or error
      }
    } else {
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
                <span className="block truncate text-sm font-black">{item.title}</span>
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
                isLoading={isChatLoading}
                error={error}
                onProjectIdeaChange={setProjectIdea}
                onSubmit={handleBriefSubmit}
              />
            ) : null}

            {snapshot.phase === "questions" ? (
              isGenerating ? (
                <LoadingStep />
              ) : (
                <QuestionsStep
                  snapshot={snapshot}
                  questionAnswers={questionAnswers}
                  isChatLoading={isChatLoading}
                  error={error}
                  onAnswerChange={setQuestionAnswers}
                  onGenerate={generatePrd}
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

function LoadingStep() {
  return (
    <div className="rounded-[2rem] border border-stone-200 bg-white p-12 text-center shadow-sm flex flex-col items-center justify-center min-h-[400px]">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-stone-200 border-t-stone-900 mb-6"></div>
      <h2 className="font-display text-2xl font-black tracking-[-0.03em] text-stone-900">
        Menyusun PRD Final...
      </h2>
      <p className="mt-3 text-sm text-stone-500 max-w-sm mx-auto leading-relaxed">
        Harap tunggu sebentar sementara AI merangkum semua jawaban Anda dan menyusun PRD berdasarkan template yang ditentukan.
      </p>
    </div>
  );
}

function BriefStep(props: {
  projectIdea: string;
  isLoading: boolean;
  error: string;
  onProjectIdeaChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={props.onSubmit} className="rounded-[2rem] border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-bold text-stone-500">Step 1</p>
      <h2 className="mt-3 font-display text-4xl font-black tracking-[-0.05em] sm:text-5xl">
        Project apa yang ingin dibuat?
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-500">
        Tulis ide project. AI akan memproses brief ini dulu, lalu membuat halaman pertanyaan
        untuk memperjelas requirement.
      </p>

      <label className="mt-8 block text-sm font-black text-stone-800" htmlFor="projectIdea">
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
          disabled={!props.projectIdea.trim() || props.isLoading}
          className="rounded-full bg-stone-950 px-6 py-4 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.isLoading ? "AI memproses..." : "Process Brief"}
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
  onGenerate: (techStackPref: string) => void;
}) {
  const [techStackChoice, setTechStackChoice] = useState<"ai" | "manual">("ai");
  const [manualTechStack, setManualTechStack] = useState("");

  const latestQuestions = getLatestQuestions(props.snapshot);
  const previousMessages = props.snapshot.messages.slice(1, -1);
  const hasQuestions = latestQuestions.length > 0;

  const answeredCount = props.questionAnswers.filter(a => a.selected.length > 0 || a.note.trim() !== '').length;
  const totalCount = latestQuestions.length;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const techStackPref = techStackChoice === "ai"
      ? "Dipilihkan oleh AI yang paling sesuai dengan project ini"
      : manualTechStack.trim() || "Bebas (ditentukan AI)";
    props.onGenerate(techStackPref);
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
          <h2 className="font-display text-3xl font-black tracking-[-0.03em] text-stone-900">
            Beberapa pertanyaan
          </h2>
          <p className="mt-2 text-base text-stone-500">
            Biar PRD-nya lebih akurat. Jawab semua pertanyaan di bawah.
          </p>
        </div>
        {hasQuestions ? (
          <div className="text-sm font-bold text-stone-500">
            {answeredCount}/{totalCount}
          </div>
        ) : null}
      </div>

      {previousMessages.length > 0 && (
        <div className="mt-6 space-y-3 rounded-3xl bg-stone-50 p-4">
          {previousMessages.map((message) => (
            <CompactMessageCard key={message.id} message={message} />
          ))}
          {props.isChatLoading ? (
            <div className="rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-500">
              AI sedang menyusun pertanyaan lanjutan...
            </div>
          ) : null}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6">
        <div className="mb-8 border-b border-stone-200 pb-8">
          <h3 className="text-xl font-black text-stone-900 tracking-[-0.02em]">Preferensi teknologi</h3>
          <p className="mt-1 text-sm text-stone-500">Udah punya pilihan tech stack, atau mau AI yang tentuin?</p>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className={`cursor-pointer rounded-2xl border-2 p-5 transition-all ${
              techStackChoice === "ai"
                ? "border-orange-500 bg-stone-900 text-white"
                : "border-stone-200 bg-white text-stone-900 hover:border-stone-300"
            }`}>
              <input
                type="radio"
                name="techStack"
                value="ai"
                className="sr-only"
                checked={techStackChoice === "ai"}
                onChange={() => setTechStackChoice("ai")}
              />
              <div className="flex items-center gap-3 mb-2">
                <div className={`p-1.5 rounded-lg ${techStackChoice === "ai" ? "text-orange-500" : "text-stone-500"}`}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M9 10h.01"></path><path d="M15 10h.01"></path></svg>
                </div>
                <span className="font-bold text-base">Biarkan AI pilih</span>
              </div>
              <p className={`text-sm ${techStackChoice === "ai" ? "text-stone-300" : "text-stone-500"}`}>
                AI rekomendasiin stack yang paling cocok buat project kamu
              </p>
            </label>

            <label className={`cursor-pointer rounded-2xl border-2 p-5 transition-all ${
              techStackChoice === "manual"
                ? "border-orange-500 bg-stone-900 text-white"
                : "border-stone-200 bg-white text-stone-900 hover:border-stone-300"
            }`}>
              <input
                type="radio"
                name="techStack"
                value="manual"
                className="sr-only"
                checked={techStackChoice === "manual"}
                onChange={() => setTechStackChoice("manual")}
              />
              <div className="flex items-center gap-3 mb-2">
                <div className={`p-1.5 rounded-lg ${techStackChoice === "manual" ? "text-orange-500" : "text-stone-500"}`}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                </div>
                <span className="font-bold text-base">Pilih sendiri</span>
              </div>
              <p className={`text-sm ${techStackChoice === "manual" ? "text-stone-300" : "text-stone-500"}`}>
                Kamu tentuin teknologi yang mau dipakai
              </p>
            </label>
          </div>

          {techStackChoice === "manual" && (
            <textarea
              value={manualTechStack}
              onChange={(e) => setManualTechStack(e.target.value)}
              rows={2}
              placeholder="Contoh: Next.js, Tailwind CSS, Supabase"
              className="mt-4 w-full resize-none rounded-2xl border-2 border-stone-200 bg-white p-4 text-sm leading-7 outline-none transition placeholder:text-stone-400 focus:border-stone-900"
            />
          )}
        </div>

        <div className="space-y-6">
          {hasQuestions ? (
            latestQuestions.map((question, index) => {
              const answer = props.questionAnswers[index] || { selected: [], note: "" };
              const options = question.options && question.options.length > 0 ? question.options : ["Lainnya"];
              const allowFreeText = question.allowFreeText ?? true;
              const multiSelect = question.multiSelect ?? true;

              return (
                <div key={`${question.text}-${index}`} className="border-b border-stone-100 pb-6 last:border-0 last:pb-0">
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
                          onClick={() => toggleOption(index, option, multiSelect)}
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
                      onChange={(event) => updateAnswer(index, event.target.value)}
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
              Tidak ada pertanyaan baru. Kamu bisa lanjut membuat PRD final.
            </div>
          )}
        </div>

        {props.error ? <ErrorMessage message={props.error} /> : null}

        <div className="mt-8 pt-6 flex flex-wrap justify-end gap-3">
          <button
            type="submit"
            disabled={props.isChatLoading}
            className="rounded-full bg-stone-950 px-8 py-4 text-sm font-black text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Generate PRD
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
          <p className="text-sm font-bold text-stone-500">Step 3</p>
          <h2 className="mt-3 font-display text-4xl font-black tracking-[-0.05em]">
            Final PRD
          </h2>
          <p className="mt-3 text-sm leading-7 text-stone-500">
            Output PRD dibuat dalam Bahasa Indonesia dan bisa didownload sebagai Markdown.
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

function CompactMessageCard({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const questions = isUser ? [] : extractQuestions(message.content).slice(0, 2);
  const summary = isUser
    ? "Jawaban terkirim."
    : questions.length > 0
      ? questions.join(" | ")
      : message.content.split(/\n+/)[0]?.slice(0, 140) || "Pertanyaan lanjutan.";

  return (
    <div
      className={`rounded-2xl border px-4 py-3 text-xs leading-6 ${
        isUser ? "border-stone-950 bg-stone-950 text-white" : "border-stone-200 bg-white text-stone-700"
      }`}
    >
      <p
        className={`mb-1 text-[0.65rem] font-black uppercase tracking-[0.2em] ${
          isUser ? "text-white/50" : "text-stone-400"
        }`}
      >
        {isUser ? "Jawaban" : "Pertanyaan"}
      </p>
      <p className="whitespace-pre-wrap break-words">{summary}</p>
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

function createMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };
}

function formatAssistantMessage(message: string, questions: ChatQuestion[]) {
  const normalizedQuestions =
    questions.length > 0 ? questions.map((question) => question.text) : extractQuestions(message);
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
    value.matchAll(/(?:^|\n)\s*(?:\d+[\).]|[-*])\s+([\s\S]+?)(?=\n\s*(?:\d+[\).]|[-*])\s+|\n{2,}|$)/g),
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

function upsertHistory(history: PrdHistoryItem[], snapshot: ConversationSnapshot) {
  const item: PrdHistoryItem = {
    id: snapshot.sessionId,
    title: snapshot.title || createTitle(snapshot.projectIdea),
    projectIdea: snapshot.projectIdea,
    markdown: snapshot.markdown,
    createdAt: new Date().toISOString(),
  };

  return [item, ...history.filter((entry) => entry.id !== item.id)].slice(0, 12);
}

function migrateSnapshot(snapshot: ConversationSnapshot) {
  const fallback = createEmptyConversation("technical");
  const phase =
    snapshot.phase || (snapshot.markdown ? "result" : snapshot.messages.length > 0 ? "questions" : "brief");

  return {
    ...fallback,
    ...snapshot,
    title: snapshot.title || createTitle(snapshot.projectIdea || snapshot.messages[0]?.content || ""),
    projectIdea: snapshot.projectIdea || "",
    phase,
    lastQuestions: snapshot.lastQuestions || [],
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
  };
}
