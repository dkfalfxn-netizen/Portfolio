"use client";

import { sortHoldingsItems, buildHoldingsGroupBlocks, HoldingsSortMode } from "@/lib/portfolio-storage";
import { cn } from "@/lib/utils";
import { type UseQueryResult } from "@tanstack/react-query";
import { type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { fmtInt, fmtUsdNumber, parseKoreanIntDigits, signedPnlTextClass, MONEY_INT_LOCALE } from "@/lib/format-money";
import { formatKrwApproxAsUsd, formatPositionMarketValueForeign, CashByOwner } from "@/lib/portfolio-positions";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableTr, SortableOrStaticTableRow } from "@/components/table-sortable-row";
import { UsdCashInput } from "@/components/usd-cash-input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Fragment, type Dispatch, type SetStateAction } from "react";
import { GripVertical } from "lucide-react";
import { IntradaySparkline } from "@/components/intraday-sparkline";
import { LivePriceCell } from "@/components/live-price-cell";
import { positionAlertKey, type AlertThresholdsByKey } from "@/lib/alert-thresholds";
import { PurchaseFxCell } from "@/components/purchase-fx-cell";
import { SellLogEntry, BuyJournalEntry, HistoryResponse, MarketResponse, Position, OwnerName } from "@/lib/portfolio-types";
import { type TradeSignal } from "@/lib/signals";

export type HoldingsSectionProps = {
  alertThresholdsByKey: AlertThresholdsByKey;
  buyJournal: BuyJournalEntry[];
  cancelEditRow: () => void;
  editAvgPrice: string;
  editChartGroup: string;
  editingRowIndex: number | null;
  editName: string;
  editPurchaseEurKrw: string;
  editPurchaseUsdKrw: string;
  editQuantity: string;
  editSymbol: string;
  eurKrw: number;
  handleDeleteRow: (rowIndex: number) => void;
  historyQuery: UseQueryResult<HistoryResponse, Error>;
  holdingsDndSensors: SensorDescriptor<SensorOptions>[];
  holdingsSortByOwner: Record<string, HoldingsSortMode>;
  holdingsSummaryCollapsed: Record<string, boolean>;
  holdingsViewOwner: string | null;
  marketQuery: UseQueryResult<MarketResponse, Error>;
  moveRow: (rowIndex: number, direction: "up" | "down") => void;
  ownerNames: string[];
  patchPositionAlertPrice: (positionKey: string, field: "takeProfitPrice" | "stopLossPrice", value: number | undefined) => void;
  pendingConfirm: { type: "edit" | "delete"; rowIndex: number; position: Position; } | null;
  pendingSaveConfirm: boolean;
  positions: Position[];
  positionsByOwnerForTab: { ownerName: string; items: { sourceIndex: number; currentPrice: number; previousClose: number | null; pnl: number; valueKrw: number; costKrw: number; purchaseFxUsed: number; pnlUsdPct: number | null; pnlEurPct: number | null; pnlKrwEquityPct: number | null; marketState: "REGULAR" | "PRE" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED" | null; symbol: string; name: string; quantity: number; avgPrice: number; currency: "USD" | "EUR" | "KRW"; purchaseUsdKrw?: number; purchaseEurKrw?: number; purchaseDate?: string; purchaseFxPending?: boolean; purchaseFxAtAdd?: number; accountType: "\uD574\uC678\uC8FC\uC2DD" | "\uAD6D\uB0B4\uC8FC\uC2DD"; accountName: string; owner: OwnerName; chartGroup?: string; }[]; sectionStockValue: number; sectionStockCost: number; sectionCashKrw: number; sectionTotal: number; sectionCostBasis: number; sectionPnL: number; sectionPnLPct: number; cashUsd: number; cashKrw: number; }[];
  reorderHoldingsDrag: (owner: string, e: DragEndEvent) => void;
  saveAlertThresholdsForOwner: (ownerName: string) => Promise<void>;
  saveEditRow: () => void;
  savingAlertOwner: string | null;
  sellLog: Record<string, SellLogEntry[]>;
  sellLogErrorByOwner: Record<string, string>;
  sellLogForm: Record<string, { date: string; symbol: string; name: string; qty: string; sellPrice: string; avgPrice: string; currency: "USD" | "EUR" | "KRW"; fxRate: string; note: string; selectedOwners: string[]; ownerOverrides: Record<string, { qty: string; avgPrice: string; fxRate: string; }>; editingId: string | null; }>;
  setCashByOwner: Dispatch<SetStateAction<CashByOwner>>;
  setEditAvgPrice: Dispatch<SetStateAction<string>>;
  setEditChartGroup: Dispatch<SetStateAction<string>>;
  setEditName: Dispatch<SetStateAction<string>>;
  setEditPurchaseEurKrw: Dispatch<SetStateAction<string>>;
  setEditPurchaseUsdKrw: Dispatch<SetStateAction<string>>;
  setEditQuantity: Dispatch<SetStateAction<string>>;
  setEditSymbol: Dispatch<SetStateAction<string>>;
  setHoldingsSortByOwner: Dispatch<SetStateAction<Record<string, HoldingsSortMode>>>;
  setHoldingsSummaryCollapsed: Dispatch<SetStateAction<Record<string, boolean>>>;
  setPendingConfirm: Dispatch<SetStateAction<{ type: "edit" | "delete"; rowIndex: number; position: Position; } | null>>;
  setPendingSaveConfirm: Dispatch<SetStateAction<boolean>>;
  setSellLog: Dispatch<SetStateAction<Record<string, SellLogEntry[]>>>;
  setSellLogDetailOpenOwner: Dispatch<SetStateAction<string | null>>;
  setSellLogErrorByOwner: Dispatch<SetStateAction<Record<string, string>>>;
  setSellLogForm: Dispatch<SetStateAction<Record<string, { date: string; symbol: string; name: string; qty: string; sellPrice: string; avgPrice: string; currency: "USD" | "EUR" | "KRW"; fxRate: string; note: string; selectedOwners: string[]; ownerOverrides: Record<string, { qty: string; avgPrice: string; fxRate: string; }>; editingId: string | null; }>>>;
  setShowHoldingsAlertColumn: Dispatch<SetStateAction<boolean>>;
  setShowSymbolPnl: Dispatch<SetStateAction<Record<string, boolean>>>;
  setSignalDetailTarget: Dispatch<SetStateAction<{ symbol: string; name: string; } | null>>;
  showActionSuccessToast: (message: string) => void;
  showHoldingsAlertColumn: boolean;
  showSymbolPnl: Record<string, boolean>;
  signalBySymbol: Map<string, { final: TradeSignal; ma: TradeSignal; rsi: TradeSignal; bb: TradeSignal; vol: TradeSignal; }>;
  startEditRow: (p: Position, rowIndex: number) => void;
  usdKrw: number;
};

export function HoldingsSection({
  alertThresholdsByKey,
  buyJournal,
  cancelEditRow,
  editAvgPrice,
  editChartGroup,
  editingRowIndex,
  editName,
  editPurchaseEurKrw,
  editPurchaseUsdKrw,
  editQuantity,
  editSymbol,
  eurKrw,
  handleDeleteRow,
  historyQuery,
  holdingsDndSensors,
  holdingsSortByOwner,
  holdingsSummaryCollapsed,
  holdingsViewOwner,
  marketQuery,
  moveRow,
  ownerNames,
  patchPositionAlertPrice,
  pendingConfirm,
  pendingSaveConfirm,
  positions,
  positionsByOwnerForTab,
  reorderHoldingsDrag,
  saveAlertThresholdsForOwner,
  saveEditRow,
  savingAlertOwner,
  sellLog,
  sellLogErrorByOwner,
  sellLogForm,
  setCashByOwner,
  setEditAvgPrice,
  setEditChartGroup,
  setEditName,
  setEditPurchaseEurKrw,
  setEditPurchaseUsdKrw,
  setEditQuantity,
  setEditSymbol,
  setHoldingsSortByOwner,
  setHoldingsSummaryCollapsed,
  setPendingConfirm,
  setPendingSaveConfirm,
  setSellLog,
  setSellLogDetailOpenOwner,
  setSellLogErrorByOwner,
  setSellLogForm,
  setShowHoldingsAlertColumn,
  setShowSymbolPnl,
  setSignalDetailTarget,
  showActionSuccessToast,
  showHoldingsAlertColumn,
  showSymbolPnl,
  signalBySymbol,
  startEditRow,
  usdKrw,
}: HoldingsSectionProps) {
  return (
    <div id="section-holdings" className="flex flex-col gap-4">
          <section className="min-w-0 flex-1 overflow-hidden rounded-xl border border-slate-700/60 bg-slate-800/40 shadow-sm">
            <div className="border-b border-slate-700/60 px-4 py-3">
              <h2 className="flex flex-wrap items-center gap-2 font-semibold text-slate-100">
                보유 포지션
                <span className="rounded-full bg-slate-700/80 px-2 py-0.5 text-xs font-normal text-slate-300 tabular-nums">
                  {holdingsViewOwner
                    ? positionsByOwnerForTab.reduce((a, g) => a + g.items.length, 0)
                    : positions.length}
                </span>
                <span className="text-xs font-normal text-slate-500">(가족·퇴직연금)</span>
              </h2>
            </div>
            <div className="space-y-5 p-4">
              {positionsByOwnerForTab.map((group) => {
                const sortMode = holdingsSortByOwner[group.ownerName] ?? "manual";
                const displayItems = sortHoldingsItems(group.items, sortMode);
                const holdingsGroupBlocks = buildHoldingsGroupBlocks(displayItems);
                const sortBtn = (mode: HoldingsSortMode, label: string) => (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                      sortMode === mode
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background hover:bg-muted"
                    }`}
                    onClick={() =>
                      setHoldingsSortByOwner((prev) => ({
                        ...prev,
                        [group.ownerName]: mode,
                      }))
                    }
                  >
                    {label}
                  </button>
                );
                return (
                <div key={group.ownerName} id={`owner-${group.ownerName}`} className="rounded-xl border-2 border-border/70 shadow-sm">
                  <div className="flex flex-col gap-2 border-b bg-muted/30 px-4 py-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-2">
                      <p className="font-semibold">보유자({group.ownerName})</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">정렬</span>
                        {sortBtn("manual", "입력 순")}
                        {sortBtn("valueAsc", "평가금액 ↑")}
                        {sortBtn("valueDesc", "평가금액 ↓")}
                        {sortBtn("group", "그룹별")}
                        <button
                          type="button"
                          className={cn(
                            "rounded-md border px-2 py-1 text-[11px] transition-colors",
                            showHoldingsAlertColumn
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background hover:bg-muted",
                          )}
                          title="익절·손절 가격·수익률 % 입력 열 표시/숨김"
                          onClick={() => setShowHoldingsAlertColumn((v) => !v)}
                        >
                          기준선 {showHoldingsAlertColumn ? "숨기기" : "열 표시"}
                        </button>
                        {showHoldingsAlertColumn ? (
                          <button
                            type="button"
                            disabled={savingAlertOwner === group.ownerName}
                            title="이 보유자 표에 입력한 익절·손절 기준을 서버에 저장"
                            className="rounded-md border border-primary bg-primary/15 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-50"
                            onClick={() => void saveAlertThresholdsForOwner(group.ownerName)}
                          >
                            {savingAlertOwner === group.ownerName ? "저장 중…" : "기준선 저장"}
                          </button>
                        ) : null}
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        입력 순은 ⋮ 드래그 또는 ▲▼로 저장됩니다. 다른 정렬일 때는 순서 변경이 비활성화됩니다. 표는
                        차트 그룹(미입력 시 티커)별로 묶여 보입니다.
                        {showHoldingsAlertColumn ? (
                          <span className="text-muted-foreground/90">
                            {" "}
                            「익·손 가격」열: 보유자별 가격만. 익·손 %는 「종목별 합산」 탭에서 티커 공통. 가격·% 여러 칸은 OR.
                          </span>
                        ) : (
                          <span className="text-muted-foreground/90">
                            {" "}
                            가격 입력은 「기준선 열 표시」 후 보유 표에, %는 「종목별 합산」 탭에서 입력합니다.
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="max-w-md space-y-1 text-right text-sm">
                      <p className="text-xs text-muted-foreground">
                        총 매입{" "}
                        <span className="font-medium tabular-nums text-foreground">
                          ₩{fmtInt(group.sectionCostBasis)}
                        </span>
                        <span className="hidden sm:inline">
                          {" "}
                          (주식 원가 ₩{fmtInt(group.sectionStockCost)} · 현금 ₩
                          {fmtInt(group.sectionCashKrw)})
                        </span>
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-foreground">
                        ≈ {formatKrwApproxAsUsd(group.sectionTotal, usdKrw)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">(USD)</span>
                      </p>
                      <p className="font-semibold tabular-nums">
                        총 평가(주식+현금) ₩{fmtInt(group.sectionTotal)}
                      </p>
                      <p
                        className={`text-sm font-semibold tabular-nums ${
                          group.sectionPnL >= 0 ? "text-red-600" : "text-blue-600"
                        }`}
                      >
                        평가손익 {group.sectionPnL >= 0 ? "+" : ""}₩
                        {fmtInt(group.sectionPnL)} (
                        {group.sectionPnL >= 0 ? "+" : ""}
                        {group.sectionPnLPct.toFixed(2)}%)
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        주식 평가 ₩{fmtInt(group.sectionStockValue)}
                        <span className="hidden sm:inline">
                          {" "}
                          · 현금 ₩{fmtInt(group.sectionCashKrw)} (USD{" "}
                          {fmtUsdNumber(group.cashUsd, 2, 2)} / KRW {fmtInt(group.cashKrw)})
                        </span>
                      </p>
                    </div>
                  </div>
                  {/* ── 심플 종목 요약 테이블 ── */}
                  {(() => {
                    const collapsed = holdingsSummaryCollapsed[group.ownerName] ?? true;
                    const isManual = sortMode === "manual";
                    return (
                      <div className="border-b">
                        {/* 헤더 토글 버튼 */}
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/20"
                          onClick={() =>
                            setHoldingsSummaryCollapsed((prev) => ({
                              ...prev,
                              [group.ownerName]: !collapsed,
                            }))
                          }
                        >
                          <span>{collapsed ? "▶" : "▼"}</span>
                          <span>보유 종목 {displayItems.length}개</span>
                          {!collapsed && isManual && (
                            <span className="ml-1 text-[10px] text-muted-foreground/60">⋮ 드래그로 순서 변경</span>
                          )}
                          {!collapsed && !isManual && (
                            <span className="ml-1 text-[10px] text-muted-foreground/60">(순서 변경은 「입력 순」 정렬에서 가능)</span>
                          )}
                        </button>
                        {!collapsed && (
                          <div className="overflow-x-auto px-4 pb-3">
                            {isManual ? (
                              <DndContext
                                sensors={holdingsDndSensors}
                                collisionDetection={closestCenter}
                                onDragEnd={(e) => {
                                  reorderHoldingsDrag(group.ownerName, e);
                                  showActionSuccessToast("순서가 저장되었습니다.");
                                }}
                              >
                                <SortableContext
                                  items={displayItems.map((p) => p.sourceIndex)}
                                  strategy={verticalListSortingStrategy}
                                >
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b text-muted-foreground">
                                        <th className="w-5 py-1 pr-1" />
                                        <th className="py-1 pr-3 text-left font-medium">종목명</th>
                                        <th className="py-1 pr-3 text-left font-medium text-muted-foreground/70">티커</th>
                                        <th className="py-1 text-right font-medium">수량</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {displayItems.map((position) => (
                                        <SortableTr
                                          key={position.sourceIndex}
                                          id={position.sourceIndex}
                                          className="border-b border-border/30 last:border-0"
                                        >
                                          {({ attributes, listeners }) => (
                                            <>
                                              <td className="py-1 pr-1 text-muted-foreground/50">
                                                <span
                                                  {...attributes}
                                                  {...listeners}
                                                  className="cursor-grab touch-none select-none active:cursor-grabbing"
                                                  title="드래그로 순서 변경"
                                                >⋮</span>
                                              </td>
                                              <td className="py-1 pr-3 font-medium">{position.name}</td>
                                              <td className="py-1 pr-3 font-mono text-muted-foreground">{position.symbol}</td>
                                              <td className="py-1 text-right tabular-nums">
                                                {position.quantity % 1 === 0
                                                  ? fmtInt(position.quantity)
                                                  : position.quantity.toFixed(4).replace(/\.?0+$/, "")}
                                              </td>
                                            </>
                                          )}
                                        </SortableTr>
                                      ))}
                                    </tbody>
                                  </table>
                                </SortableContext>
                              </DndContext>
                            ) : (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b text-muted-foreground">
                                    <th className="py-1 pr-3 text-left font-medium">종목명</th>
                                    <th className="py-1 pr-3 text-left font-medium text-muted-foreground/70">티커</th>
                                    <th className="py-1 text-right font-medium">수량</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {displayItems.map((position) => (
                                    <tr key={position.sourceIndex} className="border-b border-border/30 last:border-0">
                                      <td className="py-1 pr-3 font-medium">{position.name}</td>
                                      <td className="py-1 pr-3 font-mono text-muted-foreground">{position.symbol}</td>
                                      <td className="py-1 text-right tabular-nums">
                                        {position.quantity % 1 === 0
                                          ? fmtInt(position.quantity)
                                          : position.quantity.toFixed(4).replace(/\.?0+$/, "")}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <div className="flex flex-wrap items-end gap-3 border-b bg-muted/10 px-4 py-2 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">현금</span>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-muted-foreground">USD</span>
                      <UsdCashInput
                        value={group.cashUsd}
                        onChange={(usd) =>
                          setCashByOwner((prev) => ({
                            ...prev,
                            [group.ownerName]: {
                              ...prev[group.ownerName],
                              usd,
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-muted-foreground">KRW</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        className="w-36 min-w-0 rounded-md border bg-background px-2 py-1.5 text-right tabular-nums"
                        placeholder="0"
                        value={group.cashKrw === 0 ? "" : fmtInt(group.cashKrw)}
                        onChange={(e) => {
                          const krw = parseKoreanIntDigits(e.target.value);
                          setCashByOwner((prev) => ({
                            ...prev,
                            [group.ownerName]: {
                              ...prev[group.ownerName],
                              krw,
                            },
                          }));
                        }}
                      />
                    </label>
                  </div>
                  <Table className="min-w-full text-xs">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead className="px-3 py-1.5">종목</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">평가금액</TableHead>
                        <TableHead
                          className="w-[72px] px-1 py-1.5 text-center"
                          title="당일 분봉 기준 가격 흐름"
                        >
                          일중
                        </TableHead>
                        <TableHead className="px-3 py-1.5 text-right">현재가</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">수량</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">수익률</TableHead>
                        {showHoldingsAlertColumn ? (
                          <TableHead
                            className="px-3 py-1.5 text-center"
                            title="보유자별 익절·손절 가격(현재가와 같은 통화). %는 종목별 합산 표에서 입력."
                          >
                            익·손 가격
                          </TableHead>
                        ) : null}
                        <TableHead className="px-3 py-1.5 text-center">시그널</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">평단가</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">매입환율</TableHead>
                        <TableHead className="px-3 py-1.5 w-[140px]">수정/삭제</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {displayItems.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={showHoldingsAlertColumn ? 11 : 10}
                            className="px-3 py-4 text-center text-xs text-muted-foreground"
                          >
                            등록된 종목이 없습니다.
                          </TableCell>
                        </TableRow>
                      ) : (
                        (() => {
                          const blockRows = holdingsGroupBlocks.map((block) => {
                          // 오늘 등락
                          const groupDailyChangeKrw = block.items.reduce((sum, p) => {
                            if (p.previousClose === null) return sum;
                            const diff = p.currentPrice - p.previousClose;
                            const krw =
                              p.currency === "USD" ? diff * p.quantity * usdKrw
                              : p.currency === "EUR" ? diff * p.quantity * eurKrw
                              : diff * p.quantity;
                            return sum + krw;
                          }, 0);
                          const prevSumKrw = block.items.reduce((sum, p) => {
                            if (p.previousClose === null) return sum;
                            const v =
                              p.currency === "USD" ? p.previousClose * p.quantity * usdKrw
                              : p.currency === "EUR" ? p.previousClose * p.quantity * eurKrw
                              : p.previousClose * p.quantity;
                            return sum + v;
                          }, 0);
                          const hasChange = prevSumKrw > 0;
                          const groupDailyChangePct = hasChange ? (groupDailyChangeKrw / prevSumKrw) * 100 : null;
                          // 총 수익
                          const groupCostKrw = block.items.reduce((sum, p) => sum + p.costKrw, 0);
                          const groupTotalPnlKrw = block.sumKrw - groupCostKrw;
                          const groupTotalPnlPct = groupCostKrw > 0 ? (groupTotalPnlKrw / groupCostKrw) * 100 : null;
                          return (
                          <Fragment key={`${group.ownerName}-${block.label}`}>
                            <TableRow className="border-y border-border hover:bg-transparent">
                              <TableCell colSpan={showHoldingsAlertColumn ? 11 : 10} className="px-0 py-0">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-l-4 border-primary/70 bg-primary/[0.07] px-3 py-2">
                                  <span className="text-base font-bold tracking-wide text-foreground">
                                    {block.label}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    {/* 오늘 등락 */}
                                    {hasChange && (
                                      <span className={`text-xs tabular-nums font-semibold ${groupDailyChangeKrw > 0 ? "text-red-400" : groupDailyChangeKrw < 0 ? "text-blue-400" : "text-muted-foreground"}`}>
                                        오늘 {groupDailyChangeKrw > 0 ? "+" : ""}
                                        {fmtInt(groupDailyChangeKrw)}원
                                        {groupDailyChangePct !== null && (
                                          <span className="ml-0.5 opacity-80">
                                            ({groupDailyChangePct > 0 ? "+" : ""}{groupDailyChangePct.toFixed(2)}%)
                                          </span>
                                        )}
                                      </span>
                                    )}
                                    {/* 총 수익 */}
                                    {groupTotalPnlPct !== null && (
                                      <span className={`text-xs tabular-nums font-semibold ${groupTotalPnlKrw > 0 ? "text-red-400" : groupTotalPnlKrw < 0 ? "text-blue-400" : "text-muted-foreground"}`}>
                                        총 {groupTotalPnlKrw > 0 ? "+" : ""}
                                        {fmtInt(groupTotalPnlKrw)}원
                                        <span className="ml-0.5 opacity-80">
                                          ({groupTotalPnlPct > 0 ? "+" : ""}{groupTotalPnlPct.toFixed(2)}%)
                                        </span>
                                      </span>
                                    )}
                                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums font-medium text-muted-foreground">
                                      합계 ₩{fmtInt(block.sumKrw)}
                                    </span>
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                            {block.items.map((position) => {
                              const posIdx = displayItems.indexOf(position);
                              const rowIndex = position.sourceIndex;
                              const rowKey = `${group.ownerName}-${position.symbol}-${rowIndex}`;
                              const isEditing = editingRowIndex === rowIndex;
                              const foreignMarketValue = formatPositionMarketValueForeign(position);
                              return (
                        <SortableOrStaticTableRow
                          manual={sortMode === "manual"}
                          id={position.sourceIndex}
                          key={rowKey}
                          disabled={sortMode === "manual" && isEditing}
                          className="group/row"
                        >
                          {(drag) => (
                          <>
                          <TableCell className="px-3 py-1.5">
                            <div className="flex items-start gap-1">
                              {sortMode === "manual" && !isEditing && drag ? (
                                <button
                                  type="button"
                                  className="touch-none mt-0.5 inline-flex shrink-0 cursor-grab rounded p-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
                                  title="순서 이동 (드래그)"
                                  aria-label={`${position.name ?? position.symbol} 순서 변경`}
                                  {...drag.attributes}
                                  {...drag.listeners}
                                >
                                  <GripVertical className="h-4 w-4 opacity-70" />
                                </button>
                              ) : null}
                              <div className="min-w-0 flex-1">
                            {isEditing ? (
                              <div className="flex flex-col gap-1">
                                <input
                                  className="w-24 rounded-md border bg-background px-2 py-1 text-sm font-medium"
                                  placeholder="티커"
                                  value={editSymbol}
                                  onChange={(e) => setEditSymbol(e.target.value)}
                                />
                                <input
                                  className="w-40 rounded-md border bg-background px-2 py-1.5 text-sm font-medium text-foreground"
                                  placeholder="종목명"
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                />
                                <input
                                  className="w-32 rounded-md border bg-background px-2 py-1 text-xs"
                                  placeholder="차트 그룹 (선택)"
                                  value={editChartGroup}
                                  onChange={(e) => setEditChartGroup(e.target.value)}
                                  list="holdings-chart-group-presets"
                                  autoComplete="off"
                                />
                              </div>
                            ) : (
                              <>
                                <p className="text-sm font-semibold leading-snug text-foreground">
                                  {position.name}
                                </p>
                                <p className="text-[11px] text-muted-foreground">{position.symbol}</p>
                              </>
                            )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right align-top">
                            <p className="text-[16px] font-semibold tabular-nums leading-none">
                              ₩{fmtInt(position.valueKrw)}
                            </p>
                            {foreignMarketValue ? (
                              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                                {foreignMarketValue}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="px-2 py-1.5 align-middle">
                            <div className="flex justify-center">
                              <IntradaySparkline
                                points={marketQuery.data?.intraday?.[position.symbol] ?? []}
                              />
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-1.5 align-top">
                            <LivePriceCell
                              currency={position.currency}
                              price={position.currentPrice}
                              previousClose={position.previousClose}
                              marketState={position.marketState}
                              krwLine={
                                position.currency === "USD"
                                  ? `₩${fmtInt(
                                      position.currentPrice * usdKrw,
                                    )}`
                                  : position.currency === "EUR"
                                    ? `₩${fmtInt(
                                        position.currentPrice * eurKrw,
                                      )}`
                                    : undefined
                              }
                            />
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right">
                            {isEditing ? (
                              <input
                                type="number"
                                min="0.000001"
                                step="any"
                                className="w-24 rounded-md border bg-background px-2 py-1 text-right text-sm"
                                value={editQuantity}
                                onChange={(e) => setEditQuantity(e.target.value)}
                              />
                            ) : (
                              position.quantity
                            )}
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right font-semibold">
                            {(position.currency === "USD" || position.currency === "EUR") &&
                            position.pnlKrwEquityPct != null &&
                            (position.currency === "USD"
                              ? position.pnlUsdPct != null
                              : position.pnlEurPct != null) ? (
                              <div className="flex flex-col items-end gap-0.5 leading-tight">
                                {(() => {
                                  const fxPct =
                                    position.currency === "USD"
                                      ? position.pnlUsdPct!
                                      : position.pnlEurPct!;
                                  const krwPct = position.pnlKrwEquityPct!;
                                  const krwAmt = position.valueKrw - position.costKrw;
                                  return (
                                    <>
                                      <span className={signedPnlTextClass(fxPct)}>
                                        {position.currency === "USD" ? "USD" : "EUR"}{" "}
                                        {fxPct >= 0 ? "+" : ""}
                                        {fxPct.toFixed(2)}%
                                      </span>
                                      <span
                                        className={cn(
                                          "text-xs font-normal opacity-90",
                                          signedPnlTextClass(krwPct),
                                        )}
                                      >
                                        원화 {krwPct >= 0 ? "+" : ""}
                                        {krwPct.toFixed(2)}%
                                      </span>
                                      <span
                                        className={cn(
                                          "text-xs font-normal opacity-75",
                                          signedPnlTextClass(krwAmt),
                                        )}
                                      >
                                        {krwAmt >= 0 ? "+" : ""}₩{fmtInt(krwAmt)}
                                      </span>
                                    </>
                                  );
                                })()}
                              </div>
                            ) : (
                              <div className="flex flex-col items-end gap-0.5 leading-tight">
                                {(() => {
                                  const krwAmt = position.valueKrw - position.costKrw;
                                  return (
                                    <>
                                      <span className={signedPnlTextClass(position.pnl)}>
                                        {position.pnl >= 0 ? "+" : ""}
                                        {position.pnl.toFixed(2)}%
                                      </span>
                                      <span
                                        className={cn(
                                          "text-xs font-normal opacity-75",
                                          signedPnlTextClass(krwAmt),
                                        )}
                                      >
                                        {krwAmt >= 0 ? "+" : ""}₩{fmtInt(krwAmt)}
                                      </span>
                                    </>
                                  );
                                })()}
                              </div>
                            )}
                          </TableCell>
                          {showHoldingsAlertColumn ? (
                          <TableCell
                            className="min-w-[4.5rem] max-w-[5.5rem] px-1 py-1 align-top"
                            title="보유자별 익절·손절 가격(현재가와 같은 통화). %는 종목별 합산 표."
                          >
                            {(() => {
                              const alertPk = positionAlertKey(position.owner, position.symbol);
                              const ar = alertThresholdsByKey[alertPk] ?? {};
                              const inp =
                                "h-6 w-full min-w-0 rounded border border-border bg-background px-1 text-right text-[10px] tabular-nums text-foreground placeholder:text-muted-foreground/50";
                              const parseNum = (raw: string) => {
                                const v = raw.trim();
                                if (v === "") return undefined;
                                const n = parseFloat(v.replace(/,/g, ""));
                                return Number.isFinite(n) ? n : undefined;
                              };
                              return (
                                <div className="grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-0.5 gap-y-0.5 text-[9px] leading-tight">
                                  <span className="text-muted-foreground">익가</span>
                                  <input
                                    type="number"
                                    step="any"
                                    inputMode="decimal"
                                    aria-label={`${position.name} 익절가`}
                                    className={inp}
                                    placeholder="·"
                                    value={ar.takeProfitPrice ?? ""}
                                    onChange={(e) =>
                                      patchPositionAlertPrice(alertPk, "takeProfitPrice", parseNum(e.target.value))
                                    }
                                  />
                                  <span className="text-muted-foreground">손가</span>
                                  <input
                                    type="number"
                                    step="any"
                                    inputMode="decimal"
                                    aria-label={`${position.name} 손절가`}
                                    className={inp}
                                    placeholder="·"
                                    value={ar.stopLossPrice ?? ""}
                                    onChange={(e) =>
                                      patchPositionAlertPrice(alertPk, "stopLossPrice", parseNum(e.target.value))
                                    }
                                  />
                                </div>
                              );
                            })()}
                          </TableCell>
                          ) : null}
                          <TableCell className="px-3 py-1.5 text-center">
                            {group.ownerName === "김승주" ? (
                              (() => {
                                const s = signalBySymbol.get(position.symbol);
                                const color =
                                  s?.final === "BUY"
                                    ? "text-red-500"
                                    : s?.final === "SELL"
                                      ? "text-blue-500"
                                      : "text-muted-foreground";
                                return (
                                  <div className={`text-xs font-semibold ${color}`}>
                                    {historyQuery.isLoading ? "..." : s?.final ?? "HOLD"}
                                    {s ? (
                                      <p className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                                        MA:{s.ma} RSI:{s.rsi} BB:{s.bb} VOL:{s.vol}
                                      </p>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="mt-1 block w-full text-[10px] font-medium text-primary underline-offset-2 hover:underline"
                                      onClick={() =>
                                        setSignalDetailTarget({ symbol: position.symbol, name: position.name })
                                      }
                                    >
                                      차트·근거 보기
                                    </button>
                                  </div>
                                );
                              })()
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right">
                            {isEditing ? (
                              <input
                                type="number"
                                min="0.000001"
                                step="any"
                                className="w-28 rounded-md border bg-background px-2 py-1 text-right text-sm"
                                value={editAvgPrice}
                                onChange={(e) => setEditAvgPrice(e.target.value)}
                              />
                            ) : (
                              <>
                                {position.currency === "KRW"
                                  ? `${fmtInt(Math.round(position.avgPrice))} KRW`
                                  : position.currency === "USD"
                                    ? `$${fmtUsdNumber(position.avgPrice, 2, 4)}`
                                    : `€${fmtUsdNumber(position.avgPrice, 2, 4)}`}
                                <p className="text-xs text-muted-foreground">
                                  {position.currency === "USD" || position.currency === "EUR" ? (
                                    <>
                                      원화(매입환율): ₩
                                      {fmtInt(
                                        position.avgPrice * position.purchaseFxUsed,
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      원화: ₩
                                      {fmtInt(position.avgPrice)}
                                    </>
                                  )}
                                </p>
                              </>
                            )}
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right text-xs">
                            {position.currency === "USD" ? (
                              isEditing ? (
                                <input
                                  type="number"
                                  min="0.000001"
                                  step="any"
                                  className="w-24 rounded-md border bg-background px-2 py-1 text-right text-sm"
                                  value={editPurchaseUsdKrw}
                                  onChange={(e) => setEditPurchaseUsdKrw(e.target.value)}
                                />
                              ) : (
                                <div className="flex flex-col items-end gap-0.5">
                                  <PurchaseFxCell position={position} currentUsdKrw={usdKrw} journal={buyJournal}>
                                    {position.purchaseUsdKrw != null
                                      ? `${fmtInt(Math.round(position.purchaseUsdKrw))} ₩/$`
                                      : `${usdKrw.toLocaleString(MONEY_INT_LOCALE)} ₩/$`}
                                  </PurchaseFxCell>
                                  {position.purchaseUsdKrw == null ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      미입력·현재환율 추정
                                    </span>
                                  ) : position.purchaseFxPending ? (
                                    <span className="text-[10px] text-amber-500">
                                      정산환율 대기(매수 2영업일 후 자동 보정)
                                    </span>
                                  ) : null}
                                </div>
                              )
                            ) : position.currency === "EUR" ? (
                              isEditing ? (
                                <input
                                  type="number"
                                  min="0.000001"
                                  step="any"
                                  className="w-24 rounded-md border bg-background px-2 py-1 text-right text-sm"
                                  value={editPurchaseEurKrw}
                                  onChange={(e) => setEditPurchaseEurKrw(e.target.value)}
                                />
                              ) : (
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>
                                    {position.purchaseEurKrw != null
                                      ? `${fmtInt(Math.round(position.purchaseEurKrw))} ₩/EUR`
                                      : `${eurKrw.toLocaleString(MONEY_INT_LOCALE)} ₩/EUR`}
                                  </span>
                                  {position.purchaseEurKrw == null ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      미입력·현재환율 추정
                                    </span>
                                  ) : null}
                                </div>
                              )
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="px-3 py-1.5">
                            {isEditing ? (
                              pendingSaveConfirm ? (
                                /* ── 저장 최종 확인 ── */
                                <div className="flex flex-col gap-1">
                                  <p className="text-[11px] font-semibold text-slate-300">저장할까요?</p>
                                  <div className="flex gap-1">
                                    <button
                                      type="button"
                                      className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all duration-100 hover:bg-muted active:scale-95"
                                      onClick={() => setPendingSaveConfirm(false)}
                                    >
                                      취소
                                    </button>
                                    <button
                                      type="button"
                                      className="cursor-pointer rounded-md border border-primary bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95"
                                      onClick={() => { saveEditRow(); setPendingSaveConfirm(false); }}
                                    >
                                      저장
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex flex-col gap-1">
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95"
                                    onClick={() => setPendingSaveConfirm(true)}
                                  >
                                    저장
                                  </button>
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all duration-100 hover:bg-muted active:scale-95"
                                    onClick={cancelEditRow}
                                  >
                                    취소
                                  </button>
                                </div>
                              )
                            ) : pendingConfirm?.rowIndex === rowIndex ? (
                              /* ── 인라인 확인 UI ── */
                              <div className="flex flex-col gap-1">
                                <p className="text-[11px] font-semibold text-slate-300">삭제할까요?</p>
                                <div className="flex gap-1">
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all duration-100 hover:bg-muted active:scale-95"
                                    onClick={() => setPendingConfirm(null)}
                                  >
                                    취소
                                  </button>
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded-md border border-destructive px-2 py-1 text-xs font-semibold text-destructive transition-all duration-100 hover:bg-destructive/10 active:scale-95"
                                    onClick={() => {
                                      handleDeleteRow(pendingConfirm.rowIndex);
                                      setPendingConfirm(null);
                                    }}
                                  >
                                    삭제
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-col gap-1 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100">
                                <div className="flex gap-1">
                                  <button
                                    type="button"
                                    title={
                                      sortMode !== "manual"
                                        ? "입력 순 정렬일 때만 순서를 바꿀 수 있습니다"
                                        : "위로"
                                    }
                                    className="cursor-pointer rounded border px-1.5 py-0.5 text-xs transition-all duration-100 hover:bg-muted active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
                                    disabled={sortMode !== "manual" || posIdx === 0}
                                    onClick={() => moveRow(rowIndex, "up")}
                                  >
                                    ▲
                                  </button>
                                  <button
                                    type="button"
                                    title={
                                      sortMode !== "manual"
                                        ? "입력 순 정렬일 때만 순서를 바꿀 수 있습니다"
                                        : "아래로"
                                    }
                                    className="cursor-pointer rounded border px-1.5 py-0.5 text-xs transition-all duration-100 hover:bg-muted active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
                                    disabled={
                                      sortMode !== "manual" ||
                                      posIdx === displayItems.length - 1
                                    }
                                    onClick={() => moveRow(rowIndex, "down")}
                                  >
                                    ▼
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all duration-100 hover:bg-muted active:scale-95"
                                  onClick={() => startEditRow(position, rowIndex)}
                                >
                                  수정
                                </button>
                                <button
                                  type="button"
                                  className="cursor-pointer rounded-md border px-2 py-1 text-xs text-destructive transition-all duration-100 hover:bg-destructive/10 active:scale-95"
                                  onClick={() => setPendingConfirm({ type: "delete", rowIndex, position })}
                                >
                                  삭제
                                </button>
                              </div>
                            )}
                          </TableCell>
                        </>
                          )}
                        </SortableOrStaticTableRow>
                              );
                            })}
                          </Fragment>
                        );
                        });
                          return sortMode === "manual" ? (
                            <DndContext
                              sensors={holdingsDndSensors}
                              collisionDetection={closestCenter}
                              onDragEnd={(e) => reorderHoldingsDrag(group.ownerName, e)}
                            >
                              <SortableContext
                                items={displayItems.map((p) => p.sourceIndex)}
                                strategy={verticalListSortingStrategy}
                              >
                                {blockRows}
                              </SortableContext>
                            </DndContext>
                          ) : (
                            blockRows
                          );
                        })()
                      )}
                    </TableBody>
                  </Table>
                  {/* ── 매도 기록 섹션 ── */}
                  {false && (() => {
                    const owner = group.ownerName;
                    const log = sellLog[owner] ?? [];
                    const totalRealized = log.reduce((s, e) => s + e.realizedKrw, 0);

                    // 종목별 집계
                    type SymPnl = { symbol: string; name: string; qty: number; costKrw: number; realizedKrw: number };
                    const symMap = new Map<string, SymPnl>();
                    for (const e of log) {
                      const prev = symMap.get(e.symbol) ?? { symbol: e.symbol, name: e.name, qty: 0, costKrw: 0, realizedKrw: 0 };
                      const fx = e.fxRate ?? 1;
                      const costKrwEntry = e.currency === "KRW" ? e.avgPrice * e.qty : e.avgPrice * e.qty * fx;
                      symMap.set(e.symbol, {
                        ...prev,
                        qty: prev.qty + e.qty,
                        costKrw: prev.costKrw + costKrwEntry,
                        realizedKrw: prev.realizedKrw + e.realizedKrw,
                      });
                    }
                    const symPnlList = [...symMap.values()].sort((a, b) => b.realizedKrw - a.realizedKrw);
                    const ownerTickerOptions = Array.from(
                      new Map(
                        positions
                          .map((p) => [
                            p.symbol,
                            { symbol: p.symbol, name: p.name, avgPrice: p.avgPrice, currency: p.currency },
                          ]),
                      ).values(),
                    ).sort((a, b) => a.symbol.localeCompare(b.symbol));

                    const form = sellLogForm[owner] ?? {
                      date: new Date().toISOString().slice(0, 10),
                      symbol: "", name: "", qty: "", sellPrice: "", avgPrice: "",
                      currency: "USD" as const, fxRate: String(Math.round(usdKrw)),
                      note: "", selectedOwners: [owner], ownerOverrides: {}, editingId: null,
                    };
                    const setForm2 = (patch: Partial<typeof form>) => {
                      setSellLogForm((prev) => ({
                        ...prev,
                        [owner]: { ...(prev[owner] ?? form), ...patch },
                      }));
                      setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "" }));
                    };

                    function calcRealized(entry: typeof form): number {
                      const qty = Number(entry.qty);
                      const sell = Number(entry.sellPrice);
                      const avg = Number(entry.avgPrice);
                      const fx = Number(entry.fxRate) || 1;
                      if (!Number.isFinite(qty) || !Number.isFinite(sell) || !Number.isFinite(avg)) return 0;
                      if (entry.currency === "KRW") return (sell - avg) * qty;
                      return (sell - avg) * qty * fx;
                    }

                    function calcRealizedByValues(qtyRaw: string, avgRaw: string, fxRaw: string, sellRaw: string): number {
                      const qty = Number(qtyRaw);
                      const sell = Number(sellRaw);
                      const avg = Number(avgRaw);
                      const fx = Number(fxRaw) || 1;
                      if (!Number.isFinite(qty) || !Number.isFinite(sell) || !Number.isFinite(avg)) return 0;
                      if (form.currency === "KRW") return (sell - avg) * qty;
                      return (sell - avg) * qty * fx;
                    }

                    function handleSellLogSave() {
                      // 붙여넣기 오류(⚠️)가 남아 있으면 저장 차단
                      const currentErr = sellLogErrorByOwner[owner] ?? "";
                      if (currentErr.startsWith("⚠️")) return;

                      setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "" }));
                      const sell = Number(form.sellPrice);
                      if (!form.symbol.trim()) {
                        setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "ℹ️ 티커(종목코드)를 입력해주세요." }));
                        return;
                      }
                      const avg = Number(form.avgPrice);
                      if (!Number.isFinite(avg) || avg <= 0) {
                        setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "ℹ️ 평균매입단가를 입력해주세요." }));
                        return;
                      }
                      if (!Number.isFinite(sell) || sell <= 0) return;
                      const selectedOwners = form.selectedOwners.length > 0 ? form.selectedOwners : [owner];
                      const symbol = form.symbol.trim().toUpperCase();
                      const name = form.name.trim() || symbol;
                      const hasHolding = (ownerName: string) =>
                        positions.some((p) => p.owner === ownerName && p.symbol === symbol);

                      // 수정 모드는 기존처럼 단일 보유자만 수정
                      if (form.editingId) {
                        if (!hasHolding(owner)) {
                          setSellLogErrorByOwner((prev) => ({
                            ...prev,
                            [owner]:
                              "오류: 현재 보유 종목에 없는 티커입니다. 실제 보유분 매도 기록만 허용합니다.",
                          }));
                          return;
                        }
                        const qty = Number(form.qty);
                        const fx = Number(form.fxRate) || 1;
                        if (!Number.isFinite(qty) || qty <= 0) return;
                        const realized = calcRealized(form);
                        const entry: SellLogEntry = {
                          id: form.editingId,
                          date: form.date,
                          symbol,
                          name,
                          qty,
                          sellPrice: sell,
                          avgPrice: avg,
                          currency: form.currency,
                          fxRate: fx,
                          realizedKrw: realized,
                          note: form.note.trim() || undefined,
                        };
                        setSellLog((prev) => {
                          const existing = prev[owner] ?? [];
                          return { ...prev, [owner]: existing.map((e) => (e.id === form.editingId ? entry : e)) };
                        });
                        setForm2({
                          symbol: "", name: "", qty: "", sellPrice: "", avgPrice: "",
                          currency: "USD", fxRate: String(Math.round(usdKrw)), note: "",
                          selectedOwners: [owner], ownerOverrides: {}, editingId: null,
                        });
                        return;
                      }
                      const invalidOwners = selectedOwners.filter((name2) => !hasHolding(name2));
                      if (invalidOwners.length > 0) {
                        setSellLogErrorByOwner((prev) => ({
                          ...prev,
                          [owner]:
                            `오류: ${invalidOwners.join(", ")} 보유자에게 ${symbol} 보유 내역이 없어 매도 기록을 저장할 수 없습니다.`,
                        }));
                        return;
                      }

                      setSellLog((prev) => {
                        let next = { ...prev };
                        for (const targetOwner of selectedOwners) {
                          const ovr = form.ownerOverrides[targetOwner] ?? { qty: "", avgPrice: "", fxRate: "" };
                          const qtyRaw = targetOwner === owner ? form.qty : ovr.qty;
                          const avgRaw = targetOwner === owner ? form.avgPrice : ovr.avgPrice;
                          const fxRaw = targetOwner === owner ? form.fxRate : ovr.fxRate;
                          const qty = Number(qtyRaw);
                          const avg = Number(avgRaw);
                          const fx = Number(fxRaw) || 1;
                          if (!Number.isFinite(qty) || qty <= 0) continue;
                          if (!Number.isFinite(avg) || avg <= 0) continue;
                          const entry: SellLogEntry = {
                            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            date: form.date,
                            symbol,
                            name,
                            qty,
                            sellPrice: sell,
                            avgPrice: avg,
                            currency: form.currency,
                            fxRate: fx,
                            realizedKrw: calcRealizedByValues(String(qty), String(avg), String(fx), String(sell)),
                            note: form.note.trim() || undefined,
                          };
                          const existing = next[targetOwner] ?? [];
                          next = { ...next, [targetOwner]: [...existing, entry] };
                        }
                        return next;
                      });
                      setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "" }));
                      setForm2({ symbol: "", name: "", qty: "", sellPrice: "", avgPrice: "",
                        currency: "USD", fxRate: String(Math.round(usdKrw)), note: "",
                        selectedOwners: [owner], ownerOverrides: {}, editingId: null });
                    }

                    function handleSellLogEdit(e: SellLogEntry) {
                      setForm2({
                        date: e.date, symbol: e.symbol, name: e.name,
                        qty: String(e.qty), sellPrice: String(e.sellPrice),
                        avgPrice: String(e.avgPrice), currency: e.currency,
                        fxRate: String(e.fxRate), note: e.note ?? "",
                        selectedOwners: [owner], ownerOverrides: {}, editingId: e.id,
                      });
                    }

                    function handleSellLogDelete(id: string) {
                      setSellLog((prev) => ({
                        ...prev,
                        [owner]: (prev[owner] ?? []).filter((e) => e.id !== id),
                      }));
                    }

                    function handleTickerChange(nextSymbol: string) {
                      const selected = ownerTickerOptions.find((x) => x.symbol === nextSymbol);
                      if (!selected) {
                        setForm2({ symbol: nextSymbol });
                        return;
                      }
                      const nextFxRate =
                        selected.currency === "KRW"
                          ? "1"
                          : selected.currency === "EUR"
                            ? String(Math.round(eurKrw))
                            : String(Math.round(usdKrw));
                      const nextOverrides = { ...form.ownerOverrides };
                      for (const targetOwner of form.selectedOwners) {
                        if (targetOwner === owner) continue;
                        const match = positions.find((p) => p.owner === targetOwner && p.symbol === selected.symbol);
                        nextOverrides[targetOwner] = {
                          qty: nextOverrides[targetOwner]?.qty ?? "",
                          avgPrice: nextOverrides[targetOwner]?.avgPrice || (match ? String(match.avgPrice) : ""),
                          fxRate:
                            selected.currency === "KRW"
                              ? "1"
                              : selected.currency === "EUR"
                                ? String(Math.round(eurKrw))
                                : String(Math.round(usdKrw)),
                        };
                      }
                      setForm2({
                        symbol: selected.symbol,
                        name: selected.name,
                        avgPrice: String(selected.avgPrice),
                        currency: selected.currency,
                        fxRate: nextFxRate,
                        ownerOverrides: nextOverrides,
                      });
                    }

                    function handleToggleSellOwner(targetOwner: string, checked: boolean) {
                      const nextOwners = checked
                        ? [...new Set([...form.selectedOwners, targetOwner])]
                        : form.selectedOwners.filter((n) => n !== targetOwner);
                      const overrides = { ...form.ownerOverrides };
                      if (checked && !overrides[targetOwner]) {
                        const match = positions.find((p) => p.owner === targetOwner && p.symbol === form.symbol);
                        overrides[targetOwner] = {
                          qty: "",
                          avgPrice: match ? String(match.avgPrice) : "",
                          fxRate:
                            form.currency === "KRW"
                              ? "1"
                              : form.currency === "EUR"
                                ? String(Math.round(eurKrw))
                                : String(Math.round(usdKrw)),
                        };
                      }
                      if (!checked) delete overrides[targetOwner];
                      setForm2({ selectedOwners: nextOwners, ownerOverrides: overrides });
                    }

                    const previewRealizedTotal = form.selectedOwners.reduce((sum, targetOwner) => {
                      const ovr = form.ownerOverrides[targetOwner] ?? { qty: "", avgPrice: "", fxRate: "" };
                      const qtyRaw = targetOwner === owner ? form.qty : ovr.qty;
                      const avgRaw = targetOwner === owner ? form.avgPrice : ovr.avgPrice;
                      const fxRaw = targetOwner === owner ? form.fxRate : ovr.fxRate;
                      return sum + calcRealizedByValues(qtyRaw, avgRaw, fxRaw, form.sellPrice);
                    }, 0);
                    const pricePlaceholder = form.currency === "KRW" ? "60000" : "60.00";
                    const avgPricePlaceholder = form.currency === "KRW" ? "55000" : "55.00";

                    return (
                      <div className="mt-3 rounded-xl border bg-muted/20 p-3">
                        {/* 헤더 */}
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-semibold">매도 기록</p>
                          <div className="flex items-center gap-2">
                            {symPnlList.length > 0 && (
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-[10px] hover:bg-muted"
                                onClick={() => setShowSymbolPnl((prev) => ({ ...prev, [owner]: !prev[owner] }))}>
                                {showSymbolPnl[owner] ? "종목별 접기 ▲" : "종목별 손익 ▼"}
                              </button>
                            )}
                            <button
                              type="button"
                              className={`text-xs font-bold tabular-nums underline-offset-2 hover:underline ${totalRealized > 0 ? "text-red-500" : totalRealized < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                              onClick={() => setSellLogDetailOpenOwner(owner)}
                            >
                              누적 실현손익: {totalRealized >= 0 ? "+" : ""}₩{fmtInt(totalRealized)}
                            </button>
                          </div>
                        </div>

                        {/* 종목별 실현손익 (토글) */}
                        {showSymbolPnl[owner] && symPnlList.length > 0 && (
                          <div className="mb-3 overflow-x-auto rounded-lg border bg-background p-2">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="border-b text-muted-foreground">
                                  <th className="py-1 pr-2 text-left font-medium">종목</th>
                                  <th className="py-1 pr-2 text-right font-medium">총매도량</th>
                                  <th className="py-1 pr-2 text-right font-medium">매수원가(₩)</th>
                                  <th className="py-1 pr-2 text-right font-medium">실현손익(₩)</th>
                                  <th className="py-1 text-right font-medium">수익률</th>
                                </tr>
                              </thead>
                              <tbody>
                                {symPnlList.map((s) => {
                                  const pct = s.costKrw > 0 ? (s.realizedKrw / s.costKrw) * 100 : 0;
                                  return (
                                    <tr key={s.symbol} className="border-b border-border/30 last:border-0 hover:bg-muted/30">
                                      <td className="py-1 pr-2">
                                        <span className="font-medium">{s.name}</span>
                                        <span className="ml-1 text-muted-foreground">{s.symbol}</span>
                                      </td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{s.qty}</td>
                                      <td className="py-1 pr-2 text-right tabular-nums">₩{fmtInt(s.costKrw)}</td>
                                      <td className={`py-1 pr-2 text-right tabular-nums font-semibold ${s.realizedKrw > 0 ? "text-red-500" : s.realizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                        {s.realizedKrw >= 0 ? "+" : ""}₩{fmtInt(s.realizedKrw)}
                                      </td>
                                      <td className={`py-1 text-right tabular-nums font-semibold ${pct > 0 ? "text-red-500" : pct < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                              <tfoot>
                                <tr className="border-t-2 border-border font-semibold">
                                  <td className="py-1 pr-2 text-[10px] text-muted-foreground">합계</td>
                                  <td className="py-1 pr-2 text-right tabular-nums">
                                    {symPnlList.reduce((s, x) => s + x.qty, 0)}
                                  </td>
                                  <td className="py-1 pr-2 text-right tabular-nums">
                                    ₩{fmtInt(symPnlList.reduce((s, x) => s + x.costKrw, 0))}
                                  </td>
                                  <td className={`py-1 pr-2 text-right tabular-nums ${totalRealized > 0 ? "text-red-500" : totalRealized < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                    {totalRealized >= 0 ? "+" : ""}₩{fmtInt(totalRealized)}
                                  </td>
                                  <td className={`py-1 text-right tabular-nums ${(() => { const tc = symPnlList.reduce((s, x) => s + x.costKrw, 0); const p = tc > 0 ? (totalRealized / tc) * 100 : 0; return p > 0 ? "text-red-500" : p < 0 ? "text-blue-500" : "text-muted-foreground"; })()}`}>
                                    {(() => { const tc = symPnlList.reduce((s, x) => s + x.costKrw, 0); const p = tc > 0 ? (totalRealized / tc) * 100 : 0; return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`; })()}
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        )}

                        {/* 입력 폼 */}
                        <div className="mb-3 grid grid-cols-2 gap-1.5 rounded-lg border bg-background p-2 text-xs sm:grid-cols-4">
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] text-muted-foreground">날짜</span>
                            <input type="date" className="rounded border bg-background px-1.5 py-1 text-xs"
                              value={form.date} onChange={(e) => setForm2({ date: e.target.value })} />
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] text-muted-foreground">티커</span>
                            <select
                              className="rounded border bg-background px-1.5 py-1 text-xs"
                              value={form.symbol}
                              onChange={(e) => handleTickerChange(e.target.value)}
                            >
                              <option value="">티커 선택</option>
                              {ownerTickerOptions.map((opt) => (
                                <option key={opt.symbol} value={opt.symbol}>
                                  {opt.symbol}({opt.name})
                                </option>
                              ))}
                              {form.symbol &&
                                !ownerTickerOptions.some((opt) => opt.symbol === form.symbol) && (
                                  <option value={form.symbol}>
                                    {form.symbol}
                                    {form.name ? `(${form.name})` : ""}
                                  </option>
                                )}
                            </select>
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] text-muted-foreground">종목명</span>
                            <input placeholder="에너지" className="rounded border bg-background px-1.5 py-1 text-xs"
                              value={form.name} onChange={(e) => setForm2({ name: e.target.value })} />
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] text-muted-foreground">통화</span>
                            <select className="rounded border bg-background px-1.5 py-1 text-xs"
                              value={form.currency}
                              onChange={(e) => setForm2({ currency: e.target.value as "USD" | "EUR" | "KRW",
                                fxRate: e.target.value === "KRW" ? "1" : e.target.value === "EUR" ? String(Math.round(eurKrw)) : String(Math.round(usdKrw)) })}>
                              <option value="USD">USD</option>
                              <option value="EUR">EUR</option>
                              <option value="KRW">KRW</option>
                            </select>
                          </label>
                          <div className="col-span-2 rounded border bg-muted/30 p-1.5 text-[11px] sm:col-span-4">
                            <p className="mb-1 text-[10px] text-muted-foreground">보유자(복수 선택)</p>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {ownerNames.map((name) => (
                                <label key={name} className="flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    className="accent-primary"
                                    checked={form.selectedOwners.includes(name)}
                                    disabled={form.editingId != null}
                                    onChange={(e) => handleToggleSellOwner(name, e.target.checked)}
                                  />
                                  <span>{name}</span>
                                </label>
                              ))}
                            </div>
                            {form.editingId && (
                              <p className="mt-1 text-[10px] text-muted-foreground">수정 모드에서는 단일 보유자만 변경됩니다.</p>
                            )}
                          </div>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] text-muted-foreground">수량</span>
                            <input type="number" min="0" step="any" placeholder="10"
                              className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                              value={form.qty} onChange={(e) => setForm2({ qty: e.target.value })} />
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] text-muted-foreground">매도가</span>
                            <input type="number" min="0" step="any" placeholder={pricePlaceholder}
                              className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                              value={form.sellPrice} onChange={(e) => setForm2({ sellPrice: e.target.value })} />
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] text-muted-foreground">매수평단가</span>
                            <input type="number" min="0" step="any" placeholder={avgPricePlaceholder}
                              className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                              value={form.avgPrice} onChange={(e) => setForm2({ avgPrice: e.target.value })} />
                          </label>
                          {form.currency !== "KRW" && (
                            <label className="flex flex-col gap-0.5">
                              <span className="text-[10px] text-muted-foreground">적용환율(₩)</span>
                              <input type="number" min="0" step="1"
                                className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                                value={form.fxRate} onChange={(e) => setForm2({ fxRate: e.target.value })} />
                            </label>
                          )}
                          {form.selectedOwners.filter((n) => n !== owner).map((targetOwner) => {
                            const override = form.ownerOverrides[targetOwner] ?? { qty: "", avgPrice: "", fxRate: "" };
                            return (
                              <div key={targetOwner} className="col-span-2 grid grid-cols-2 gap-1.5 rounded border bg-muted/20 p-1.5 sm:col-span-4 sm:grid-cols-4">
                                <p className="col-span-2 text-[10px] font-semibold text-muted-foreground sm:col-span-4">
                                  {targetOwner} 입력 (수량/평단가/환율)
                                </p>
                                <label className="flex flex-col gap-0.5">
                                  <span className="text-[10px] text-muted-foreground">수량</span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                                    value={override.qty}
                                    onChange={(e) =>
                                      setForm2({
                                        ownerOverrides: {
                                          ...form.ownerOverrides,
                                          [targetOwner]: { ...override, qty: e.target.value },
                                        },
                                      })
                                    }
                                  />
                                </label>
                                <label className="flex flex-col gap-0.5">
                                  <span className="text-[10px] text-muted-foreground">매도가</span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                                    value={form.sellPrice}
                                    onChange={(e) => setForm2({ sellPrice: e.target.value })}
                                  />
                                </label>
                                <label className="flex flex-col gap-0.5">
                                  <span className="text-[10px] text-muted-foreground">매수평단가</span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                                    value={override.avgPrice}
                                    onChange={(e) =>
                                      setForm2({
                                        ownerOverrides: {
                                          ...form.ownerOverrides,
                                          [targetOwner]: { ...override, avgPrice: e.target.value },
                                        },
                                      })
                                    }
                                  />
                                </label>
                                {form.currency !== "KRW" && (
                                  <label className="flex flex-col gap-0.5">
                                    <span className="text-[10px] text-muted-foreground">적용환율(₩)</span>
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      className="rounded border bg-background px-1.5 py-1 text-right text-xs"
                                      value={override.fxRate}
                                      onChange={(e) =>
                                        setForm2({
                                          ownerOverrides: {
                                            ...form.ownerOverrides,
                                            [targetOwner]: { ...override, fxRate: e.target.value },
                                          },
                                        })
                                      }
                                    />
                                  </label>
                                )}
                              </div>
                            );
                          })}
                          <label className="col-span-2 flex flex-col gap-0.5 sm:col-span-4">
                            <span className="text-[10px] text-muted-foreground">메모 (선택)</span>
                            <input placeholder="예: 일부 매도, 수익 실현"
                              className="rounded border bg-background px-1.5 py-1 text-xs"
                              value={form.note} onChange={(e) => setForm2({ note: e.target.value })} />
                          </label>
                          <div className="col-span-2 flex items-center justify-between sm:col-span-4">
                            <span className={`text-[11px] font-semibold tabular-nums ${previewRealizedTotal > 0 ? "text-red-500" : previewRealizedTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                              실현손익 예상: {previewRealizedTotal >= 0 ? "+" : ""}₩{fmtInt(previewRealizedTotal)}
                            </span>
                            <div className="flex gap-1.5">
                              {form.editingId && (
                                <button type="button"
                                  className="rounded border px-2 py-1 text-xs hover:bg-muted"
                                  onClick={() => setForm2({ symbol: "", name: "", qty: "", sellPrice: "",
                                    avgPrice: "", currency: "USD", fxRate: String(Math.round(usdKrw)), note: "",
                                    selectedOwners: [owner], ownerOverrides: {}, editingId: null })}>
                                  취소
                                </button>
                              )}
                              <button type="button"
                                className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
                                onClick={handleSellLogSave}>
                                {form.editingId ? "수정 저장" : "+ 기록 추가"}
                              </button>
                            </div>
                          </div>
                          {sellLogErrorByOwner[owner] ? (
                            <p className={`col-span-2 text-[11px] font-medium sm:col-span-4 ${sellLogErrorByOwner[owner].startsWith("ℹ️") ? "text-blue-400" : "text-destructive"}`}>
                              {sellLogErrorByOwner[owner]}
                            </p>
                          ) : null}
                        </div>

                        {/* 기록 목록 */}
                        {log.length > 0 && (
                          <div className="overflow-x-auto">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="border-b text-muted-foreground">
                                  <th className="py-1 pr-2 text-left font-medium">날짜</th>
                                  <th className="py-1 pr-2 text-left font-medium">종목</th>
                                  <th className="py-1 pr-2 text-right font-medium">수량</th>
                                  <th className="py-1 pr-2 text-right font-medium">매도가</th>
                                  <th className="py-1 pr-2 text-right font-medium">평단가</th>
                                  <th className="py-1 pr-2 text-right font-medium">실현손익</th>
                                  <th className="py-1 text-left font-medium">메모</th>
                                  <th className="py-1 text-right font-medium">관리</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[...log].sort((a, b) => b.date.localeCompare(a.date)).map((e) => (
                                  <tr key={e.id} className="border-b border-border/30 last:border-0 hover:bg-muted/30">
                                    <td className="py-1 pr-2 tabular-nums">{e.date}</td>
                                    <td className="py-1 pr-2">
                                      <span className="font-medium">{e.name}</span>
                                      <span className="ml-1 text-muted-foreground">{e.symbol}</span>
                                    </td>
                                    <td className="py-1 pr-2 text-right tabular-nums">{e.qty}</td>
                                    <td className="py-1 pr-2 text-right tabular-nums">
                                      {e.currency !== "KRW"
                                        ? e.currency === "EUR"
                                          ? `€${fmtUsdNumber(e.sellPrice, 2, 4)}`
                                          : `$${fmtUsdNumber(e.sellPrice, 2, 4)}`
                                        : `₩${fmtInt(Math.round(e.sellPrice))}`}
                                    </td>
                                    <td className="py-1 pr-2 text-right tabular-nums">
                                      {e.currency !== "KRW"
                                        ? e.currency === "EUR"
                                          ? `€${fmtUsdNumber(e.avgPrice, 2, 4)}`
                                          : `$${fmtUsdNumber(e.avgPrice, 2, 4)}`
                                        : `₩${fmtInt(Math.round(e.avgPrice))}`}
                                    </td>
                                    <td className={`py-1 pr-2 text-right tabular-nums font-semibold ${e.realizedKrw > 0 ? "text-red-500" : e.realizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                      {e.realizedKrw >= 0 ? "+" : ""}₩{fmtInt(e.realizedKrw)}
                                    </td>
                                    <td className="py-1 pr-2 text-muted-foreground">{e.note ?? "—"}</td>
                                    <td className="py-1 text-right">
                                      <div className="flex justify-end gap-1">
                                        <button type="button"
                                          className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                                          onClick={() => handleSellLogEdit(e)}>수정</button>
                                        <button type="button"
                                          className="rounded border px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                                          onClick={() => handleSellLogDelete(e.id)}>삭제</button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
              })}
            </div>
          </section>

          </div>
  );
}
