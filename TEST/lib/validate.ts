import { REASONS, type ExamLink, type Question, type WrongItem } from "./types";

const REASON_CODES = new Set<string>(REASONS.map((r) => r.code));

export function isDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function parseQuestions(v: unknown): Question[] | null {
  if (!Array.isArray(v) || v.length > 60) return null;
  const out: Question[] = [];
  for (const [i, q] of v.entries()) {
    const points = Number((q as Question)?.points);
    if (!Number.isFinite(points) || points <= 0 || points > 100) return null;
    const unit = str((q as Question)?.unit, 60);
    out.push({ no: i + 1, points, ...(unit ? { unit } : {}) });
  }
  return out;
}

export function parseLinks(v: unknown): ExamLink[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l) => ({ label: str(l?.label, 60), url: str(l?.url, 1000) }))
    .filter((l) => l.label && /^https?:\/\//.test(l.url))
    .slice(0, 20);
}

export function parseItems(v: unknown): WrongItem[] | null {
  if (!Array.isArray(v) || v.length > 120) return null;
  const seen = new Set<string>();
  const out: WrongItem[] = [];
  for (const raw of v) {
    const kind = raw?.kind;
    const no = Number(raw?.no);
    if ((kind !== "mc" && kind !== "sa") || !Number.isInteger(no) || no < 1) return null;
    const key = `${kind}${no}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item: WrongItem = { kind, no };
    if (kind === "sa" && raw.earned !== undefined && raw.earned !== null && raw.earned !== "") {
      const e = Number(raw.earned);
      if (!Number.isFinite(e) || e < 0) return null;
      item.earned = e;
    }
    if (typeof raw.reason === "string" && REASON_CODES.has(raw.reason)) item.reason = raw.reason;
    const note = str(raw.note, 300);
    if (note) item.note = note;
    if (raw.solved === true) item.solved = true;
    out.push(item);
  }
  return out;
}
