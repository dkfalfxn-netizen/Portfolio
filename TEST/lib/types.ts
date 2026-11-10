// 공용 타입 — 서버/클라이언트 모두에서 사용

export type QuestionKind = "mc" | "sa"; // mc = 선택형, sa = 서답형

export interface Question {
  no: number;
  points: number;
  unit?: string; // 단원·개념 태그 (예: "원의 방정식")
}

export interface ExamLink {
  label: string;
  url: string;
}

export interface Exam {
  id: string;
  title: string; // 짧은 이름 (예: 2025 풍문고1 2-2 [CM 19-24])
  description: string; // 부가 설명 (예: 2025 풍문고1 2학기 기말 공통수학2)
  mc: Question[];
  sa: Question[];
  links: ExamLink[];
  createdAt: string;
}

export const REASONS = [
  { code: "concept", label: "개념 부족" },
  { code: "calc", label: "계산 실수" },
  { code: "reading", label: "조건·문제 해석" },
  { code: "time", label: "시간 부족" },
  { code: "guess", label: "모름·찍음" },
  { code: "etc", label: "기타" },
] as const;

export type ReasonCode = (typeof REASONS)[number]["code"];

export function reasonLabel(code?: string): string {
  return REASONS.find((r) => r.code === code)?.label ?? "";
}

export interface WrongItem {
  kind: QuestionKind;
  no: number;
  earned?: number; // 서답형 부분점수 (없으면 0점)
  reason?: ReasonCode;
  note?: string;
  solved?: boolean; // 다시 풀어서 해결했는지
}

export interface ExamRecord {
  id: string;
  studentId: string;
  examId: string;
  date: string; // YYYY-MM-DD
  items: WrongItem[];
  score: number;
  total: number;
  memo: string;
  createdAt: string;
}

export interface Student {
  id: string;
  name: string;
  createdAt: string;
}

export interface StudentWithPin extends Student {
  pinHash: string;
}

export type Session =
  | { role: "teacher"; exp: number }
  | { role: "student"; studentId: string; name: string; exp: number };
