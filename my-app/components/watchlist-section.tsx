"use client";

import { WATCHLIST_OWNER_ALL, WatchlistRow } from "@/lib/portfolio-types";
import { type Dispatch, type SetStateAction } from "react";

export type WatchlistSectionProps = {
  handleSaveWatchlist: () => Promise<void>;
  ownerNames: string[];
  setWatchlistRows: Dispatch<SetStateAction<WatchlistRow[]>>;
  watchlistBusy: boolean;
  watchlistMessage: string;
  watchlistRows: WatchlistRow[];
};

export function WatchlistSection({
  handleSaveWatchlist,
  ownerNames,
  setWatchlistRows,
  watchlistBusy,
  watchlistMessage,
  watchlistRows,
}: WatchlistSectionProps) {
  return (
    <section id="section-watchlist" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">⭐ 관심종목 (매수 타이밍 참고)</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              보유하지 않은 종목 중 <b>관심 티커</b>를 등록하면, 텔레그램으로{" "}
              <b>이동평균(MA)·RSI·볼린저(BB)·거래량(VOL)</b> 네 가지 근거를 요약한 시그널을 함께 보냅니다.
              아래 저장 시 서버(Supabase)에 동기화 키별로 저장됩니다.{" "}
              <code className="rounded bg-muted px-1">supabase/watchlist_column.sql</code> 실행이 필요합니다.
            </p>
            <div className="space-y-2">
              {watchlistRows.length === 0 && (
                <p className="text-xs text-muted-foreground">행 추가 후 티커를 입력하세요. (예: 005930, NVDA, TSM)</p>
              )}
              {watchlistRows.map((row, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
                  <input
                    className="w-28 rounded border bg-background px-2 py-1 text-xs font-mono uppercase"
                    placeholder="티커"
                    value={row.symbol}
                    onChange={(e) =>
                      setWatchlistRows((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, symbol: e.target.value } : r)),
                      )
                    }
                  />
                  <input
                    className="min-w-[120px] flex-1 rounded border bg-background px-2 py-1 text-xs"
                    placeholder="표시 이름 (선택)"
                    value={row.name}
                    onChange={(e) =>
                      setWatchlistRows((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r)),
                      )
                    }
                  />
                  <input
                    className="w-28 rounded border bg-background px-2 py-1 text-xs"
                    placeholder="그룹 (선택)"
                    value={row.group ?? ""}
                    onChange={(e) =>
                      setWatchlistRows((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, group: e.target.value } : r)),
                      )
                    }
                  />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border bg-background px-2 py-1">
                    <label className="flex cursor-pointer items-center gap-1 text-[11px]">
                      <input
                        type="checkbox"
                        checked={(row.owners ?? [WATCHLIST_OWNER_ALL]).includes(WATCHLIST_OWNER_ALL)}
                        onChange={(e) =>
                          setWatchlistRows((prev) =>
                            prev.map((r, i) => {
                              if (i !== idx) return r;
                              if (e.target.checked) return { ...r, owners: [WATCHLIST_OWNER_ALL] };
                              return { ...r, owners: [] };
                            }),
                          )
                        }
                      />
                      전체
                    </label>
                    {ownerNames.map((name) => (
                      <label key={`watch-owner-${name}`} className="flex cursor-pointer items-center gap-1 text-[11px]">
                        <input
                          type="checkbox"
                          checked={(row.owners ?? [WATCHLIST_OWNER_ALL]).includes(name)}
                          onChange={(e) =>
                            setWatchlistRows((prev) =>
                              prev.map((r, i) => {
                                if (i !== idx) return r;
                                const current = (r.owners ?? [WATCHLIST_OWNER_ALL]).filter(
                                  (v) => v !== WATCHLIST_OWNER_ALL,
                                );
                                const next = e.target.checked
                                  ? Array.from(new Set([...current, name]))
                                  : current.filter((v) => v !== name);
                                return { ...r, owners: next.length > 0 ? next : [WATCHLIST_OWNER_ALL] };
                              }),
                            )
                          }
                        />
                        {name}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="ml-auto rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                    onClick={() => setWatchlistRows((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    삭제
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                  onClick={() =>
                    setWatchlistRows((prev) => [
                      ...prev,
                      { symbol: "", name: "", group: "", owners: [WATCHLIST_OWNER_ALL] },
                    ])
                  }
                >
                  + 종목 추가
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  disabled={watchlistBusy}
                  onClick={() => void handleSaveWatchlist()}
                >
                  {watchlistBusy ? "저장 중…" : "관심종목 저장"}
                </button>
              </div>
              {watchlistMessage && (
                <p className="text-xs text-muted-foreground">{watchlistMessage}</p>
              )}
            </div>
          </section>
  );
}
