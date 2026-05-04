import { GoogleGenAI } from "@google/genai";

let cachedClient: GoogleGenAI | null = null;

export function getGeminiModel() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

export function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum diatur di environment server.");
  }

  cachedClient ??= new GoogleGenAI({ apiKey });
  return cachedClient;
}

export async function generateWithGemini(options: {
  systemInstruction: string;
  prompt: string;
  responseMimeType?: string;
  temperature?: number;
  maxOutputTokens?: number;
}) {
  const ai = getGeminiClient();
  const modelName = getGeminiModel();
  const isGemma = modelName.toLowerCase().includes("gemma");

  const contents = isGemma
    ? `[SYSTEM INSTRUCTIONS]\n${options.systemInstruction}\n\n[USER REQUEST]\n${options.prompt}`
    : options.prompt;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    responseMimeType: options.responseMimeType,
    temperature: options.temperature ?? 0.45,
    maxOutputTokens: options.maxOutputTokens ?? 1800,
  };

  if (!isGemma) {
    config.systemInstruction = options.systemInstruction;
  }

  const response = await ai.models.generateContent({
    model: modelName,
    contents,
    config,
  });

  const text = response.text?.trim();

  if (!text) {
    throw new Error("Gemini tidak mengembalikan teks.");
  }

  return text;
}
