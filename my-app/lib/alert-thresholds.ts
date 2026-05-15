/**
 * 보유 종목별 익절·손절 기준(현재가·수익률 %) — 대시보드 요약·동기화용
 */

export type AlertRule = {
  takeProfitPrice?: number;
  stopLossPrice?: number;
  takeProfitReturnPct?: number;
  stopLossReturnPct?: number;
};

export type AlertThresholdsByKey = Record<string, AlertRule>;

export const ALERT_THRESHOLDS_STORAGE_KEY = "portfolio_alert_thresholds_v1";

export function positionAlertKey(owner: string, symbol: string): string {
  return `${owner.trim()}::${normalizeSymbolForAlert(symbol)}`;
}

/** 티커 공통 % 기준 — 보유자 무관 (키: `*::XLE`) */
export function symbolAlertKey(symbol: string): string {
  return `*::${normalizeSymbolForAlert(symbol)}`;
}

export function isSymbolAlertKey(key: string): boolean {
  return key.startsWith("*::");
}

/** 종목별 합산·동기화용 티커 정규화 (KRX:/KQ: 접두 제거) */
export function normalizeSymbolForAlert(symbol: string): string {
  const u = symbol.trim().toUpperCase();
  if (u.startsWith("KRX:")) return u.slice(4);
  if (u.startsWith("KQ:")) return u.slice(3);
  return u;
}

function sanitizeSymbolPctRule(raw: unknown): AlertRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const normalized = normalizeRulePart(raw as AlertRule);
  const out: AlertRule = {};
  if (normalized.takeProfitReturnPct !== undefined) {
    out.takeProfitReturnPct = normalized.takeProfitReturnPct;
  }
  if (normalized.stopLossReturnPct !== undefined) {
    out.stopLossReturnPct = normalized.stopLossReturnPct;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 보유자별 가격 + 티커 공통 % 병합 (평가·표시용) */
export function resolveAlertRule(
  map: AlertThresholdsByKey,
  owner: string,
  symbol: string,
): AlertRule {
  const pos = map[positionAlertKey(owner, symbol)] ?? {};
  const sym = map[symbolAlertKey(symbol)] ?? {};
  return {
    takeProfitPrice: pos.takeProfitPrice,
    stopLossPrice: pos.stopLossPrice,
    takeProfitReturnPct: sym.takeProfitReturnPct ?? pos.takeProfitReturnPct,
    stopLossReturnPct: sym.stopLossReturnPct ?? pos.stopLossReturnPct,
  };
}

/** 기존 보유자::티커에만 있던 % → 티커 키로 이전 */
export function migrateAlertPctToSymbolKeys(map: AlertThresholdsByKey): AlertThresholdsByKey {
  const out: AlertThresholdsByKey = { ...map };
  for (const [k, rule] of Object.entries(map)) {
    if (isSymbolAlertKey(k) || !k.includes("::")) continue;
    const owner = (k.split("::")[0] ?? "").trim();
    if (!owner || owner === "*") continue;
    const sym = (k.split("::")[1] ?? "").trim();
    if (!sym) continue;
    const symKey = symbolAlertKey(sym);
    const pctOnly = sanitizeSymbolPctRule(rule);
    if (!pctOnly) continue;
    const existingSym = out[symKey] ?? {};
    out[symKey] = {
      takeProfitReturnPct: existingSym.takeProfitReturnPct ?? pctOnly.takeProfitReturnPct,
      stopLossReturnPct: existingSym.stopLossReturnPct ?? pctOnly.stopLossReturnPct,
    };
    const pos = { ...(out[k] ?? {}) };
    delete pos.takeProfitReturnPct;
    delete pos.stopLossReturnPct;
    if (Object.keys(pos).length === 0) delete out[k];
    else out[k] = pos;
  }
  return out;
}

function parseOptFinite(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function normalizeRulePart(rule: AlertRule): AlertRule {
  const out: AlertRule = {};
  const tp = parseOptFinite(rule.takeProfitPrice);
  const sl = parseOptFinite(rule.stopLossPrice);
  const tpr = parseOptFinite(rule.takeProfitReturnPct);
  const slr = parseOptFinite(rule.stopLossReturnPct);
  if (tp !== undefined) out.takeProfitPrice = tp;
  if (sl !== undefined) out.stopLossPrice = sl;
  if (tpr !== undefined) out.takeProfitReturnPct = tpr;
  if (slr !== undefined) out.stopLossReturnPct = slr;
  return out;
}

export function sanitizeAlertRule(raw: unknown): AlertRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const normalized = normalizeRulePart(raw as AlertRule);
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function sanitizeAlertThresholdsMap(raw: unknown): AlertThresholdsByKey {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AlertThresholdsByKey = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.includes("::")) continue;
    const key = k.trim();
    if (isSymbolAlertKey(key)) {
      const rule = sanitizeSymbolPctRule(v);
      if (rule) out[key] = rule;
      continue;
    }
    const rule = sanitizeAlertRule(v);
    if (!rule) continue;
    const priceOnly: AlertRule = {};
    if (rule.takeProfitPrice !== undefined) priceOnly.takeProfitPrice = rule.takeProfitPrice;
    if (rule.stopLossPrice !== undefined) priceOnly.stopLossPrice = rule.stopLossPrice;
    if (Object.keys(priceOnly).length > 0) out[key] = priceOnly;
    const pct = sanitizeSymbolPctRule(rule);
    if (pct) {
      const sym = (key.split("::")[1] ?? "").trim();
      if (sym) {
        const symKey = symbolAlertKey(sym);
        out[symKey] = { ...(out[symKey] ?? {}), ...pct };
      }
    }
  }
  return migrateAlertPctToSymbolKeys(out);
}

export function filterAlertThresholdsForOwners(
  map: AlertThresholdsByKey,
  allowed: Set<string>,
): AlertThresholdsByKey {
  const out: AlertThresholdsByKey = {};
  for (const [k, v] of Object.entries(map)) {
    if (isSymbolAlertKey(k)) {
      if (v && Object.keys(v).length > 0) out[k] = v;
      continue;
    }
    const owner = (k.split("::")[0] ?? "").trim();
    if (!owner || !allowed.has(owner)) continue;
    if (v && Object.keys(v).length > 0) out[k] = v;
  }
  return out;
}

export function mergeAlertThresholdsFromServer(
  raw: unknown,
  ownerNames: string[],
): AlertThresholdsByKey {
  const parsed = sanitizeAlertThresholdsMap(raw);
  return filterAlertThresholdsForOwners(parsed, new Set(ownerNames));
}

/**
 * pull 시: 서버에 기준선이 비어 있으면 로컬(브라우저) 값을 유지.
 * 서버·로컬 둘 다 있으면 같은 키는 로컬(최근 입력) 우선, 서버에만 있는 키는 서버 값 유지.
 */
export function mergeAlertThresholdsOnPull(
  localRaw: AlertThresholdsByKey,
  serverRaw: unknown,
  ownerNames: string[],
): AlertThresholdsByKey {
  const allowed = new Set(ownerNames);
  const local = filterAlertThresholdsForOwners(localRaw, allowed);
  const fromServer = mergeAlertThresholdsFromServer(serverRaw, ownerNames);
  if (Object.keys(fromServer).length === 0) {
    return local;
  }
  const out: AlertThresholdsByKey = { ...fromServer };
  for (const [k, rule] of Object.entries(local)) {
    if (rule && Object.keys(rule).length > 0) {
      out[k] = rule;
    }
  }
  return out;
}

export function loadAlertThresholdsFromStorage(): AlertThresholdsByKey {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ALERT_THRESHOLDS_STORAGE_KEY);
    if (!raw) return {};
    return sanitizeAlertThresholdsMap(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** 동기화 push 시 localStorage 기준으로 전송 */
export function getAlertThresholdsForSync(): AlertThresholdsByKey {
  return loadAlertThresholdsFromStorage();
}

type EnrichedForAlert = {
  currency: "USD" | "EUR" | "KRW";
  pnl: number;
  pnlKrwEquityPct: number | null;
};

/** 보유 표 '수익률'과 동일: 해외는 원화 매입 대비, 국내는 주가 기준 % */
export function positionReturnPctForAlert(p: EnrichedForAlert): number | null {
  if ((p.currency === "USD" || p.currency === "EUR") && p.pnlKrwEquityPct != null) {
    return p.pnlKrwEquityPct;
  }
  return Number.isFinite(p.pnl) ? p.pnl : null;
}

export function evaluateAlertRule(
  rule: AlertRule | undefined,
  ctx: { price: number | null; returnPct: number | null },
): { hit: boolean; reasons: string[] } {
  if (!rule || Object.keys(rule).length === 0) return { hit: false, reasons: [] };
  const reasons: string[] = [];
  const { price, returnPct } = ctx;
  if (rule.takeProfitPrice != null && price != null && price >= rule.takeProfitPrice) {
    reasons.push(`현재가 ≥ 익절가 ${rule.takeProfitPrice}`);
  }
  if (rule.stopLossPrice != null && price != null && price <= rule.stopLossPrice) {
    reasons.push(`현재가 ≤ 손절가 ${rule.stopLossPrice}`);
  }
  if (
    rule.takeProfitReturnPct != null &&
    returnPct != null &&
    returnPct >= rule.takeProfitReturnPct
  ) {
    reasons.push(`수익률 ≥ ${rule.takeProfitReturnPct}%`);
  }
  if (
    rule.stopLossReturnPct != null &&
    returnPct != null &&
    returnPct <= rule.stopLossReturnPct
  ) {
    reasons.push(`수익률 ≤ ${rule.stopLossReturnPct}%`);
  }
  return { hit: reasons.length > 0, reasons };
}
