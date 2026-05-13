/** 리밸 계산기 ↔ 대시보드 도넛(stockSlicesForTargets) 종목 라인 동기화 */

export type WatchlistRowForRebalance = {
  symbol: string;
  name?: string;
  group?: string;
  owners?: string[];
};

export function watchlistRowAppliesToOwner(
  row: WatchlistRowForRebalance,
  ownerName: string,
  ownerAllToken: string,
): boolean {
  if (!row.symbol?.trim()) return false;
  const owns = row.owners;
  return (
    !owns ||
    owns.length === 0 ||
    owns.includes(ownerAllToken) ||
    owns.includes(ownerName)
  );
}

/** FamilyAllocationDonut 과 동일: 그룹 티커 = trim(group) 있으면 그것, 없으면 대문자 심볼 */
export function watchlistSliceTickerKey(row: WatchlistRowForRebalance): string {
  const rawSym = typeof row.symbol === "string" ? row.symbol.trim() : "";
  const symU = rawSym.toUpperCase();
  const grp = typeof row.group === "string" ? row.group.trim() : "";
  return grp || symU;
}

export function allocationTickerMatches(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** 보유 allocation 슬라이스 티커 + 해당 보유자 워치 슬라이스 티커만 허용 (대시보드 목표 요약과 동일 기준, LS 잔재 줄 차단) */
export function allowedCalculatorStubTickerKeysUpper(params: {
  ownerName: string;
  allocationTickers: string[];
  watchlistRows: WatchlistRowForRebalance[];
  watchlistOwnerAllToken: string;
}): Set<string> {
  const s = new Set<string>();
  for (const t of params.allocationTickers) {
    const u = t.trim().toUpperCase();
    if (u) s.add(u);
  }
  for (const row of params.watchlistRows) {
    if (!watchlistRowAppliesToOwner(row, params.ownerName, params.watchlistOwnerAllToken)) continue;
    const key = watchlistSliceTickerKey(row).trim().toUpperCase();
    if (key) s.add(key);
  }
  return s;
}

export type CalcPositionLite = {
  owner: string;
  symbol: string;
  name: string;
  chartGroup?: string;
  valueKrw: number;
  currentPrice: number;
  currency: string;
};

export type CalcMemberLite = {
  symbol: string;
  name: string;
  valueKrw: number;
  priceKrw: number;
};

export type CalcGroupLite = {
  groupKey: string;
  displayName: string;
  valueKrw: number;
  currentPct: number;
  repSymbol: string;
  repName: string;
  repPrice: number;
  members: CalcMemberLite[];
};

/** `/api/market` quotes 와 동형 — 미보유 종목도 주수 계산 가능하도록 시세 조회 결과 주입 */
export type ExternalMarketQuotes = Record<
  string,
  { price: number | null; currency: string | null }
>;

export type MergeWatchlistQuoteContext = {
  quotes?: ExternalMarketQuotes;
  /** EUR 표시 통화 종목용 */
  eurKrw?: number;
};

function quoteToPriceKrw(
  symbol: string,
  quotes: ExternalMarketQuotes | undefined,
  usdKrw: number,
  eurKrw: number,
): number {
  if (!quotes) return 0;
  const sym = symbol.trim();
  if (!sym) return 0;
  const upper = sym.toUpperCase();
  let row: { price: number | null; currency: string | null } | undefined =
    quotes[sym] ?? quotes[upper];
  if (!row?.price || !(row.price > 0)) {
    row = undefined;
    for (const [k, q] of Object.entries(quotes)) {
      if (k.trim().toUpperCase() === upper && q.price != null && q.price > 0) {
        row = q;
        break;
      }
    }
  }
  if (!row?.price || !(row.price > 0)) return 0;
  const c = (row.currency ?? "").toUpperCase();
  if (c === "USD") return row.price * usdKrw;
  if (c === "EUR") return row.price * eurKrw;
  return row.price;
}

function enrichMembersFromMarketQuotes<G extends CalcGroupLite>(
  g: G,
  quotes: ExternalMarketQuotes | undefined,
  usdKrw: number,
  eurKrw: number,
): G {
  if (!quotes || Object.keys(quotes).length === 0) return g;
  let touched = false;
  const members = g.members.map((m) => {
    if (m.priceKrw > 0) return m;
    const pk = quoteToPriceKrw(m.symbol, quotes, usdKrw, eurKrw);
    if (pk <= 0) return m;
    touched = true;
    return { ...m, priceKrw: pk };
  });
  return touched ? { ...g, members } : g;
}

/** 워치리스트 종목을 해당 그룹 티커와 일치하는 계산기 그룹 members 에 합침 (대시보드 바와 동일 후보) */
export function mergeWatchlistSymbolsIntoCalculatorGroups<G extends CalcGroupLite>(
  ownerName: string,
  groups: G[],
  watchlistRows: WatchlistRowForRebalance[],
  ownerAllToken: string,
  enrichedPositions: CalcPositionLite[],
  usdKrw: number,
  quoteCtx?: MergeWatchlistQuoteContext,
): G[] {
  const quotes = quoteCtx?.quotes;
  const eurKrw =
    typeof quoteCtx?.eurKrw === "number" && quoteCtx.eurKrw > 0 ? quoteCtx.eurKrw : 1450;

  const items = enrichedPositions.filter((p) => p.owner === ownerName);
  const applicable = watchlistRows.filter((r) =>
    watchlistRowAppliesToOwner(r, ownerName, ownerAllToken),
  );

  return groups.map((g) => {
    const finish = (next: G) =>
      refreshGroupRepHint(enrichMembersFromMarketQuotes(next, quotes, usdKrw, eurKrw));

    const wlHits = applicable.filter((r) =>
      allocationTickerMatches(g.groupKey, watchlistSliceTickerKey(r)),
    );
    if (wlHits.length === 0) return finish(g);

    const seen = new Set(g.members.map((m) => m.symbol.trim().toUpperCase()));
    const extra: CalcMemberLite[] = [];
    for (const r of wlHits) {
      const symRaw = r.symbol.trim();
      const symKey = symRaw.toUpperCase();
      if (!symKey || seen.has(symKey)) continue;
      if (
        g.members.some((m) => m.symbol.trim().toUpperCase() === symKey)
      ) {
        seen.add(symKey);
        continue;
      }
      seen.add(symKey);
      const priceRow = items.find((p) => p.symbol.trim().toUpperCase() === symKey);
      let priceKrw =
        priceRow && priceRow.currentPrice > 0
          ? priceRow.currency === "USD"
            ? priceRow.currentPrice * usdKrw
            : priceRow.currency === "EUR"
              ? priceRow.currentPrice * eurKrw
              : priceRow.currentPrice
          : 0;
      if (priceKrw <= 0) {
        priceKrw = quoteToPriceKrw(symRaw, quotes, usdKrw, eurKrw);
      }
      extra.push({
        symbol: symRaw,
        name: (typeof r.name === "string" && r.name.trim()) ? r.name.trim() : symRaw,
        valueKrw: priceRow?.valueKrw ?? 0,
        priceKrw,
      });
    }
    if (extra.length === 0) return finish(g);
    const merged = { ...g, members: [...g.members, ...extra] } as G;
    return finish(merged);
  });
}

function refreshGroupRepHint<G extends CalcGroupLite>(g: G): G {
  const hit = g.members.find((m) => m.priceKrw > 0);
  if (!hit) return g;
  if (g.repPrice > 0) return g;
  return {
    ...g,
    repSymbol: hit.symbol,
    repName: hit.name,
    repPrice: hit.priceKrw,
  };
}
