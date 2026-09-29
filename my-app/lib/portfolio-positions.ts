import { fmtUsdNumber } from "@/lib/format-money";
import { SEED_강희진_보유 } from "@/lib/portfolio-seed";
import { parseCashPair, safeSetItem } from "@/lib/portfolio-storage";
import { CASH_STORAGE_KEY, LEGACY_POSITIONS_STORAGE_KEY, OwnerName, Position, STORAGE_KEY } from "@/lib/portfolio-types";

export function positionsForOwner(
  seed: Omit<Position, "owner">[],
  owner: OwnerName,
): Position[] {
  return seed.map((p) => ({ ...p, owner }));
}

// 견본/시드 데이터는 사용하지 않는다. 빈 포트폴리오로 시작해야 초기화·새 키가
// 깨끗하게 비어 보이며, 옛 견본 데이터(NVDA·SEED 보유)가 되살아나지 않는다.
export const DEFAULT_POSITIONS: Position[] = [];
void SEED_강희진_보유;
void positionsForOwner;

export type CashByOwner = Record<OwnerName, { usd: number; krw: number }>;

export const DEFAULT_CASH_BY_OWNER: CashByOwner = {
  김승주: { usd: 0, krw: 0 },
  강희진: { usd: 0, krw: 0 },
  김도율: { usd: 0, krw: 0 },
  김찬율: { usd: 0, krw: 0 },
  퇴직연금: { usd: 0, krw: 0 },
};

export function isOwnerName(value: unknown): value is OwnerName {
  return typeof value === "string" && value.trim().length > 0;
}

/** 원화를 USD/KRW로 나눈 달러 표기 (Intl currency 심볼 대신 `$` 고정 — 가독성·환경 차이 대비) */
export function formatKrwApproxAsUsd(krw: number, usdKrwRate: number): string {
  const rate =
    typeof usdKrwRate === "number" && usdKrwRate > 0 && Number.isFinite(usdKrwRate)
      ? usdKrwRate
      : 1350;
  const usd = krw / rate;
  if (!Number.isFinite(usd)) return "—";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 종목 평가액을 통화 기준(수량×현재가) — USD/EUR 행에 표시 */
export function formatPositionMarketValueForeign(
  position: Pick<Position, "currency" | "quantity" | "currentPrice">,
): string | null {
  if (position.currency !== "USD" && position.currency !== "EUR") return null;
  const v = position.quantity * position.currentPrice;
  if (!Number.isFinite(v)) return null;
  if (position.currency === "USD") {
    return `$${fmtUsdNumber(v, 2, 2)}`;
  }
  return `€${fmtUsdNumber(v, 2, 2)}`;
}

/** 같은 담당자·같은 티커·같은 통화면 한 줄로 합칩니다(계좌 구분 무시, 가중 평단). */
export function makePositionKey(p: Pick<Position, "owner" | "symbol" | "currency">) {
  return `${p.owner}|${p.symbol}|${p.currency}`;
}

/** USD 종목 합산 시 매입 환율(원화 매입액/달러 매입액) 가중평균 */
export function blendPurchaseUsdKrw(existing: Position, added: Position): number | undefined {
  if (existing.currency !== "USD") return undefined;
  const usdCostE = existing.quantity * existing.avgPrice;
  const usdCostP = added.quantity * added.avgPrice;
  const fxE = existing.purchaseUsdKrw;
  const fxP = added.purchaseUsdKrw;
  const rE = fxE ?? fxP;
  const rP = fxP ?? fxE;
  if (rE != null && rP != null && rE > 0 && rP > 0) {
    return (usdCostE * rE + usdCostP * rP) / (usdCostE + usdCostP);
  }
  return undefined;
}

/** EUR 종목 합산 시 매입 EUR/KRW 가중평균 */
export function blendPurchaseEurKrw(existing: Position, added: Position): number | undefined {
  if (existing.currency !== "EUR") return undefined;
  const eurCostE = existing.quantity * existing.avgPrice;
  const eurCostP = added.quantity * added.avgPrice;
  const fxE = existing.purchaseEurKrw;
  const fxP = added.purchaseEurKrw;
  const rE = fxE ?? fxP;
  const rP = fxP ?? fxE;
  if (rE != null && rP != null && rE > 0 && rP > 0) {
    return (eurCostE * rE + eurCostP * rP) / (eurCostE + eurCostP);
  }
  return undefined;
}

export function mergeDuplicatePositions(positions: Position[]): Position[] {
  const map = new Map<string, Position>();
  for (const p of positions) {
    const key = makePositionKey(p);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...p });
      continue;
    }
    const newQty = existing.quantity + p.quantity;
    const newAvg =
      (existing.quantity * existing.avgPrice + p.quantity * p.avgPrice) / newQty;
    const mergedPurchase = blendPurchaseUsdKrw(existing, p);
    const mergedEur = blendPurchaseEurKrw(existing, p);
    const nextPurchase =
      mergedPurchase ?? existing.purchaseUsdKrw ?? p.purchaseUsdKrw;
    const nextEurPurchase =
      mergedEur ?? existing.purchaseEurKrw ?? p.purchaseEurKrw;
    map.set(key, {
      ...existing,
      quantity: newQty,
      avgPrice: newAvg,
      currentPrice: p.currentPrice,
      name: existing.name || p.name,
      ...(existing.currency === "USD" && nextPurchase != null && nextPurchase > 0
        ? { purchaseUsdKrw: nextPurchase }
        : {}),
      ...(existing.currency === "EUR" && nextEurPurchase != null && nextEurPurchase > 0
        ? { purchaseEurKrw: nextEurPurchase }
        : {}),
    });
  }
  return Array.from(map.values());
}

/** 할당·툴팁용 현금 번들: 동일 행 평가금액 합산 — USD/KRW「현금」은 표시명만으로 묶음(예수금·가짜 종목 줄 중복 방지) */
export function mergeCashBundleDisplayEntries(
  parts: { name: string; symbol: string; value: number }[],
): { name: string; symbol: string; value: number }[] {
  const map = new Map<string, { name: string; symbol: string; value: number }>();
  for (const p of parts) {
    const sym = typeof p.symbol === "string" ? p.symbol.trim() : "";
    const nm = typeof p.name === "string" ? p.name.trim() : "";
    const key =
      nm === "USD 현금" || nm === "KRW 현금"
        ? `__byName__:${nm}`
        : `${sym}\n${nm}`;
    const cur = map.get(key);
    if (cur) cur.value += p.value;
    else
      map.set(key, {
        name: nm || p.name,
        symbol: nm === "USD 현금" || nm === "KRW 현금" ? "" : sym,
        value: p.value,
      });
  }
  return Array.from(map.values());
}

/** 종목 추가 폼: 한 건을 기존 목록에 병합하거나 새 줄 추가 */
export function applyPositionUpsert(prev: Position[], nextEntry: Position): Position[] {
  const key = makePositionKey(nextEntry);
  const idx = prev.findIndex((p) => makePositionKey(p) === key);
  if (idx === -1) return [...prev, nextEntry];
  const existing = prev[idx];
  const newQty = existing.quantity + nextEntry.quantity;
  const newAvg =
    (existing.quantity * existing.avgPrice + nextEntry.quantity * nextEntry.avgPrice) / newQty;
  const mergedPurchase = blendPurchaseUsdKrw(existing, nextEntry);
  const mergedEur = blendPurchaseEurKrw(existing, nextEntry);
  const merged: Position = {
    ...existing,
    quantity: newQty,
    avgPrice: newAvg,
    currentPrice: existing.currentPrice,
    name: nextEntry.name || existing.name,
  };
  if (nextEntry.currency === "USD") {
    const px = mergedPurchase ?? existing.purchaseUsdKrw ?? nextEntry.purchaseUsdKrw;
    if (px != null && px > 0) merged.purchaseUsdKrw = px;
    delete merged.purchaseEurKrw;
  } else if (nextEntry.currency === "EUR") {
    const px = mergedEur ?? existing.purchaseEurKrw ?? nextEntry.purchaseEurKrw;
    if (px != null && px > 0) merged.purchaseEurKrw = px;
    delete merged.purchaseUsdKrw;
  } else {
    delete merged.purchaseUsdKrw;
    delete merged.purchaseEurKrw;
  }
  return prev.map((p, i) => (i === idx ? merged : p));
}

export function isValidPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Position>;
  const purchaseUsdOk =
    item.currency !== "USD" ||
    item.purchaseUsdKrw === undefined ||
    (typeof item.purchaseUsdKrw === "number" &&
      Number.isFinite(item.purchaseUsdKrw) &&
      item.purchaseUsdKrw > 0);
  const purchaseEurOk =
    item.currency !== "EUR" ||
    item.purchaseEurKrw === undefined ||
    (typeof item.purchaseEurKrw === "number" &&
      Number.isFinite(item.purchaseEurKrw) &&
      item.purchaseEurKrw > 0);
  return (
    typeof item.symbol === "string" &&
    typeof item.name === "string" &&
    typeof item.quantity === "number" &&
    typeof item.avgPrice === "number" &&
    typeof item.currentPrice === "number" &&
    (item.currency === "USD" || item.currency === "EUR" || item.currency === "KRW") &&
    (item.accountType === "해외주식" || item.accountType === "국내주식") &&
    typeof item.accountName === "string" &&
    isOwnerName(item.owner) &&
    purchaseUsdOk &&
    purchaseEurOk
  );
}

export function parsePositionsArray(parsed: unknown): Position[] {
  if (!Array.isArray(parsed)) return DEFAULT_POSITIONS;
  const migrated = parsed
    .map((item) => {
      if (isValidPosition(item)) return item;
      if (item && typeof item === "object") {
        const p = item as Partial<Position> & { account?: string };
        const withOwner: Partial<Position> = {
          ...p,
          owner: isOwnerName(p.owner) ? p.owner : "김승주",
        };
        if (isValidPosition(withOwner)) return withOwner as Position;
      }
      if (!item || typeof item !== "object") return null;
      const legacy = item as {
        symbol?: unknown;
        name?: unknown;
        quantity?: unknown;
        avgPrice?: unknown;
        currentPrice?: unknown;
        currency?: unknown;
        account?: unknown;
      };
      if (
        typeof legacy.symbol !== "string" ||
        typeof legacy.name !== "string" ||
        typeof legacy.quantity !== "number" ||
        typeof legacy.avgPrice !== "number" ||
        typeof legacy.currentPrice !== "number" ||
        (legacy.currency !== "USD" &&
          legacy.currency !== "EUR" &&
          legacy.currency !== "KRW")
      ) {
        return null;
      }
      const accountType =
        legacy.account === "국내주식" || legacy.currency === "KRW" ? "국내주식" : "해외주식";
      const accountName =
        accountType === "국내주식" ? "국내주식-주계좌" : "미국주식-주계좌";
      return {
        symbol: legacy.symbol,
        name: legacy.name,
        quantity: legacy.quantity,
        avgPrice: legacy.avgPrice,
        currentPrice: legacy.currentPrice,
        currency: legacy.currency,
        accountType,
        accountName,
        owner: "김승주",
      } satisfies Position;
    })
    .filter((item): item is Position => item !== null);
  const list = migrated.length > 0 ? migrated : DEFAULT_POSITIONS;
  return mergeDuplicatePositions(list);
}

export function loadPositions(): Position[] {
  if (typeof window === "undefined") return DEFAULT_POSITIONS;
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      return parsePositionsArray(JSON.parse(rawV2) as unknown);
    }
    const rawV1 = window.localStorage.getItem(LEGACY_POSITIONS_STORAGE_KEY);
    if (rawV1) {
      const list = parsePositionsArray(JSON.parse(rawV1) as unknown);
      safeSetItem(STORAGE_KEY, JSON.stringify(list));
      window.localStorage.removeItem(LEGACY_POSITIONS_STORAGE_KEY);
      return list;
    }
    return DEFAULT_POSITIONS;
  } catch {
    return DEFAULT_POSITIONS;
  }
}

export function loadCashByOwner(): CashByOwner {
  if (typeof window === "undefined") return { ...DEFAULT_CASH_BY_OWNER };
  try {
    const raw = window.localStorage.getItem(CASH_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CASH_BY_OWNER };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CASH_BY_OWNER };
    const obj = parsed as Record<string, unknown>;
    if ("usd" in obj || "krw" in obj) {
      const legacy = parseCashPair(parsed);
      return { ...DEFAULT_CASH_BY_OWNER, 김승주: { ...legacy } };
    }
    const next: CashByOwner = { ...DEFAULT_CASH_BY_OWNER };
    for (const [name, value] of Object.entries(obj)) {
      if (typeof name === "string" && name.trim()) {
        next[name] = parseCashPair(value);
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_CASH_BY_OWNER };
  }
}
