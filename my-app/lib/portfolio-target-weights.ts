/** page·목표비중 UI 공통 — 로컬 변경 시 서버 푸시 유도 */
export const HAS_LOCAL_CHANGES_KEY = "portfolio_has_local_changes_v1";

/** 목표 비중 % — 대시보드·리밸런싱 계산기 공통(localStorage 단일 소스) */
export const TARGET_WEIGHT_STORAGE_KEY = "portfolio_target_stock_weight_v1";

/** 과거 버전 호환용: 계산기가 별도 키에만 저장했던 데이터 (신규 설치에서는 비어 있음) */
export const CALCULATOR_TARGET_STORAGE_KEY = "portfolio_calculator_target_weight_v1";

const LEGACY_CALC_TARGETS_MERGED_FLAG = "portfolio_legacy_calc_targets_merged_v2";

/** 계산기 그룹 내 종목별 매매액 분배 가중치 (보유자 → 그룹키 → 심볼 → 양수 가중치) */
export const CALCULATOR_MEMBER_SPLIT_STORAGE_KEY = "portfolio_calculator_member_split_v1";

/** 그룹 내 분배 입력 해석: 상대 가중치 vs 종목별 포트 목표%(합을 그룹 목표%에 맞게 스케일) */
export const CALCULATOR_MEMBER_SPLIT_MODE_STORAGE_KEY = "portfolio_calculator_member_split_mode_v1";

export type CalculatorMemberSplitMode = "weight" | "targetPct";

/** 원형 차트 내부 교차 탭 동기화용 브라우저 이벤트 */
export const PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT = "portfolio-target-weights-refresh";

/** 리밸 계산기 LS 갱신 시 UI 재읽기(서버 pull 반영 후) */
export const REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT =
  "portfolio-rebalance-calculator-storage-refresh";

export type TargetStockWeightByOwner = Record<string, Record<string, number>>;

export function loadAllTargetStockWeights(): TargetStockWeightByOwner {
  if (typeof window === "undefined") return {};
  migrateLegacyCalculatorTargetWeightsOnce();
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

/** @deprecated 과거 이름 유지 — `loadAllTargetStockWeights()`와 동일 */
export function loadAllCalculatorTargetWeights(): TargetStockWeightByOwner {
  return loadAllTargetStockWeights();
}

/**
 * 계산기·대시보드 공통 목표 % 저장: 해당 보유자 행만 병합(다른 티커 목표는 유지).
 */
export function persistOwnerTargetWeightsFromInputStrings(
  ownerName: string,
  targetsStrings: Record<string, string>,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const all = loadAllTargetStockWeights();
    const prevRow = JSON.stringify(all[ownerName] ?? {});
    const merged = { ...(all[ownerName] ?? {}) };
    for (const [k, v] of Object.entries(targetsStrings)) {
      const key = typeof k === "string" ? k.trim() : "";
      if (!key) continue;
      const rawStr = typeof v === "string" ? v.trim().replace(",", ".") : String(v ?? "");
      if (rawStr === "") continue;
      const n = parseFloat(rawStr);
      if (!Number.isFinite(n)) continue;
      merged[key] = Math.min(100, Math.max(0, n));
    }
    all[ownerName] = merged;
    if (JSON.stringify(all[ownerName]) === prevRow) return false;
    window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(all));
    window.localStorage.setItem(HAS_LOCAL_CHANGES_KEY, "1");
    window.dispatchEvent(new Event(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT));
    return true;
  } catch {
    return false;
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

function parseTargetWeightsStoredJson(raw: string | null): TargetStockWeightByOwner {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return {};
    const out: TargetStockWeightByOwner = {};
    for (const [owner, inner] of Object.entries(p as Record<string, unknown>)) {
      if (typeof owner !== "string" || !owner.trim()) continue;
      out[owner.trim()] =
        inner && typeof inner === "object" && !Array.isArray(inner) ? sanitizeInner(inner) : {};
    }
    return out;
  } catch {
    return {};
  }
}

/** 과거 분리 저장소(CALCULATOR_TARGET_STORAGE_KEY) → 통합 키로 1회 이관 후 레거시 키 제거 */
function migrateLegacyCalculatorTargetWeightsOnce(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(LEGACY_CALC_TARGETS_MERGED_FLAG)) return;
    const dash = parseTargetWeightsStoredJson(window.localStorage.getItem(TARGET_WEIGHT_STORAGE_KEY));
    const calc = parseTargetWeightsStoredJson(window.localStorage.getItem(CALCULATOR_TARGET_STORAGE_KEY));
    let wrote = false;
    if (Object.keys(calc).length > 0) {
      const merged: TargetStockWeightByOwner = { ...dash };
      for (const [owner, row] of Object.entries(calc)) {
        const o = owner.trim();
        if (!o) continue;
        merged[o] = { ...(merged[o] ?? {}), ...row };
      }
      window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(merged));
      window.localStorage.removeItem(CALCULATOR_TARGET_STORAGE_KEY);
      wrote = true;
    }
    window.localStorage.setItem(LEGACY_CALC_TARGETS_MERGED_FLAG, "1");
    if (wrote) {
      window.dispatchEvent(new Event(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT));
      window.dispatchEvent(new Event(REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT));
    }
  } catch {
    try {
      window.localStorage.setItem(LEGACY_CALC_TARGETS_MERGED_FLAG, "1");
    } catch {
      /* ignore */
    }
  }
}

/** API·pull 응답용: 중첩 객체를 보유자별 비중 %로 정제(목표 없는 보유자는 빈 객체로 유지) */
export function parseTargetStockWeightFromServer(raw: unknown): TargetStockWeightByOwner {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TargetStockWeightByOwner = {};
  for (const [owner, inner] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof owner !== "string" || !owner.trim()) continue;
    const row =
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? sanitizeInner(inner)
        : {};
    out[owner.trim()] = row;
  }
  return out;
}

/** 서버 스냅샷 우선: 응답에 포함된 보유자별 목표 전체를 서버 맵으로 교체 후 저장합니다.
 * 동기화 서버 목표 미포함 로컬 전용 줄은 새 기기에서는 사라져도, 여러 번 pull 시 같은 스키마입니다. */
export function mergeAndPersistTargetStockWeightsFromServer(server: unknown): void {
  if (typeof window === "undefined") return;
  const parsed = parseTargetStockWeightFromServer(server);
  if (Object.keys(parsed).length === 0) return;
  const local = loadAllTargetStockWeights();
  const next: TargetStockWeightByOwner = { ...local };
  for (const [owner, row] of Object.entries(parsed)) {
    if (typeof owner !== "string" || !owner.trim()) continue;
    next[owner.trim()] = { ...row };
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

export type CalculatorMemberSplitModeByOwner = Record<
  string,
  Record<string, CalculatorMemberSplitMode>
>;

export function loadAllCalculatorMemberSplitModes(): CalculatorMemberSplitModeByOwner {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CALCULATOR_MEMBER_SPLIT_MODE_STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null) return {};
    const out: CalculatorMemberSplitModeByOwner = {};
    for (const [owner, mid] of Object.entries(p as Record<string, unknown>)) {
      if (typeof owner !== "string" || !owner.trim()) continue;
      if (!mid || typeof mid !== "object" || Array.isArray(mid)) continue;
      const groups: Record<string, CalculatorMemberSplitMode> = {};
      for (const [gk, v] of Object.entries(mid as Record<string, unknown>)) {
        if (typeof gk !== "string" || !gk.trim()) continue;
        if (v === "weight" || v === "targetPct") groups[gk.trim()] = v;
      }
      if (Object.keys(groups).length > 0) out[owner.trim()] = groups;
    }
    return out;
  } catch {
    return {};
  }
}

/** 그룹별 분배 방식만 저장 */
export function persistCalculatorMemberSplitModesForOwner(
  ownerName: string,
  modes: Record<string, CalculatorMemberSplitMode>,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const all = loadAllCalculatorMemberSplitModes();
    const cleaned: Record<string, CalculatorMemberSplitMode> = {};
    for (const [gk, v] of Object.entries(modes)) {
      const g = gk.trim();
      if (!g) continue;
      if (v === "weight" || v === "targetPct") cleaned[g] = v;
    }
    const before = JSON.stringify(all[ownerName] ?? {});
    all[ownerName] = cleaned;
    if (JSON.stringify(all[ownerName]) === before) return false;
    window.localStorage.setItem(CALCULATOR_MEMBER_SPLIT_MODE_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** 서버(sync)·API 본문 공통: 보유자별 번들(groupTargets은 통합 목표 LS와 동일 스냅샷) */
export type RebalanceCalculatorWireBundle = {
  groupTargets: Record<string, number>;
  memberSplits: Record<string, Record<string, number>>;
  memberSplitModes: Record<string, CalculatorMemberSplitMode>;
};

export type RebalanceCalculatorByOwnerWire = Record<string, RebalanceCalculatorWireBundle>;

function emptyCalculatorWireBundle(): RebalanceCalculatorWireBundle {
  return { groupTargets: {}, memberSplits: {}, memberSplitModes: {} };
}

function sanitizeCalculatorGroupTargetsInner(raw: unknown): Record<string, number> {
  return sanitizeInner(raw);
}

function sanitizeCalculatorMemberSplitsInner(raw: unknown): Record<string, Record<string, number>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const groups: Record<string, Record<string, number>> = {};
  for (const [gk, symMap] of Object.entries(raw as Record<string, unknown>)) {
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
  return groups;
}

function sanitizeCalculatorMemberModesInner(raw: unknown): Record<string, CalculatorMemberSplitMode> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const groups: Record<string, CalculatorMemberSplitMode> = {};
  for (const [gk, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof gk !== "string" || !gk.trim()) continue;
    if (v === "weight" || v === "targetPct") groups[gk.trim()] = v;
  }
  return groups;
}

/** pull 응답·직렬화 검증용(허용된 보유자만) */
export function sanitizeRebalanceCalculatorForOwners(
  raw: unknown,
  allowed: Set<string>,
): RebalanceCalculatorByOwnerWire {
  const out: RebalanceCalculatorByOwnerWire = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [owner, inner] of Object.entries(raw as Record<string, unknown>)) {
    const ou = typeof owner === "string" ? owner.trim() : "";
    if (!ou || !allowed.has(ou)) continue;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
      out[ou] = emptyCalculatorWireBundle();
      continue;
    }
    const o = inner as Record<string, unknown>;
    out[ou] = {
      groupTargets: sanitizeCalculatorGroupTargetsInner(o.groupTargets ?? o.targets),
      memberSplits: sanitizeCalculatorMemberSplitsInner(o.memberSplits),
      memberSplitModes: sanitizeCalculatorMemberModesInner(o.memberSplitModes ?? o.memberSplitMode),
    };
  }
  return out;
}

/** 클라이언트 로컬(LS) 세 키를 보유자별 번들로 합쳐 푸시 본문에 넣습니다. */
export function buildRebalanceCalculatorByOwnerFromLocal(): RebalanceCalculatorByOwnerWire {
  const targets = loadAllCalculatorTargetWeights();
  const splits = loadAllCalculatorMemberSplits();
  const modes = loadAllCalculatorMemberSplitModes();
  const owners = new Set<string>([
    ...Object.keys(targets),
    ...Object.keys(splits),
    ...Object.keys(modes),
  ]);
  const out: RebalanceCalculatorByOwnerWire = {};
  for (const o of owners) {
    const name = o.trim();
    if (!name) continue;
    out[name] = {
      groupTargets: { ...(targets[name] ?? {}) },
      memberSplits: JSON.parse(JSON.stringify(splits[name] ?? {})) as Record<string, Record<string, number>>,
      memberSplitModes: { ...(modes[name] ?? {}) },
    };
  }
  return out;
}

/** 서버 pull → 목표 통합 저장소 + 분배 LS 반영 후 UI 갱신 */
export function mergeAndPersistRebalanceCalculatorFromServer(server: unknown): void {
  if (typeof window === "undefined") return;
  const parsed = parseRebalanceCalculatorFromServer(server);
  if (Object.keys(parsed).length === 0) return;
  const targets = loadAllTargetStockWeights();
  const splits = loadAllCalculatorMemberSplits();
  const modes = loadAllCalculatorMemberSplitModes();
  for (const [owner, bundle] of Object.entries(parsed)) {
    const o = owner.trim();
    if (!o) continue;
    targets[o] = { ...(targets[o] ?? {}), ...(bundle.groupTargets ?? {}) };
    if (Object.keys(bundle.memberSplits).length > 0) splits[o] = bundle.memberSplits;
    else delete splits[o];
    if (Object.keys(bundle.memberSplitModes).length > 0) modes[o] = bundle.memberSplitModes;
    else delete modes[o];
  }
  try {
    window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(targets));
    window.localStorage.setItem(CALCULATOR_MEMBER_SPLIT_STORAGE_KEY, JSON.stringify(splits));
    window.localStorage.setItem(CALCULATOR_MEMBER_SPLIT_MODE_STORAGE_KEY, JSON.stringify(modes));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT));
  window.dispatchEvent(new Event(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT));
}

function parseRebalanceCalculatorFromServer(server: unknown): RebalanceCalculatorByOwnerWire {
  if (!server || typeof server !== "object" || Array.isArray(server)) return {};
  const raw = server as Record<string, unknown>;
  const allowed = new Set<string>();
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const ou = typeof k === "string" ? k.trim() : "";
    if (!ou) continue;
    allowed.add(ou);
    normalized[ou] = v;
  }
  return sanitizeRebalanceCalculatorForOwners(normalized, allowed);
}
