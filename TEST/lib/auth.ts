import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { Session } from "./types";

const COOKIE = "wn_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30일

const isProd = () => process.env.NODE_ENV === "production";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (isProd()) throw new Error("SESSION_SECRET(16자 이상)이 설정되지 않았습니다.");
  return "dev-only-session-secret-change-me";
}

export function teacherPassword(): string {
  const p = process.env.TEACHER_PASSWORD;
  if (p) return p;
  if (isProd()) throw new Error("TEACHER_PASSWORD 가 설정되지 않았습니다.");
  return "teacher"; // 로컬 개발 기본값
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

type SessionInput =
  | { role: "teacher" }
  | { role: "student"; studentId: string; name: string };

export function setSessionCookie(res: NextResponse, s: SessionInput) {
  const payload = Buffer.from(
    JSON.stringify({ ...s, exp: Date.now() + MAX_AGE_SEC * 1000 }),
  ).toString("base64url");
  res.cookies.set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
}

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

// ── PIN 해시 (scrypt) ──
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return safeEqual(scryptSync(pin, salt, 32).toString("hex"), hash);
}

// ── 로그인 시도 제한 (메모리 기반: 같은 키로 10분에 8회) ──
const attempts = new Map<string, { n: number; until: number }>();
export function tooManyAttempts(key: string): boolean {
  const a = attempts.get(key);
  return !!a && a.until > Date.now() && a.n >= 8;
}
export function noteFailure(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { n: 1, until: now + 10 * 60 * 1000 });
  else a.n += 1;
}
export function clearFailures(key: string) {
  attempts.delete(key);
}

// ── 라우트 헬퍼 ──
export const jsonError = (msg: string, status = 400) => NextResponse.json({ error: msg }, { status });

export async function requireSession(): Promise<Session | NextResponse> {
  return (await getSession()) ?? jsonError("로그인이 필요합니다.", 401);
}

export async function requireTeacher(): Promise<Session | NextResponse> {
  const s = await getSession();
  if (!s) return jsonError("로그인이 필요합니다.", 401);
  if (s.role !== "teacher") return jsonError("선생님만 사용할 수 있습니다.", 403);
  return s;
}

/**
 * 학생 세션이면 해당 학생 id 로 강제, 선생님이면 null(제한 없음).
 * 삭제된 학생의 쿠키는 401.
 */
export async function scopeStudentId(
  s: Session,
  studentExists: (id: string) => Promise<boolean>,
): Promise<string | null | NextResponse> {
  if (s.role === "teacher") return null;
  if (!(await studentExists(s.studentId))) return jsonError("다시 로그인하세요.", 401);
  return s.studentId;
}
