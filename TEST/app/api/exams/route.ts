import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { jsonError, requireSession, requireTeacher } from "@/lib/auth";
import { examFromBody } from "@/lib/exam-input";
import { getStore } from "@/lib/store";

export async function GET() {
  const s = await requireSession();
  if (s instanceof NextResponse) return s;
  return NextResponse.json({ exams: await getStore().listExams() });
}

export async function POST(req: Request) {
  const s = await requireTeacher();
  if (s instanceof NextResponse) return s;
  const exam = examFromBody(await req.json().catch(() => ({})), randomUUID(), new Date().toISOString());
  if (typeof exam === "string") return jsonError(exam);
  await getStore().saveExam(exam);
  return NextResponse.json({ exam });
}
