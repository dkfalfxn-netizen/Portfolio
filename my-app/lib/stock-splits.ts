/**
 * 주식 분할(액면분할) 반영 — 보유 수량·평단·가격 기준 알림가·매수 저널을 분할 비율에 맞게 조정.
 *
 * - 분할은 총 투자금(원가)을 바꾸지 않는다: 수량 × factor, 단가 ÷ factor.
 * - 행마다 `splitsApplied` 에 적용한 분할 id 를 남겨 중복 적용을 막는다(동기화로 기기 간 공유).
 * - 이 파일은 순수 함수만 둔다(React·localStorage 비의존) — 단위 테스트 용이.
 */
import { holdingSymbolsEquivalent } from "@/lib/finance-symbols";
import { normalizeSymbolForAlert, type AlertThresholdsByKey } from "@/lib/alert-thresholds";
import type { BuyJournalEntry, Position } from "@/lib/portfolio-types";

export type StockSplit = {
  /** `${SYMBOL}@${date}` — 행의 splitsApplied 에 기록되는 값 */
  id: string;
  symbol: string;
  /** 분할 반영 가격으로 첫 거래되는 날(미국 현지 날짜, YYYY-MM-DD) */
  date: string;
  /** 신주 수 / 구주 수 (3:1 분할 = 3, 1:10 병합 = 0.1) */
  factor: number;
  note?: string;
};

export function makeSplitId(symbol: string, date: string): string {
  return `${normalizeSymbolForAlert(symbol)}@${date}`;
}

/**
 * 알려진 예정 분할. 분할은 드물어 공시 후 한 줄만 추가하면 된다.
 * (시세 쪽 분할 이벤트는 /api/stock-splits 가 확인해, 시세가 실제로 바뀐 뒤에만 자동 적용한다.)
 */
export const KNOWN_SPLITS: StockSplit[] = [
  {
    id: makeSplitId("SOXX", "2026-11-05"),
    symbol: "SOXX",
    date: "2026-11-05",
    factor: 3,
    note: "iShares Semiconductor ETF 3:1 (11/4 장 마감 후 적용)",
  },
  {
    id: makeSplitId("SNDK", "2026-11-20"),
    symbol: "SNDK",
    date: "2026-11-20",
    factor: 8,
    note: "Sandisk 8:1 (11/19 적용, 11/20 장 시작부터 분할 반영 거래)",
  },
];

const EPS = 1e-9;

function roundQty(n: number): number {
  // 부동소수 오차 제거(수량은 소수 8자리까지)
  return Math.round(n * 1e8) / 1e8;
}

function roundPrice(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function positionMatchesSplit(p: { symbol: string }, s: StockSplit): boolean {
  return holdingSymbolsEquivalent(p.symbol, s.symbol);
}

export function isSplitApplied(p: Position, s: StockSplit): boolean {
  return (p.splitsApplied ?? []).includes(s.id);
}

/** 오늘(KST) 기준으로 이미 분할일이 지났는데 아직 반영되지 않은 행이 있는 분할 목록 */
export function pendingSplitsForPositions(
  positions: Position[],
  splits: StockSplit[],
  todayYmd: string,
): StockSplit[] {
  return splits.filter(
    (s) =>
      s.date <= todayYmd &&
      positions.some((p) => positionMatchesSplit(p, s) && !isSplitApplied(p, s)),
  );
}

/** 분할일 이후(또는 당일) 새로 만든 행에 찍을 표식: 분할 후 기준으로 입력된 행임을 표시 */
export function stampKnownSplits<T extends Position>(
  entry: T,
  todayYmd: string,
  splits: StockSplit[] = KNOWN_SPLITS,
): T {
  const basisDate = entry.purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(entry.purchaseDate) ? entry.purchaseDate : todayYmd;
  const ids = splits.filter((s) => positionMatchesSplit(entry, s) && s.date <= basisDate).map((s) => s.id);
  if (ids.length === 0) return entry;
  const merged = Array.from(new Set([...(entry.splitsApplied ?? []), ...ids]));
  return { ...entry, splitsApplied: merged };
}

export type ApplySplitResult = {
  positions: Position[];
  /** 이번 호출에서 실제로 조정된 행의 보유자 — 알림가·매수 저널 조정 대상 */
  owners: string[];
  changedRows: number;
};

export function applySplitToPositions(positions: Position[], s: StockSplit): ApplySplitResult {
  if (!(s.factor > 0) || Math.abs(s.factor - 1) < EPS) return { positions, owners: [], changedRows: 0 };
  const owners = new Set<string>();
  let changedRows = 0;
  const next = positions.map((p) => {
    if (!positionMatchesSplit(p, s) || isSplitApplied(p, s)) return p;
    owners.add(p.owner);
    changedRows += 1;
    return {
      ...p,
      quantity: roundQty(p.quantity * s.factor),
      avgPrice: roundPrice(p.avgPrice / s.factor),
      currentPrice: roundPrice(p.currentPrice / s.factor),
      splitsApplied: [...(p.splitsApplied ?? []), s.id],
    };
  });
  return { positions: changedRows > 0 ? next : positions, owners: [...owners], changedRows };
}

/** 가격 기준 익절·손절가를 분할 비율로 조정. % 기준 규칙은 그대로. (`보유자::티커` 키만 — `*::티커`는 % 전용) */
export function applySplitToAlertThresholds(
  map: AlertThresholdsByKey,
  s: StockSplit,
  owners: string[],
): AlertThresholdsByKey {
  if (owners.length === 0) return map;
  const ownerSet = new Set(owners.map((o) => o.trim()));
  const sym = normalizeSymbolForAlert(s.symbol);
  let changed = false;
  const out: AlertThresholdsByKey = {};
  for (const [key, rule] of Object.entries(map)) {
    const idx = key.indexOf("::");
    const keyOwner = idx >= 0 ? key.slice(0, idx) : "";
    const keySym = idx >= 0 ? key.slice(idx + 2) : "";
    if (keyOwner !== "*" && ownerSet.has(keyOwner) && keySym === sym) {
      const r = { ...rule };
      if (r.takeProfitPrice != null) r.takeProfitPrice = roundPrice(r.takeProfitPrice / s.factor);
      if (r.stopLossPrice != null) r.stopLossPrice = roundPrice(r.stopLossPrice / s.factor);
      out[key] = r;
      changed = true;
    } else {
      out[key] = rule;
    }
  }
  return changed ? out : map;
}

/** 분할일 이전 매수 저널(차트 마커용)의 수량·매수가를 조정. 총 매수금(totalKrw)은 그대로. */
export function applySplitToBuyJournal(
  journal: BuyJournalEntry[],
  s: StockSplit,
  owners: string[],
): BuyJournalEntry[] {
  if (owners.length === 0) return journal;
  const ownerSet = new Set(owners);
  let changed = false;
  const next = journal.map((e) => {
    if (!ownerSet.has(e.owner) || !holdingSymbolsEquivalent(e.symbol, s.symbol) || e.date >= s.date) return e;
    changed = true;
    return { ...e, qty: roundQty(e.qty * s.factor), buyPrice: roundPrice(e.buyPrice / s.factor) };
  });
  return changed ? next : journal;
}

/** 시세(Yahoo)가 보고한 분할 이벤트가 알려진 분할과 같은지(날짜 ±3일, 비율 1% 이내) */
export function splitConfirmedByFeed(
  s: StockSplit,
  events: { symbol: string; date: string; factor: number }[],
): boolean {
  const t0 = Date.parse(`${s.date}T00:00:00Z`);
  return events.some((e) => {
    if (!holdingSymbolsEquivalent(e.symbol, s.symbol)) return false;
    const dt = Math.abs(Date.parse(`${e.date}T00:00:00Z`) - t0) / 86_400_000;
    return dt <= 3 && Math.abs(e.factor / s.factor - 1) < 0.01;
  });
}
