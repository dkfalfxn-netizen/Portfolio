import type { Exam } from "./types";

const mcPoints = [2.7, 2.8, 2.9, 3, 3.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4];
const saPoints = [3, 4, 4, 5, 10, 11, 13];

/** 첫 실행 시 들어가는 예시 시험지 (선생님 화면에서 수정·삭제 가능) */
export const SAMPLE_EXAM: Exam = {
  id: "sample-pungmun-2025-1-2-2",
  title: "2025 풍문고1 2-2 [CM 19-24]",
  description: "2025 풍문고1 2학기 기말 공통수학2 [CM 19-24]",
  mc: mcPoints.map((points, i) => ({ no: i + 1, points })),
  sa: saPoints.map((points, i) => ({ no: i + 1, points })),
  links: [],
  createdAt: "2026-11-10T00:00:00.000Z",
};
