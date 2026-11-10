"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { findQuestion, kindLabel, sortItems } from "@/lib/scoring";
import { reasonLabel, type Exam, type ExamRecord, type Student, type WrongItem } from "@/lib/types";

interface Props {
  records: ExamRecord[];
  exams: Exam[];
  /** 선생님 화면이면 학생 목록(이름 표시·필터), 학생 화면이면 undefined */
  students?: Student[];
  onChanged: () => void;
}

export function RecordList({ records, exams, students, onChanged }: Props) {
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const examById = new Map(exams.map((e) => [e.id, e]));
  const nameById = new Map((students ?? []).map((s) => [s.id, s.name]));
  const shown = filter ? records.filter((r) => r.studentId === filter) : records;

  async function toggleSolved(r: ExamRecord, it: WrongItem) {
    setError("");
    const items = r.items.map((x) => (x.kind === it.kind && x.no === it.no ? { ...x, solved: !x.solved } : x));
    try {
      await api(`/api/records/${r.id}`, { method: "PATCH", body: { items } });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(r: ExamRecord) {
    if (!confirm(`${r.date} 기록을 삭제할까요?`)) return;
    try {
      await api(`/api/records/${r.id}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      {students && (
        <div style={{ maxWidth: 260, marginBottom: 10 }}>
          <label className="f">학생</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">전체</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <p className="err">{error}</p>}
      {shown.length === 0 ? (
        <p>아직 기록이 없습니다. 위에서 틀린 문항을 골라 저장하면 여기에 쌓입니다.</p>
      ) : (
        <>
          <p className="muted">빨간 태그를 누르면 &lsquo;다시 풀어서 해결&rsquo;로 표시됩니다. (오답 추출에서 제외 가능)</p>
          <table>
            <thead>
              <tr>
                <th>날짜</th>
                {students && <th>학생</th>}
                <th>시험지</th>
                <th>점수</th>
                <th>오답</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const exam = examById.get(r.examId);
                return (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{r.date}</td>
                    {students && <td>{nameById.get(r.studentId) ?? "-"}</td>}
                    <td>{exam?.title ?? "(삭제된 시험지)"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <b>{r.score}</b> / {r.total}
                    </td>
                    <td>
                      {r.items.length === 0 && <span className="muted">없음</span>}
                      {sortItems(r.items).map((it) => {
                        const q = exam && findQuestion(exam, it.kind, it.no);
                        const tip = [
                          q?.unit,
                          reasonLabel(it.reason),
                          it.kind === "sa" && it.earned ? `부분 ${it.earned}점` : "",
                          it.note,
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <span
                            key={it.kind + it.no}
                            className={`tag ${it.solved ? "solved" : ""}`}
                            title={tip}
                            onClick={() => toggleSolved(r, it)}
                          >
                            {kindLabel(it.kind)} {it.no}
                          </span>
                        );
                      })}
                      {r.memo && <div className="muted">{r.memo}</div>}
                    </td>
                    <td>
                      <button className="link" onClick={() => remove(r)}>
                        삭제
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
