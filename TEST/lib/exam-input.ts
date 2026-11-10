import type { Exam } from "./types";
import { parseLinks, parseQuestions, str } from "./validate";

/** 요청 본문 → Exam (검증 실패 시 오류 메시지 문자열) */
export function examFromBody(body: Record<string, unknown>, id: string, createdAt: string): Exam | string {
  const title = str(body.title, 100);
  if (!title) return "시험지 이름을 입력하세요.";
  const mc = parseQuestions(body.mc);
  const sa = parseQuestions(body.sa);
  if (!mc || !sa) return "배점 형식이 올바르지 않습니다.";
  if (mc.length + sa.length === 0) return "문항이 하나 이상 필요합니다.";
  return { id, title, description: str(body.description, 200), mc, sa, links: parseLinks(body.links), createdAt };
}
