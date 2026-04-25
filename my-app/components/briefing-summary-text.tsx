"use client";

const URL_RE = /(https?:\/\/[^\s<>"']+)/gi;

/**
 * `whitespace-pre-wrap`으로 줄바꿈을 유지하고, http(s) URL만 링크로 렌더링합니다.
 */
export function BriefingSummaryText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(URL_RE);
  return (
    <div className={`whitespace-pre-wrap text-sm leading-relaxed text-slate-200 ${className ?? ""}`}>
      {parts.map((part, i) =>
        /^https?:\/\//i.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-sky-400 underline decoration-sky-400/60 underline-offset-2 hover:text-sky-300"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
}
