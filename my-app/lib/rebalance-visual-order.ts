import { HAS_LOCAL_CHANGES_KEY } from "@/lib/portfolio-target-weights";

/** 보유자별 비중 행 순서(chart 그룹·티커 키 문자열과 동일) */
export const REBALANCE_VISUAL_ORDER_KEY = "portfolio_rebalance_visual_order_v1";

export const REBALANCE_VISUAL_ORDER_REFRESH_EVENT = "portfolio-rebalance-visual-order-refresh";

export type RebalanceVisualOrderByOwner = Record<string, string[]>;

export function loadAllRebalanceVisualOrders(): RebalanceVisualOrderByOwner {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(REBALANCE_VISUAL_ORDER_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return {};
    return p as RebalanceVisualOrderByOwner;
  } catch {
    return {};
  }
}

export function loadVisualOrderKeysForOwner(owner: string): string[] | null {
  const keys = loadAllRebalanceVisualOrders()[owner];
  return Array.isArray(keys) && keys.length > 0 ? keys : null;
}

/** 비현금 블록 순서만 넘기면 됩니다. 현금 키는 저장에서 제외해도 됩니다. */
export function persistVisualOrderForOwner(owner: string, keys: string[]): void {
  if (typeof window === "undefined") return;
  try {
    const all = loadAllRebalanceVisualOrders();
    all[owner] = keys.filter((k) => typeof k === "string" && k.length > 0);
    window.localStorage.setItem(REBALANCE_VISUAL_ORDER_KEY, JSON.stringify(all));
    window.localStorage.setItem(HAS_LOCAL_CHANGES_KEY, "1");
  } catch {
    /* 저장 불가 시 무시 */
  }
  window.dispatchEvent(new Event(REBALANCE_VISUAL_ORDER_REFRESH_EVENT));
}
