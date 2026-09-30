"use client";

import { calcSellRealizedKrw } from "@/lib/portfolio-calc";
import { fmtInt } from "@/lib/format-money";
import { SellLogEntry } from "@/lib/portfolio-types";
import { type Dispatch, type SetStateAction } from "react";

export type SellLogDetailModalProps = {
  sellLog: Record<string, SellLogEntry[]>;
  sellLogDetailOpenOwner: string | null;
  sellLogOwnersForModal: string[];
  setSellLogDetailOpenOwner: Dispatch<SetStateAction<string | null>>;
};

export function SellLogDetailModal({
  sellLog,
  sellLogDetailOpenOwner,
  sellLogOwnersForModal,
  setSellLogDetailOpenOwner,
}: SellLogDetailModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-xl border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <p className="text-sm font-semibold">보유자별 매도 기록 전체 보기</p>
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => setSellLogDetailOpenOwner(null)}
              >
                닫기
              </button>
            </div>
            <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4">
              {sellLogOwnersForModal.map((name) => {
                const rows = [...(sellLog[name] ?? [])].sort((a, b) => b.date.localeCompare(a.date));
                const ownerTotal = rows.reduce((s, r) => s + calcSellRealizedKrw(r), 0);
                return (
                  <div
                    key={name}
                    className={`rounded-lg border p-3 ${name === sellLogDetailOpenOwner ? "border-primary" : ""}`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold">보유자: {name}</p>
                      <span className={`text-xs font-bold ${ownerTotal > 0 ? "text-red-500" : ownerTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                        누적: {ownerTotal >= 0 ? "+" : ""}₩{fmtInt(ownerTotal)}
                      </span>
                    </div>
                    {rows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">입력된 매도 기록이 없습니다.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="py-1 pr-2 text-left font-medium">날짜</th>
                              <th className="py-1 pr-2 text-left font-medium">종목</th>
                              <th className="py-1 pr-2 text-right font-medium">수량</th>
                              <th className="py-1 pr-2 text-right font-medium">매도가</th>
                              <th className="py-1 pr-2 text-right font-medium">평단가</th>
                              <th className="py-1 pr-2 text-right font-medium">환율</th>
                              <th className="py-1 pr-2 text-right font-medium">실현손익</th>
                              <th className="py-1 text-left font-medium">메모</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((e) => (
                              <tr key={e.id} className="border-b border-border/30 last:border-0">
                                <td className="py-1 pr-2 tabular-nums">{e.date}</td>
                                <td className="py-1 pr-2">{e.name} ({e.symbol})</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{e.qty}</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{e.sellPrice}</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{e.avgPrice}</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{e.currency === "KRW" ? "1" : e.fxRate}</td>
                                <td className={`py-1 pr-2 text-right tabular-nums font-semibold ${calcSellRealizedKrw(e) > 0 ? "text-red-500" : calcSellRealizedKrw(e) < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                  {calcSellRealizedKrw(e) >= 0 ? "+" : ""}₩{fmtInt(calcSellRealizedKrw(e))}
                                </td>
                                <td className="py-1 text-muted-foreground">{e.note ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
  );
}
