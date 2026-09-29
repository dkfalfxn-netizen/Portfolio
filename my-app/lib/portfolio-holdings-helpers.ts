export const DEFAULT_OWNER_NAMES = ["김승주", "강희진", "김도율", "김찬율", "퇴직연금"] as const;
/** 포트폴리오 비중 그리드: 기본 순서 후 나머지 보유자 */
export function sortPortfolioGridRows<T extends { ownerName: string }>(
  rows: T[],
  preferred: readonly string[],
): T[] {
  const byName = new Map(rows.map((r) => [r.ownerName, r]));
  const used = new Set<string>();
  const out: T[] = [];
  for (const name of preferred) {
    const row = byName.get(name);
    if (row) {
      out.push(row);
      used.add(name);
    }
  }
  for (const row of rows) {
    if (!used.has(row.ownerName)) out.push(row);
  }
  return out;
}

/** 보유자 전체 합산용 티커 키 — KRX:/KQ: 생략 형태를 동일 종목으로 묶음 */
export function aggregateSymbolKeyForHoldings(symbol: string): string {
  const u = symbol.trim().toUpperCase();
  if (u.startsWith("KRX:")) return u.slice(4);
  if (u.startsWith("KQ:")) return u.slice(3);
  return u;
}

export function isStockRowForSymbolAggregate(p: { symbol: string; name: string }): boolean {
  const sym = p.symbol?.trim() ?? "";
  if (!sym) return false;
  const nm = p.name?.trim() ?? "";
  if (nm === "USD 현금" || nm === "KRW 현금") return false;
  return true;
}

/** 차트 그룹 구성란: 해외(USD/EUR)=티커, 국내(KRW)=종목명 */
export function chartGroupCompositionLabel(p: {
  symbol: string;
  name: string;
  currency: "USD" | "EUR" | "KRW";
}): string {
  const sym = p.symbol.trim();
  if (p.currency === "USD" || p.currency === "EUR") return sym;
  const nm = (p.name ?? "").trim();
  return nm || sym;
}

export type HoldingsAggTipRow = {
  code: string;
  name: string;
  pct: number | null;
};

export function fmtHoldingsAggTipPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

/** 행 합계 대비 지분(등락률과 구분 — 부호 없이 소수 한 자리) */
export function fmtHoldingsAggSharePct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return `${p.toFixed(1)}%`;
}
