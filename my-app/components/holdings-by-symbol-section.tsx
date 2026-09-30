"use client";

import { cn } from "@/lib/utils";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { HoldingsAggRichTooltip } from "@/components/holdings-agg-rich-tooltip";
import { fmtInt } from "@/lib/format-money";
import { symbolAlertKey, type AlertThresholdsByKey } from "@/lib/alert-thresholds";
import { ALERT_RETURN_PCT_PRESETS, alertPctPresetBtnClass } from "@/lib/portfolio-alert-ui";
import { HoldingsAggTipRow } from "@/lib/portfolio-holdings-helpers";
import { type Dispatch, type SetStateAction } from "react";

export type HoldingsBySymbolSectionProps = {
  alertThresholdsByKey: AlertThresholdsByKey;
  holdingsAggregatedBySymbolSorted: { key: string; displaySymbol: string; displayName: string; symbolsForAlert: string[]; valueKrw: number; costKrw: number; pnlKrw: number; pnlPct: number | null; ownerCount: number; ownersLabel: string; ownerBreakdown: { owner: string; valueKrw: number; costKrw: number; pnlKrw: number; }[]; tooltipHeader: string; tooltipCompositionRows: HoldingsAggTipRow[]; tooltipOwnerValueRows: HoldingsAggTipRow[]; tooltipOwnerPnlRows: HoldingsAggTipRow[]; tooltipOwnersListRows: HoldingsAggTipRow[]; }[];
  holdingsAggSource: { key: string; displaySymbol: string; displayName: string; symbolsForAlert: string[]; valueKrw: number; costKrw: number; pnlKrw: number; pnlPct: number | null; ownerCount: number; ownersLabel: string; ownerBreakdown: { owner: string; valueKrw: number; costKrw: number; pnlKrw: number; }[]; tooltipHeader: string; tooltipCompositionRows: HoldingsAggTipRow[]; tooltipOwnerValueRows: HoldingsAggTipRow[]; tooltipOwnerPnlRows: HoldingsAggTipRow[]; tooltipOwnersListRows: HoldingsAggTipRow[]; }[];
  holdingsBySymbolSort: "name" | "valueKrw" | "pnlPct" | "pnlKrw" | "owners";
  holdingsBySymbolView: "ticker" | "chartGroup";
  holdingsSymbolGrandTotals: { valueKrw: number; costKrw: number; pnlKrw: number; pnlPct: number | null; };
  patchSymbolAlertPct: (symbolKeys: string[], field: "takeProfitReturnPct" | "stopLossReturnPct", value: number | undefined) => void;
  saveAllAlertThresholds: () => Promise<void>;
  savingAlertAll: boolean;
  setHoldingsBySymbolSort: Dispatch<SetStateAction<"name" | "valueKrw" | "pnlPct" | "pnlKrw" | "owners">>;
  setHoldingsBySymbolView: Dispatch<SetStateAction<"ticker" | "chartGroup">>;
  setShowAggAlertColumn: Dispatch<SetStateAction<boolean>>;
  showAggAlertColumn: boolean;
};

export function HoldingsBySymbolSection({
  alertThresholdsByKey,
  holdingsAggregatedBySymbolSorted,
  holdingsAggSource,
  holdingsBySymbolSort,
  holdingsBySymbolView,
  holdingsSymbolGrandTotals,
  patchSymbolAlertPct,
  saveAllAlertThresholds,
  savingAlertAll,
  setHoldingsBySymbolSort,
  setHoldingsBySymbolView,
  setShowAggAlertColumn,
  showAggAlertColumn,
}: HoldingsBySymbolSectionProps) {
  return (
    <div id="section-holdings-by-symbol" className="flex flex-col gap-4">
              <section className="min-w-0 overflow-hidden rounded-xl border border-slate-700/60 bg-slate-800/40 shadow-sm">
                <div className="border-b border-slate-700/60 px-4 py-3">
                  <h2 className="font-semibold text-slate-100">종목별 합산</h2>
                  <p className="mt-1 text-xs text-slate-400">
                    모든 보유자·계좌의 같은 종목을 합산한 평가액, 매입원가, 평가손익, 수익률(원화 기준)입니다.
                    익·손 <span className="text-slate-300">%</span>는 티커별로 모든 보유자에게 동일 적용됩니다.
                  </p>
                </div>
                <div className="flex flex-col gap-3 p-4 pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        showAggAlertColumn
                          ? "border-sky-500 bg-sky-500/25 text-sky-100"
                          : "border-slate-600 bg-slate-900/50 text-slate-300 hover:bg-slate-800/80",
                      )}
                      title="익·손 % 입력 열 표시/숨김"
                      onClick={() => setShowAggAlertColumn((v) => !v)}
                    >
                      기준선 {showAggAlertColumn ? "숨기기" : "열 표시"}
                    </button>
                    {showAggAlertColumn ? (
                      <button
                        type="button"
                        disabled={savingAlertAll}
                        className="rounded-md border border-sky-500/60 bg-sky-500/20 px-2 py-1 text-[11px] font-medium text-sky-100 transition-colors hover:bg-sky-500/30 disabled:opacity-50"
                        onClick={() => void saveAllAlertThresholds()}
                      >
                        {savingAlertAll ? "저장 중…" : "기준선 저장"}
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-medium text-slate-500">합산 기준</span>
                    <button
                      type="button"
                      onClick={() => setHoldingsBySymbolView("ticker")}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        holdingsBySymbolView === "ticker"
                          ? "border-sky-500 bg-sky-500/25 text-sky-100"
                          : "border-slate-600 bg-slate-900/50 text-slate-300 hover:bg-slate-800/80",
                      )}
                    >
                      티커별
                    </button>
                    <button
                      type="button"
                      onClick={() => setHoldingsBySymbolView("chartGroup")}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        holdingsBySymbolView === "chartGroup"
                          ? "border-sky-500 bg-sky-500/25 text-sky-100"
                          : "border-slate-600 bg-slate-900/50 text-slate-300 hover:bg-slate-800/80",
                      )}
                    >
                      차트 그룹별
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { key: "name" as const, label: "종목명순" },
                        { key: "valueKrw" as const, label: "평가액순" },
                        { key: "pnlPct" as const, label: "수익률순" },
                        { key: "pnlKrw" as const, label: "평가손익순" },
                        { key: "owners" as const, label: "보유자순" },
                      ] as const
                    ).map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setHoldingsBySymbolSort(key)}
                        className={cn(
                          "rounded-md border px-2 py-1 text-[11px] transition-colors",
                          holdingsBySymbolSort === key
                            ? "border-sky-500 bg-sky-500/25 text-sky-100"
                            : "border-slate-600 bg-slate-900/50 text-slate-300 hover:bg-slate-800/80",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="overflow-x-auto px-4 pb-4">
                  <Table className="min-w-[640px] text-xs">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead className="px-3 py-2">
                          {holdingsBySymbolView === "chartGroup" ? "그룹" : "티커"}
                        </TableHead>
                        <TableHead className="px-3 py-2">
                          {holdingsBySymbolView === "chartGroup" ? "구성 · 종목명" : "종목명"}
                        </TableHead>
                        <TableHead className="px-3 py-2 text-right tabular-nums">평가액</TableHead>
                        <TableHead className="px-3 py-2 text-right tabular-nums">매입원가</TableHead>
                        <TableHead className="px-3 py-2 text-right tabular-nums">평가손익</TableHead>
                        <TableHead className="px-3 py-2 text-right tabular-nums">수익률</TableHead>
                        {showAggAlertColumn ? (
                          <TableHead
                            className="w-[6.5rem] min-w-[6.5rem] max-w-[6.5rem] px-0.5 py-2 text-center text-[11px]"
                            title="티커별 공통 — 모든 보유자의 해당 종목 수익률에 적용"
                          >
                            기준선
                          </TableHead>
                        ) : null}
                        <TableHead className="px-3 py-2 text-center">보유자</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {holdingsAggSource.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={showAggAlertColumn ? 8 : 7}
                            className="px-3 py-8 text-center text-muted-foreground"
                          >
                            합산할 주식 보유가 없습니다.
                          </TableCell>
                        </TableRow>
                      ) : (
                        <>
                          {holdingsAggregatedBySymbolSorted.map((row) => (
                            <TableRow key={row.key}>
                              <TableCell
                                className={cn(
                                  "px-3 py-2 text-[11px]",
                                  holdingsBySymbolView === "chartGroup"
                                    ? "font-medium text-slate-200"
                                    : "font-mono",
                                )}
                              >
                                {row.displaySymbol}
                              </TableCell>
                              <TableCell className="max-w-[180px] px-3 py-2">
                                <HoldingsAggRichTooltip
                                  header={row.tooltipHeader}
                                  rows={row.tooltipCompositionRows}
                                  className="block max-w-full truncate"
                                >
                                  {row.displayName}
                                </HoldingsAggRichTooltip>
                              </TableCell>
                              <TableCell className="cursor-help px-3 py-2 text-right tabular-nums">
                                <HoldingsAggRichTooltip
                                  header={row.tooltipHeader}
                                  rows={row.tooltipOwnerValueRows}
                                  showPctColumn={false}
                                  mergePctIntoName
                                  codeMono={false}
                                  className="block"
                                >
                                  ₩{fmtInt(row.valueKrw)}
                                </HoldingsAggRichTooltip>
                              </TableCell>
                              <TableCell className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                ₩{fmtInt(row.costKrw)}
                              </TableCell>
                              <TableCell
                                className={`cursor-help px-3 py-2 text-right tabular-nums font-semibold ${
                                  row.pnlKrw >= 0 ? "text-red-600" : "text-blue-600"
                                }`}
                              >
                                <HoldingsAggRichTooltip
                                  header={row.tooltipHeader}
                                  rows={row.tooltipOwnerPnlRows}
                                  showPctColumn={false}
                                  mergePctIntoName
                                  codeMono={false}
                                  className="block"
                                >
                                  {row.pnlKrw >= 0 ? "+" : ""}₩{fmtInt(row.pnlKrw)}
                                </HoldingsAggRichTooltip>
                              </TableCell>
                              <TableCell
                                className={`px-3 py-2 text-right tabular-nums ${
                                  row.pnlPct !== null && row.pnlPct >= 0 ? "text-red-600" : "text-blue-600"
                                }`}
                              >
                                {row.pnlPct === null
                                  ? "—"
                                  : `${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%`}
                              </TableCell>
                              {showAggAlertColumn ? (
                              <TableCell
                                className="w-[6.5rem] min-w-[6.5rem] max-w-[6.5rem] px-0.5 py-1 align-top"
                                title={
                                  row.symbolsForAlert.length > 1
                                    ? `차트 그룹 내 ${row.symbolsForAlert.length}개 티커에 동일 % 적용`
                                    : "모든 보유자에게 동일 적용"
                                }
                              >
                                {(() => {
                                  const syms = row.symbolsForAlert;
                                  if (syms.length === 0) {
                                    return <span className="text-muted-foreground">—</span>;
                                  }
                                  const ar =
                                    alertThresholdsByKey[symbolAlertKey(syms[0])] ?? {};
                                  const inp =
                                    "h-6 w-full min-w-0 rounded-md border border-border bg-background px-1 text-right text-[11px] tabular-nums text-foreground placeholder:text-muted-foreground/50";
                                  const parseNum = (raw: string) => {
                                    const v = raw.trim();
                                    if (v === "") return undefined;
                                    const n = parseFloat(v.replace(/,/g, ""));
                                    return Number.isFinite(n) ? n : undefined;
                                  };
                                  return (
                                    <div className="grid grid-cols-[1.1rem_minmax(0,1fr)] items-start gap-x-0.5 gap-y-1 text-[10px] leading-tight">
                                      <span className="pt-1 text-[10px] font-medium text-muted-foreground">
                                        익
                                      </span>
                                      <div className="min-w-0 space-y-1">
                                        <input
                                          type="number"
                                          step="any"
                                          inputMode="decimal"
                                          aria-label={`${row.displaySymbol} 익절 수익률 퍼센트`}
                                          className={inp}
                                          placeholder="·"
                                          value={ar.takeProfitReturnPct ?? ""}
                                          onChange={(e) =>
                                            patchSymbolAlertPct(
                                              syms,
                                              "takeProfitReturnPct",
                                              parseNum(e.target.value),
                                            )
                                          }
                                        />
                                        <div className="flex gap-0.5">
                                          {ALERT_RETURN_PCT_PRESETS.map((pct) => (
                                            <button
                                              key={`agg-tp-${row.key}-${pct}`}
                                              type="button"
                                              className={alertPctPresetBtnClass(
                                                ar.takeProfitReturnPct === pct,
                                              )}
                                              title={`익절 ${pct}%`}
                                              onClick={() =>
                                                patchSymbolAlertPct(syms, "takeProfitReturnPct", pct)
                                              }
                                            >
                                              {pct}%
                                            </button>
                                          ))}
                                        </div>
                                      </div>
                                      <span className="pt-1 text-[10px] font-medium text-muted-foreground">
                                        손
                                      </span>
                                      <div className="min-w-0 space-y-1">
                                        <input
                                          type="number"
                                          step="any"
                                          inputMode="decimal"
                                          aria-label={`${row.displaySymbol} 손절 수익률 퍼센트`}
                                          className={inp}
                                          placeholder="·"
                                          value={ar.stopLossReturnPct ?? ""}
                                          onChange={(e) =>
                                            patchSymbolAlertPct(
                                              syms,
                                              "stopLossReturnPct",
                                              parseNum(e.target.value),
                                            )
                                          }
                                        />
                                        <div className="flex gap-0.5">
                                          {ALERT_RETURN_PCT_PRESETS.map((pct) => (
                                            <button
                                              key={`agg-sl-${row.key}-${pct}`}
                                              type="button"
                                              className={alertPctPresetBtnClass(
                                                ar.stopLossReturnPct === -pct,
                                              )}
                                              title={`손절 -${pct}%`}
                                              onClick={() =>
                                                patchSymbolAlertPct(syms, "stopLossReturnPct", -pct)
                                              }
                                            >
                                              -{pct}%
                                            </button>
                                          ))}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })()}
                              </TableCell>
                              ) : null}
                              <TableCell
                                className="cursor-help px-3 py-2 text-center text-[11px] text-muted-foreground"
                              >
                                <HoldingsAggRichTooltip
                                  header={row.tooltipHeader}
                                  rows={row.tooltipOwnersListRows}
                                  showPctColumn={false}
                                  codeMono={false}
                                  className="inline-block"
                                >
                                  {row.ownerCount}명
                                </HoldingsAggRichTooltip>
                              </TableCell>
                            </TableRow>
                          ))}
                          <TableRow className="border-t-2 border-border bg-muted/30 font-semibold">
                            <TableCell colSpan={2} className="px-3 py-2.5">
                              합계 (주식만)
                            </TableCell>
                            <TableCell className="px-3 py-2.5 text-right tabular-nums">
                              ₩{fmtInt(holdingsSymbolGrandTotals.valueKrw)}
                            </TableCell>
                            <TableCell className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                              ₩{fmtInt(holdingsSymbolGrandTotals.costKrw)}
                            </TableCell>
                            <TableCell
                              className={`px-3 py-2.5 text-right tabular-nums ${
                                holdingsSymbolGrandTotals.pnlKrw >= 0 ? "text-red-600" : "text-blue-600"
                              }`}
                            >
                              {holdingsSymbolGrandTotals.pnlKrw >= 0 ? "+" : ""}₩
                              {fmtInt(holdingsSymbolGrandTotals.pnlKrw)}
                            </TableCell>
                            <TableCell
                              className={`px-3 py-2.5 text-right tabular-nums ${
                                holdingsSymbolGrandTotals.pnlPct !== null && holdingsSymbolGrandTotals.pnlPct >= 0
                                  ? "text-red-600"
                                  : "text-blue-600"
                              }`}
                            >
                              {holdingsSymbolGrandTotals.pnlPct === null
                                ? "—"
                                : `${holdingsSymbolGrandTotals.pnlPct >= 0 ? "+" : ""}${holdingsSymbolGrandTotals.pnlPct.toFixed(2)}%`}
                            </TableCell>
                            {showAggAlertColumn ? (
                              <TableCell className="px-0.5 py-2.5 text-center text-muted-foreground">—</TableCell>
                            ) : null}
                            <TableCell className="px-3 py-2.5 text-center text-muted-foreground">—</TableCell>
                          </TableRow>
                        </>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </section>
            </div>
  );
}
