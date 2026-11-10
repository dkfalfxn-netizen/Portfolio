import { NextResponse } from "next/server";
import { jsonError, requireTeacher } from "@/lib/auth";
import { examFromBody } from "@/lib/exam-input";
import { computeScore } from "@/lib/scoring";
import { getStore } from "@/lib/store";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireTeacher();
  if (s instanceof NextResponse) return s;
  const { id } = await ctx.params;
  const store = getStore();
  const prev = await store.getExam(id);
  if (!prev) return jsonError("시험지를 찾을 수 없습니다.", 404);
  const exam = examFromBody(await req.json().catch(() => ({})), id, prev.createdAt);
  if (typeof exam === "string") return jsonError(exam);
  await store.saveExam(exam);
  // 배점이 바뀌었을 수 있으니 이 시험지의 기록 점수를 다시 계산
  for (const r of await store.listRecords({ examId: id })) {
    const { score, total } = computeScore(exam, r.items);
    if (score !== r.score || total !== r.total) await store.saveRecord({ ...r, score, total });
  }
  return NextResponse.json({ exam });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireTeacher();
  if (s instanceof NextResponse) return s;
  const { id } = await ctx.params;
  await getStore().deleteExam(id);
  return NextResponse.json({ ok: true });
}
