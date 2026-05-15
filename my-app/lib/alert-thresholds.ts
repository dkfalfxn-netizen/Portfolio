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
  return `${owner.trim()}::${symbol.trim().toUpperCase()}`;
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
    const rule = sanitizeAlertRule(v);
    if (rule) out[k.trim()] = rule;
  }
  return out;
}

export function filterAlertThresholdsForOwners(
  map: AlertThresholdsByKey,
  allowed: Set<string>,
): AlertThresholdsByKey {
  const out: AlertThresholdsByKey = {};
  for (const [k, v] of Object.entries(map)) {
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
