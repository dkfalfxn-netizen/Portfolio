"use client";

import { LiquidityBriefingChart } from "@/components/liquidity-briefing-chart";
import type { LiquidityHistoryRow } from "@/components/liquidity-briefing-chart";

type Props = {
  isLoading: boolean;
  isError: boolean;
  rows: LiquidityHistoryRow[];
};

export function LiquiditySection({ isLoading, isError, rows }: Props) {
  return (
    <section id="section-liquidity" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
      <h2 className="mb-1 font-semibold">유동성 브리핑 차트</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        매일 오전 9시 브리핑 데이터를 시계열로 보여줍니다. 순유동성·DXY·미10년·VIX를 그래프로 보고,
        최신 AI 한두 문장 요약을 함께 확인할 수 있습니다.
      </p>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">유동성 브리핑 데이터를 불러오는 중...</p>
      ) : isError ? (
        <p className="text-sm text-red-500">유동성 브리핑 조회에 실패했습니다.</p>
      ) : (
        <LiquidityBriefingChart rows={rows} />
      )}
    </section>
  );
}
