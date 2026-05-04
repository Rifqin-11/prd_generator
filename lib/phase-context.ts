import type { ChatQuestion, Phase, StructuredAnswers } from "@/lib/types";

const phaseOrder: Phase[] = ["discovery", "refinement", "validation", "generation"];

export function createEmptyStructuredAnswers(): StructuredAnswers {
  return {
    productIdea: "",
    targetUser: "",
    platform: "",
    features: [],
    userFlow: "",
    constraints: [],
  };
}

export function normalizePhase(value: unknown, fallback: Phase = "discovery"): Phase {
  return typeof value === "string" && phaseOrder.includes(value as Phase)
    ? (value as Phase)
    : fallback;
}

export function normalizeStructuredAnswers(value: unknown): StructuredAnswers {
  const fallback = createEmptyStructuredAnswers();
  if (!value || typeof value !== "object") return fallback;

  const record = value as Record<string, unknown>;
  return {
    productIdea: normalizeText(record.productIdea),
    targetUser: normalizeText(record.targetUser),
    platform: normalizeText(record.platform),
    features: normalizeTextList(record.features),
    userFlow: normalizeText(record.userFlow),
    constraints: normalizeTextList(record.constraints),
  };
}

export function mergeStructuredAnswers(
  previous: StructuredAnswers,
  input: {
    projectIdea?: string;
    techStackPref?: string;
    questions?: ChatQuestion[];
    answerText?: string;
  },
): StructuredAnswers {
  const next = normalizeStructuredAnswers(previous);
  const projectIdea = normalizeText(input.projectIdea);
  const techStackPref = normalizeText(input.techStackPref);
  const answerText = normalizeText(input.answerText, 6000);

  if (projectIdea) next.productIdea = projectIdea;
  if (techStackPref) next.constraints = appendUnique(next.constraints, `Tech stack: ${techStackPref}`);
  if (!answerText) return next;

  const questionText = (input.questions || []).map((question) => question.text).join("\n").toLowerCase();
  const combined = `${questionText}\n${answerText.toLowerCase()}`;

  if (includesAny(combined, ["target", "user", "pengguna", "customer", "audience"])) {
    next.targetUser = appendSentence(next.targetUser, answerText);
  }

  if (includesAny(combined, ["platform", "web", "mobile", "desktop", "android", "ios"])) {
    next.platform = appendSentence(next.platform, answerText);
  }

  if (includesAny(combined, ["fitur", "feature", "fungsi", "capability", "scope"])) {
    next.features = appendUnique(next.features, splitAnswerItems(answerText));
  }

  if (includesAny(combined, ["flow", "alur", "journey", "step", "proses"])) {
    next.userFlow = appendSentence(next.userFlow, answerText);
  }

  if (includesAny(combined, ["constraint", "batasan", "teknis", "deadline", "budget", "database", "framework", "integrasi"])) {
    next.constraints = appendUnique(next.constraints, splitAnswerItems(answerText));
  }

  if (!next.features.length) next.features = appendUnique(next.features, splitAnswerItems(answerText).slice(0, 3));
  return next;
}

export function resolveNextPhase(currentPhase: Phase, requestedPhase: Phase, structuredAnswers: StructuredAnswers) {
  const currentIndex = phaseOrder.indexOf(currentPhase);
  const requestedIndex = phaseOrder.indexOf(requestedPhase);
  const cappedIndex = Math.min(Math.max(requestedIndex, currentIndex), currentIndex + 1);
  const proposed = phaseOrder[cappedIndex] || currentPhase;

  if (currentPhase === "discovery" && !hasBasicInfo(structuredAnswers)) return "discovery";
  if (currentPhase === "refinement" && !hasRequirementClarity(structuredAnswers)) return "refinement";
  if (currentPhase === "validation" && proposed !== "generation") return "validation";
  return proposed;
}

export function getPhaseStep(phase: Phase) {
  if (phase === "discovery") return "Discovery";
  if (phase === "refinement") return "Requirement refinement";
  if (phase === "validation") return "Requirement validation";
  return "PRD generation";
}

function hasBasicInfo(value: StructuredAnswers) {
  return Boolean(value.productIdea && (value.targetUser || value.platform || value.features.length > 0));
}

function hasRequirementClarity(value: StructuredAnswers) {
  return Boolean(
    value.productIdea &&
      (value.targetUser || value.platform) &&
      value.features.length > 0 &&
      (value.userFlow || value.constraints.length > 0),
  );
}

function normalizeText(value: unknown, maxLength = 1200) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function normalizeTextList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item, 500)).filter(Boolean).slice(0, 24)
    : [];
}

function appendSentence(base: string, addition: string) {
  if (!base) return addition;
  if (base.includes(addition)) return base;
  return `${base}\n${addition}`.slice(0, 2400);
}

function appendUnique(base: string[], additions: string | string[]) {
  const items = Array.isArray(additions) ? additions : [additions];
  const seen = new Set(base.map((item) => item.toLowerCase()));
  const next = [...base];

  for (const item of items.map((value) => normalizeText(value, 500)).filter(Boolean)) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      next.push(item);
    }
  }

  return next.slice(0, 24);
}

function splitAnswerItems(value: string) {
  return value
    .split(/\n|,|;|\s+-\s+/)
    .map((item) => normalizeText(item, 500))
    .filter(Boolean)
    .slice(0, 12);
}

function includesAny(value: string, keywords: string[]) {
  return keywords.some((keyword) => value.includes(keyword));
}
