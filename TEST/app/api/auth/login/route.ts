import { NextResponse } from "next/server";
import {
  clearFailures,
  jsonError,
  noteFailure,
  safeEqual,
  setSessionCookie,
  teacherPassword,
  tooManyAttempts,
  verifyPin,
} from "@/lib/auth";
import { getStore } from "@/lib/store";
import { str } from "@/lib/validate";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  if (body.role === "teacher") {
    const key = "teacher";
    if (tooManyAttempts(key)) return jsonError("시도가 너무 많습니다. 10분 뒤 다시 시도하세요.", 429);
    if (!safeEqual(String(body.password ?? ""), teacherPassword())) {
      noteFailure(key);
      return jsonError("비밀번호가 맞지 않습니다.", 401);
    }
    clearFailures(key);
    const res = NextResponse.json({ ok: true, role: "teacher" });
    setSessionCookie(res, { role: "teacher" });
    return res;
  }

  if (body.role === "student") {
    const name = str(body.name, 40);
    const pin = String(body.pin ?? "");
    const key = "student:" + name;
    if (!name || !pin) return jsonError("이름과 PIN을 입력하세요.");
    if (tooManyAttempts(key)) return jsonError("시도가 너무 많습니다. 10분 뒤 다시 시도하세요.", 429);
    const student = await getStore().getStudentByName(name);
    if (!student || !verifyPin(pin, student.pinHash)) {
      noteFailure(key);
      return jsonError("이름 또는 PIN이 맞지 않습니다.", 401);
    }
    clearFailures(key);
    const res = NextResponse.json({ ok: true, role: "student" });
    setSessionCookie(res, { role: "student", studentId: student.id, name: student.name });
    return res;
  }

  return jsonError("잘못된 요청입니다.");
}
