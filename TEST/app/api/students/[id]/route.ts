import { NextResponse } from "next/server";
import { hashPin, jsonError, requireTeacher } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { str } from "@/lib/validate";

/** 이름 변경 또는 PIN 재설정 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireTeacher();
  if (s instanceof NextResponse) return s;
  const { id } = await ctx.params;
  const store = getStore();
  const student = await store.getStudent(id);
  if (!student) return jsonError("학생을 찾을 수 없습니다.", 404);
  const body = await req.json().catch(() => ({}));
  const next = { ...student };
  if (body.name !== undefined) {
    const name = str(body.name, 40);
    if (!name) return jsonError("이름을 입력하세요.");
    const dup = await store.getStudentByName(name);
    if (dup && dup.id !== id) return jsonError("같은 이름의 학생이 이미 있습니다.");
    next.name = name;
  }
  if (body.pin !== undefined) {
    const pin = String(body.pin);
    if (!/^\d{4,8}$/.test(pin)) return jsonError("PIN은 숫자 4~8자리입니다.");
    next.pinHash = hashPin(pin);
  }
  await store.saveStudent(next);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireTeacher();
  if (s instanceof NextResponse) return s;
  const { id } = await ctx.params;
  await getStore().deleteStudent(id);
  return NextResponse.json({ ok: true });
}
