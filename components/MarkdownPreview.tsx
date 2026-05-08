"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

type MarkdownPreviewProps = {
  markdown: string;
};

// Initialize mermaid once
if (typeof window !== "undefined") {
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: {
      primaryColor: "#ffffff",
      primaryTextColor: "#1c1917",
      primaryBorderColor: "#e7e5e4",
      lineColor: "#a8a29e",
      secondaryColor: "#f5f5f4",
      tertiaryColor: "#fafaf9",
    },
    securityLevel: "loose",
  });
}

/**
 * Auto-fix sintaks mermaid yang sering AI-output tidak valid:
 * - Wrap label flowchart node `[...]`, `(...)`, `{...}` dengan tanda kutip ganda
 *   kalau labelnya mengandung karakter spesial (`(`, `)`, `<br/>`, `/`, `:`)
 *   dan belum di-wrap.
 *
 * Tidak menyentuh erDiagram (di sana kutip ganda justru error).
 */
function sanitizeMermaid(chart: string): string {
  const isErDiagram = /^\s*erDiagram/m.test(chart);
  if (isErDiagram) return chart;

  // Special chars yang butuh quoting di label flowchart.
  const needsQuote = /[()/:,]|<br\s*\/?>/;

  // Match: ID diikuti `[label]` / `(label)` / `{label}` di mana label belum
  // diawali tanda kutip ganda.
  // Contoh match: A[Mobile App<br/>(React Native / Flutter)]
  return chart.replace(
    /([A-Za-z_][\w-]*)\s*([\[(\{])([^"\]\)\}\n][^\]\)\}\n]*)([\]\)\}])/g,
    (match, id, open, label, close) => {
      // Skip jika label sudah punya kutip ganda di awal (sudah benar).
      if (label.startsWith('"')) return match;
      // Skip jika label tidak mengandung karakter problematik.
      if (!needsQuote.test(label)) return match;
      // Bracket harus match: [..], (..), {..}.
      const expected =
        open === "[" ? "]" : open === "(" ? ")" : open === "{" ? "}" : "";
      if (close !== expected) return match;
      return `${id}${open}"${label.trim()}"${close}`;
    },
  );
}

function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);

  const safeChart = useMemo(() => sanitizeMermaid(chart), [chart]);

  useEffect(() => {
    let isMounted = true;
    if (ref.current && safeChart && !hasError) {
      const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
      mermaid
        .render(id, safeChart)
        .then(({ svg }) => {
          if (isMounted && ref.current) {
            ref.current.innerHTML = svg;
          }
        })
        .catch((e) => {
          console.error("Mermaid error", e, "\nChart:\n", safeChart);
          if (isMounted) {
            setHasError(true);
          }
        });
    }
    return () => {
      isMounted = false;
    };
  }, [safeChart, hasError]);

  if (hasError) {
    return (
      <div className="my-6 rounded-2xl border border-red-200 bg-red-50 p-4">
        <p className="mb-2 text-sm font-bold text-red-700">
          ⚠️ Diagram gagal dirender (Sintaks Mermaid tidak valid)
        </p>
        <pre className="overflow-x-auto rounded-xl bg-white p-4 text-xs text-stone-800 shadow-sm border border-red-100">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="mermaid flex justify-center overflow-x-auto my-8 bg-white p-6 rounded-3xl border border-stone-200 shadow-sm"
      ref={ref}
    />
  );
}

export function MarkdownPreview({ markdown }: MarkdownPreviewProps) {
  if (!markdown) {
    return (
      <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-stone-900/15 bg-stone-50/60 p-10 text-center text-sm text-stone-500">
        <svg
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-stone-400"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <p className="font-display text-base font-semibold text-stone-700">
          PRD belum dibuat
        </p>
        <p className="max-w-xs text-xs text-stone-500">
          Hasil PRD final akan muncul di sini setelah AI selesai menyusun.
        </p>
      </div>
    );
  }

  return (
    <article className="max-h-[70vh] overflow-auto rounded-3xl border border-stone-900/10 bg-white p-6 shadow-inner sm:max-h-[720px] sm:p-8">
      <div className="max-w-none text-stone-900">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            code({ className, children, ...props }: any) {
              const match = /language-(\w+)/.exec(className || "");
              const language = match ? match[1] : "";

              if (language === "mermaid") {
                return (
                  <MermaidDiagram chart={String(children).replace(/\n$/, "")} />
                );
              }

              const isInline = !match;

              return !isInline ? (
                <div className="rounded-2xl overflow-hidden my-6 border border-stone-200">
                  <div className="bg-stone-100 px-4 py-2 border-b border-stone-200 flex items-center">
                    <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                      {language || "code"}
                    </span>
                  </div>
                  <pre className="bg-white p-4 overflow-x-auto text-sm text-stone-800">
                    <code className={className} {...props}>
                      {children}
                    </code>
                  </pre>
                </div>
              ) : (
                <code
                  className="bg-stone-200 text-stone-900 px-1.5 py-0.5 rounded-md text-sm font-mono border border-stone-300"
                  {...props}
                >
                  {children}
                </code>
              );
            },
            table({ children, ...props }) {
              return (
                <div className="overflow-x-auto my-8">
                  <table
                    className="min-w-full divide-y divide-stone-200 border border-stone-200 rounded-2xl overflow-hidden bg-white"
                    {...props}
                  >
                    {children}
                  </table>
                </div>
              );
            },
            thead({ children, ...props }) {
              return (
                <thead className="bg-stone-100" {...props}>
                  {children}
                </thead>
              );
            },
            tbody({ children, ...props }) {
              return (
                <tbody className="divide-y divide-stone-200" {...props}>
                  {children}
                </tbody>
              );
            },
            tr({ children, ...props }) {
              return (
                <tr className="transition-colors hover:bg-stone-50" {...props}>
                  {children}
                </tr>
              );
            },
            th({ children, ...props }) {
              return (
                <th
                  className="px-5 py-4 text-left text-sm font-black text-stone-900"
                  {...props}
                >
                  {children}
                </th>
              );
            },
            td({ children, ...props }) {
              return (
                <td className="px-5 py-4 text-sm text-stone-700" {...props}>
                  {children}
                </td>
              );
            },
            h1({ children, ...props }) {
              return (
                <h1
                  className="font-display text-3xl sm:text-4xl font-black tracking-[-0.03em] text-stone-950 mb-5 mt-2 first:mt-0"
                  {...props}
                >
                  {children}
                </h1>
              );
            },
            h2({ children, ...props }) {
              return (
                <h2
                  className="font-display text-2xl font-black tracking-[-0.02em] text-stone-950 mb-4 mt-10 pb-3 border-b border-stone-900/10"
                  {...props}
                >
                  {children}
                </h2>
              );
            },
            h3({ children, ...props }) {
              return (
                <h3
                  className="font-display font-bold text-xl tracking-tight text-stone-900 mt-8 mb-3"
                  {...props}
                >
                  {children}
                </h3>
              );
            },
            ul({ children, ...props }) {
              return (
                <ul
                  className="list-disc pl-6 my-5 space-y-2 text-stone-700 marker:text-stone-400"
                  {...props}
                >
                  {children}
                </ul>
              );
            },
            ol({ children, ...props }) {
              return (
                <ol
                  className="list-decimal pl-6 my-5 space-y-2 text-stone-700 marker:text-stone-400"
                  {...props}
                >
                  {children}
                </ol>
              );
            },
            p({ children, ...props }) {
              return (
                <p className="text-stone-700 leading-relaxed my-5" {...props}>
                  {children}
                </p>
              );
            },
            a({ children, ...props }) {
              return (
                <a
                  className="text-blue-600 hover:text-blue-800 hover:underline font-semibold transition-colors"
                  {...props}
                >
                  {children}
                </a>
              );
            },
            strong({ children, ...props }) {
              return (
                <strong className="font-black text-stone-950" {...props}>
                  {children}
                </strong>
              );
            },
            blockquote({ children, ...props }) {
              return (
                <blockquote
                  className="border-l-4 border-stone-300 bg-stone-100/50 pl-5 py-2 my-6 italic text-stone-600 rounded-r-2xl"
                  {...props}
                >
                  {children}
                </blockquote>
              );
            },
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </article>
  );
}
