"use client";

import { OwnerName, HistoryResponse } from "@/lib/portfolio-types";
import { type Dispatch, type SetStateAction } from "react";
import { type UseQueryResult } from "@tanstack/react-query";
import { type TradeSignal } from "@/lib/signals";

export type TechnicalSignalSectionProps = {
  enrichedPositions: { sourceIndex: number; currentPrice: number; previousClose: number | null; pnl: number; valueKrw: number; costKrw: number; purchaseFxUsed: number; pnlUsdPct: number | null; pnlEurPct: number | null; pnlKrwEquityPct: number | null; marketState: "REGULAR" | "PRE" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED" | null; symbol: string; name: string; quantity: number; avgPrice: number; currency: "USD" | "EUR" | "KRW"; purchaseUsdKrw?: number; purchaseEurKrw?: number; purchaseDate?: string; purchaseFxPending?: boolean; purchaseFxAtAdd?: number; accountType: "\uD574\uC678\uC8FC\uC2DD" | "\uAD6D\uB0B4\uC8FC\uC2DD"; accountName: string; owner: OwnerName; chartGroup?: string; }[];
  goDashboardSection: (elementId: string) => void;
  historyQuery: UseQueryResult<HistoryResponse, Error>;
  setSignalDetailTarget: Dispatch<SetStateAction<{ symbol: string; name: string; } | null>>;
  signalBySymbol: Map<string, { final: TradeSignal; ma: TradeSignal; rsi: TradeSignal; bb: TradeSignal; vol: TradeSignal; }>;
};

export function TechnicalSignalSection({
  enrichedPositions,
  goDashboardSection,
  historyQuery,
  setSignalDetailTarget,
  signalBySymbol,
}: TechnicalSignalSectionProps) {
  return (
    <section id="section-technical-signal" className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-100">기술 시그널</h2>
              {historyQuery.isLoading && (
                <span className="text-[11px] text-slate-400">일봉 로드 중…</span>
              )}
              {historyQuery.isError && (
                <span className="text-[11px] text-rose-400">데이터 조회 실패</span>
              )}
            </div>
            <p className="mb-3 text-xs text-slate-400">
              일봉(김승주 보유 종목) 기반 MA·RSI·BB·거래량 요약. 상세는 &quot;차트·근거&quot;와「관심종목」을
              이용하세요.
            </p>
            {enrichedPositions.filter((p) => p.owner === "김승주").length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">김승주 보유 종목이 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="py-2 pr-2">종목명</th>
                      <th className="py-2 pr-2">티커</th>
                      <th className="py-2 pr-2">시장</th>
                      <th className="py-2 text-right">시그널</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enrichedPositions
                      .filter((p) => p.owner === "김승주")
                      .map((position) => {
                        const s = signalBySymbol.get(position.symbol);
                        const mkt =
                          position.currency === "KRW"
                            ? "국내"
                            : position.currency === "USD"
                              ? "미국"
                              : "유럽";
                        const color =
                          s?.final === "BUY"
                            ? "text-red-400"
                            : s?.final === "SELL"
                              ? "text-sky-400"
                              : "text-slate-300";
                        return (
                          <tr key={`sig-${position.sourceIndex}`} className="border-b border-slate-800/80">
                            <td className="py-2 pr-2 font-medium">{position.name}</td>
                            <td className="py-2 pr-2 text-slate-400">{position.symbol}</td>
                            <td className="py-2 pr-2 text-slate-500">{mkt}</td>
                            <td className="py-2 text-right">
                              {historyQuery.isLoading ? (
                                <span className="text-slate-500">로드 중…</span>
                              ) : historyQuery.isError ? (
                                <span className="text-rose-400/70">조회 실패</span>
                              ) : (
                                <>
                                  <span className={`font-semibold ${color}`}>
                                    {s?.final ?? "HOLD"}
                                  </span>
                                  {s ? (
                                    <p className="text-[10px] text-slate-500">
                                      MA:{s.ma} RSI:{s.rsi} BB:{s.bb} VOL:{s.vol}
                                    </p>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="mt-1 text-[10px] text-sky-400 underline-offset-2 hover:underline"
                                    onClick={() =>
                                      setSignalDetailTarget({ symbol: position.symbol, name: position.name })
                                    }
                                  >
                                    차트·근거
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-center text-xs text-slate-500">
              <button
                type="button"
                className="text-sky-400 underline"
                onClick={() => goDashboardSection("section-watchlist")}
              >
                관심종목
              </button>
              으로 이동
            </p>
          </section>
  );
}
