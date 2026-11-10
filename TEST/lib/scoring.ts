import type { Exam, Question, QuestionKind, WrongItem } from "./types";

export const round1 = (n: number) => Math.round(n * 10) / 10;

export function findQuestion(exam: Exam, kind: QuestionKind, no: number): Question | undefined {
  return (kind === "mc" ? exam.mc : exam.sa).find((q) => q.no === no);
}

export function examTotal(exam: Exam): number {
  return round1([...exam.mc, ...exam.sa].reduce((s, q) => s + q.points, 0));
}

/** 틀린 문항(부분점수 반영)으로 점수 계산. 존재하지 않는 문항은 무시한다. */
export function computeScore(exam: Exam, items: WrongItem[]): { score: number; total: number } {
  const total = examTotal(exam);
  let lost = 0;
  for (const it of items) {
    const q = findQuestion(exam, it.kind, it.no);
    if (!q) continue;
    const earned = it.kind === "sa" ? clampEarned(it.earned, q.points) : 0;
    lost += q.points - earned;
  }
  return { score: round1(total - lost), total };
}

export function clampEarned(earned: number | undefined, max: number): number {
  if (earned === undefined || !Number.isFinite(earned)) return 0;
  return Math.min(Math.max(earned, 0), max);
}

export const kindLabel = (k: QuestionKind) => (k === "mc" ? "선택형" : "서답형");

export function sortItems(items: WrongItem[]): WrongItem[] {
  return [...items].sort((a, b) => (a.kind === b.kind ? a.no - b.no : a.kind === "mc" ? -1 : 1));
}
