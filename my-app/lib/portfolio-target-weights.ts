/** page·목표비중 UI 공통 — 로컬 변경 시 서버 푸시 유도 */
export const HAS_LOCAL_CHANGES_KEY = "portfolio_has_local_changes_v1";

/** 대시보드(원형 차트) 전용 목표 비중 키 */
export const TARGET_WEIGHT_STORAGE_KEY = "portfolio_target_stock_weight_v1";

/** 리밸런싱 계산기 전용 목표 비중 키 (대시보드와 독립) */
export const CALCULATOR_TARGET_STORAGE_KEY = "portfolio_calculator_target_weight_v1";

/** 계산기 그룹 내 종목별 매매액 분배 가중치 (보유자 → 그룹키 → 심볼 → 양수 가중치) */
export const CALCULATOR_MEMBER_SPLIT_STORAGE_KEY = "portfolio_calculator_member_split_v1";

/** 원형 차트 내부 교차 탭 동기화용 브라우저 이벤트 */
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

/** 리밸런싱 계산기 전용 목표 비중 로더 */
export function loadAllCalculatorTargetWeights(): TargetStockWeightByOwner {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CALCULATOR_TARGET_STORAGE_KEY);
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

/** 서버에서 받은 맵을 로컬과 병합(같은 보유자·같은 티커면 서버 값이 우선)한 뒤 저장하고, UI 갱신 이벤트를 보냅니다.
 * 미보유(워치리스트만 있는) 목표 티커 등 로컬에만 있는 줄은 서버 맵에 없으므로 살려 둠. */
export function mergeAndPersistTargetStockWeightsFromServer(server: unknown): void {
  if (typeof window === "undefined") return;
  const parsed = parseTargetStockWeightFromServer(server);
  if (Object.keys(parsed).length === 0) return;
  const local = loadAllTargetStockWeights();
  const next: TargetStockWeightByOwner = { ...local };
  for (const [owner, row] of Object.entries(parsed)) {
    if (typeof owner !== "string" || !owner.trim()) continue;
    const prevInner = local[owner] ?? {};
    next[owner] = { ...prevInner, ...row };
  }
  try {
    window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT));
}

/** 계산기 그룹 내 종목 분배 가중치: owner → groupKey → symbol → weight */
export type CalculatorMemberSplitByOwner = Record<string, Record<string, Record<string, number>>>;

export function loadAllCalculatorMemberSplits(): CalculatorMemberSplitByOwner {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CALCULATOR_MEMBER_SPLIT_STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return {};
    return sanitizeCalculatorMemberSplitsRoot(p);
  } catch {
    return {};
  }
}

function sanitizeCalculatorMemberSplitsRoot(raw: unknown): CalculatorMemberSplitByOwner {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CalculatorMemberSplitByOwner = {};
  for (const [owner, mid] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof owner !== "string" || !owner.trim()) continue;
    if (!mid || typeof mid !== "object" || Array.isArray(mid)) continue;
    const groups: Record<string, Record<string, number>> = {};
    for (const [gk, symMap] of Object.entries(mid as Record<string, unknown>)) {
      if (typeof gk !== "string" || !gk.trim()) continue;
      if (!symMap || typeof symMap !== "object" || Array.isArray(symMap)) continue;
      const inner: Record<string, number> = {};
      for (const [sym, v] of Object.entries(symMap as Record<string, unknown>)) {
        if (typeof sym !== "string" || !sym.trim()) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0 && n <= 1e9) inner[sym.trim()] = n;
      }
      if (Object.keys(inner).length > 0) groups[gk.trim()] = inner;
    }
    if (Object.keys(groups).length > 0) out[owner.trim()] = groups;
  }
  return out;
}

/** 문자열 상태(입력칸)를 숫자 맵으로 정제해 한 보유자 분만 통째로 저장 */
export function persistCalculatorMemberSplitsForOwner(
  ownerName: string,
  splits: Record<string, Record<string, string>>,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const all = loadAllCalculatorMemberSplits();
    const nested: Record<string, Record<string, number>> = {};
    for (const [gk, symMap] of Object.entries(splits)) {
      const g = gk.trim();
      if (!g) continue;
      const row: Record<string, number> = {};
      for (const [sym, val] of Object.entries(symMap)) {
        const s = sym.trim();
        if (!s) continue;
        const raw = typeof val === "string" ? val.trim().replace(",", ".") : "";
        if (raw === "") continue;
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || n < 0) continue;
        row[s] = Math.min(1e9, n);
      }
      if (Object.keys(row).length > 0) nested[g] = row;
    }
    const before = JSON.stringify(all[ownerName] ?? {});
    all[ownerName] = nested;
    if (JSON.stringify(all[ownerName]) === before) return false;
    window.localStorage.setItem(CALCULATOR_MEMBER_SPLIT_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
