import { NextResponse } from "next/server";
import { jsonError, requireSession, scopeStudentId } from "@/lib/auth";
import { computeScore } from "@/lib/scoring";
import { getStore } from "@/lib/store";
import { isDate, parseItems, str } from "@/lib/validate";

async function load(id: string) {
  const s = await requireSession();
  if (s instanceof NextResponse) return s;
  const store = getStore();
  const scoped = await scopeStudentId(s, async (sid) => !!(await store.getStudent(sid)));
  if (scoped instanceof NextResponse) return scoped;
  const record = await store.getRecord(id);
  // 다른 학생 기록은 존재 여부도 드러내지 않음
  if (!record || (scoped && record.studentId !== scoped)) return jsonError("기록을 찾을 수 없습니다.", 404);
  return { store, record };
}

/** 오답 항목(원인·메모·재풀이 해결 여부·부분점수), 날짜, 메모 수정 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await load((await ctx.params).id);
  if (got instanceof NextResponse) return got;
  const { store, record } = got;
  const body = await req.json().catch(() => ({}));
  const next = { ...record };
  if (body.items !== undefined) {
    const items = parseItems(body.items);
    if (!items) return jsonError("오답 문항 형식이 올바르지 않습니다.");
    const exam = await store.getExam(record.examId);
    if (!exam) return jsonError("시험지를 찾을 수 없습니다.", 404);
    next.items = items.filter((it) => (it.kind === "mc" ? exam.mc : exam.sa).some((q) => q.no === it.no));
    Object.assign(next, computeScore(exam, next.items));
  }
  if (body.date !== undefined) {
    if (!isDate(body.date)) return jsonError("날짜 형식이 올바르지 않습니다.");
    next.date = body.date;
  }
  if (body.memo !== undefined) next.memo = str(body.memo, 500);
  await store.saveRecord(next);
  return NextResponse.json({ record: next });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await load((await ctx.params).id);
  if (got instanceof NextResponse) return got;
  await got.store.deleteRecord(got.record.id);
  return NextResponse.json({ ok: true });
}
