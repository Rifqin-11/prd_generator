"use client";

type MarkdownPreviewProps = {
  markdown: string;
};

export function MarkdownPreview({ markdown }: MarkdownPreviewProps) {
  if (!markdown) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-dashed border-stone-200 bg-stone-50 p-8 text-center text-sm text-stone-500">
        Final PRD will appear here after generation.
      </div>
    );
  }

  return (
    <article className="max-h-[720px] overflow-auto rounded-3xl border border-stone-200 bg-stone-50 p-6">
      <div className="space-y-3 text-stone-900">
        {markdown.split("\n").map((line, index) => (
          <MarkdownLine key={`${line}-${index}`} line={line} />
        ))}
      </div>
    </article>
  );
}

function MarkdownLine({ line }: { line: string }) {
  if (!line.trim()) return <div className="h-3" />;

  if (line.startsWith("# ")) {
    return <h1 className="font-display text-3xl font-black leading-tight tracking-[-0.04em]">{line.slice(2)}</h1>;
  }

  if (line.startsWith("## ")) {
    return (
      <h2 className="pt-5 font-display text-xl font-black leading-tight tracking-[-0.03em]">
        {line.slice(3)}
      </h2>
    );
  }

  if (line.startsWith("### ")) {
    return <h3 className="pt-2 text-base font-black text-stone-900">{line.slice(4)}</h3>;
  }

  if (line.startsWith("- ")) {
    return (
      <p className="pl-4 text-sm leading-7 text-stone-700 before:mr-2 before:text-stone-400 before:content-['•']">
        {line.slice(2)}
      </p>
    );
  }

  const ordered = line.match(/^(\d+)\.\s(.+)$/);
  if (ordered) {
    return (
      <p className="pl-4 text-sm leading-7 text-stone-700">
        <span className="mr-2 font-black text-stone-950">{ordered[1]}.</span>
        {ordered[2]}
      </p>
    );
  }

  return <p className="text-sm leading-7 text-stone-700">{line}</p>;
}
