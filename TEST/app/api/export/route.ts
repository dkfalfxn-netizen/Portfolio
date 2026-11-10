import { NextResponse } from "next/server";
import { requireSession, scopeStudentId } from "@/lib/auth";
import { buildMarkdown, flattenWrong } from "@/lib/export";
import { getStore } from "@/lib/store";
import { isDate } from "@/lib/validate";

/**
 * 오답만 추출. ?studentId&examId&from&to&excludeSolved=1&prompt=1&format=md|json
 * 학생은 studentId 와 상관없이 본인 것만.
 */
export async function GET(req: Request) {
  const s = await requireSession();
  if (s instanceof NextResponse) return s;
  const store = getStore();
  const scoped = await scopeStudentId(s, async (id) => !!(await store.getStudent(id)));
  if (scoped instanceof NextResponse) return scoped;

  const p = new URL(req.url).searchParams;
  const studentId = scoped ?? (p.get("studentId") || undefined);
  const examId = p.get("examId") || undefined;
  const from = isDate(p.get("from")) ? p.get("from")! : "";
  const to = isDate(p.get("to")) ? p.get("to")! : "";
  const excludeSolved = p.get("excludeSolved") === "1";
  const includePrompt = p.get("prompt") !== "0";

  const [records, exams, students] = await Promise.all([
    store.listRecords({ studentId, examId }),
    store.listExams(),
    store.listStudents(),
  ]);
  const inRange = records.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  const visibleStudents = students
    .filter((st) => !scoped || st.id === scoped)
    .map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  const rows = flattenWrong(inRange, exams, visibleStudents, { excludeSolved });

  if (p.get("format") === "json") return NextResponse.json({ rows });

  const studentName = studentId ? (visibleStudents.find((st) => st.id === studentId)?.name ?? "") : "전체 학생";
  const exam = exams.find((e) => e.id === examId);
  const condition = [
    exam ? exam.title : "모든 시험지",
    from || to ? `${from || "처음"} ~ ${to || "오늘"}` : "전체 기간",
    excludeSolved ? "재풀이 해결 문항 제외" : "해결 문항 포함",
  ].join(" · ");
  const usedExamIds = new Set(inRange.map((r) => r.examId));
  const links = exams
    .filter((e) => usedExamIds.has(e.id))
    .flatMap((e) => e.links.map((l) => ({ exam: e.title, ...l })));

  return NextResponse.json({
    rows,
    markdown: buildMarkdown(rows, { title: studentName, condition, links }, { excludeSolved, includePrompt }),
  });
}
