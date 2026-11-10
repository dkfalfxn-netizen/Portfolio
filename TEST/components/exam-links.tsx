"use client";

import type { Exam } from "@/lib/types";

/** 자료 내려받기: 링크가 있는 시험지만 표시 */
export function ExamLinks({ exams }: { exams: Exam[] }) {
  const withLinks = exams.filter((e) => e.links.length > 0);
  if (withLinks.length === 0) return <p className="muted">등록된 자료가 없습니다.</p>;
  return (
    <div>
      {withLinks.map((e) => (
        <div key={e.id} className="row" style={{ padding: "6px 0" }}>
          <b>{e.title}</b>
          <span className="spacer" />
          {e.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
              <button type="button">{l.label}</button>
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}
