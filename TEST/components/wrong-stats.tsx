"use client";

import { useState } from "react";
import { kindLabel, round1 } from "@/lib/scoring";
import { REASONS, type Exam, type ExamRecord, type QuestionKind } from "@/lib/types";

/** 시험지별 문항 오답 수 + 오답 원인 분포 (넘겨받은 기록 기준) */
export function WrongStats({ records, exams }: { records: ExamRecord[]; exams: Exam[] }) {
  const [examId, setExamId] = useState(exams[0]?.id ?? "");
  const exam = exams.find((e) => e.id === examId) ?? exams[0];
  if (!exam) return null;

  const recs = records.filter((r) => r.examId === exam.id);
  const count = (kind: QuestionKind, no: number) =>
    recs.filter((r) => r.items.some((i) => i.kind === kind && i.no === no)).length;
  const rows = [
    ...exam.mc.map((q) => ({ kind: "mc" as const, q })),
    ...exam.sa.map((q) => ({ kind: "sa" as const, q })),
  ].map(({ kind, q }) => ({ kind, q, n: count(kind, q.no) }));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const avg = recs.length ? round1(recs.reduce((s, r) => s + r.score, 0) / recs.length) : 0;

  const reasonCounts = REASONS.map((r) => ({
    ...r,
    n: recs.reduce((s, rec) => s + rec.items.filter((i) => i.reason === r.code).length, 0),
  })).filter((r) => r.n > 0);

  return (
    <div>
      <div style={{ maxWidth: 260, marginBottom: 10 }}>
        <label className="f">시험지</label>
        <select value={exam.id} onChange={(e) => setExamId(e.target.value)}>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      </div>
      {recs.length === 0 ? (
        <p>이 시험지의 기록이 아직 없습니다.</p>
      ) : (
        <>
          <p className="muted">
            응시 {recs.length}회 · 평균 {avg} / {recs[0].total}점
            {reasonCounts.length > 0 && " · 오답 원인: " + reasonCounts.map((r) => `${r.label} ${r.n}`).join(", ")}
          </p>
          <table className="bars">
            <tbody>
              {rows.map(({ kind, q, n }) => (
                <tr key={kind + q.no}>
                  <td style={{ width: 110, whiteSpace: "nowrap" }}>
                    {kindLabel(kind)} {q.no}번
                  </td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <div className="bar" style={{ width: `${(n / max) * 70}%`, minWidth: n ? 4 : 0 }} />
                      <span className="muted">
                        {n}회{q.unit ? ` · ${q.unit}` : ""}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
