"use client";

import { useState } from "react";
import { api, download, todayStr } from "@/lib/api";
import type { WrongRow } from "@/lib/export";
import type { Exam, Student } from "@/lib/types";

interface Props {
  exams: Exam[];
  /** 선생님이면 학생 목록, 학생이면 undefined(본인 것만) */
  students?: Student[];
  fileLabel?: string;
}

/** 오답만 추출 → Claude에 붙여넣을 마크다운 / CSV */
export function ExportPanel({ exams, students, fileLabel }: Props) {
  const [studentId, setStudentId] = useState("");
  const [examId, setExamId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [excludeSolved, setExcludeSolved] = useState(true);
  const [includePrompt, setIncludePrompt] = useState(true);
  const [result, setResult] = useState<{ markdown: string; rows: WrongRow[] } | null>(null);
  const [msg, setMsg] = useState("");

  async function run() {
    setMsg("");
    const q = new URLSearchParams({
      ...(studentId ? { studentId } : {}),
      ...(examId ? { examId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      excludeSolved: excludeSolved ? "1" : "0",
      prompt: includePrompt ? "1" : "0",
    });
    try {
      setResult(await api(`/api/export?${q}`));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const baseName = () => {
    const who = students ? (students.find((s) => s.id === studentId)?.name ?? "전체") : (fileLabel ?? "내");
    return `오답_${who}_${todayStr()}`;
  };

  function csv(rows: WrongRow[]) {
    const head = ["학생", "시험지", "날짜", "점수", "만점", "구분", "번호", "배점", "받은점수", "단원", "오답원인", "메모", "해결"];
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.student, r.exam, r.date, r.score, r.total, r.kind, r.no, r.points, r.earned, r.unit, r.reason, r.note, r.solved ? "O" : ""]
        .map(esc)
        .join(","),
    );
    return "﻿" + [head.join(","), ...lines].join("\r\n"); // BOM: 엑셀 한글 깨짐 방지
  }

  return (
    <div>
      <div className="grid2">
        {students && (
          <div>
            <label className="f">학생</label>
            <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">전체 학생</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="f">시험지</label>
          <select value={examId} onChange={(e) => setExamId(e.target.value)}>
            <option value="">모든 시험지</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="f">시작일</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="f">종료일</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={excludeSolved} onChange={(e) => setExcludeSolved(e.target.checked)} />
          다시 풀어 해결한 문항 제외
        </label>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={includePrompt} onChange={(e) => setIncludePrompt(e.target.checked)} />
          Claude 요청문 포함 (오답 분석 + 유사 문제)
        </label>
        <span className="spacer" />
        <button className="primary" onClick={run}>
          오답 추출
        </button>
      </div>
      {msg && <p className="err">{msg}</p>}
      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="muted">오답 {result.rows.length}문항</span>
            <span className="spacer" />
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(result.markdown);
                setMsg("");
                alert("복사했습니다. Claude 대화창에 붙여넣고 시험지 PDF를 함께 첨부하세요.");
              }}
            >
              복사
            </button>
            <button onClick={() => download(baseName() + ".md", result.markdown)}>.md 저장</button>
            <button onClick={() => download(baseName() + ".csv", csv(result.rows), "text/csv")}>.csv 저장</button>
          </div>
          <pre className="md">{result.markdown}</pre>
        </div>
      )}
    </div>
  );
}
