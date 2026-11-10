import { findQuestion, kindLabel, round1, sortItems } from "./scoring";
import { reasonLabel, type Exam, type ExamRecord, type Student } from "./types";

export interface ExportOptions {
  excludeSolved: boolean;
  includePrompt: boolean;
}

export interface WrongRow {
  student: string;
  exam: string;
  examDescription: string;
  date: string;
  score: number;
  total: number;
  kind: "선택형" | "서답형";
  no: number;
  points: number;
  earned: number;
  unit: string;
  reason: string;
  note: string;
  solved: boolean;
}

/** 기록들을 "오답 1문항 = 1행" 으로 평탄화 */
export function flattenWrong(
  records: ExamRecord[],
  exams: Exam[],
  students: Student[],
  opts: Pick<ExportOptions, "excludeSolved">,
): WrongRow[] {
  const examById = new Map(exams.map((e) => [e.id, e]));
  const nameById = new Map(students.map((s) => [s.id, s.name]));
  const rows: WrongRow[] = [];
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of sorted) {
    const exam = examById.get(r.examId);
    if (!exam) continue;
    for (const it of sortItems(r.items)) {
      if (opts.excludeSolved && it.solved) continue;
      const q = findQuestion(exam, it.kind, it.no);
      rows.push({
        student: nameById.get(r.studentId) ?? "(알 수 없음)",
        exam: exam.title,
        examDescription: exam.description,
        date: r.date,
        score: r.score,
        total: r.total,
        kind: kindLabel(it.kind) as WrongRow["kind"],
        no: it.no,
        points: q?.points ?? 0,
        earned: it.kind === "sa" ? (it.earned ?? 0) : 0,
        unit: q?.unit ?? "",
        reason: reasonLabel(it.reason),
        note: it.note ?? "",
        solved: !!it.solved,
      });
    }
  }
  return rows;
}

const cell = (s: string | number) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

function countBy(rows: WrongRow[], key: (r: WrongRow) => string): string {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) || "(미입력)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

/** Claude에게 붙여넣을 마크다운 */
export function buildMarkdown(
  rows: WrongRow[],
  meta: { title: string; condition: string; links: { exam: string; label: string; url: string }[] },
  opts: ExportOptions,
): string {
  const out: string[] = [];
  out.push(`# 오답 추출 — ${meta.title}`);
  out.push(`- 추출 조건: ${meta.condition}`);
  out.push(`- 오답 문항 수: ${rows.length}`);
  out.push("");

  if (rows.length === 0) {
    out.push("조건에 맞는 오답이 없습니다.");
    return out.join("\n");
  }

  // 학생 → 시험(날짜) 순서로 묶기
  const groups = new Map<string, WrongRow[]>();
  for (const r of rows) {
    const k = `${r.student}\u0000${r.exam}\u0000${r.date}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const multiStudent = new Set(rows.map((r) => r.student)).size > 1;

  for (const g of groups.values()) {
    const h = g[0];
    out.push(
      `## ${multiStudent ? `[${h.student}] ` : ""}${h.exam} — ${h.date} (점수 ${h.score} / ${h.total})`,
    );
    if (h.examDescription && h.examDescription !== h.exam) out.push(`_${h.examDescription}_`);
    out.push("");
    out.push("| 구분 | 번호 | 배점 | 받은 점수 | 단원 | 오답 원인 | 메모 | 재풀이 |");
    out.push("|---|---|---|---|---|---|---|---|");
    for (const r of g) {
      out.push(
        `| ${r.kind} | ${r.no} | ${r.points} | ${r.kind === "서답형" ? r.earned : 0} | ${cell(r.unit)} | ${cell(r.reason)} | ${cell(r.note)} | ${r.solved ? "해결" : "미해결"} |`,
      );
    }
    out.push("");
  }

  out.push("## 요약");
  out.push(`- 잃은 점수 합계: ${round1(rows.reduce((s, r) => s + (r.points - r.earned), 0))}점`);
  out.push(`- 오답 원인별: ${countBy(rows, (r) => r.reason)}`);
  if (rows.some((r) => r.unit)) out.push(`- 단원별: ${countBy(rows, (r) => r.unit)}`);
  out.push("");

  if (meta.links.length) {
    out.push("## 시험지 자료");
    for (const l of meta.links) out.push(`- ${l.exam} · ${l.label}: ${l.url}`);
    out.push("");
  }

  if (opts.includePrompt) {
    out.push("---");
    out.push("## Claude 요청");
    out.push(
      [
        "위 오답 데이터와 첨부한 시험지(문제·정답·채점기준)를 바탕으로 다음을 해 주세요.",
        "1. **오답 분석**: 문항별로 어떤 개념·풀이 단계에서 막혔을지 추정하고, 오답 원인·단원 분포에서 보이는 공통 패턴과 우선 보완할 점 3가지를 정리.",
        "2. **유사 문제**: 틀린 문항마다 같은 개념을 묻는 유사 문제 2개(원 문항과 같은 난이도 1개, 한 단계 높은 난이도 1개). 선택형은 5지선다로.",
        "3. 정답과 풀이는 문제와 분리해 맨 뒤에 모아 주세요.",
        "4. 서답형에서 부분점수를 받은 문항은 감점된 단계를 중심으로 다뤄 주세요.",
      ].join("\n"),
    );
  }
  return out.join("\n");
}
