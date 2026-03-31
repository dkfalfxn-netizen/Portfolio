"use client";

import { useState, useMemo } from "react";

export type GroupAllocation = {
  groupKey: string;      // chartGroup 또는 symbol
  displayName: string;
  valueKrw: number;
  currentPct: number;
  /** 그룹 내 종목 중 현재가가 있는 대표 종목 정보 (매수/매도 주수 계산용) */
  repSymbol: string;
  repName: string;
  repPrice: number;       // KRW 환산 현재가
};

type Props = {
  ownerName: string;
  groups: GroupAllocation[];
  totalKrw: number;
};

function fmt(n: number) {
  return `₩${Math.round(n).toLocaleString()}`;
}

function RebalancingOwner({ ownerName, groups, totalKrw }: Props) {
  // 목표 비중 state: groupKey → % 문자열
  const [targets, setTargets] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const g of groups) init[g.groupKey] = g.currentPct.toFixed(1);
    return init;
  });

  const targetSum = useMemo(
    () => Object.values(targets).reduce((s, v) => s + (parseFloat(v) || 0), 0),
    [targets],
  );

  const rows = useMemo(() => {
    return groups.map((g) => {
      const targetPct = parseFloat(targets[g.groupKey] ?? "0") || 0;
      const targetKrw = (targetPct / 100) * totalKrw;
      const diffKrw = targetKrw - g.valueKrw;          // + 매수, - 매도
      const shares =
        g.repPrice > 0 ? Math.round((diffKrw / g.repPrice) * 100) / 100 : null;
      return { ...g, targetPct, targetKrw, diffKrw, shares };
    });
  }, [groups, targets, totalKrw]);

  const isOver = targetSum > 100.05;
  const isUnder = targetSum < 99.95;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          목표 합계:{" "}
          <span
            className={
              isOver
                ? "font-bold text-red-400"
                : isUnder
                ? "font-bold text-amber-400"
                : "font-bold text-green-400"
            }
          >
            {targetSum.toFixed(1)}%
          </span>
          {isOver && " (100% 초과)"}
          {isUnder && " (100% 미달)"}
        </p>
        <button
          type="button"
          className="cursor-pointer rounded border px-2 py-0.5 text-[11px] hover:bg-muted active:scale-95 transition-all"
          onClick={() => {
            const init: Record<string, string> = {};
            for (const g of groups) init[g.groupKey] = g.currentPct.toFixed(1);
            setTargets(init);
          }}
        >
          현재 비중으로 초기화
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-1.5 pr-2 text-left font-medium">그룹</th>
              <th className="py-1.5 px-2 text-right font-medium">현재</th>
              <th className="py-1.5 px-2 text-right font-medium">현재액</th>
              <th className="py-1.5 px-2 text-right font-medium w-20">목표%</th>
              <th className="py-1.5 px-2 text-right font-medium">목표액</th>
              <th className="py-1.5 px-2 text-right font-medium">매수/매도</th>
              <th className="py-1.5 px-2 text-right font-medium">종목(주수)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.groupKey} className="border-b last:border-0 hover:bg-muted/30">
                <td className="py-1.5 pr-2 font-semibold">{r.groupKey}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                  {r.currentPct.toFixed(1)}%
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                  {fmt(r.valueKrw)}
                </td>
                <td className="py-1.5 px-2 text-right">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    className="w-16 rounded border bg-background px-1.5 py-0.5 text-right text-xs tabular-nums"
                    value={targets[r.groupKey] ?? ""}
                    onChange={(e) =>
                      setTargets((prev) => ({ ...prev, [r.groupKey]: e.target.value }))
                    }
                  />
                  <span className="ml-0.5 text-muted-foreground">%</span>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmt(r.targetKrw)}</td>
                <td
                  className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                    Math.abs(r.diffKrw) < 10000
                      ? "text-muted-foreground"
                      : r.diffKrw > 0
                      ? "text-red-400"
                      : "text-blue-400"
                  }`}
                >
                  {r.diffKrw > 10000
                    ? `▲ ${fmt(r.diffKrw)}`
                    : r.diffKrw < -10000
                    ? `▼ ${fmt(Math.abs(r.diffKrw))}`
                    : "—"}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                  {r.shares !== null && Math.abs(r.diffKrw) >= 10000 ? (
                    <span>
                      {r.repSymbol}{" "}
                      <span
                        className={
                          r.diffKrw > 0 ? "font-semibold text-red-400" : "font-semibold text-blue-400"
                        }
                      >
                        {r.diffKrw > 0 ? "+" : ""}
                        {r.shares}주
                      </span>
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-semibold">
              <td className="py-1.5 pr-2">합계</td>
              <td className="py-1.5 px-2 text-right tabular-nums">
                {groups.reduce((s, g) => s + g.currentPct, 0).toFixed(1)}%
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums">{fmt(totalKrw)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">
                <span className={isOver || isUnder ? "text-amber-400" : "text-green-400"}>
                  {targetSum.toFixed(1)}%
                </span>
              </td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function RebalancingCalculator({
  allocationByOwner,
  enrichedPositions,
  usdKrw,
}: {
  allocationByOwner: {
    ownerName: string;
    data: { ticker: string; displayName: string; value: number; weight: number }[];
    total: number;
  }[];
  enrichedPositions: {
    owner: string;
    symbol: string;
    name: string;
    chartGroup?: string;
    valueKrw: number;
    currentPrice: number;
    currency: string;
  }[];
  usdKrw: number;
}) {
  const [selectedOwner, setSelectedOwner] = useState(allocationByOwner[0]?.ownerName ?? "");

  const ownerData = useMemo(() => {
    return allocationByOwner.map(({ ownerName, data, total }) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);

      // 그룹별 대표 종목 찾기 (그룹 내 첫 번째 종목, 현재가가 있는 것 우선)
      const repMap = new Map<string, { symbol: string; name: string; priceKrw: number }>();
      for (const p of items) {
        const gk = p.chartGroup?.trim() || p.symbol;
        if (!repMap.has(gk) && p.currentPrice > 0) {
          const priceKrw =
            p.currency === "USD"
              ? p.currentPrice * usdKrw
              : p.currentPrice;
          repMap.set(gk, { symbol: p.symbol, name: p.name, priceKrw });
        }
      }

      const groups: GroupAllocation[] = data
        .filter((d) => !d.ticker.includes("현금"))
        .map((d) => {
          const rep = repMap.get(d.ticker);
          return {
            groupKey: d.ticker,
            displayName: d.displayName,
            valueKrw: d.value,
            currentPct: d.weight,
            repSymbol: rep?.symbol ?? d.ticker,
            repName: rep?.name ?? d.displayName,
            repPrice: rep?.priceKrw ?? 0,
          };
        });

      return { ownerName, groups, totalKrw: total };
    });
  }, [allocationByOwner, enrichedPositions, usdKrw]);

  const current = ownerData.find((o) => o.ownerName === selectedOwner);

  return (
    <div className="space-y-3">
      {/* 탭 */}
      <div className="flex flex-wrap gap-1">
        {ownerData.map(({ ownerName }) => (
          <button
            key={ownerName}
            type="button"
            onClick={() => setSelectedOwner(ownerName)}
            className={`cursor-pointer rounded px-3 py-1 text-xs transition-all ${
              selectedOwner === ownerName
                ? "bg-primary text-primary-foreground"
                : "border hover:bg-muted"
            }`}
          >
            {ownerName}
          </button>
        ))}
      </div>

      {current && current.groups.length > 0 ? (
        <RebalancingOwner
          key={current.ownerName}
          ownerName={current.ownerName}
          groups={current.groups}
          totalKrw={current.totalKrw}
        />
      ) : (
        <p className="text-sm text-muted-foreground">보유 종목이 없습니다.</p>
      )}

      <p className="text-[11px] text-muted-foreground">
        * 주수는 그룹 내 첫 번째 종목 현재가 기준 참고용입니다. 실제 매매 시 수수료·가격 변동을 감안하세요.
      </p>
    </div>
  );
}
