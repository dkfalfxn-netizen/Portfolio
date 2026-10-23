"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { EtfHoldingsResponse } from "@/app/api/etf-holdings/route";
import { isKrxListedEquityCode } from "@/lib/finance-symbols";

const UP_TEXT = "text-[#ef5350]";
const DOWN_TEXT = "text-[#00bfa5]";

export function EtfHoldingsPanel({
  symbol,
  query,
}: {
  symbol: string;
  query: UseQueryResult<EtfHoldingsResponse>;
}) {
  if (query.isLoading) {
    return <p className="text-xs text-muted-foreground">{symbol} 구성 종목 불러오는 중...</p>;
  }
  if (query.isError) {
    return <p className="text-xs text-destructive">구성 종목 조회에 실패했습니다.</p>;
  }

  const holdings = query.data?.holdings ?? [];
  if (holdings.length === 0) {
    return (
      <div className="space-y-0.5">
        <p className="text-xs text-muted-foreground">
          {symbol}의 구성 종목 정보를 제공받지 못했습니다(ETF가 아니거나 데이터 소스 미지원).
        </p>
        {query.data?.diag ? <p className="text-[10px] text-muted-foreground/70">원인 힌트: {query.data.diag}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {symbol} 상위 구성 종목 — 비중·일일 변동 (리밸런싱 시 비중은 자동 갱신)
      </p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 lg:grid-cols-5">
        {holdings.map((h) => {
          const up = h.changePct != null && h.changePct >= 0;
          return (
            <div
              key={h.symbol}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
              title={h.name}
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-foreground">
                  {isKrxListedEquityCode(h.symbol) && h.name && h.name !== h.symbol ? h.name : h.symbol}
                </p>
                {h.weightPct != null ? (
                  <p className="text-[10px] text-muted-foreground">비중 {h.weightPct.toFixed(2)}%</p>
                ) : null}
              </div>
              <span
                className={`shrink-0 font-semibold tabular-nums ${
                  h.changePct == null ? "text-muted-foreground" : up ? UP_TEXT : DOWN_TEXT
                }`}
              >
                {h.changePct == null ? "—" : `${up ? "+" : ""}${h.changePct.toFixed(2)}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
