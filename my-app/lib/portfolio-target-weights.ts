/** page·목표비중 UI 공통 — 로컬 변경 시 서버 푸시 유도 */
export const HAS_LOCAL_CHANGES_KEY = "portfolio_has_local_changes_v1";

export const TARGET_WEIGHT_STORAGE_KEY = "portfolio_target_stock_weight_v1";

/** 원형 차트·리밸 계산기 교차 동기화용 브라우저 이벤트(detail 없음) */
export const PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT = "portfolio-target-weights-refresh";

export type TargetStockWeightByOwner = Record<string, Record<string, number>>;

export function loadAllTargetStockWeights(): TargetStockWeightByOwner {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TARGET_WEIGHT_STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return {};
    return p as TargetStockWeightByOwner;
  } catch {
    return {};
  }
}

function sanitizeInner(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const row: Record<string, number> = {};
  for (const [ticker, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ticker !== "string" || !ticker.trim()) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 100) row[ticker] = n;
  }
  return row;
}

/** API·pull 응답용: 중첩 객체를 보유자별 비중 %로 정제 */
export function parseTargetStockWeightFromServer(raw: unknown): TargetStockWeightByOwner {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TargetStockWeightByOwner = {};
  for (const [owner, inner] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof owner !== "string" || !owner.trim()) continue;
    const row = sanitizeInner(inner);
    if (Object.keys(row).length) out[owner] = row;
  }
  return out;
}

/** 서버에서 받은 맵을 로컬과 병합(보유자 단위는 서버가 우선)한 뒤 저장하고, UI 갱신 이벤트를 보냅니다. */
export function mergeAndPersistTargetStockWeightsFromServer(server: unknown): void {
  if (typeof window === "undefined") return;
  const parsed = parseTargetStockWeightFromServer(server);
  if (Object.keys(parsed).length === 0) return;
  const local = loadAllTargetStockWeights();
  const next = { ...local, ...parsed };
  try {
    window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT));
}
