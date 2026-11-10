"use client";

import { useMemo, useState } from "react";
import { api, todayStr } from "@/lib/api";
import { clampEarned, computeScore, findQuestion, kindLabel, round1, sortItems } from "@/lib/scoring";
import { REASONS, type Exam, type QuestionKind, type Student, type WrongItem } from "@/lib/types";

interface Props {
  exams: Exam[];
  /** 선생님이면 학생 목록, 학생이면 undefined(본인으로 저장) */
  students?: Student[];
  onSaved: () => void;
}

export function RecordForm({ exams, students, onSaved }: Props) {
  const [date, setDate] = useState(todayStr());
  const [studentId, setStudentId] = useState("");
  const [examId, setExamId] = useState(exams[0]?.id ?? "");
  const [items, setItems] = useState<WrongItem[]>([]);
  const [memo, setMemo] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const exam = exams.find((e) => e.id === examId) ?? exams[0];
  const { score, total } = useMemo(
    () => (exam ? computeScore(exam, items) : { score: 0, total: 0 }),
    [exam, items],
  );

  if (!exam) return <p className="muted">등록된 시험지가 없습니다.</p>;

  const isWrong = (kind: QuestionKind, no: number) => items.find((i) => i.kind === kind && i.no === no);

  function toggle(kind: QuestionKind, no: number) {
    setMsg(null);
    setItems((prev) =>
      prev.some((i) => i.kind === kind && i.no === no)
        ? prev.filter((i) => !(i.kind === kind && i.no === no))
        : [...prev, { kind, no }],
    );
  }

  function patch(kind: QuestionKind, no: number, p: Partial<WrongItem>) {
    setItems((prev) => prev.map((i) => (i.kind === kind && i.no === no ? { ...i, ...p } : i)));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/records", {
        method: "POST",
        body: { studentId: students ? studentId : undefined, examId: exam!.id, date, items, memo },
      });
      setItems([]);
      setMemo("");
      setMsg({ ok: true, text: "저장했습니다." });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const chips = (kind: QuestionKind) =>
    (kind === "mc" ? exam.mc : exam.sa).map((q) => {
      const w = isWrong(kind, q.no);
      const partial = w && kind === "sa" && clampEarned(w.earned, q.points) > 0;
      return (
        <button
          key={q.no}
          type="button"
          className={`chip ${w ? (partial ? "partial" : "on") : ""}`}
          onClick={() => toggle(kind, q.no)}
          title={q.unit}
        >
          <b>{q.no}</b>
          <small>{q.points}점</small>
        </button>
      );
    });

  const lost = round1(total - score);

  return (
    <div>
      <div className="grid3">
        <div>
          <label className="f">날짜</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="f">학생</label>
          {students ? (
            <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">학생 선택</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            <input value="나" disabled />
          )}
        </div>
        <div>
          <label className="f">시험지</label>
          <select
            value={exam.id}
            onChange={(e) => {
              setExamId(e.target.value);
              setItems([]);
            }}
          >
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {exam.mc.length > 0 && (
        <>
          <div className="sec-label">선택형</div>
          <div className="chips">{chips("mc")}</div>
        </>
      )}
      {exam.sa.length > 0 && (
        <>
          <div className="sec-label">서답형</div>
          <div className="chips">{chips("sa")}</div>
        </>
      )}

      {items.length > 0 && (
        <table className="wronglist" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>틀린 문항</th>
              <th>오답 원인</th>
              <th>받은 점수</th>
              <th>메모 (어디서 막혔나)</th>
            </tr>
          </thead>
          <tbody>
            {sortItems(items).map((it) => {
              const q = findQuestion(exam, it.kind, it.no)!;
              return (
                <tr key={it.kind + it.no}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {kindLabel(it.kind)} {it.no}번 <span className="muted">({q.points}점)</span>
                    {q.unit && <div className="muted">{q.unit}</div>}
                  </td>
                  <td>
                    <select
                      value={it.reason ?? ""}
                      onChange={(e) =>
                        patch(it.kind, it.no, { reason: (e.target.value || undefined) as WrongItem["reason"] })
                      }
                    >
                      <option value="">선택 안 함</option>
                      {REASONS.map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ width: 90 }}>
                    {it.kind === "sa" ? (
                      <input
                        type="number"
                        min={0}
                        max={q.points}
                        step={0.1}
                        placeholder="0"
                        value={it.earned ?? ""}
                        onChange={(e) =>
                          patch(it.kind, it.no, {
                            earned: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                      />
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td>
                    <input value={it.note ?? ""} onChange={(e) => patch(it.kind, it.no, { note: e.target.value })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <hr />
      <div className="row">
        <span className="score">
          {score} <small>/ {total}점</small>
        </span>
        <span className="muted">{items.length ? `틀린 문항 ${items.length}개 · -${lost}점` : "틀린 문항 없음"}</span>
      </div>
      <div style={{ marginTop: 8 }}>
        <input placeholder="메모 (선택)" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={save} disabled={busy || (!!students && !studentId)}>
          저장
        </button>
        <span className="muted">서답형에서 부분점수를 받았으면 칩을 누른 뒤 받은 점수를 적으세요.</span>
        {msg && <span className={msg.ok ? "okmsg" : "err"}>{msg.text}</span>}
      </div>
    </div>
  );
}
