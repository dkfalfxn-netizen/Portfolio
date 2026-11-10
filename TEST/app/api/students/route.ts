import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { hashPin, jsonError, requireTeacher } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { str } from "@/lib/validate";

const isPin = (p: string) => /^\d{4,8}$/.test(p);

export async function GET() {
  const s = await requireTeacher();
  if (s instanceof NextResponse) return s;
  const students = (await getStore().listStudents()).map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  students.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return NextResponse.json({ students });
}

export async function POST(req: Request) {
  const s = await requireTeacher();
  if (s instanceof NextResponse) return s;
  const body = await req.json().catch(() => ({}));
  const name = str(body.name, 40);
  const pin = String(body.pin ?? "");
  if (!name) return jsonError("이름을 입력하세요.");
  if (!isPin(pin)) return jsonError("PIN은 숫자 4~8자리입니다.");
  const store = getStore();
  if (await store.getStudentByName(name)) return jsonError("같은 이름의 학생이 이미 있습니다. (예: 김민준2)");
  const student = { id: randomUUID(), name, pinHash: hashPin(pin), createdAt: new Date().toISOString() };
  await store.saveStudent(student);
  return NextResponse.json({ student: { id: student.id, name, createdAt: student.createdAt } });
}
