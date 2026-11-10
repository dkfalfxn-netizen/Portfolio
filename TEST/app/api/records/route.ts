import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { jsonError, requireSession, scopeStudentId } from "@/lib/auth";
import { computeScore } from "@/lib/scoring";
import { getStore } from "@/lib/store";
import { isDate, parseItems, str } from "@/lib/validate";

export async function GET(req: Request) {
  const s = await requireSession();
  if (s instanceof NextResponse) return s;
  const store = getStore();
  const scoped = await scopeStudentId(s, async (id) => !!(await store.getStudent(id)));
  if (scoped instanceof NextResponse) return scoped;
  const url = new URL(req.url);
  const records = await store.listRecords({
    // 학생은 쿼리와 상관없이 본인 기록만
    studentId: scoped ?? (url.searchParams.get("studentId") || undefined),
    examId: url.searchParams.get("examId") || undefined,
  });
  records.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json({ records });
}

export async function POST(req: Request) {
  const s = await requireSession();
  if (s instanceof NextResponse) return s;
  const store = getStore();
  const scoped = await scopeStudentId(s, async (id) => !!(await store.getStudent(id)));
  if (scoped instanceof NextResponse) return scoped;
  const body = await req.json().catch(() => ({}));

  const studentId = scoped ?? str(body.studentId, 100);
  if (!studentId || !(await store.getStudent(studentId))) return jsonError("학생을 선택하세요.");
  const exam = await store.getExam(str(body.examId, 100));
  if (!exam) return jsonError("시험지를 선택하세요.");
  if (!isDate(body.date)) return jsonError("날짜 형식이 올바르지 않습니다.");
  const items = parseItems(body.items);
  if (!items) return jsonError("오답 문항 형식이 올바르지 않습니다.");
  const valid = items.filter((it) => (it.kind === "mc" ? exam.mc : exam.sa).some((q) => q.no === it.no));

  const { score, total } = computeScore(exam, valid);
  const record = {
    id: randomUUID(),
    studentId,
    examId: exam.id,
    date: body.date as string,
    items: valid,
    score,
    total,
    memo: str(body.memo, 500),
    createdAt: new Date().toISOString(),
  };
  await store.saveRecord(record);
  return NextResponse.json({ record });
}
