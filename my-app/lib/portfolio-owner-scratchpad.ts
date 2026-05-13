/** 보유자별 메모(트리맵 왼쪽) — 로컬 + 서버 동기화 공통 */

import { buildRebalanceCalculatorByOwnerFromLocal, loadAllTargetStockWeights } from "@/lib/portfolio-target-weights";

export const OWNER_SCRATCHPAD_STORAGE_KEY = "portfolio-owner-scratchpad-v1";

export type OwnerScratchpadByOwner = Record<string, string>;

export function loadAllOwnerScratchpads(): OwnerScratchpadByOwner {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(OWNER_SCRATCHPAD_STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return {};
    const out: OwnerScratchpadByOwner = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof k !== "string" || !k.trim()) continue;
      if (typeof v !== "string") continue;
      out[k] = v.replace(/\u0000/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

/** API·pull 응답용 문자열만 정제 */
export function parseOwnerScratchpadsFromServer(raw: unknown): OwnerScratchpadByOwner {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: OwnerScratchpadByOwner = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.trim()) continue;
    if (typeof v !== "string") continue;
    let s = v.replace(/\u0000/g, "");
    const MAX = 50_000;
    if (s.length > MAX) s = s.slice(0, MAX);
    out[k] = s;
  }
  return out;
}

/** 단일 보유자 메모를 전체 맵에 반영해 로컬에 저장 */
export function persistOneOwnerScratchpad(ownerName: string, text: string): void {
  if (typeof window === "undefined") return;
  const all = loadAllOwnerScratchpads();
  if (!text.length) delete all[ownerName];
  else all[ownerName] = text;
  try {
    window.localStorage.setItem(OWNER_SCRATCHPAD_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota */
  }
}

/** 서버 맵과 로컬 병합(같은 키면 서버가 덮음) 후 저장·새로고침 이벤트 */
export function mergeAndPersistOwnerScratchpadsFromServer(server: unknown): void {
  if (typeof window === "undefined") return;
  const parsed = parseOwnerScratchpadsFromServer(server);
  if (Object.keys(parsed).length === 0) return;
  const local = loadAllOwnerScratchpads();
  const next = { ...local, ...parsed };
  try {
    window.localStorage.setItem(OWNER_SCRATCHPAD_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return;
  }
  window.dispatchEvent(new Event("portfolio-owner-scratchpads-refresh"));
}

/** 목표 비중 저장과 동일 API로 메모 포함 업로드 — 동기화 키 8자 미만이면 false */
export async function pushTargetWeightsAndScratchpadsToServer(cloudSyncKey: string): Promise<boolean> {
  const key = cloudSyncKey.trim();
  if (key.length < 8) return false;
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "pushTargetWeights",
        key,
        targetStockWeightByOwner: loadAllTargetStockWeights(),
        ownerScratchpadByOwner: loadAllOwnerScratchpads(),
        rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
