import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getStore } from "@/lib/store";

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ session: null });
  // 삭제된 학생의 쿠키는 무효 처리
  if (s.role === "student" && !(await getStore().getStudent(s.studentId))) {
    return NextResponse.json({ session: null });
  }
  return NextResponse.json({
    session: s.role === "teacher" ? { role: "teacher" } : { role: "student", name: s.name },
  });
}
