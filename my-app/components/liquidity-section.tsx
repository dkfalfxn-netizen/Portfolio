"use client";

import { withCoercedBriefingBody } from "@/lib/briefing-format";
import { BriefingSummaryText } from "@/components/briefing-summary-text";
import { LiquidityBriefingChart } from "@/components/liquidity-briefing-chart";
import type { LiquidityHistoryRow } from "@/components/liquidity-briefing-chart";

type Props = {
  isLoading: boolean;
  isError: boolean;
  rows: LiquidityHistoryRow[];
  /** 연준·금리 뉴스 요약(별도 Cron) */
  fedLoading?: boolean;
  fedSummary?: string | null;
  fedReportDate?: string | null;
  fedNote?: { tone: "info" | "warn"; text: string } | null;
  /** AI·방산 뉴스 요약(별도 Cron) */
  themesLoading?: boolean;
  themesSummary?: string | null;
  themesReportDate?: string | null;
  themesNote?: { tone: "info" | "warn"; text: string } | null;
};

export function LiquiditySection({
  isLoading,
  isError,
  rows,
  fedLoading = false,
  fedSummary = null,
  fedReportDate = null,
  fedNote = null,
  themesLoading = false,
  themesSummary = null,
  themesReportDate = null,
  themesNote = null,
}: Props) {
  return (
    <div id="section-data" className="space-y-4">
      <section className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
        <h2 className="mb-1 font-semibold">데이터 분석 — 시장 유동성·지표</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          매일 오전 9시(KST) Cron으로 지표·AI 요약이 쌓입니다(자세한 점검: <code className="rounded bg-muted px-1">docs/liquidity-briefing-cron.md</code>).
          순유동성·DXY·미10년·VIX를 시계열로 보고, 아래 <strong>AI 요약(번호 목록 4~6줄)</strong>을 함께 봅니다.
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">지표 데이터를 불러오는 중...</p>
        ) : isError ? (
          <p className="text-sm text-red-500">지표 데이터 조회에 실패했습니다.</p>
        ) : (
          <LiquidityBriefingChart rows={rows} />
        )}
      </section>

      <section className="rounded-2xl border border-slate-700/60 bg-slate-900/30 p-3 shadow-sm sm:p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-100">연준·금리 정책 (뉴스 헤드라인 AI 요약)</h3>
        <p className="mb-2 text-[11px] text-slate-500 sm:text-xs">
          Google 뉴스 RSS에서 &quot;Federal Reserve / Kevin Warsh / FOMC&quot; 키워드로 수집한 <strong>헤드라인·링크</strong>를 바탕으로, 매일 별도 Cron이 번호 목록 요약과 참고 링크를 만듭니다. 링크는 Google 뉴스 경유일 수 있습니다. 투자 권유가 아니라 모니터링용입니다.
        </p>
        {fedLoading ? (
          <p className="text-sm text-slate-400">연·금리 요약을 불러오는 중…</p>
        ) : (
          <>
            {fedNote && !fedSummary ? (
              <p
                className={
                  fedNote.tone === "warn"
                    ? "mb-2 text-sm text-amber-200/90"
                    : "mb-2 text-sm text-slate-400"
                }
              >
                {fedNote.text}
              </p>
            ) : null}
            {fedSummary ? (
              <>
                {fedReportDate ? (
                  <p className="mb-1 text-[10px] text-slate-500">기준일(저장): {fedReportDate}</p>
                ) : null}
                <BriefingSummaryText text={withCoercedBriefingBody(fedSummary, 6)} />
              </>
            ) : !fedNote ? (
              <p className="text-sm text-slate-400">요약이 없습니다.</p>
            ) : null}
          </>
        )}
      </section>

      <section className="rounded-2xl border border-slate-700/60 bg-slate-900/30 p-3 shadow-sm sm:p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-100">AI·방산 (뉴스 헤드라인 AI 요약)</h3>
        <p className="mb-2 text-[11px] text-slate-500 sm:text-xs">
          Google 뉴스 RSS에서 <strong>인공지능·반도체·투자</strong>와 <strong>한국 방산·방위 산업</strong> 등으로 수집한 <strong>헤드라인·링크</strong>를 바탕으로, 매일 별도 Cron이 번호 목록 요약과 참고 링크를 만듭니다. 투자 권유가 아니라 모니터링용입니다.
        </p>
        {themesLoading ? (
          <p className="text-sm text-slate-400">AI·방산 요약을 불러오는 중…</p>
        ) : (
          <>
            {themesNote && !themesSummary ? (
              <p
                className={
                  themesNote.tone === "warn"
                    ? "mb-2 text-sm text-amber-200/90"
                    : "mb-2 text-sm text-slate-400"
                }
              >
                {themesNote.text}
              </p>
            ) : null}
            {themesSummary ? (
              <>
                {themesReportDate ? (
                  <p className="mb-1 text-[10px] text-slate-500">기준일(저장): {themesReportDate}</p>
                ) : null}
                <BriefingSummaryText text={withCoercedBriefingBody(themesSummary, 6)} />
              </>
            ) : !themesNote ? (
              <p className="text-sm text-slate-400">요약이 없습니다.</p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
