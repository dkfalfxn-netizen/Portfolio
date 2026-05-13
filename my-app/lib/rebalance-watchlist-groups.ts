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

/** 워치리스트 종목을 해당 그룹 티커와 일치하는 계산기 그룹 members 에 합침 (대시보드 바와 동일 후보) */
export function mergeWatchlistSymbolsIntoCalculatorGroups<G extends CalcGroupLite>(
  ownerName: string,
  groups: G[],
  watchlistRows: WatchlistRowForRebalance[],
  ownerAllToken: string,
  enrichedPositions: CalcPositionLite[],
  usdKrw: number,
): G[] {
  const items = enrichedPositions.filter((p) => p.owner === ownerName);
  const applicable = watchlistRows.filter((r) =>
    watchlistRowAppliesToOwner(r, ownerName, ownerAllToken),
  );

  return groups.map((g) => {
    const wlHits = applicable.filter((r) =>
      allocationTickerMatches(g.groupKey, watchlistSliceTickerKey(r)),
    );
    if (wlHits.length === 0) return refreshGroupRepHint(g);

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
      const priceKrw =
        priceRow && priceRow.currentPrice > 0
          ? priceRow.currency === "USD"
            ? priceRow.currentPrice * usdKrw
            : priceRow.currentPrice
          : 0;
      extra.push({
        symbol: symRaw,
        name: (typeof r.name === "string" && r.name.trim()) ? r.name.trim() : symRaw,
        valueKrw: priceRow?.valueKrw ?? 0,
        priceKrw,
      });
    }
    if (extra.length === 0) return refreshGroupRepHint(g);
    const merged = { ...g, members: [...g.members, ...extra] } as G;
    return refreshGroupRepHint(merged);
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
