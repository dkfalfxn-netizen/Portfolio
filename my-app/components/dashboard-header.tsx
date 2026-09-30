"use client";

import { type UseQueryResult } from "@tanstack/react-query";
import { MONEY_INT_LOCALE } from "@/lib/format-money";
import { FEAR_GREED_LABEL_KO, MarketResponse } from "@/lib/portfolio-types";
import { cn } from "@/lib/utils";
import { createPortal } from "react-dom";
import { type RefObject, type Dispatch, type SetStateAction } from "react";

export type DashboardHeaderProps = {
  activeTopNav: string;
  cloudSyncKey: string;
  cronDailySnapshotRecordedAt: string | null;
  eurKrw: number;
  goDashboardSection: (elementId: string) => void;
  goDashboardTop: () => void;
  holdingsMenuPos: { top: number; left: number; minW: number; } | null;
  holdingsMenuRef: RefObject<HTMLDivElement | null>;
  holdingsNavOpen: boolean;
  holdingsNavRef: RefObject<HTMLDivElement | null>;
  lastSyncedAt: string | null;
  marketQuery: UseQueryResult<MarketResponse, Error>;
  ownerNames: string[];
  setHoldingsNavOpen: Dispatch<SetStateAction<boolean>>;
  usdKrw: number;
};

export function DashboardHeader({
  activeTopNav,
  cloudSyncKey,
  cronDailySnapshotRecordedAt,
  eurKrw,
  goDashboardSection,
  goDashboardTop,
  holdingsMenuPos,
  holdingsMenuRef,
  holdingsNavOpen,
  holdingsNavRef,
  lastSyncedAt,
  marketQuery,
  ownerNames,
  setHoldingsNavOpen,
  usdKrw,
}: DashboardHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/90 bg-[#0b1220]/95 backdrop-blur-sm">
        <div className="mx-auto max-w-[1600px] px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="flex items-center gap-2 text-base font-bold tracking-tight sm:text-lg">
                <span aria-hidden>📈</span>
                주식 대시보드
              </h1>
              <span className="rounded-md bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-200 ring-1 ring-rose-500/25 sm:text-[11px]">
                로컬
              </span>
              <span className="hidden text-[11px] text-slate-500 sm:inline">
                USD/KRW {usdKrw.toLocaleString(MONEY_INT_LOCALE)} · EUR/KRW{" "}
                {eurKrw.toLocaleString(MONEY_INT_LOCALE)}
              </span>
              <span
                className="rounded-md border border-slate-600/80 bg-slate-900/40 px-2 py-0.5 text-[10px] tabular-nums text-slate-300 sm:text-[11px]"
                title="CNN Fear & Greed Index (CNN Dataviz API)"
              >
                F&amp;G{" "}
                {marketQuery.data?.fearGreed ? (
                  <>
                    <span className="font-semibold text-amber-300">
                      {Math.round(marketQuery.data.fearGreed.score)}
                    </span>
                    <span className="text-slate-500">
                      {" "}
                      {FEAR_GREED_LABEL_KO[marketQuery.data.fearGreed.label] ??
                        marketQuery.data.fearGreed.label}
                    </span>
                  </>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </span>
              <span
                className="rounded-md border border-slate-600/80 bg-slate-900/40 px-2 py-0.5 text-[10px] tabular-nums text-slate-300 sm:text-[11px]"
                title="CBOE 변동성 지수 (^VIX, Yahoo)"
              >
                VIX{" "}
                {typeof marketQuery.data?.vix === "number" ? (
                  <span className="font-semibold text-violet-300">
                    {marketQuery.data.vix.toFixed(2)}
                  </span>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </span>
              <a
                href="https://www.etfcheck.co.kr"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-slate-600/80 bg-slate-900/40 px-2 py-0.5 text-[10px] font-medium text-sky-400 hover:bg-slate-800/80 hover:text-sky-300 sm:text-[11px]"
              >
                ETF CHECK
              </a>
              <a
                href="https://finance.yahoo.com/sectors/"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-slate-600/80 bg-slate-900/40 px-2 py-0.5 text-[10px] font-medium text-violet-400 hover:bg-slate-800/80 hover:text-violet-300 sm:text-[11px]"
              >
                Yahoo Sectors
              </a>
            </div>
            <div
              role="status"
              aria-label="동기화 및 일별 크론 기록 시각"
              className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-slate-500 sm:w-auto sm:max-w-[min(42rem,calc(100vw-10rem))] sm:justify-end sm:text-[11px]"
            >
              <span className="break-words sm:text-right">
                동기화:{" "}
                <time dateTime={lastSyncedAt ?? undefined} className="font-medium text-slate-300">
                  {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "—"}
                </time>
              </span>
              <span className="hidden text-slate-600 sm:inline" aria-hidden>
                ·
              </span>
              <span className="break-words sm:text-right">
                크론(일별 스냅):{" "}
                <time dateTime={cronDailySnapshotRecordedAt ?? undefined} className="font-medium text-slate-300">
                  {cronDailySnapshotRecordedAt
                    ? new Date(cronDailySnapshotRecordedAt).toLocaleString()
                    : cloudSyncKey.trim().length >= 8
                      ? "미기록"
                      : "—"}
                </time>
              </span>
            </div>
          </div>
          <nav
            className="mt-2 flex max-w-full gap-0.5 overflow-x-auto border-t border-slate-800/80 pt-2 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1"
            role="navigation"
            aria-label="포트폴리오"
          >
            <div className="flex min-w-min flex-nowrap items-stretch gap-0.5">
              <button
                type="button"
                onClick={goDashboardTop}
                className={cn(
                  "relative shrink-0 rounded-t-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                  activeTopNav === "dashboard"
                    ? "text-white after:absolute after:bottom-0 after:left-1.5 after:right-1.5 after:h-[3px] after:rounded-sm after:bg-sky-500"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                대시보드
              </button>
              {(
                [
                  { id: "section-trend" as const, icon: "📈", label: "일별 자산 추이" },
                ] as const
              ).map(({ id, icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => goDashboardSection(id)}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1 rounded-t-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                    activeTopNav === id
                      ? "text-white after:absolute after:bottom-0 after:left-1.5 after:right-1.5 after:h-[3px] after:rounded-sm after:bg-sky-500"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  <span className="leading-none">{icon}</span>
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              ))}
              <div className="relative shrink-0" ref={holdingsNavRef}>
                <button
                  type="button"
                  aria-expanded={holdingsNavOpen}
                  onClick={() => setHoldingsNavOpen((o) => !o)}
                  className={cn(
                    "relative flex w-full min-w-0 items-center gap-0.5 rounded-t-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                    activeTopNav === "section-holdings" ||
                    activeTopNav === "section-holdings-by-symbol" ||
                    activeTopNav.startsWith("owner-")
                      ? "text-white after:absolute after:bottom-0 after:left-1.5 after:right-1.5 after:h-[3px] after:rounded-sm after:bg-sky-500"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  <span>📋</span>
                  <span className="whitespace-nowrap">보유 종목</span>
                  <span className="text-[10px] text-slate-500" aria-hidden>
                    {holdingsNavOpen ? "▴" : "▾"}
                  </span>
                </button>
                {holdingsNavOpen && holdingsMenuPos
                  ? createPortal(
                      <div
                        ref={holdingsMenuRef}
                        role="menu"
                        className="fixed z-[100] max-h-[min(70dvh,22rem)] max-w-[min(100vw-1rem,20rem)] overflow-y-auto overscroll-contain rounded-lg border border-slate-600 bg-[#0f172a] py-0.5 shadow-xl ring-1 ring-slate-800/60 divide-y divide-slate-800/80"
                        style={{
                          top: holdingsMenuPos.top,
                          left: holdingsMenuPos.left,
                          minWidth: holdingsMenuPos.minW,
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="w-full px-3 py-2.5 text-left text-sm text-slate-200 hover:bg-slate-800/80"
                          onClick={() => goDashboardSection("section-holdings")}
                        >
                          보유·전체
                        </button>
                        {ownerNames.map((name) => (
                          <button
                            key={name}
                            type="button"
                            role="menuitem"
                            className="w-full px-3 py-2.5 pl-4 text-left text-sm text-slate-300 hover:bg-slate-800/80 hover:text-slate-100"
                            onClick={() => goDashboardSection(`owner-${name}`)}
                          >
                            {name}
                          </button>
                        ))}
                        <button
                          type="button"
                          role="menuitem"
                          className="w-full px-3 py-2.5 text-left text-sm text-slate-200 hover:bg-slate-800/80"
                          onClick={() => goDashboardSection("section-holdings-by-symbol")}
                        >
                          종목별 합산
                        </button>
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
              {(
                [
                  { id: "section-add" as const, icon: "➕", label: "종목 추가" },
                  { id: "section-realized" as const, icon: "💰", label: "실현손익 입력" },
                  { id: "section-rebalance" as const, icon: "⚖️", label: "리밸런싱 계산기" },
                  { id: "section-watchlist" as const, icon: "⭐", label: "관심종목" },
                  { id: "section-telegram" as const, icon: "📲", label: "텔레그램" },
                  { id: "section-sync" as const, icon: "🔑", label: "동기화 키" },
                ] as const
              ).map(({ id, icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => goDashboardSection(id)}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1 rounded-t-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                    activeTopNav === id
                      ? "text-white after:absolute after:bottom-0 after:left-1.5 after:right-1.5 after:h-[3px] after:rounded-sm after:bg-sky-500"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  <span className="leading-none">{icon}</span>
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              ))}
            </div>
          </nav>
        </div>
      </header>
  );
}
