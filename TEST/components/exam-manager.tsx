"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { examTotal, round1 } from "@/lib/scoring";
import type { Exam, Question } from "@/lib/types";

interface Draft {
  id?: string;
  title: string;
  description: string;
  mcPoints: string;
  mcUnits: string;
  saPoints: string;
  saUnits: string;
  links: string;
}

const EMPTY: Draft = { title: "", description: "", mcPoints: "", mcUnits: "", saPoints: "", saUnits: "", links: "" };

const toDraft = (e: Exam): Draft => ({
  id: e.id,
  title: e.title,
  description: e.description,
  mcPoints: e.mc.map((q) => q.points).join(", "),
  mcUnits: e.mc.map((q) => q.unit ?? "").join(", "),
  saPoints: e.sa.map((q) => q.points).join(", "),
  saUnits: e.sa.map((q) => q.unit ?? "").join(", "),
  links: e.links.map((l) => `${l.label} | ${l.url}`).join("\n"),
});

const splitList = (s: string) => (s.trim() ? s.split(/[,\n]/).map((x) => x.trim()) : []);

function toQuestions(points: string, units: string): Question[] | string {
  const ps = splitList(points);
  const us = splitList(units);
  const out: Question[] = [];
  for (const [i, p] of ps.entries()) {
    const n = Number(p);
    if (!p || !Number.isFinite(n) || n <= 0) return `배점 "${p}" 이(가) 숫자가 아닙니다.`;
    out.push({ no: i + 1, points: n, ...(us[i] ? { unit: us[i] } : {}) });
  }
  if (us.filter(Boolean).length > ps.length) return "단원 개수가 문항 수보다 많습니다.";
  return out;
}

export function ExamManager({ exams, onChanged }: { exams: Exam[]; onChanged: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState("");

  const mc = draft ? toQuestions(draft.mcPoints, draft.mcUnits) : [];
  const sa = draft ? toQuestions(draft.saPoints, draft.saUnits) : [];
  const total =
    typeof mc !== "string" && typeof sa !== "string" ? round1([...mc, ...sa].reduce((s, q) => s + q.points, 0)) : null;

  async function save() {
    if (!draft) return;
    setErr("");
    if (typeof mc === "string") return setErr("선택형: " + mc);
    if (typeof sa === "string") return setErr("서답형: " + sa);
    const links = draft.links
      .split("\n")
      .map((l) => l.split("|").map((x) => x.trim()))
      .filter((p) => p.length >= 2 && p[1])
      .map(([label, url]) => ({ label: label || "자료", url }));
    const body = { title: draft.title, description: draft.description, mc, sa, links };
    try {
      if (draft.id) {
        if (!confirm("배점이 바뀌면 이 시험지의 기존 기록 점수도 다시 계산됩니다. 저장할까요?")) return;
        await api(`/api/exams/${draft.id}`, { method: "PUT", body });
      } else await api("/api/exams", { method: "POST", body });
      setDraft(null);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function remove(e: Exam) {
    if (!confirm(`"${e.title}" 시험지와 이 시험지의 모든 학생 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await api(`/api/exams/${e.id}`, { method: "DELETE" });
      onChanged();
    } catch (er) {
      setErr((er as Error).message);
    }
  }

  const set = (k: keyof Draft) => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => (d ? { ...d, [k]: ev.target.value } : d));

  return (
    <div>
      <table>
        <tbody>
          {exams.map((e) => (
            <tr key={e.id}>
              <td>
                <b>{e.title}</b>
                <div className="muted">
                  선택형 {e.mc.length} · 서답형 {e.sa.length} · {examTotal(e)}점
                  {e.description ? ` · ${e.description}` : ""}
                </div>
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <button className="link" onClick={() => setDraft(toDraft(e))}>
                  수정
                </button>
                <button className="link" onClick={() => remove(e)}>
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!draft && (
        <button style={{ marginTop: 10 }} onClick={() => setDraft(EMPTY)}>
          + 새 시험지
        </button>
      )}
      {draft && (
        <div style={{ marginTop: 12 }}>
          <div className="grid2">
            <div>
              <label className="f">이름 (예: 2025 풍문고1 2-2 [CM 19-24])</label>
              <input value={draft.title} onChange={set("title")} />
            </div>
            <div>
              <label className="f">설명 (학교·학기·과목·범위)</label>
              <input value={draft.description} onChange={set("description")} />
            </div>
            <div>
              <label className="f">선택형 배점 (쉼표로 구분, 1번부터)</label>
              <textarea rows={2} value={draft.mcPoints} onChange={set("mcPoints")} placeholder="2.7, 2.8, 2.9, 3 ..." />
            </div>
            <div>
              <label className="f">선택형 단원 (선택, 같은 순서)</label>
              <textarea rows={2} value={draft.mcUnits} onChange={set("mcUnits")} placeholder="원의 방정식, 평행이동, ..." />
            </div>
            <div>
              <label className="f">서답형 배점</label>
              <textarea rows={2} value={draft.saPoints} onChange={set("saPoints")} placeholder="3, 4, 4, 5, 10, 11, 13" />
            </div>
            <div>
              <label className="f">서답형 단원 (선택)</label>
              <textarea rows={2} value={draft.saUnits} onChange={set("saUnits")} />
            </div>
          </div>
          <label className="f" style={{ marginTop: 10 }}>
            자료 링크 (한 줄에 하나: 이름 | URL) — 구글 드라이브 PDF 공유 링크 등
          </label>
          <textarea rows={3} value={draft.links} onChange={set("links")} placeholder="정답·배점·채점기준 | https://..." />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={save}>
              {draft.id ? "수정 저장" : "추가"}
            </button>
            <button onClick={() => setDraft(null)}>취소</button>
            {total !== null && <span className="muted">합계 {total}점</span>}
            {err && <span className="err">{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
