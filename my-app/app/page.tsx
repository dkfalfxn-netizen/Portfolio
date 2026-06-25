"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChangeEvent,
  Fragment,
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FamilyAllocationDonut, PortfolioAllOwnersTodayProfitCard } from "@/components/family-allocation-chart";
import { IntradaySparkline } from "@/components/intraday-sparkline";
import { LivePriceCell } from "@/components/live-price-cell";
import { DailyTrendChart, type DailyTradeMarker } from "@/components/daily-trend-chart";
import { DailyChangeCalendar } from "@/components/daily-change-calendar";
import { RebalancingCalculator } from "@/components/rebalancing-calculator";
import { TechnicalSignalDetailModal } from "@/components/technical-signal-detail-modal";
import TradeImageImport, { type ConfirmedBuyTrade, type ConfirmedSellTrade } from "@/components/trade-image-import";
import { cn } from "@/lib/utils";
import { FALLBACK_USD_KRW, FALLBACK_EUR_KRW } from "@/lib/fx-fallback";
import { holdingSymbolsEquivalent, inferTradingCurrencyFromTicker, isKrxListedEquityCode } from "@/lib/finance-symbols";
import {
  fmtInt,
  fmtUsdNumber,
  MONEY_INT_LOCALE,
  parseKoreanIntDigits,
  signedPnlTextClass,
} from "@/lib/format-money";
import {
  HAS_LOCAL_CHANGES_KEY,
  LOCAL_CHANGES_AT_KEY,
  clearLocalChanged,
  markLocalChanged,
  TARGET_WEIGHT_STORAGE_KEY,
  CALCULATOR_TARGET_STORAGE_KEY,
  buildRebalanceCalculatorByOwnerFromLocal,
  loadAllTargetStockWeights,
  mergeAndPersistRebalanceCalculatorFromServer,
  mergeAndPersistTargetStockWeightsFromServer,
} from "@/lib/portfolio-target-weights";
import { OWNER_SCRATCHPAD_STORAGE_KEY, mergeAndPersistOwnerScratchpadsFromServer, loadAllOwnerScratchpads } from "@/lib/portfolio-owner-scratchpad";
import {
  ALERT_THRESHOLDS_STORAGE_KEY,
  evaluateAlertRule,
  getAlertThresholdsPayload,
  getAlertThresholdsForSync,
  loadAlertThresholdsFromStorage,
  mergeAlertThresholdsFromServer,
  mergeAlertThresholdsOnPull,
  positionAlertKey,
  positionReturnPctForAlert,
  resolveAlertRule,
  symbolAlertKey,
  type AlertRule,
  type AlertThresholdsByKey,
} from "@/lib/alert-thresholds";
import { todayKST, yesterdayKST } from "@/lib/date-utils";

const ALERT_RETURN_PCT_PRESETS = [5, 10, 15, 20] as const;

const ALERT_PCT_PRESET_BTN =
  "min-h-[1.35rem] min-w-0 flex-1 rounded-md border border-slate-500/90 bg-slate-800 px-0.5 py-0.5 text-[10px] font-semibold leading-tight tabular-nums text-slate-100 shadow-sm transition-colors hover:border-sky-400/80 hover:bg-sky-500/25 active:scale-[0.98]";

function alertPctPresetBtnClass(active: boolean): string {
  return cn(
    ALERT_PCT_PRESET_BTN,
    active && "border-sky-400 bg-sky-500/40 text-white ring-1 ring-sky-400/40",
  );
}

function hasAlertThresholdRule(rule: AlertRule | undefined): boolean {
  if (!rule) return false;
  return (
    rule.takeProfitPrice !== undefined ||
    rule.stopLossPrice !== undefined ||
    rule.takeProfitReturnPct !== undefined ||
    rule.stopLossReturnPct !== undefined
  );
}

import {
  calculateBollingerSignal,
  calculateMACrossoverSignal,
  calculateRSISignal,
  calculateVolumeSignal,
  type DailyPrice as SignalDailyPrice,
  type TradeSignal,
} from "@/lib/signals";
import { shouldShowDailyChangeVsPreviousClose, krSettlementTargetUnixSec } from "@/lib/trading-calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GripVertical } from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableOrStaticTableRow, SortableTr } from "@/components/table-sortable-row";

const DEFAULT_OWNER_NAMES = ["김승주", "강희진", "김도율", "김찬율", "퇴직연금"] as const;
/** 포트폴리오 비중 그리드: 기본 순서 후 나머지 보유자 */
function sortPortfolioGridRows<T extends { ownerName: string }>(
  rows: T[],
  preferred: readonly string[],
): T[] {
  const byName = new Map(rows.map((r) => [r.ownerName, r]));
  const used = new Set<string>();
  const out: T[] = [];
  for (const name of preferred) {
    const row = byName.get(name);
    if (row) {
      out.push(row);
      used.add(name);
    }
  }
  for (const row of rows) {
    if (!used.has(row.ownerName)) out.push(row);
  }
  return out;
}

/** 보유자 전체 합산용 티커 키 — KRX:/KQ: 생략 형태를 동일 종목으로 묶음 */
function aggregateSymbolKeyForHoldings(symbol: string): string {
  const u = symbol.trim().toUpperCase();
  if (u.startsWith("KRX:")) return u.slice(4);
  if (u.startsWith("KQ:")) return u.slice(3);
  return u;
}

function isStockRowForSymbolAggregate(p: { symbol: string; name: string }): boolean {
  const sym = p.symbol?.trim() ?? "";
  if (!sym) return false;
  const nm = p.name?.trim() ?? "";
  if (nm === "USD 현금" || nm === "KRW 현금") return false;
  return true;
}

/** 차트 그룹 구성란: 해외(USD/EUR)=티커, 국내(KRW)=종목명 */
function chartGroupCompositionLabel(p: {
  symbol: string;
  name: string;
  currency: "USD" | "EUR" | "KRW";
}): string {
  const sym = p.symbol.trim();
  if (p.currency === "USD" || p.currency === "EUR") return sym;
  const nm = (p.name ?? "").trim();
  return nm || sym;
}

type HoldingsAggTipRow = {
  code: string;
  name: string;
  pct: number | null;
};

function fmtHoldingsAggTipPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

/** 행 합계 대비 지분(등락률과 구분 — 부호 없이 소수 한 자리) */
function fmtHoldingsAggSharePct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return `${p.toFixed(1)}%`;
}

/** 종목별 합산 표 — 네이티브 title 대신 DOM 오버레이(한글·₩ 깨짐 방지), 표 형식 툴팁 */
function HoldingsAggRichTooltip({
  header,
  rows,
  pctHeader = "등락",
  showPctColumn = true,
  /** 보유자별 평가/손익: 금액 뒤에 행 합계 대비 지분(%)을 같은 칸에 표시 — 3열 대신 2열 */
  mergePctIntoName = false,
  codeMono = true,
  className,
  children,
}: {
  header: string;
  rows: HoldingsAggTipRow[];
  /** 보유자별 수익률 열일 때 열 제목 */
  pctHeader?: string;
  /** 보유자 목록 등 % 열이 의미 없을 때 숨김 */
  showPctColumn?: boolean;
  mergePctIntoName?: boolean;
  /** 첫 열을 티커용 고정폭(모노)으로 — 보유자 이름은 false */
  codeMono?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  if (rows.length === 0) {
    return <span className={className}>{children}</span>;
  }
  const hdr = header.trim();
  const twoColAmountPct = !showPctColumn && mergePctIntoName;
  return (
    <>
      <span
        className={className}
        onMouseEnter={(e) => {
          setOpen(true);
          setCoords({ x: e.clientX, y: e.clientY });
        }}
        onMouseMove={(e) => {
          if (open) setCoords({ x: e.clientX, y: e.clientY });
        }}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[300] w-[min(92vw,22rem)] rounded-lg border border-slate-600/90 bg-slate-950 px-3 py-2.5 text-left shadow-xl ring-1 ring-white/5"
            style={{ left: coords.x + 12, top: coords.y + 12 }}
          >
            {hdr.length > 0 ? (
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-100">
                {hdr}
              </p>
            ) : null}
            <table className="w-full border-separate border-spacing-y-1 text-[11px]">
              <thead>
                {twoColAmountPct ? (
                  <tr className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    <th className="pb-1 pr-2 text-left font-medium">보유자</th>
                    <th className="pb-1 px-1 text-right font-medium">금액</th>
                    <th className="w-[4.5rem] min-w-[4.5rem] pb-1 pl-1 text-right font-medium tabular-nums">
                      비중
                    </th>
                  </tr>
                ) : (
                  <tr className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    <th className="pb-1 pr-2 text-left font-medium">
                      {showPctColumn ? "코드" : "보유자"}
                    </th>
                    <th
                      className={cn(
                        "pb-1 text-left font-medium",
                        showPctColumn ? "px-1" : "pl-1",
                      )}
                    >
                      {showPctColumn ? "이름" : ""}
                    </th>
                    {showPctColumn ? (
                      <th className="pb-1 pl-2 text-right font-medium">{pctHeader}</th>
                    ) : null}
                  </tr>
                )}
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.code}-${i}`}>
                    <td
                      className={cn(
                        "max-w-[5.5rem] truncate pr-2 align-top text-slate-200",
                        codeMono && "font-mono",
                        !showPctColumn && "max-w-none",
                        !codeMono && "font-sans",
                      )}
                      title={!showPctColumn ? r.code : undefined}
                    >
                      {r.code}
                    </td>
                    {twoColAmountPct ? (
                      <>
                        <td className="max-w-[10rem] truncate px-1 text-right align-top tabular-nums text-slate-200">
                          {r.name}
                        </td>
                        <td className="w-[4.5rem] min-w-[4.5rem] truncate pl-1 text-right align-top tabular-nums font-medium text-slate-400">
                          {fmtHoldingsAggSharePct(r.pct)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td
                          className={cn(
                            "truncate align-top text-slate-300",
                            showPctColumn ? "max-w-[9rem] px-1" : "pl-1 text-slate-500",
                          )}
                          title={showPctColumn ? r.name : undefined}
                        >
                          {showPctColumn ? r.name || "—" : ""}
                        </td>
                        {showPctColumn ? (
                          <td
                            className={cn(
                              "pl-2 text-right tabular-nums align-top font-medium",
                              r.pct === null || !Number.isFinite(r.pct)
                                ? "text-slate-500"
                                : r.pct >= 0
                                  ? "text-rose-400"
                                  : "text-sky-400",
                            )}
                          >
                            {fmtHoldingsAggTipPct(r.pct)}
                          </td>
                        ) : null}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
          document.body,
        )}
    </>
  );
}

type OwnerName = string;
type Position = {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  currency: "USD" | "EUR" | "KRW";
  /** 해외(USD) 매수 시점 USD/KRW — 원화 매입원가·원화 수익률에 사용 */
  purchaseUsdKrw?: number;
  /** 해외(EUR) 매수 시점 EUR/KRW */
  purchaseEurKrw?: number;
  /** 매수일(YYYY-MM-DD, KST) — 정산환율(T+2 09:00) 자동 보정용. 날짜 미입력 시 추가한 날로 설정 */
  purchaseDate?: string;
  /** 정산환율(T+2 09:00 KST) 미확정 상태 — 현재환율 임시값. 정산 시점 경과 후 자동 보정되면 해제 */
  purchaseFxPending?: boolean;
  /** 추가 당시 임시로 박은 환율(현재환율). 정산 후 매입환율은 정산값으로 바뀌므로 내역 표시용으로 보존 */
  purchaseFxAtAdd?: number;
  accountType: "해외주식" | "국내주식";
  accountName: string;
  owner: OwnerName;
  /** 원형 차트에서 같은 값끼리 합산할 그룹명 (미입력 시 티커 기준) */
  chartGroup?: string;
};

type MarketState = "REGULAR" | "PRE" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED" | null;

type MarketResponse = {
  quotes: Record<
    string,
    { price: number | null; currency: string | null; previousClose: number | null; marketState?: MarketState }
  >;
  /** 티커별 당일 분봉 종가 시계열 */
  intraday?: Record<string, number[]>;
  usdKrw: number | null;
  eurKrw: number | null;
  /** Yahoo ^VIX */
  vix: number | null;
  /** Fear & Greed — CNN Dataviz (edition.cnn.com 과 동일 소스) */
  fearGreed: { score: number; label: string } | null;
  fetchedAt: number;
};

const FEAR_GREED_LABEL_KO: Record<string, string> = {
  "Extreme Fear": "극공포",
  Fear: "공포",
  Neutral: "중립",
  Greed: "탐욕",
  "Extreme Greed": "극탐욕",
};

type HistoryResponse = {
  history: Record<string, SignalDailyPrice[]>;
  fetchedAt?: number;
};

/** 로컬 저장 키 — v1에서 한 번만 마이그레이션 후 v2만 사용 */
const STORAGE_KEY = "portfolio_positions_v2";
const LEGACY_POSITIONS_STORAGE_KEY = "portfolio_positions_v1";
const CASH_STORAGE_KEY = "portfolio_cash_v1";
const OWNER_NAMES_STORAGE_KEY = "portfolio_owner_names_v1";
const SYNC_KEY_STORAGE = "portfolio_sync_key_v1";
const AUTO_SYNC_STORAGE = "portfolio_auto_sync_v1";
const HOLDINGS_SORT_STORAGE_KEY = "portfolio_holdings_sort_v1";
/** 보유 표 「기준선」열 표시 여부 (기본 숨김) */
const HOLDINGS_ALERT_COLUMN_VISIBLE_KEY = "portfolio_holdings_alert_col_visible_v1";
/** 종목별 합산 표 「기준선」(% )열 표시 여부 (기본 표시) */
const AGG_ALERT_COLUMN_VISIBLE_KEY = "portfolio_agg_alert_col_visible_v1";
const DAILY_SNAPSHOTS_KEY = "portfolio_daily_snapshots_v1";
/**
 * 마지막으로 서버와 성공적으로 동기화했을 때의 서버 updated_at 값.
 * 로컬 시계가 아닌 서버 시각 기준이라 기기 간 시계 차이 문제가 없다.
 */
const LAST_SYNC_TS_KEY = "portfolio_last_sync_ts_v1";
/**
 * 오늘 서버에 push한 날짜 ("YYYY-MM-DD") 와 그때의 totalValue.
 * 날짜가 같아도 totalValue가 1% 이상 달라지면 재push해 현금 변경을 반영한다.
 */
const SNAPSHOT_PUSHED_DATE_KEY = "portfolio_snapshot_pushed_date_v1";
const SNAPSHOT_PUSHED_TOTAL_KEY = "portfolio_snapshot_pushed_total_v1";
const SELL_LOG_KEY = "portfolio_sell_log_v1";
/** 「종목 추가」체결을 일별 차트 마커용으로만 로컬 저장(서버 동기화 없음) */
const BUY_JOURNAL_KEY = "portfolio_buy_journal_v1";
const BUY_JOURNAL_MAX = 500;
const LAST_SELL_LOG_SYNC_TS_KEY = "portfolio_last_sell_log_sync_ts_v1";
const SELL_LOG_DIRTY_KEY = "portfolio_sell_log_dirty_v1";
const TRADING_FEE_RATE = 0.001; // 0.1%
/** 매입 시 현금 잔고 비교용(부동소수 오차) */
const CASH_CHECK_EPS = 1e-6;
/** 보유 종목 차트 그룹 추천(datalist). 「현금」은 현금·현금성 자산을 한 그룹으로 묶을 때 사용 */
const HOLDINGS_CHART_GROUP_PRESETS = [
  "현금",
  "GOLD",
  "ATTACK",
  "XLE",
  "AI",
  "S&P500",
  "방산",
] as const;
/** 일별 스냅샷 최대 보관 일수 */
const SNAPSHOT_MAX_DAYS = 180;
/** 실현손익 '종목별 손익' 접기 키(전 보유자 합산 표이므로 단일 토글) */
const REALIZED_SYMBOL_PNL_TOGGLE_KEY = "__realizedSymbolPnlAll__";

export type DailySnapshot = {
  date: string; // YYYY-MM-DD
  ownerValues: Record<string, number>; // ownerName → 총 평가액(KRW)
  breakdownValues?: Record<string, number>; // "owner · group" 또는 "owner · 현금" → 평가액(KRW)
  totalValue: number;
  /** 서버 DB의 updated_at (ISO 8601). LWW 병합에 사용 */
  updatedAt?: string;
  /** 로컬 저장 시각 (Date.now() ms). LWW 병합에 사용 */
  savedAt?: number;
};

type DailyLiveChange = {
  date: string;
  changeKrw: number;
  changePct: number | null;
  ownerChanges: Array<{ name: string; changeKrw: number; changePct: number | null }>;
  compareNote?: string;
};

type SellLogEntry = {
  id: string;
  date: string;          // YYYY-MM-DD
  symbol: string;
  name: string;
  qty: number;
  sellPrice: number;
  avgPrice: number;
  currency: "USD" | "EUR" | "KRW";
  /** 매도 시 적용 환율 (USD/EUR용) */
  fxRate: number;
  /** 실현손익 원화 */
  realizedKrw: number;
  note?: string;
};

/** 종목 추가 시 로컬에만 남기는 매수 저널(차트 마커용) */
type BuyJournalEntry = {
  id: string;
  date: string;
  owner: OwnerName;
  symbol: string;
  name: string;
  qty: number;
  buyPrice: number;
  currency: "USD" | "EUR" | "KRW";
  fxRate: number;
  totalKrw: number;
  /** USD 매수 정산환율(T+2 09:00) 미확정 — 현재환율 임시. 정산 후 fxRate·totalKrw 자동 보정되면 해제 */
  fxPending?: boolean;
};

// ── 증권사 체결 알림 파서 ─────────────────────────────────────────────────────
type BrokerNotificationParsed = {
  accountName: string;       // 정확한 이름 또는 마스킹된 이름 (김*주)
  name: string;
  symbol: string;            // 없으면 빈 문자열 (하나증권 등)
  tradeType: "buy" | "sell";
  qty: number;
  price: number;
  currency: "KRW" | "USD" | "EUR";
  date?: string;             // YYYY-MM-DD (없으면 호출부에서 오늘 날짜 사용)
  accountKind?: string;      // 계좌 종류 토큰: "ISA" | "직투" | "IRP" | "DC"
  accountNumber?: string;    // 계좌번호 문자열 (구분용)
};

/** 계좌번호 끝자리 → 보유자명 (이름 마스킹으로 구분 불가한 경우). 필요시 여기에 추가. */
const ACCOUNT_NUMBER_OWNER_RULES: { test: RegExp; owner: string }[] = [
  { test: /27-?01\b/, owner: "김도율" },
  { test: /62-?01\b/, owner: "김찬율" },
];

/** 마스킹된 이름(김*주)을 ownerNames 목록에서 찾아 실제 이름 반환. 유일하게 매칭되면 반환, 아니면 빈 문자열 */
function resolveOwnerFromMasked(masked: string, ownerNames: string[]): string {
  if (!masked) return "";
  // 마스킹 없으면 그대로 exact match 시도
  if (!masked.includes("*")) return ownerNames.find((n) => n === masked) ? masked : "";
  const first = masked[0];
  const last = masked[masked.length - 1];
  const matches = ownerNames.filter((n) => n.length >= 2 && n[0] === first && n[n.length - 1] === last);
  return matches.length === 1 ? matches[0] : "";
}

/** 이름(마스킹 가능)이 보유자명의 사람 부분과 맞는지 — "김승주 ISA"의 사람부분 "김승주" 기준 */
function brokerNameMatchesOwner(accountName: string, owner: string): boolean {
  if (!accountName) return true;
  const personPart = owner.split(/\s+/)[0] ?? owner;
  if (accountName.includes("*")) {
    const f = accountName[0];
    const l = accountName[accountName.length - 1];
    return personPart.length >= 2 && personPart[0] === f && personPart[personPart.length - 1] === l;
  }
  return owner.includes(accountName) || accountName.includes(personPart);
}

/** 증권사 파싱 결과에서 보유자(계좌)를 결정.
 *  1) 계좌번호 규칙 → 2) 계좌종류(ISA/직투/IRP/DC)+이름 조합 → 3) 이름 단독(마스킹 해석) */
function resolveBrokerOwner(parsed: BrokerNotificationParsed, ownerNames: string[]): string {
  // 1) 계좌번호로 특정
  if (parsed.accountNumber) {
    for (const rule of ACCOUNT_NUMBER_OWNER_RULES) {
      if (rule.test.test(parsed.accountNumber)) {
        const o = ownerNames.find((n) => n === rule.owner) ?? ownerNames.find((n) => n.includes(rule.owner));
        if (o) return o;
      }
    }
  }
  // 2) 계좌 종류 토큰으로 후보를 좁히고, 여럿이면 이름으로 특정
  const kind = parsed.accountKind?.trim().toUpperCase();
  if (kind) {
    const cands = ownerNames.filter((n) => n.toUpperCase().includes(kind));
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
      const narrowed = cands.filter((o) => brokerNameMatchesOwner(parsed.accountName, o));
      if (narrowed.length >= 1) return narrowed[0];
      return cands[0];
    }
  }
  // 3) 이름 단독
  const exact = ownerNames.find((n) => n === parsed.accountName);
  return exact ?? resolveOwnerFromMasked(parsed.accountName, ownerNames);
}

function parsePriceField(raw: string): { price: number; currency: "KRW" | "USD" | "EUR" } {
  if (raw.includes("$") || raw.toUpperCase().includes("USD"))
    return { currency: "USD", price: parseFloat(raw.replace(/[^0-9.]/g, "")) };
  if (raw.includes("€") || raw.toUpperCase().includes("EUR"))
    return { currency: "EUR", price: parseFloat(raw.replace(/[^0-9.]/g, "")) };
  return { currency: "KRW", price: parseInt(raw.replace(/[^\d]/g, ""), 10) };
}

/** 미래에셋증권 카카오 체결 알림
 * 예) [미래에셋증권] 전량체결 / 계좌명 : 김찬율 / 종목명 : SOL 미국원자력SMR(A0051G0) */
function parseMiraeAssetNotification(text: string): BrokerNotificationParsed | null {
  if (!text.includes("미래에셋")) return null;
  const get = (key: string) => {
    const m = text.match(new RegExp(`${key}\\s*:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  const 종목명Raw = get("종목명");
  const 매매구분 = get("매매구분");
  const 체결수량Raw = get("체결수량");
  const 체결단가Raw = get("체결단가");
  const 계좌명 = get("계좌명");
  if (!종목명Raw || !매매구분 || !체결수량Raw || !체결단가Raw) return null;

  const nameMatch = 종목명Raw.match(/^(.+?)\(([^)]+)\)$/);
  const name = nameMatch ? nameMatch[1].trim() : 종목명Raw.trim();
  const symbol = nameMatch ? nameMatch[2].trim() : "";
  const qty = parseInt(체결수량Raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const { price, currency } = parsePriceField(체결단가Raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const tradeType: "buy" | "sell" = 매매구분.includes("매도") ? "sell" : "buy";
  // 미래에셋 → ISA 계좌
  return { accountName: 계좌명, name, symbol, tradeType, qty, price, currency, accountKind: "ISA", accountNumber: get("계좌번호") };
}

/** 하나증권 퇴직연금 체결 알림
 * 예) [하나증권] 퇴직연금 매매체결 안내 / ■ 종목 : TIGER 테슬라채권혼합Fn / ■ 수량 : 5 주 */
function parseHanaNotification(text: string): BrokerNotificationParsed | null {
  if (!text.includes("하나증권")) return null;
  const get = (key: string) => {
    const m = text.match(new RegExp(`■\\s*${key}\\s*:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  const 주문구분 = get("주문구분");
  const 종목 = get("종목");
  const 수량Raw = get("수량");
  const 가격Raw = get("가격");
  if (!주문구분 || !종목 || !수량Raw || !가격Raw) return null;

  const qty = parseInt(수량Raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const { price, currency } = parsePriceField(가격Raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const tradeType: "buy" | "sell" = 주문구분.includes("매도") ? "sell" : "buy";
  // 헤더 "퇴직연금"으로 보유자 추론
  const accountName = text.includes("퇴직연금") ? "퇴직연금" : "";
  // 개인형 IRP / 확정기여형(DC) 구분
  const accountKind = /개인형|IRP/i.test(text) ? "IRP" : /확정기여형|DC\s*형|\(DC/i.test(text) ? "DC" : undefined;
  return { accountName, name: 종목.trim(), symbol: "", tradeType, qty, price, currency, accountKind };
}

/** 메리츠증권 해외주식 주문체결 안내
 * 예) [메리츠증권] 해외주식 주문체결 안내 / 종목명 : FIDELITY CRYPTO...(FDIG) / 체결단가 : USD 44.8300 */
function parseMeritzNotification(text: string): BrokerNotificationParsed | null {
  if (!text.includes("메리츠")) return null;
  const get = (key: string) => {
    const m = text.match(new RegExp(`${key}\\s*:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  const 종목명Raw = get("종목명");
  const 매매구분 = get("매매구분");
  const 체결수량Raw = get("체결수량");
  const 체결단가Raw = get("체결단가");
  const 계좌명Raw = get("계좌명");
  const 체결일자Raw = get("체결일자"); // MM/DD 형식
  if (!종목명Raw || !매매구분 || !체결수량Raw || !체결단가Raw) return null;

  // "FIDELITY CRYPTO INDUSTRY AND DIGITAL PAY(FDIG)" → name / symbol 분리
  const nameMatch = 종목명Raw.match(/^(.+?)\(([^)]+)\)$/);
  const name = nameMatch ? nameMatch[1].trim() : 종목명Raw.trim();
  const symbol = nameMatch ? nameMatch[2].trim() : "";

  const qty = parseInt(체결수량Raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const { price, currency } = parsePriceField(체결단가Raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const tradeType: "buy" | "sell" = 매매구분.includes("매도") ? "sell" : "buy";

  // 체결일자 MM/DD → YYYY-MM-DD
  let date: string | undefined;
  const dateMatch = 체결일자Raw.match(/^(\d{1,2})\/(\d{2})$/);
  if (dateMatch) {
    const year = new Date().getFullYear();
    date = `${year}-${dateMatch[1].padStart(2, "0")}-${dateMatch[2]}`;
  }

  // 메리츠 → 직투 계좌 (계좌번호로 김도율/김찬율 등 추가 구분)
  return { accountName: 계좌명Raw, name, symbol, tradeType, qty, price, currency, date, accountKind: "직투", accountNumber: get("계좌번호") };
}

/** 지원하는 모든 증권사 파서를 순서대로 시도 */
function parseBrokerNotification(text: string): BrokerNotificationParsed | null {
  return parseMiraeAssetNotification(text) ?? parseHanaNotification(text) ?? parseMeritzNotification(text);
}

// 하위 호환: 기존 타입명 유지

function calcSellRealizedKrw(entry: Pick<SellLogEntry, "qty" | "sellPrice" | "avgPrice" | "currency" | "fxRate">): number {
  const qty = Number(entry.qty);
  const sell = Number(entry.sellPrice);
  const avg = Number(entry.avgPrice);
  const fx = Number(entry.fxRate) || 1;
  if (!Number.isFinite(qty) || !Number.isFinite(sell) || !Number.isFinite(avg)) return 0;
  const sellNotionalKrw =
    entry.currency === "KRW" ? sell * qty : sell * qty * fx;
  const buyNotionalKrw =
    entry.currency === "KRW" ? avg * qty : avg * qty * fx;
  /** 매도 금액 기준 수수료 차감(매입 쪽은 종목 추가 시 별도 반영) */
  const netProceedsKrw = sellNotionalKrw * (1 - TRADING_FEE_RATE);
  return netProceedsKrw - buyNotionalKrw;
}

/**
 * USD 종목 매수: 달러 예수금이 충분하면 USD만 차감, 아니면 EUR와 같이 전액을 현재(또는 입력) USD/KRW로 원화 차감.
 */
function usdPurchaseCashPlan(
  quantity: number,
  avgPrice: number,
  purchaseUsdKrw: number,
  wallet: { usd: number; krw: number },
): { deductUsd: number; deductKrw: number } | null {
  const qty = Number(quantity);
  const px = Number(avgPrice);
  const fx = Number(purchaseUsdKrw);
  if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0) return null;
  if (!Number.isFinite(fx) || fx <= 0) return null;
  const withFee = qty * px * (1 + TRADING_FEE_RATE);
  const krwNeed = withFee * fx;
  if (wallet.usd >= withFee - CASH_CHECK_EPS) return { deductUsd: withFee, deductKrw: 0 };
  if (wallet.krw >= krwNeed - CASH_CHECK_EPS) return { deductUsd: 0, deductKrw: krwNeed };
  return null;
}

/** 종목 추가 시 현금 차감: KRW·EUR (USD는 usdPurchaseCashPlan) */
function purchaseCashDeduction(params: {
  currency: "EUR" | "KRW";
  quantity: number;
  avgPrice: number;
  purchaseEurKrw: number;
}): { deductUsd: number; deductKrw: number } {
  const qty = Number(params.quantity);
  const px = Number(params.avgPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(px)) return { deductUsd: 0, deductKrw: 0 };
  const withFee = qty * px * (1 + TRADING_FEE_RATE);
  if (params.currency === "KRW") return { deductUsd: 0, deductKrw: withFee };
  const eurKrw = Number(params.purchaseEurKrw);
  if (!Number.isFinite(eurKrw) || eurKrw <= 0) return { deductUsd: 0, deductKrw: 0 };
  return { deductUsd: 0, deductKrw: withFee * eurKrw };
}

type FxTooltipRow = { label: string; value: string; tag?: string };
type FxTooltipData = { ticker: string; name?: string; rows: FxTooltipRow[]; note?: string };

/** 매입환율 셀 hover 툴팁 데이터: 매수일·정산일·정산환율 내역 (USD만). 매수일은 포지션 또는 매수저널에서 찾음 */
function purchaseFxTooltipData(
  p: Position,
  currentUsdKrw: number,
  journal: BuyJournalEntry[] = [],
): FxTooltipData | undefined {
  if (p.currency !== "USD") return undefined;
  const pdate = typeof p.purchaseDate === "string" ? p.purchaseDate.trim() : "";
  const jEntry = journal.find(
    (b) => b.owner === p.owner && b.symbol === p.symbol && b.currency === "USD",
  );
  const jdate = jEntry?.date ?? "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(pdate)
    ? pdate
    : /^\d{4}-\d{2}-\d{2}$/.test(jdate)
      ? jdate
      : "";
  if (!d) return undefined;
  const mdd = (ymd: string) => {
    const parts = ymd.split("-");
    return `${Number(parts[1])}/${Number(parts[2])}`;
  };
  const r = (n: number | undefined | null) =>
    typeof n === "number" && Number.isFinite(n) ? `${Math.round(n).toLocaleString("ko-KR")} ₩/$` : null;
  const name = (jEntry?.name || p.name || "").trim() || undefined;
  const applied = r(p.purchaseUsdKrw);

  if (p.purchaseFxPending) {
    const est = applied ?? r(currentUsdKrw) ?? "—";
    return {
      ticker: p.symbol,
      name,
      rows: [{ label: `매수 ${mdd(d)}`, value: est }],
      note: "정산 전 · 현재환율 추정",
    };
  }
  const targetSec = krSettlementTargetUnixSec(d, 2, 9);
  const settleYmd =
    targetSec !== null
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(targetSec * 1000))
      : null;
  const addRate = r(p.purchaseFxAtAdd);
  const rows: FxTooltipRow[] = [];
  if (addRate) rows.push({ label: `추가 ${mdd(d)}`, value: addRate });
  if (applied) {
    rows.push(
      addRate && settleYmd
        ? { label: `정산 ${mdd(settleYmd)}`, value: applied, tag: "적용" }
        : { label: `매수 ${mdd(d)}`, value: applied },
    );
  }
  if (rows.length === 0) return undefined;
  return { ticker: p.symbol, name, rows };
}

/** 매입환율 셀: hover 시 「오늘 수익 요약」과 같은 양식의 팝업(헤더+행) 표시 */
function PurchaseFxCell({
  position,
  currentUsdKrw,
  journal,
  children,
}: {
  position: Position;
  currentUsdKrw: number;
  journal: BuyJournalEntry[];
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const data = purchaseFxTooltipData(position, currentUsdKrw, journal);
  if (!data) return <>{children}</>;
  return (
    <>
      <span
        className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2"
        onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setPos(null)}
      >
        {children}
      </span>
      {pos !== null &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] rounded-lg border border-white/[0.12] bg-[#1a1f2e] shadow-2xl"
            style={{ left: pos.x + 14, top: pos.y - 6 }}
          >
            <div className="flex items-baseline gap-2 border-b border-white/[0.1] px-3 py-2">
              <span className="text-[13px] font-bold text-zinc-100">{data.ticker}</span>
              {data.name ? <span className="text-[12px] text-zinc-400">{data.name}</span> : null}
            </div>
            <div className="space-y-1 px-3 py-2">
              {data.rows.map((row, i) => (
                <div key={i} className="flex items-center gap-4 text-[12px]">
                  <span className="shrink-0 text-zinc-400">{row.label}</span>
                  <span className="flex-1 text-right tabular-nums font-medium text-zinc-100">
                    {row.value}
                  </span>
                  {row.tag ? <span className="shrink-0 text-[11px] text-emerald-400">{row.tag}</span> : null}
                </div>
              ))}
              {data.note ? <div className="pt-0.5 text-[11px] text-amber-400">{data.note}</div> : null}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function normalizeOwnerNames(raw: unknown): OwnerName[] {
  if (!Array.isArray(raw)) return [...DEFAULT_OWNER_NAMES];
  const seen = new Set<string>();
  const names: OwnerName[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) return [...DEFAULT_OWNER_NAMES];
  return names;
}

/** 서버 owner_names 등: 빈 배열은 빈 배열(기본 보유자 주입 없음) */
function parseOwnerNamesNoDefault(raw: unknown): OwnerName[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: OwnerName[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function inferOwnerNamesFromSyncPayload(payload: {
  owner_names?: unknown;
  positions?: unknown;
  cash_by_owner?: unknown;
  holdings_sort_by_owner?: unknown;
}): OwnerName[] {
  const explicit = parseOwnerNamesNoDefault(payload.owner_names);
  // DB에 저장된 owner_names가 있으면 그것만 신뢰 (cash/sort 잔여 키로 부활 방지)
  if (explicit.length > 0) {
    return explicit;
  }
  const fromPositions = Array.isArray(payload.positions)
    ? payload.positions
        .map((p) => (p && typeof p === "object" ? (p as { owner?: unknown }).owner : undefined))
        .filter((name): name is string => typeof name === "string")
    : [];
  /** 레거시: 잔액 0 cash 키·sort 키만으로는 부활하지 않음 */
  const fromCash: string[] = [];
  if (payload.cash_by_owner && typeof payload.cash_by_owner === "object") {
    for (const [name, value] of Object.entries(payload.cash_by_owner as Record<string, unknown>)) {
      if (typeof name !== "string" || !name.trim()) continue;
      const p = parseCashPair(value);
      if (p.usd > 0 || p.krw > 0) fromCash.push(name);
    }
  }
  const inferred = parseOwnerNamesNoDefault([...fromPositions, ...fromCash]);
  if (inferred.length > 0) return inferred;
  return [...DEFAULT_OWNER_NAMES];
}

function loadOwnerNames(): OwnerName[] {
  if (typeof window === "undefined") return [...DEFAULT_OWNER_NAMES];
  try {
    const raw = window.localStorage.getItem(OWNER_NAMES_STORAGE_KEY);
    if (!raw) return [...DEFAULT_OWNER_NAMES];
    return normalizeOwnerNames(JSON.parse(raw) as unknown);
  } catch {
    return [...DEFAULT_OWNER_NAMES];
  }
}

function loadDailySnapshots(): DailySnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DAILY_SNAPSHOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is DailySnapshot =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as DailySnapshot).date === "string" &&
        typeof (s as DailySnapshot).ownerValues === "object",
    );
  } catch {
    return [];
  }
}

function loadBuyJournal(): BuyJournalEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BUY_JOURNAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is BuyJournalEntry =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as BuyJournalEntry).id === "string" &&
        typeof (e as BuyJournalEntry).date === "string" &&
        typeof (e as BuyJournalEntry).owner === "string" &&
        typeof (e as BuyJournalEntry).symbol === "string" &&
        typeof (e as BuyJournalEntry).name === "string" &&
        typeof (e as BuyJournalEntry).qty === "number" &&
        typeof (e as BuyJournalEntry).buyPrice === "number" &&
        typeof (e as BuyJournalEntry).fxRate === "number" &&
        typeof (e as BuyJournalEntry).totalKrw === "number" &&
        ((e as BuyJournalEntry).currency === "USD" ||
          (e as BuyJournalEntry).currency === "EUR" ||
          (e as BuyJournalEntry).currency === "KRW"),
    );
  } catch {
    return [];
  }
}

function loadSellLog(): Record<string, SellLogEntry[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SELL_LOG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, SellLogEntry[]> = {};
    for (const [owner, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      out[owner] = entries
        .filter(
          (e): e is Record<string, unknown> =>
            e !== null &&
            typeof e === "object" &&
            typeof (e as Record<string, unknown>).id === "string" &&
            typeof (e as Record<string, unknown>).symbol === "string" &&
            typeof (e as Record<string, unknown>).qty === "number" &&
            typeof (e as Record<string, unknown>).realizedKrw === "number",
        )
        .map((e): SellLogEntry => {
          const currency =
            e.currency === "USD" || e.currency === "EUR" || e.currency === "KRW"
              ? e.currency
              : "KRW";
          return {
            id: e.id as string,
            date: typeof e.date === "string" ? e.date : "",
            symbol: e.symbol as string,
            name: typeof e.name === "string" && e.name ? e.name : (e.symbol as string),
            qty: e.qty as number,
            sellPrice: typeof e.sellPrice === "number" ? e.sellPrice : 0,
            avgPrice: typeof e.avgPrice === "number" ? e.avgPrice : 0,
            currency,
            fxRate: typeof e.fxRate === "number" && e.fxRate > 0 ? e.fxRate : 1,
            realizedKrw: e.realizedKrw as number,
            note: typeof e.note === "string" ? e.note : undefined,
          };
        });
    }
    return out;
  } catch {
    return {};
  }
}

/** localStorage.setItem 안전 래퍼 — QuotaExceededError·프라이빗 모드 예외 방어 */
function safeSetItem(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    //
  }
}

function saveDailySnapshot(snap: DailySnapshot) {
  if (typeof window === "undefined") return;
  try {
    const existing = loadDailySnapshots();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - SNAPSHOT_MAX_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    // 같은 날짜 스냅샷은 항상 최신값으로 교체 (현금·종목 변경이 반영되도록)
    const updated = [...existing.filter((s) => s.date !== snap.date), snap]
      .filter((s) => s.date >= cutoffStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    safeSetItem(DAILY_SNAPSHOTS_KEY, JSON.stringify(updated));
  } catch {}
}


/** 보유 종목 표시 순: 입력 순(저장된 배열 순) / 평가금액 / 차트 그룹 */
type HoldingsSortMode = "manual" | "valueAsc" | "valueDesc" | "group";

function defaultHoldingsSort(): Record<OwnerName, HoldingsSortMode> {
  return Object.fromEntries(
    DEFAULT_OWNER_NAMES.map((name) => [name, "manual" as HoldingsSortMode]),
  );
}

function loadHoldingsSort(): Record<OwnerName, HoldingsSortMode> {
  const base = defaultHoldingsSort();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(HOLDINGS_SORT_STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as unknown;
    return normalizeHoldingsSortFromServer(parsed);
  } catch {
    return base;
  }
}

function normalizeHoldingsSortFromServer(raw: unknown): Record<OwnerName, HoldingsSortMode> {
  const base = defaultHoldingsSort();
  if (!raw || typeof raw !== "object") return base;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "manual" || v === "valueAsc" || v === "valueDesc" || v === "group") {
      base[name] = v;
    }
  }
  return base;
}

function sortHoldingsItems<
  T extends { valueKrw: number; chartGroup?: string; symbol: string },
>(items: T[], mode: HoldingsSortMode): T[] {
  const copy = [...items];
  if (mode === "manual") return copy;
  if (mode === "valueAsc") return copy.sort((a, b) => a.valueKrw - b.valueKrw);
  if (mode === "valueDesc") return copy.sort((a, b) => b.valueKrw - a.valueKrw);
  if (mode === "group") {
    return copy.sort((a, b) => {
      const ga = (a.chartGroup ?? "").trim();
      const gb = (b.chartGroup ?? "").trim();
      if (ga === "" && gb !== "") return 1;
      if (gb === "" && ga !== "") return -1;
      if (ga !== gb) return ga.localeCompare(gb, "ko");
      return a.symbol.localeCompare(b.symbol);
    });
  }
  return copy;
}

/** 보유 표: 차트 그룹명(없으면 티커) 기준으로 묶어 헤더 아래에 종목 표시 — 원형 차트와 동일 키 */
function buildHoldingsGroupBlocks<
  T extends { chartGroup?: string; symbol: string; valueKrw: number },
>(items: T[]): { label: string; items: T[]; sumKrw: number }[] {
  const keyFor = (p: T) => p.chartGroup?.trim() || p.symbol;
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const p of items) {
    const k = keyFor(p);
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k)!.push(p);
  }
  return order.map((label) => {
    const groupItems = map.get(label)!;
    const sumKrw = groupItems.reduce((s, x) => s + x.valueKrw, 0);
    return { label, items: groupItems, sumKrw };
  });
}

/** 그룹 헤더 툴팁: 포함 종목(이름·티커), 줄바꿈 목록 */

/** 강희진 실제 보유 기준 시드 — 김도율·김찬율도 동일 수량·평단가로 복제 */
const SEED_강희진_보유: Omit<Position, "owner">[] = [
  {
    symbol: "0022T0",
    name: "SOL 커버드콜",
    quantity: 1576,
    avgPrice: 14989,
    currentPrice: 15070,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "GOLD",
  },
  {
    symbol: "RMS",
    name: "에르메스",
    quantity: 4,
    avgPrice: 2084,
    currentPrice: 1622,
    currency: "EUR",
    purchaseEurKrw: 1532.78,
    accountType: "해외주식",
    accountName: "해외주식-유럽",
  },
  {
    symbol: "0118S0",
    name: "미국넥스트테크",
    quantity: 314,
    avgPrice: 10445,
    currentPrice: 9510,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "ATTACK",
  },
  {
    symbol: "0118Z0",
    name: "ACE 미국AI테크핵심산업액티브",
    quantity: 749,
    avgPrice: 10225,
    currentPrice: 7935,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "ATTACK",
  },
  {
    symbol: "218420",
    name: "KODEX 미국S&P500에너지",
    quantity: 202,
    avgPrice: 19475,
    currentPrice: 22400,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "XLE",
  },
  {
    symbol: "381180",
    name: "TIGER 미국필라델피아반도체나스닥",
    quantity: 70,
    avgPrice: 30622,
    currentPrice: 29665,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "AI",
  },
  {
    symbol: "487230",
    name: "KODEX 미국AI전력핵심인프라",
    quantity: 100,
    avgPrice: 20366,
    currentPrice: 19965,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "AI",
  },
  {
    symbol: "488500",
    name: "TIGER 미국S&P500동일가중",
    quantity: 693,
    avgPrice: 12548,
    currentPrice: 12105,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "S&P500",
  },
  {
    symbol: "494840",
    name: "TIGER 미국방산TOP10",
    quantity: 248,
    avgPrice: 16116,
    currentPrice: 14830,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "방산",
  },
  {
    symbol: "496770",
    name: "PLUS 글로벌방산",
    quantity: 185,
    avgPrice: 21586,
    currentPrice: 19770,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "방산",
  },
  {
    symbol: "M04020000",
    name: "금현물",
    quantity: 157,
    avgPrice: 222195,
    currentPrice: 221009,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    chartGroup: "GOLD",
  },
];

function positionsForOwner(
  seed: Omit<Position, "owner">[],
  owner: OwnerName,
): Position[] {
  return seed.map((p) => ({ ...p, owner }));
}

// 견본/시드 데이터는 사용하지 않는다. 빈 포트폴리오로 시작해야 초기화·새 키가
// 깨끗하게 비어 보이며, 옛 견본 데이터(NVDA·SEED 보유)가 되살아나지 않는다.
const DEFAULT_POSITIONS: Position[] = [];
void SEED_강희진_보유;
void positionsForOwner;

type CashByOwner = Record<OwnerName, { usd: number; krw: number }>;

const DEFAULT_CASH_BY_OWNER: CashByOwner = {
  김승주: { usd: 0, krw: 0 },
  강희진: { usd: 0, krw: 0 },
  김도율: { usd: 0, krw: 0 },
  김찬율: { usd: 0, krw: 0 },
  퇴직연금: { usd: 0, krw: 0 },
};

function isOwnerName(value: unknown): value is OwnerName {
  return typeof value === "string" && value.trim().length > 0;
}

/** 원화를 USD/KRW로 나눈 달러 표기 (Intl currency 심볼 대신 `$` 고정 — 가독성·환경 차이 대비) */
function formatKrwApproxAsUsd(krw: number, usdKrwRate: number): string {
  const rate =
    typeof usdKrwRate === "number" && usdKrwRate > 0 && Number.isFinite(usdKrwRate)
      ? usdKrwRate
      : 1350;
  const usd = krw / rate;
  if (!Number.isFinite(usd)) return "—";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 종목 평가액을 통화 기준(수량×현재가) — USD/EUR 행에 표시 */
function formatPositionMarketValueForeign(
  position: Pick<Position, "currency" | "quantity" | "currentPrice">,
): string | null {
  if (position.currency !== "USD" && position.currency !== "EUR") return null;
  const v = position.quantity * position.currentPrice;
  if (!Number.isFinite(v)) return null;
  if (position.currency === "USD") {
    return `$${fmtUsdNumber(v, 2, 2)}`;
  }
  return `€${fmtUsdNumber(v, 2, 2)}`;
}

/** 같은 담당자·같은 티커·같은 통화면 한 줄로 합칩니다(계좌 구분 무시, 가중 평단). */
function makePositionKey(p: Pick<Position, "owner" | "symbol" | "currency">) {
  return `${p.owner}|${p.symbol}|${p.currency}`;
}

/** USD 종목 합산 시 매입 환율(원화 매입액/달러 매입액) 가중평균 */
function blendPurchaseUsdKrw(existing: Position, added: Position): number | undefined {
  if (existing.currency !== "USD") return undefined;
  const usdCostE = existing.quantity * existing.avgPrice;
  const usdCostP = added.quantity * added.avgPrice;
  const fxE = existing.purchaseUsdKrw;
  const fxP = added.purchaseUsdKrw;
  const rE = fxE ?? fxP;
  const rP = fxP ?? fxE;
  if (rE != null && rP != null && rE > 0 && rP > 0) {
    return (usdCostE * rE + usdCostP * rP) / (usdCostE + usdCostP);
  }
  return undefined;
}

/** EUR 종목 합산 시 매입 EUR/KRW 가중평균 */
function blendPurchaseEurKrw(existing: Position, added: Position): number | undefined {
  if (existing.currency !== "EUR") return undefined;
  const eurCostE = existing.quantity * existing.avgPrice;
  const eurCostP = added.quantity * added.avgPrice;
  const fxE = existing.purchaseEurKrw;
  const fxP = added.purchaseEurKrw;
  const rE = fxE ?? fxP;
  const rP = fxP ?? fxE;
  if (rE != null && rP != null && rE > 0 && rP > 0) {
    return (eurCostE * rE + eurCostP * rP) / (eurCostE + eurCostP);
  }
  return undefined;
}

function mergeDuplicatePositions(positions: Position[]): Position[] {
  const map = new Map<string, Position>();
  for (const p of positions) {
    const key = makePositionKey(p);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...p });
      continue;
    }
    const newQty = existing.quantity + p.quantity;
    const newAvg =
      (existing.quantity * existing.avgPrice + p.quantity * p.avgPrice) / newQty;
    const mergedPurchase = blendPurchaseUsdKrw(existing, p);
    const mergedEur = blendPurchaseEurKrw(existing, p);
    const nextPurchase =
      mergedPurchase ?? existing.purchaseUsdKrw ?? p.purchaseUsdKrw;
    const nextEurPurchase =
      mergedEur ?? existing.purchaseEurKrw ?? p.purchaseEurKrw;
    map.set(key, {
      ...existing,
      quantity: newQty,
      avgPrice: newAvg,
      currentPrice: p.currentPrice,
      name: existing.name || p.name,
      ...(existing.currency === "USD" && nextPurchase != null && nextPurchase > 0
        ? { purchaseUsdKrw: nextPurchase }
        : {}),
      ...(existing.currency === "EUR" && nextEurPurchase != null && nextEurPurchase > 0
        ? { purchaseEurKrw: nextEurPurchase }
        : {}),
    });
  }
  return Array.from(map.values());
}

/** 할당·툴팁용 현금 번들: 동일 행 평가금액 합산 — USD/KRW「현금」은 표시명만으로 묶음(예수금·가짜 종목 줄 중복 방지) */
function mergeCashBundleDisplayEntries(
  parts: { name: string; symbol: string; value: number }[],
): { name: string; symbol: string; value: number }[] {
  const map = new Map<string, { name: string; symbol: string; value: number }>();
  for (const p of parts) {
    const sym = typeof p.symbol === "string" ? p.symbol.trim() : "";
    const nm = typeof p.name === "string" ? p.name.trim() : "";
    const key =
      nm === "USD 현금" || nm === "KRW 현금"
        ? `__byName__:${nm}`
        : `${sym}\n${nm}`;
    const cur = map.get(key);
    if (cur) cur.value += p.value;
    else
      map.set(key, {
        name: nm || p.name,
        symbol: nm === "USD 현금" || nm === "KRW 현금" ? "" : sym,
        value: p.value,
      });
  }
  return Array.from(map.values());
}

/** 종목 추가 폼: 한 건을 기존 목록에 병합하거나 새 줄 추가 */
function applyPositionUpsert(prev: Position[], nextEntry: Position): Position[] {
  const key = makePositionKey(nextEntry);
  const idx = prev.findIndex((p) => makePositionKey(p) === key);
  if (idx === -1) return [...prev, nextEntry];
  const existing = prev[idx];
  const newQty = existing.quantity + nextEntry.quantity;
  const newAvg =
    (existing.quantity * existing.avgPrice + nextEntry.quantity * nextEntry.avgPrice) / newQty;
  const mergedPurchase = blendPurchaseUsdKrw(existing, nextEntry);
  const mergedEur = blendPurchaseEurKrw(existing, nextEntry);
  const merged: Position = {
    ...existing,
    quantity: newQty,
    avgPrice: newAvg,
    currentPrice: existing.currentPrice,
    name: nextEntry.name || existing.name,
  };
  if (nextEntry.currency === "USD") {
    const px = mergedPurchase ?? existing.purchaseUsdKrw ?? nextEntry.purchaseUsdKrw;
    if (px != null && px > 0) merged.purchaseUsdKrw = px;
    delete merged.purchaseEurKrw;
  } else if (nextEntry.currency === "EUR") {
    const px = mergedEur ?? existing.purchaseEurKrw ?? nextEntry.purchaseEurKrw;
    if (px != null && px > 0) merged.purchaseEurKrw = px;
    delete merged.purchaseUsdKrw;
  } else {
    delete merged.purchaseUsdKrw;
    delete merged.purchaseEurKrw;
  }
  return prev.map((p, i) => (i === idx ? merged : p));
}

function isValidPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Position>;
  const purchaseUsdOk =
    item.currency !== "USD" ||
    item.purchaseUsdKrw === undefined ||
    (typeof item.purchaseUsdKrw === "number" &&
      Number.isFinite(item.purchaseUsdKrw) &&
      item.purchaseUsdKrw > 0);
  const purchaseEurOk =
    item.currency !== "EUR" ||
    item.purchaseEurKrw === undefined ||
    (typeof item.purchaseEurKrw === "number" &&
      Number.isFinite(item.purchaseEurKrw) &&
      item.purchaseEurKrw > 0);
  return (
    typeof item.symbol === "string" &&
    typeof item.name === "string" &&
    typeof item.quantity === "number" &&
    typeof item.avgPrice === "number" &&
    typeof item.currentPrice === "number" &&
    (item.currency === "USD" || item.currency === "EUR" || item.currency === "KRW") &&
    (item.accountType === "해외주식" || item.accountType === "국내주식") &&
    typeof item.accountName === "string" &&
    isOwnerName(item.owner) &&
    purchaseUsdOk &&
    purchaseEurOk
  );
}

function parsePositionsArray(parsed: unknown): Position[] {
  if (!Array.isArray(parsed)) return DEFAULT_POSITIONS;
  const migrated = parsed
    .map((item) => {
      if (isValidPosition(item)) return item;
      if (item && typeof item === "object") {
        const p = item as Partial<Position> & { account?: string };
        const withOwner: Partial<Position> = {
          ...p,
          owner: isOwnerName(p.owner) ? p.owner : "김승주",
        };
        if (isValidPosition(withOwner)) return withOwner as Position;
      }
      if (!item || typeof item !== "object") return null;
      const legacy = item as {
        symbol?: unknown;
        name?: unknown;
        quantity?: unknown;
        avgPrice?: unknown;
        currentPrice?: unknown;
        currency?: unknown;
        account?: unknown;
      };
      if (
        typeof legacy.symbol !== "string" ||
        typeof legacy.name !== "string" ||
        typeof legacy.quantity !== "number" ||
        typeof legacy.avgPrice !== "number" ||
        typeof legacy.currentPrice !== "number" ||
        (legacy.currency !== "USD" &&
          legacy.currency !== "EUR" &&
          legacy.currency !== "KRW")
      ) {
        return null;
      }
      const accountType =
        legacy.account === "국내주식" || legacy.currency === "KRW" ? "국내주식" : "해외주식";
      const accountName =
        accountType === "국내주식" ? "국내주식-주계좌" : "미국주식-주계좌";
      return {
        symbol: legacy.symbol,
        name: legacy.name,
        quantity: legacy.quantity,
        avgPrice: legacy.avgPrice,
        currentPrice: legacy.currentPrice,
        currency: legacy.currency,
        accountType,
        accountName,
        owner: "김승주",
      } satisfies Position;
    })
    .filter((item): item is Position => item !== null);
  const list = migrated.length > 0 ? migrated : DEFAULT_POSITIONS;
  return mergeDuplicatePositions(list);
}

function loadPositions(): Position[] {
  if (typeof window === "undefined") return DEFAULT_POSITIONS;
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      return parsePositionsArray(JSON.parse(rawV2) as unknown);
    }
    const rawV1 = window.localStorage.getItem(LEGACY_POSITIONS_STORAGE_KEY);
    if (rawV1) {
      const list = parsePositionsArray(JSON.parse(rawV1) as unknown);
      safeSetItem(STORAGE_KEY, JSON.stringify(list));
      window.localStorage.removeItem(LEGACY_POSITIONS_STORAGE_KEY);
      return list;
    }
    return DEFAULT_POSITIONS;
  } catch {
    return DEFAULT_POSITIONS;
  }
}

function parseCashPair(raw: unknown): { usd: number; krw: number } {
  if (!raw || typeof raw !== "object") return { usd: 0, krw: 0 };
  const o = raw as { usd?: unknown; krw?: unknown };
  const usd = Number(o.usd ?? 0);
  const krw = Number(o.krw ?? 0);
  return {
    usd: Number.isFinite(usd) && usd >= 0 ? usd : 0,
    krw: Number.isFinite(krw) && krw >= 0 ? krw : 0,
  };
}

function loadCashByOwner(): CashByOwner {
  if (typeof window === "undefined") return { ...DEFAULT_CASH_BY_OWNER };
  try {
    const raw = window.localStorage.getItem(CASH_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CASH_BY_OWNER };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CASH_BY_OWNER };
    const obj = parsed as Record<string, unknown>;
    if ("usd" in obj || "krw" in obj) {
      const legacy = parseCashPair(parsed);
      return { ...DEFAULT_CASH_BY_OWNER, 김승주: { ...legacy } };
    }
    const next: CashByOwner = { ...DEFAULT_CASH_BY_OWNER };
    for (const [name, value] of Object.entries(obj)) {
      if (typeof name === "string" && name.trim()) {
        next[name] = parseCashPair(value);
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_CASH_BY_OWNER };
  }
}

/** 서버 pull 전용: owner_names 기준으로만 cash 복원 (DEFAULT 강제 주입 없음) */
/** 서버 pull 전용: 매수저널 복원 (loadBuyJournal과 동일 검증 + owner_names 필터) */
function normalizeBuyJournalStrict(raw: unknown, owners: OwnerName[]): BuyJournalEntry[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(owners);
  return raw
    .filter(
      (e): e is BuyJournalEntry =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as BuyJournalEntry).id === "string" &&
        typeof (e as BuyJournalEntry).date === "string" &&
        typeof (e as BuyJournalEntry).owner === "string" &&
        typeof (e as BuyJournalEntry).symbol === "string" &&
        typeof (e as BuyJournalEntry).name === "string" &&
        typeof (e as BuyJournalEntry).qty === "number" &&
        typeof (e as BuyJournalEntry).buyPrice === "number" &&
        typeof (e as BuyJournalEntry).fxRate === "number" &&
        typeof (e as BuyJournalEntry).totalKrw === "number" &&
        ((e as BuyJournalEntry).currency === "USD" ||
          (e as BuyJournalEntry).currency === "EUR" ||
          (e as BuyJournalEntry).currency === "KRW"),
    )
    .filter((e) => allowed.has(e.owner))
    .slice(-BUY_JOURNAL_MAX);
}

function normalizeCashStrict(raw: unknown, owners: OwnerName[]): CashByOwner {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base: CashByOwner = {};
  for (const name of owners) {
    base[name] = parseCashPair(obj[name] ?? { usd: 0, krw: 0 });
  }
  return base;
}

/** 서버 pull 전용: owner_names 기준으로만 정렬 설정 복원 (DEFAULT 강제 주입 없음) */
function normalizeHoldingsSortStrict(
  raw: unknown,
  owners: OwnerName[],
): Record<OwnerName, HoldingsSortMode> {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base: Record<OwnerName, HoldingsSortMode> = {};
  for (const name of owners) {
    const v = obj[name];
    base[name] =
      v === "manual" || v === "valueAsc" || v === "valueDesc" || v === "group"
        ? v
        : "manual";
  }
  return base;
}

/** 서버 pull 전용: owner_names 기준으로만 매도 로그 복원 */
function normalizeSellLogStrict(
  raw: unknown,
  owners: OwnerName[],
): Record<string, SellLogEntry[]> {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base: Record<string, SellLogEntry[]> = {};
  for (const name of owners) {
    const entries = obj[name];
    if (!Array.isArray(entries)) {
      base[name] = [];
      continue;
    }
    // 필수 최소 필드(id, symbol, qty, realizedKrw)만 확인하고, 누락 필드는 기본값으로 복원.
    // 이전에 fxRate 등이 없던 구버전 항목도 조용히 삭제되지 않도록 방어.
    base[name] = entries
      .filter(
        (e): e is Record<string, unknown> =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as Record<string, unknown>).id === "string" &&
          typeof (e as Record<string, unknown>).symbol === "string" &&
          typeof (e as Record<string, unknown>).qty === "number" &&
          typeof (e as Record<string, unknown>).realizedKrw === "number",
      )
      .map((e): SellLogEntry => {
        const currency =
          e.currency === "USD" || e.currency === "EUR" || e.currency === "KRW"
            ? e.currency
            : "KRW";
        return {
          id: e.id as string,
          date: typeof e.date === "string" ? e.date : "",
          symbol: e.symbol as string,
          name: typeof e.name === "string" && e.name ? e.name : (e.symbol as string),
          qty: e.qty as number,
          sellPrice: typeof e.sellPrice === "number" ? e.sellPrice : 0,
          avgPrice: typeof e.avgPrice === "number" ? e.avgPrice : 0,
          currency,
          fxRate: typeof e.fxRate === "number" && e.fxRate > 0 ? e.fxRate : 1,
          realizedKrw: e.realizedKrw as number,
          note: typeof e.note === "string" ? e.note : undefined,
        };
      });
  }
  return base;
}

/**
 * 서버 `updated_at`이 로컬 `portfolio_last_sync_ts_v1`보다 새로운지.
 * 로컬 시각이 비어 있으면(저장소 삭제·최초) 항상 true → 서버 스냅샷을 반영해야 함.
 * 문자열만 `>`로 비교하면 `"" > ""`가 false가 되어 pull 적용이 건너뛰어질 수 있다.
 */
/**
 * 충돌 자동 해소 기준: 이 기기가 이 시간 안에 서버와 동기화된 적이 있으면
 * 데이터가 낡지 않았다고 보고, 묻지 않고 이 기기 변경을 우선 저장한다(서버는 자동 백업).
 * 모달은 이 시간보다 오래 동기화가 끊겼던 기기(며칠 묵은 탭 등)에서만 띄운다.
 */
const CONFLICT_AUTO_PUSH_IF_SYNCED_WITHIN_MS = 10 * 60_000;

/** 자동 이행(매수저널·알림 보존) 플래그 최소 재시도 간격 — 업로드가 계속 실패해도 push 폭주 방지 */
const AUTO_KEEP_AT_KEY = "portfolio_auto_migration_keep_at_v1";
const AUTO_KEEP_MIN_INTERVAL_MS = 10 * 60_000;

function canMarkAutoMigrationKeep(): boolean {
  try {
    const raw = window.localStorage.getItem(AUTO_KEEP_AT_KEY);
    if (!raw) return true;
    const t = Date.parse(raw);
    return !Number.isFinite(t) || Date.now() - t >= AUTO_KEEP_MIN_INTERVAL_MS;
  } catch {
    return true;
  }
}

function recordAutoMigrationKeep(): void {
  try {
    window.localStorage.setItem(AUTO_KEEP_AT_KEY, new Date().toISOString());
  } catch {
    //
  }
}

/** 충돌 확인창용 KST 시각 표기: "6. 13. 09:12" (파싱 실패 시 "시각 미상") */
function formatKstForConflict(isoRaw: string): string {
  const t = Date.parse(isoRaw.trim());
  if (!Number.isFinite(t)) return "시각 미상";
  return new Date(t).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isServerSnapshotNewerThanLocal(serverTsRaw: string, lastSyncTsRaw: string): boolean {
  const serverTs = serverTsRaw.trim();
  const lastSyncTs = lastSyncTsRaw.trim();
  if (lastSyncTs.length === 0) return true;
  if (serverTs.length === 0) return false;
  const a = Date.parse(serverTs);
  const b = Date.parse(lastSyncTs);
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
  return serverTs > lastSyncTs;
}

/**
 * 서버 push용: 라이브 시세가 있으면 currentPrice를 최신값으로 교체.
 * 클라이언트는 평소 currentPrice를 갱신하지 않아(추가 시점 가격에 고정) 서버 값이 오래되는데,
 * 이러면 크론이 시세 조회에 실패한 날 폴백(currentPrice)이 매우 stale해져 가짜 등락을 만든다.
 * push 시점에 최신 시세를 실어 보내면 크론 폴백값이 항상 최신에 가깝게 유지된다.
 */
function positionsWithLivePrices(
  list: Position[],
  quotes: Record<string, { price?: number | null } | undefined> | undefined,
): Position[] {
  if (!quotes) return list;
  return list.map((p) => {
    const lp = quotes[p.symbol]?.price;
    return typeof lp === "number" && Number.isFinite(lp) && lp > 0 ? { ...p, currentPrice: lp } : p;
  });
}

/**
 * 미국 주간거래/시간외 현재가 폴링 대상 시간 — 평일(KST)이면 종일.
 * KIS 주간거래·정규·시간외 데이터가 하루 중 넓은 시간대에 들어오므로 시간은 제한하지 않고
 * 주말(미국 휴장)만 제외한다. 세션이 없어 시세가 안 오면 엔드포인트가 알아서 빈 값을 주고,
 * 프론트는 price>0일 때만 덮어쓰므로 안전하다.
 */
function isUsTradingDayPollWindow(now: Date = new Date()): boolean {
  // 미국 거래일(월~금)은 반드시 미국 동부(ET) 요일로 판단.
  // KST 기준으로 하면 미국 금요일 오후(=KST 토요일 새벽)가 잘못 제외돼 정규장이 안 잡힌다.
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  return wd !== "Sat" && wd !== "Sun";
}

/** Yahoo가 라이브 시세를 주는 미국 세션(프리·정규·애프터마켓).
 *  이 구간엔 Yahoo가 실제 프리/애프터 가격을 갱신하므로 그대로 쓰고,
 *  그 외(POSTPOST·PREPRE·CLOSED·미상 = 미국 야간 = 한국 낮)엔 KIS 주간거래(블루오션) 시세로 덮어쓴다.
 *  KIS 주간거래는 미국 새벽 ~4시에 종료돼, 실제 프리마켓 시간엔 마지막 체결가에 멈추기 때문. */
function isYahooLiveUsSession(state: MarketState | undefined): boolean {
  return state === "PRE" || state === "REGULAR" || state === "POST";
}

/** 포지션·보유자 로컬 캐시가 없으면(부분 삭제) 동기 시각만 남아 pull이 건너뛰어지는 문제를 막기 위함 */
function isLocalPortfolioCacheCleared(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const pos = window.localStorage.getItem(STORAGE_KEY);
    const owners = window.localStorage.getItem(OWNER_NAMES_STORAGE_KEY);
    return pos == null || pos === "" || owners == null || owners === "";
  } catch {
    return true;
  }
}

export default function Home() {
  // SSR과 클라이언트 첫 렌더에서 동일한 초기값을 보장(hydration 불일치 방지).
  // localStorage에서 실제 값을 읽는 것은 아래 init useEffect에서 처리.
  // DEFAULT_OWNER_NAMES는 as const(readonly)이므로 스프레드로 mutable 배열로 변환
  const [ownerNames, setOwnerNames] = useState<OwnerName[]>([...DEFAULT_OWNER_NAMES]);
  const [positions, setPositions] = useState<Position[]>(DEFAULT_POSITIONS);
  const [cashByOwner, setCashByOwner] = useState<CashByOwner>(DEFAULT_CASH_BY_OWNER);
  const [isHydrated, setIsHydrated] = useState(false);
  const [dailySnapshots, setDailySnapshots] = useState<DailySnapshot[]>([]);
  const [buyJournal, setBuyJournal] = useState<BuyJournalEntry[]>([]);
  const [sellLog, setSellLog] = useState<Record<string, SellLogEntry[]>>({});
  const [showTradeImageImport, setShowTradeImageImport] = useState(false);
  const [buyPasteError, setBuyPasteError] = useState("");
  const [buyPasteText, setBuyPasteText] = useState("");
  const [sellPasteText, setSellPasteText] = useState("");
  const [showSymbolPnl, setShowSymbolPnl] = useState<Record<string, boolean>>({});
  const [sellLogErrorByOwner, setSellLogErrorByOwner] = useState<Record<string, string>>({});
  const [sellLogOwnerForSection, setSellLogOwnerForSection] = useState<string>("김승주");
  /** 실현손익 '기록 목록' 열람용 보유자(입력 폼의 보유자와 독립) */
  const [sellLogListViewOwner, setSellLogListViewOwner] = useState<string>("김승주");
  /** 기록 목록 UI 접힘(기본 접힘) */
  const [sellLogListExpanded, setSellLogListExpanded] = useState(false);
  /** 종목별 합산 패널 접힘 */
  const [sellLogSymSummaryExpanded, setSellLogSymSummaryExpanded] = useState(false);
  /** 종목별 합산 보유자 필터: 빈 배열 = 전체 선택 */
  const [sellLogSymOwnerFilter, setSellLogSymOwnerFilter] = useState<string[]>([]);
  /** 실현손익 티커 검색 combobox: owner별 검색어 */
  const [sellTickerSearch, setSellTickerSearch] = useState<Record<string, string>>({});
  /** 실현손익 티커 검색 combobox: owner별 드롭다운 열림 여부 */
  const [sellTickerOpen, setSellTickerOpen] = useState<Record<string, boolean>>({});
  /** 실현손익 티커 검색 combobox: owner별 키보드 하이라이트 인덱스 */
  const [sellTickerHl, setSellTickerHl] = useState<Record<string, number>>({});
  /** 실현손익 티커 입력 ref: 기록 추가 후 포커스 복귀용 */
  const sellTickerInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [sellLogForm, setSellLogForm] = useState<Record<string, {
    date: string; symbol: string; name: string; qty: string;
    sellPrice: string; avgPrice: string; currency: "USD" | "EUR" | "KRW"; fxRate: string; note: string;
    selectedOwners: string[];
    ownerOverrides: Record<string, { qty: string; avgPrice: string; fxRate: string }>;
    editingId: string | null;
  }>>({});
  const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
  const [pendingSaveConfirm, setPendingSaveConfirm] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ type: "edit" | "delete"; rowIndex: number; position: Position } | null>(null);
  const [pendingClearConfirm, setPendingClearConfirm] = useState(false);
  const [editSymbol, setEditSymbol] = useState("");
  const [editName, setEditName] = useState("");
  const [editChartGroup, setEditChartGroup] = useState("");
  const [editQuantity, setEditQuantity] = useState("");
  const [editAvgPrice, setEditAvgPrice] = useState("");
  const [editPurchaseUsdKrw, setEditPurchaseUsdKrw] = useState("");
  const [editPurchaseEurKrw, setEditPurchaseEurKrw] = useState("");
  const [signalDetailTarget, setSignalDetailTarget] = useState<{ symbol: string; name: string } | null>(
    null,
  );
  const [sellLogDetailOpenOwner, setSellLogDetailOpenOwner] = useState<string | null>(null);

  const [cloudSyncKey, setCloudSyncKey] = useState("");
  const [syncKeyDraft, setSyncKeyDraft] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [syncReady, setSyncReady] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const restoreBackupFileInputRef = useRef<HTMLInputElement>(null);
  const [syncMessage, setSyncMessage] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastSellLogSyncedAt, setLastSellLogSyncedAt] = useState<string | null>(null);
  const [sellLogDirty, setSellLogDirty] = useState(false);
  const [latestBackupAt, setLatestBackupAt] = useState<string | null>(null);
  /** 서버 `portfolio_daily_snapshots` 최신 일자 행의 `created_at`(크론·upsert 최초 기록 시각 근사) */
  const [cronDailySnapshotRecordedAt, setCronDailySnapshotRecordedAt] = useState<string | null>(
    null,
  );
  const [hasLoadedLatestBackup, setHasLoadedLatestBackup] = useState(false);
  /** 백업 선택 복원용: 파싱된 백업 파일 데이터 */
  const [pendingBackups, setPendingBackups] = useState<Array<{ id?: string; created_at: string; snapshot: Record<string, unknown> }> | null>(null);
  const [pendingBackupFileKey, setPendingBackupFileKey] = useState<string>("");
  const [serverHealth, setServerHealth] = useState<"loading" | "ok" | "error">("loading");
  const pushDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * positions/cash useEffect에서 HAS_LOCAL_CHANGES_KEY 설정을 건너뛸 횟수.
   * - 최초 하이드레이션(디스크→state 재적용)이나 서버 Pull 반영 시에는
   *   "사용자가 수정"한 것이 아니므로 로컬 변경 플래그를 올리지 않아야 한다.
   * - setPositions + setCashByOwner를 한 번 호출할 때마다 2를 설정.
   */
  const skipMarkLocalChangedRef = useRef(0);
  const skipAlertThresholdsHydrateRef = useRef(0);
  const skipOwnerLocalChangedRef = useRef(0);
  const skipSellLogLocalChangedRef = useRef(0);
  const skipBuyJournalLocalChangedRef = useRef(0);
  const [holdingsSortByOwner, setHoldingsSortByOwner] =
    useState<Record<OwnerName, HoldingsSortMode>>(defaultHoldingsSort);
  /** 보유자별 심플 종목 요약 테이블 접힘 여부 */
  const [holdingsSummaryCollapsed, setHoldingsSummaryCollapsed] = useState<Record<string, boolean>>({});

  const [telegramTestBusy, setTelegramTestBusy] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState<{
    ok: boolean;
    env?: Record<string, string>;
    symbols?: Array<{ symbol: string; changePct: number | null; willAlert: boolean }>;
    alertCount?: number;
    alreadySentToday?: string[];
    message?: string;
    error?: string;
    detail?: Record<string, string>;
    watchlistCount?: number;
    watchlistSignals?: unknown[];
    sentHoldings?: number;
    sentWatchlist?: number;
  } | null>(null);
  const WATCHLIST_OWNER_ALL = "__ALL__";

  type WatchlistRow = { symbol: string; name: string; group?: string; owners?: string[] };
  const [watchlistRows, setWatchlistRows] = useState<WatchlistRow[]>([]);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchlistMessage, setWatchlistMessage] = useState("");

  /** 보유자::티커 → 익절·손절 가격 및 수익률 % 기준 */
  const [alertThresholdsByKey, setAlertThresholdsByKey] = useState<AlertThresholdsByKey>({});
  /** 보유 표 기준선 열 — 평소 숨김, 토글로 표시 */
  const [showHoldingsAlertColumn, setShowHoldingsAlertColumn] = useState(false);
  /** 종목별 합산 표 기준선(익·손 %) 열 */
  const [showAggAlertColumn, setShowAggAlertColumn] = useState(true);

  const patchPositionAlertPrice = useCallback(
    (
      positionKey: string,
      field: "takeProfitPrice" | "stopLossPrice",
      value: number | undefined,
    ) => {
      setAlertThresholdsByKey((prev) => {
        const next = { ...prev };
        const cur: AlertRule = { ...(next[positionKey] ?? {}) };
        if (value === undefined || !Number.isFinite(value)) {
          delete cur[field];
        } else {
          cur[field] = value;
        }
        const empty = cur.takeProfitPrice === undefined && cur.stopLossPrice === undefined;
        if (empty) delete next[positionKey];
        else next[positionKey] = cur;
        return next;
      });
    },
    [],
  );

  /** 티커 공통 % — 종목별 합산 표에서 입력 */
  const patchSymbolAlertPct = useCallback(
    (
      symbolKeys: string[],
      field: "takeProfitReturnPct" | "stopLossReturnPct",
      value: number | undefined,
    ) => {
      if (symbolKeys.length === 0) return;
      setAlertThresholdsByKey((prev) => {
        const next = { ...prev };
        for (const sym of symbolKeys) {
          const storageKey = symbolAlertKey(sym);
          const cur: AlertRule = { ...(next[storageKey] ?? {}) };
          if (value === undefined || !Number.isFinite(value)) {
            delete cur[field];
          } else {
            cur[field] = value;
          }
          const empty =
            cur.takeProfitReturnPct === undefined && cur.stopLossReturnPct === undefined;
          if (empty) delete next[storageKey];
          else next[storageKey] = cur;
          const suffix = `::${sym}`;
          for (const k of Object.keys(next)) {
            if (k.startsWith("*::") || !k.endsWith(suffix)) continue;
            const pos = { ...(next[k] ?? {}) };
            delete pos.takeProfitReturnPct;
            delete pos.stopLossReturnPct;
            if (Object.keys(pos).length === 0) delete next[k];
            else next[k] = pos;
          }
        }
        return next;
      });
    },
    [],
  );

  /**
   * 보유자별 기준선 저장: localStorage(현재 state) + 서버 push.
   */
  const [savingAlertOwner, setSavingAlertOwner] = useState<string | null>(null);
  const [savingAlertAll, setSavingAlertAll] = useState(false);

  const pushAlertThresholdsToServer = useCallback(async () => {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 먼저 설정해야 서버에 저장할 수 있습니다.");
      return false;
    }
    safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(alertThresholdsByKey));
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "push",
        key,
        positions,
        cashByOwner,
        holdingsSortByOwner,
        sellLogByOwner: sellLog,
        ownerNames,
        targetStockWeightByOwner: loadAllTargetStockWeights(),
        ownerScratchpadByOwner: loadAllOwnerScratchpads(),
        rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
        usdKrw: fxRef.current.usd,
        eurKrw: fxRef.current.eur,
        ...getAlertThresholdsPayload(),
      }),
    });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
      const ts = j.updated_at ?? new Date().toISOString();
      safeSetItem(LAST_SYNC_TS_KEY, ts);
      clearLocalChanged();
      setLastSyncedAt(ts);
      return true;
    }
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setSyncMessage(j.error ?? "서버 저장 실패");
    return false;
  }, [
    cloudSyncKey,
    positions,
    cashByOwner,
    holdingsSortByOwner,
    sellLog,
    ownerNames,
    alertThresholdsByKey,
  ]);

  const saveAlertThresholdsForOwner = useCallback(
    async (ownerName: string) => {
      setSavingAlertOwner(ownerName);
      try {
        const ok = await pushAlertThresholdsToServer();
        if (ok) setSyncMessage(`${ownerName} 보유자 기준선(가격)을 서버에 저장했습니다.`);
      } finally {
        setSavingAlertOwner(null);
      }
    },
    [pushAlertThresholdsToServer],
  );

  const saveAllAlertThresholds = useCallback(async () => {
    setSavingAlertAll(true);
    try {
      const ok = await pushAlertThresholdsToServer();
      if (ok) setSyncMessage("기준선(가격·수익률 %)을 서버에 저장했습니다.");
    } finally {
      setSavingAlertAll(false);
    }
  }, [pushAlertThresholdsToServer]);

  const [form, setForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    purchaseUsdKrw: "",
    purchaseEurKrw: "",
    /** USD 매입 환율 자동입력용 매입일(한국 달력). 입력 시 매입일+2일 09:00(KST) 근처 Yahoo USD/KRW 반영 */
    purchaseDateForFx: "",
    /** 원형 차트·보유 표 그룹(미입력 시 티커); 현금성 자산은 「현금」 등으로 묶기 */
    chartGroup: "",
    currency: "USD" as "USD" | "EUR" | "KRW",
    accountType: "해외주식" as "해외주식" | "국내주식",
    /** 종목 추가 시 한 번에 넣을 담당자(복수) */
    selectedOwners: ["김승주"] as OwnerName[],
  });
  /** 종목명 수동 입력 시 자동 채움 비활성 (티커·통화·담당자 바꾸면 해제) */
  const skipAddFormAutoNameRef = useRef(false);
  /** 차트 그룹 수동 입력 시 자동 채움 비활성 */
  const skipAddFormAutoChartGroupRef = useRef(false);
  /** 종목 추가 폼: 추가 후 포커스 복귀용 티커 입력 ref */
  const addSymbolInputRef = useRef<HTMLInputElement>(null);
  /** 보유 티커 커스텀 자동완성 패널 */
  const [holdingsTickerSuggestOpen, setHoldingsTickerSuggestOpen] = useState(false);
  const [holdingsTickerSuggestHl, setHoldingsTickerSuggestHl] = useState(0);
  /** 매입 USD/KRW를 직접 수정한 뒤에는 매입일 자동 환율이 덮어쓰지 않음 */
  const addFormFxManualRef = useRef(false);
  const [purchaseFxAutoBusy, setPurchaseFxAutoBusy] = useState(false);
  const [addPositionError, setAddPositionError] = useState("");
  /** 종목 추가 누락 보유자 추적: 입력한 종목 목록과 완료한 보유자 목록 */
  const [addOwnerTracker, setAddOwnerTracker] = useState<
    { symbol: string; name: string; isKorean: boolean; doneOwners: string[] }[]
  >([]);
  /** 실현손익 누락 보유자 추적: 최근 입력한 티커·날짜와 완료한 보유자 목록 */
  const [sellOwnerTracker, setSellOwnerTracker] = useState<{ symbol: string; date: string; doneOwners: string[] } | null>(null);
  const [focusSymbolTrigger, setFocusSymbolTrigger] = useState(0);
  const actionSuccessToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionSuccessToast, setActionSuccessToast] = useState("");
  const showActionSuccessToast = useCallback((message: string) => {
    if (actionSuccessToastTimerRef.current) {
      clearTimeout(actionSuccessToastTimerRef.current);
    }
    setActionSuccessToast(message);
    actionSuccessToastTimerRef.current = setTimeout(() => {
      setActionSuccessToast("");
      actionSuccessToastTimerRef.current = null;
    }, 3200);
  }, []);
  const actionErrorToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionErrorToast, setActionErrorToast] = useState("");
  const showActionErrorToast = useCallback((message: string) => {
    if (actionErrorToastTimerRef.current) {
      clearTimeout(actionErrorToastTimerRef.current);
    }
    setActionErrorToast(message);
    actionErrorToastTimerRef.current = setTimeout(() => {
      setActionErrorToast("");
      actionErrorToastTimerRef.current = null;
    }, 4200);
  }, []);

  useEffect(
    () => () => {
      if (actionSuccessToastTimerRef.current) {
        clearTimeout(actionSuccessToastTimerRef.current);
      }
      if (actionErrorToastTimerRef.current) {
        clearTimeout(actionErrorToastTimerRef.current);
      }
    },
    [],
  );

  // 실현손익 추적: 관련 보유자 전원 완료 시 2.5초 후 자동 닫힘
  useEffect(() => {
    if (!sellOwnerTracker) return;
    const holders = ownerNames.filter((n) =>
      positions.some((p) => p.owner === n && p.symbol === sellOwnerTracker.symbol),
    );
    if (holders.length === 0) return;
    if (holders.some((n) => !sellOwnerTracker.doneOwners.includes(n))) return;
    const t = setTimeout(() => setSellOwnerTracker(null), 2500);
    return () => clearTimeout(t);
  }, [sellOwnerTracker, ownerNames, positions]);

  /** 상단 내비 활성 항목(스크롤 앵커 id 또는 dashboard) */
  const [activeTopNav, setActiveTopNav] = useState<string>("dashboard");
  const holdingsNavRef = useRef<HTMLDivElement>(null);
  const holdingsMenuRef = useRef<HTMLDivElement>(null);
  const [holdingsNavOpen, setHoldingsNavOpen] = useState(false);
  /** 종목별 합산 표 정렬 */
  const [holdingsBySymbolSort, setHoldingsBySymbolSort] = useState<
    "name" | "valueKrw" | "pnlPct" | "pnlKrw" | "owners"
  >("valueKrw");
  /** 종목별 합산: 티커 단위 vs 차트 그룹(같은 그룹명 합산) */
  const [holdingsBySymbolView, setHoldingsBySymbolView] = useState<
    "ticker" | "chartGroup"
  >("ticker");
  const [holdingsMenuPos, setHoldingsMenuPos] = useState<{
    top: number;
    left: number;
    minW: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!holdingsNavOpen) {
      setHoldingsMenuPos(null);
      return;
    }
    const el = holdingsNavRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const minW = Math.max(200, Math.round(rect.width));
    let left = rect.left;
    if (typeof window !== "undefined") {
      const pad = 8;
      left = Math.max(pad, Math.min(left, window.innerWidth - minW - pad));
    }
    setHoldingsMenuPos({ top: Math.round(rect.bottom + 6), left: Math.round(left), minW });
  }, [holdingsNavOpen, ownerNames.length]);

  useEffect(() => {
    if (!holdingsNavOpen) return;
    const onScrollOrResize = () => {
      const el = holdingsNavRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const minW = Math.max(200, Math.round(rect.width));
      let left = rect.left;
      if (typeof window !== "undefined") {
        const pad = 8;
        left = Math.max(pad, Math.min(left, window.innerWidth - minW - pad));
      }
      setHoldingsMenuPos({ top: Math.round(rect.bottom + 6), left: Math.round(left), minW });
    };
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [holdingsNavOpen, ownerNames.length]);

  useEffect(() => {
    if (!holdingsNavOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (holdingsNavRef.current?.contains(t) || holdingsMenuRef.current?.contains(t)) return;
      setHoldingsNavOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [holdingsNavOpen]);

  const goDashboardTop = useCallback(() => {
    setActiveTopNav("dashboard");
  }, []);

  const goDashboardSection = useCallback((elementId: string) => {
    setActiveTopNav(elementId);
    setHoldingsNavOpen(false);
  }, []);

  useEffect(() => {
    setAddPositionError("");
  }, [
    form.symbol,
    form.name,
    form.currency,
    form.selectedOwners,
    form.quantity,
    form.avgPrice,
    form.chartGroup,
    form.purchaseUsdKrw,
    form.purchaseEurKrw,
    form.purchaseDateForFx,
  ]);

  useEffect(() => {
    if (form.currency !== "USD") return;
    if (addFormFxManualRef.current) return;
    const ymd = form.purchaseDateForFx.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;

    const ac = new AbortController();
    let cancelled = false;

    void (async () => {
      setPurchaseFxAutoBusy(true);
      try {
        const r = await fetch(
          `/api/market/fx-settlement?purchaseDate=${encodeURIComponent(ymd)}`,
          { signal: ac.signal },
        );
        const j = (await r.json()) as { rate?: number; error?: string };
        if (!r.ok) throw new Error(j.error ?? "조회 실패");
        if (typeof j.rate !== "number" || !Number.isFinite(j.rate) || j.rate <= 0) {
          throw new Error("환율 데이터 없음");
        }
        if (cancelled) return;
        const rounded = Math.round(j.rate * 1000) / 1000;
        setForm((prev) => ({ ...prev, purchaseUsdKrw: String(rounded) }));
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        if (!cancelled) {
          showActionErrorToast(e instanceof Error ? e.message : "과거 환율 조회 실패");
        }
      } finally {
        if (!cancelled) setPurchaseFxAutoBusy(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [form.currency, form.purchaseDateForFx, showActionErrorToast]);

  // 정산환율 자동 보정: purchaseFxPending(현재환율 임시) USD 포지션·매수저널 중,
  // 매수일 + 2영업일 09:00 KST가 지난 것은 실제 정산환율을 받아 매입환율(·저널 환율/총액)을 교체한다.
  const settlementBackfillBusyRef = useRef(false);
  useEffect(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const isDue = (d: string): boolean => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      const target = krSettlementTargetUnixSec(d, 2, 9);
      return target !== null && target <= nowSec;
    };
    const dueDates = new Set<string>();
    for (const p of positions) {
      if (p.purchaseFxPending && p.currency === "USD" && typeof p.purchaseDate === "string") {
        const d = p.purchaseDate.trim();
        if (isDue(d)) dueDates.add(d);
      }
    }
    for (const b of buyJournal) {
      if (b.fxPending && b.currency === "USD" && typeof b.date === "string") {
        const d = b.date.trim();
        if (isDue(d)) dueDates.add(d);
      }
    }
    if (dueDates.size === 0 || settlementBackfillBusyRef.current) return;

    settlementBackfillBusyRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const rateByDate: Record<string, number> = {};
        for (const d of dueDates) {
          try {
            const r = await fetch(`/api/market/fx-settlement?purchaseDate=${encodeURIComponent(d)}`);
            const j = (await r.json()) as { rate?: number };
            if (r.ok && typeof j.rate === "number" && Number.isFinite(j.rate) && j.rate > 0) {
              rateByDate[d] = Math.round(j.rate * 1000) / 1000;
            }
          } catch {
            // 조회 실패한 날짜는 다음 기회에 다시 시도
          }
        }
        if (cancelled || Object.keys(rateByDate).length === 0) return;
        let anyChange = false;
        setPositions((prev) => {
          let changed = false;
          const next = prev.map((p) => {
            if (
              p.purchaseFxPending &&
              p.currency === "USD" &&
              typeof p.purchaseDate === "string" &&
              rateByDate[p.purchaseDate] != null
            ) {
              changed = true;
              const { purchaseFxPending: _drop, ...rest } = p;
              void _drop;
              return { ...rest, purchaseUsdKrw: rateByDate[p.purchaseDate] };
            }
            return p;
          });
          if (changed) anyChange = true;
          return changed ? next : prev;
        });
        setBuyJournal((prev) => {
          let changed = false;
          const next = prev.map((b) => {
            if (b.fxPending && b.currency === "USD" && rateByDate[b.date] != null) {
              changed = true;
              const fx = rateByDate[b.date];
              const { fxPending: _drop, ...rest } = b;
              void _drop;
              return { ...rest, fxRate: fx, totalKrw: b.qty * b.buyPrice * fx };
            }
            return b;
          });
          if (changed) anyChange = true;
          return changed ? next : prev;
        });
        if (anyChange) markLocalChanged();
      } finally {
        settlementBackfillBusyRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [positions, buyJournal]);

  // 매수저널 환율을 보유표 매입환율에 단방향 동기화한다.
  // (같은 보유자+종목+통화의 포지션 매입환율을 따름. 둘이 다르면 보유표가 기준)
  useEffect(() => {
    if (buyJournal.length === 0 || positions.length === 0) return;
    setBuyJournal((prev) => {
      let changed = false;
      const next = prev.map((b) => {
        if (b.currency === "KRW") return b;
        const pos = positions.find(
          (p) => p.owner === b.owner && p.symbol === b.symbol && p.currency === b.currency,
        );
        if (!pos) return b;
        const rate = b.currency === "USD" ? pos.purchaseUsdKrw : pos.purchaseEurKrw;
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return b;
        if (Math.abs(rate - b.fxRate) < 1e-6) return b;
        changed = true;
        return { ...b, fxRate: rate, totalKrw: b.qty * b.buyPrice * rate };
      });
      if (changed) markLocalChanged();
      return changed ? next : prev;
    });
  }, [positions, buyJournal]);

  const refreshLatestBackupAt = useCallback(async () => {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setLatestBackupAt(null);
      setHasLoadedLatestBackup(false);
      return;
    }
    setHasLoadedLatestBackup(false);
    try {
      const r = await fetch(`/api/backup/latest?sync_key=${encodeURIComponent(key)}`);
      const j = (await r.json()) as { latest_backup_at?: string | null };
      if (!r.ok) {
        setLatestBackupAt(null);
        setHasLoadedLatestBackup(false);
        return;
      }
      setHasLoadedLatestBackup(true);
      setLatestBackupAt(j.latest_backup_at ?? null);
    } catch {
      setLatestBackupAt(null);
      setHasLoadedLatestBackup(false);
    }
  }, [cloudSyncKey]);

  useEffect(() => {
    if (!syncReady || cloudSyncKey.trim().length < 8) {
      setLatestBackupAt(null);
      setHasLoadedLatestBackup(false);
      return;
    }
    void refreshLatestBackupAt();
  }, [syncReady, cloudSyncKey, refreshLatestBackupAt]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(OWNER_NAMES_STORAGE_KEY, JSON.stringify(ownerNames));
    if (skipOwnerLocalChangedRef.current > 0) {
      skipOwnerLocalChangedRef.current -= 1;
    } else {
      markLocalChanged();
    }
  }, [ownerNames, isHydrated]);

  useEffect(() => {
    // positions.owner만 추가 — cash/sort keys는 포함하지 않음
    // (cash/sort keys를 포함하면 삭제된 보유자가 부활하는 원인이 됨)
    const merged = normalizeOwnerNames([
      ...ownerNames,
      ...positions.map((p) => p.owner),
    ]);
    if (merged.length === ownerNames.length && merged.every((name, idx) => ownerNames[idx] === name)) {
      return;
    }
    setOwnerNames(merged);
  }, [ownerNames, positions]);

  const marketSymbols = useMemo(() => {
    const fromPos = positions.map((p) => p.symbol.trim()).filter(Boolean);
    const fromWl = watchlistRows.map((r) => r.symbol.trim()).filter(Boolean);
    return [...new Set([...fromPos, ...fromWl])].join(",");
  }, [positions, watchlistRows]);

  const marketQuery = useQuery<MarketResponse>({
    queryKey: ["market", marketSymbols],
    queryFn: async () => {
      const res = await fetch(`/api/market?symbols=${encodeURIComponent(marketSymbols)}`);
      if (!res.ok) {
        throw new Error("시세 조회 실패");
      }
      return res.json() as Promise<MarketResponse>;
    },
    /** 보유 종목이 없어도 USD/KRW만 받아 현금(USD) 환산·비중에 반영 */
    enabled: true,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  // 요청: 김승주 보유 종목에 대해 기술적 시그널 표시
  const signalSymbols = useMemo(
    () =>
      [
        ...new Set(
          positions
            .filter((p) => p.owner === "김승주")
            .map((p) => p.symbol)
            .filter(Boolean),
        ),
      ].join(","),
    [positions],
  );

  const historyQuery = useQuery<HistoryResponse>({
    queryKey: ["market-history", signalSymbols],
    queryFn: async () => {
      const res = await fetch(`/api/market/history?symbols=${encodeURIComponent(signalSymbols)}`);
      if (!res.ok) throw new Error("일봉 조회 실패");
      return res.json() as Promise<HistoryResponse>;
    },
    enabled: signalSymbols.length > 0,
    // 일봉은 분봉보다 덜 자주 바뀌므로 30분 캐시
    staleTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 30,
  });

  const signalBySymbol = useMemo(() => {
    const out = new Map<
      string,
      { final: TradeSignal; ma: TradeSignal; rsi: TradeSignal; bb: TradeSignal; vol: TradeSignal }
    >();
    const history = historyQuery.data?.history ?? {};
    for (const [symbol, prices] of Object.entries(history)) {
      const ma = calculateMACrossoverSignal(prices);
      const rsi = calculateRSISignal(prices);
      const bb = calculateBollingerSignal(prices);
      const vol = calculateVolumeSignal(prices);
      const buyCount = [ma, rsi, bb, vol].filter((s) => s === "BUY").length;
      const sellCount = [ma, rsi, bb, vol].filter((s) => s === "SELL").length;
      const final: TradeSignal = buyCount > sellCount ? "BUY" : sellCount > buyCount ? "SELL" : "HOLD";
      out.set(symbol, { final, ma, rsi, bb, vol });
    }
    return out;
  }, [historyQuery.data]);
  const sellLogOwnersForModal = useMemo(
    () => [...new Set([...ownerNames, ...Object.keys(sellLog)])],
    [ownerNames, sellLog],
  );
  useEffect(() => {
    if (ownerNames.length === 0) return;
    if (!ownerNames.includes(sellLogOwnerForSection)) {
      setSellLogOwnerForSection(ownerNames[0]);
    }
  }, [ownerNames, sellLogOwnerForSection]);
  useEffect(() => {
    if (ownerNames.length === 0) return;
    if (!ownerNames.includes(sellLogListViewOwner)) {
      setSellLogListViewOwner(ownerNames[0]);
    }
  }, [ownerNames, sellLogListViewOwner]);

  const usdKrw = marketQuery.data?.usdKrw ?? FALLBACK_USD_KRW;
  const eurKrw = marketQuery.data?.eurKrw ?? FALLBACK_EUR_KRW;
  // 동기화(push) 시점 환율을 항상 최신값으로 보관 — 어떤 push 경로에서도 스테일 클로저 없이 읽음.
  // (텔레그램이 "대시보드가 본 값"을 재현하려면 push마다 이 환율이 스냅샷에 함께 저장돼야 함)
  const fxRef = useRef({ usd: usdKrw, eur: eurKrw });
  fxRef.current = { usd: usdKrw, eur: eurKrw };

  // 미국 주간거래(데이마켓) 실시간 현재가 — KIS Railway 엔드포인트를 3~5초 폴링해 덮어씀.
  // 키: 티커(대문자). NEXT_PUBLIC_KIS_API_BASE 미설정 시 비활성(기존 Yahoo 시세 그대로).
  const [daytimeQuotes, setDaytimeQuotes] = useState<
    Record<string, { price: number; prevClose: number | null; asOf: string }>
  >({});

  useEffect(() => {
    const base = (process.env.NEXT_PUBLIC_KIS_API_BASE ?? "").trim().replace(/\/+$/, "");
    if (!base) return;
    const usdSymbols = [
      ...new Set(
        positions
          .filter((p) => p.currency === "USD")
          .map((p) => (p.symbol ?? "").trim().toUpperCase())
          .filter((s) => s.length > 0),
      ),
    ];
    if (usdSymbols.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      if (!isUsTradingDayPollWindow()) return; // 미국 동부 평일만(주말 미국 휴장)
      await Promise.all(
        usdSymbols.map(async (sym) => {
          try {
            const r = await fetch(
              `${base}/api/overseas/daytime-price?symbol=${encodeURIComponent(sym)}`,
            );
            if (!r.ok || cancelled) return;
            const j = (await r.json()) as { price?: number; prevClose?: number; asOf?: string };
            if (cancelled || typeof j.price !== "number" || !(j.price > 0)) return;
            // KIS 전일종가(base)도 함께 보관 — 전일대비/등락률을 가격과 같은 출처로 계산하기 위함.
            const pc = typeof j.prevClose === "number" && j.prevClose > 0 ? j.prevClose : null;
            setDaytimeQuotes((prev) => {
              const cur = prev[sym];
              if (cur && cur.price === j.price && cur.prevClose === pc && cur.asOf === j.asOf) return prev; // 변화 없으면 리렌더 방지
              return { ...prev, [sym]: { price: j.price as number, prevClose: pc, asOf: j.asOf ?? "" } };
            });
          } catch {
            /* 폴링 실패는 무시(다음 주기 재시도) */
          }
        }),
      );
    };
    void poll();
    const id = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [positions]);

  const handleAddSymbolInput = useCallback(
    (value: string) => {
      skipAddFormAutoNameRef.current = false;
      skipAddFormAutoChartGroupRef.current = false;
      setForm((prev) => {
        const next = { ...prev, symbol: value };
        const inferred = inferTradingCurrencyFromTicker(value);
        if (inferred === null) return next;

        const usdFilled = prev.purchaseUsdKrw.trim() !== "";
        const eurFilled = prev.purchaseEurKrw.trim() !== "";
        const purchaseUsdDefault =
          prev.currency === "USD" && usdFilled ? prev.purchaseUsdKrw : String(Math.round(usdKrw));
        const purchaseEurDefault =
          prev.currency === "EUR" && eurFilled ? prev.purchaseEurKrw : String(Math.round(eurKrw));

        return {
          ...next,
          currency: inferred,
          accountType: inferred === "KRW" ? "국내주식" : "해외주식",
          purchaseUsdKrw: inferred === "USD" ? purchaseUsdDefault : "",
          purchaseEurKrw: inferred === "EUR" ? purchaseEurDefault : "",
        };
      });
    },
    [usdKrw, eurKrw],
  );

  /** 기존 보유 티커·종목명 — 커스텀 자동완성( datalist 대신 ) */
  const holdingsTickerOptions = useMemo(() => {
    const map = new Map<string, { symbol: string; name: string }>();
    for (const p of positions) {
      const raw = p.symbol?.trim();
      if (!raw) continue;
      const key = raw.toUpperCase();
      if (!map.has(key)) {
        map.set(key, { symbol: raw, name: (p.name ?? "").trim() });
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "en"))
      .map(([, v]) => v);
  }, [positions]);

  const filteredHoldingsTickers = useMemo(() => {
    const q = form.symbol.trim().toLowerCase();
    if (holdingsTickerOptions.length === 0) return [];
    if (!q) return holdingsTickerOptions.slice(0, 120);
    return holdingsTickerOptions
      .filter((o) => {
        const s = o.symbol.toLowerCase();
        const n = o.name.toLowerCase();
        return s.startsWith(q) || s.includes(q) || n.includes(q);
      })
      .slice(0, 120);
  }, [holdingsTickerOptions, form.symbol]);

  useEffect(() => {
    setHoldingsTickerSuggestHl(0);
  }, [form.symbol]);

  useEffect(() => {
    setHoldingsTickerSuggestHl((h) =>
      filteredHoldingsTickers.length === 0
        ? 0
        : Math.min(h, filteredHoldingsTickers.length - 1),
    );
  }, [filteredHoldingsTickers.length]);

  /** 티커·담당자에 맞춰 종목명·차트 그룹 자동 입력 (보유 줄 우선: 우선 같은 통화 줄, 없으면 동일 티커 다른 통화 줄을 쓰고 폼 통화를 그에 맞춤) */
  useEffect(() => {
    const raw = form.symbol.trim();
    if (!raw) return;

    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const symU = raw.toUpperCase();
        const ownersOrdered = ownerNames.filter((o) => form.selectedOwners.includes(o));

        for (const own of ownersOrdered) {
          const sameSymbol = positions.filter(
            (x) => x.owner === own && holdingSymbolsEquivalent(symU, x.symbol),
          );
          if (sameSymbol.length === 0) continue;

          const withCur = sameSymbol.filter((x) => x.currency === form.currency);
          const pool = withCur.length > 0 ? withCur : sameSymbol;
          const p =
            pool.find((x) => (x.chartGroup ?? "").trim() !== "") ??
            pool[0];

          if (!ac.signal.aborted) {
            setForm((prev) => {
              const next = { ...prev };
              const cur = p.currency;
              if (prev.currency !== cur) {
                addFormFxManualRef.current = false;
                next.currency = cur;
                next.accountType = cur === "KRW" ? "국내주식" : "해외주식";
                next.purchaseUsdKrw = cur === "USD" ? prev.purchaseUsdKrw : "";
                next.purchaseEurKrw = cur === "EUR" ? prev.purchaseEurKrw : "";
                next.purchaseDateForFx = cur === "USD" ? prev.purchaseDateForFx : "";
              }
              if (!skipAddFormAutoNameRef.current && p.name?.trim()) {
                next.name = p.name.trim();
              }
              if (!skipAddFormAutoChartGroupRef.current && p.chartGroup?.trim()) {
                next.chartGroup = p.chartGroup.trim();
              }
              return next;
            });
          }
          return;
        }

        if (skipAddFormAutoNameRef.current) return;

        try {
          const r = await fetch(
            `/api/symbol-name?symbols=${encodeURIComponent(raw)}`,
            { signal: ac.signal },
          );
          if (!r.ok) return;
          const j = (await r.json()) as { names?: Record<string, string> };
          const names = j.names ?? {};
          let resolved: string | undefined;
          for (const [k, v] of Object.entries(names)) {
            if (k.trim().toUpperCase() === symU && typeof v === "string" && v.trim()) {
              resolved = v.trim();
              break;
            }
          }
          if (resolved) {
            if (!ac.signal.aborted) {
              setForm((prev) => ({ ...prev, name: resolved }));
            }
          }
        } catch {
          /* AbortError 등 무시 */
        }
      })();
    }, 400);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [form.symbol, form.currency, form.selectedOwners, positions, ownerNames]);

  const totalCashKrw = useMemo(() => {
    return ownerNames.reduce((sum, owner) => {
      const c = cashByOwner[owner] ?? { usd: 0, krw: 0 };
      return sum + c.krw + c.usd * usdKrw;
    }, 0);
  }, [ownerNames, cashByOwner, usdKrw]);

  const enrichedPositions = useMemo(() => {
    return positions.map((position, sourceIndex) => {
      const q = marketQuery.data?.quotes?.[position.symbol];
      // 주간거래 시간대엔 KIS 실시간 현재가를 우선 적용(없으면 기존 시세). USD 종목만 해당.
      const daytimeQuote =
        position.currency === "USD"
          ? daytimeQuotes[(position.symbol ?? "").trim().toUpperCase()]
          : undefined;
      const daytimePrice = daytimeQuote?.price;
      // 세션별 소스 전환: 미국 프리/정규/애프터마켓엔 Yahoo(라이브) 사용,
      // 그 외(미국 야간=한국 낮)엔 KIS 주간거래로 덮어씀. KIS 주간거래는 실제 프리마켓 땐 멈추기 때문.
      const usingDaytime =
        typeof daytimePrice === "number" &&
        daytimePrice > 0 &&
        !isYahooLiveUsSession(q?.marketState ?? undefined);
      const livePrice = usingDaytime ? daytimePrice : q?.price;
      // 주간거래 가격을 쓸 땐 전일대비·등락률도 KIS 전일종가(base) 기준으로 계산해야 가격과 %가 일치.
      const yahooPrevClose =
        typeof q?.previousClose === "number" && q.previousClose > 0 ? q.previousClose : null;
      const daytimePrevClose =
        usingDaytime && typeof daytimeQuote?.prevClose === "number" && daytimeQuote.prevClose > 0
          ? daytimeQuote.prevClose
          : null;
      const rawPreviousClose = usingDaytime ? (daytimePrevClose ?? yahooPrevClose) : yahooPrevClose;
      /** 김승주: 미국장 영업일에만, 그 외: 한국장 영업일에만 전일 대비 등락 표시 */
      const previousClose =
        rawPreviousClose !== null && shouldShowDailyChangeVsPreviousClose(position.owner)
          ? rawPreviousClose
          : null;
      const currentPrice = livePrice ?? position.currentPrice;
      const effectiveAvgPrice = position.avgPrice * (1 + TRADING_FEE_RATE);
      const pnl = ((currentPrice - effectiveAvgPrice) / effectiveAvgPrice) * 100;
      /** 매입 시 환율 없으면 현재 환율로 원가 추정(기존 데이터 호환) */
      const purchaseFx =
        position.currency === "USD"
          ? (position.purchaseUsdKrw ?? usdKrw)
          : position.currency === "EUR"
            ? (position.purchaseEurKrw ?? eurKrw)
            : 1;
      const valueKrw =
        position.currency === "USD"
          ? position.quantity * currentPrice * usdKrw
          : position.currency === "EUR"
            ? position.quantity * currentPrice * eurKrw
            : position.quantity * currentPrice;
      const costKrw = position.quantity * effectiveAvgPrice * purchaseFx;
      /** 해외(USD/EUR): 종목 통화 기준 주가 수익률 */
      const pnlUsdPct = position.currency === "USD" ? pnl : null;
      const pnlEurPct = position.currency === "EUR" ? pnl : null;
      /** 매입 환율 기준 원화 매입액 대비 현재 원화 평가 수익률 */
      const pnlKrwEquityPct =
        (position.currency === "USD" || position.currency === "EUR") && costKrw > 0
          ? ((valueKrw - costKrw) / costKrw) * 100
          : null;
      return {
        ...position,
        sourceIndex,
        currentPrice,
        previousClose,
        pnl,
        valueKrw,
        costKrw,
        purchaseFxUsed: purchaseFx,
        pnlUsdPct,
        pnlEurPct,
        pnlKrwEquityPct,
        marketState: q?.marketState ?? null,
      };
    });
  }, [positions, marketQuery.data, usdKrw, eurKrw, daytimeQuotes]);

  /** 보유자·계좌 무관 동일 티커 합산 — 평가·원가·손익·원화 기준 수익률 (표 정렬은 holdingsAggregatedBySymbolSorted) */
  const holdingsAggregatedBySymbol = useMemo(() => {
    type Acc = {
      key: string;
      displaySymbol: string;
      displayName: string;
      valueKrw: number;
      costKrw: number;
      owners: Set<string>;
      byOwner: Map<string, { valueKrw: number; costKrw: number }>;
    };
    const map = new Map<string, Acc>();
    for (const p of enrichedPositions) {
      if (!isStockRowForSymbolAggregate(p)) continue;
      const key = aggregateSymbolKeyForHoldings(p.symbol);
      const cur = map.get(key);
      if (!cur) {
        map.set(key, {
          key,
          displaySymbol: p.symbol.trim(),
          displayName: (p.name ?? "").trim() || p.symbol.trim(),
          valueKrw: p.valueKrw,
          costKrw: p.costKrw,
          owners: new Set([p.owner]),
          byOwner: new Map([[p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw }]]),
        });
      } else {
        cur.valueKrw += p.valueKrw;
        cur.costKrw += p.costKrw;
        cur.owners.add(p.owner);
        const om = cur.byOwner.get(p.owner);
        if (!om) {
          cur.byOwner.set(p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw });
        } else {
          om.valueKrw += p.valueKrw;
          om.costKrw += p.costKrw;
        }
        const nm = (p.name ?? "").trim();
        if (nm.length > cur.displayName.length) cur.displayName = nm || cur.displayName;
      }
    }
    return [...map.values()]
      .map((r) => {
        const pnlKrw = r.valueKrw - r.costKrw;
        const pnlPct = r.costKrw > 0 ? (pnlKrw / r.costKrw) * 100 : null;
        const ownersSorted = [...r.owners].sort((a, b) => a.localeCompare(b, "ko"));
        const ownerBreakdown = [...r.byOwner.entries()]
          .map(([owner, v]) => ({
            owner,
            valueKrw: v.valueKrw,
            costKrw: v.costKrw,
            pnlKrw: v.valueKrw - v.costKrw,
          }))
          .sort((a, b) => a.owner.localeCompare(b.owner, "ko"));
        const epForDaily = enrichedPositions.find(
          (e) =>
            isStockRowForSymbolAggregate(e) &&
            aggregateSymbolKeyForHoldings(e.symbol) === r.key,
        );
        const dailyPct =
          epForDaily &&
          epForDaily.previousClose !== null &&
          epForDaily.previousClose > 0
            ? ((epForDaily.currentPrice - epForDaily.previousClose) /
                epForDaily.previousClose) *
              100
            : null;
        const tooltipHeader = r.displaySymbol.trim().toUpperCase();
        const tooltipCompositionRows: HoldingsAggTipRow[] = [
          { code: r.displaySymbol.trim(), name: r.displayName, pct: dailyPct },
        ];
        const tooltipOwnerValueRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
          code: o.owner,
          name: `${fmtInt(o.valueKrw)}원`,
          pct: r.valueKrw > 0 ? (o.valueKrw / r.valueKrw) * 100 : null,
        }));
        const tooltipOwnerPnlRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
          code: o.owner,
          name: `${fmtInt(o.pnlKrw)}원`,
          pct:
            Math.abs(pnlKrw) > 1e-9 ? (o.pnlKrw / pnlKrw) * 100 : null,
        }));
        const tooltipOwnersListRows: HoldingsAggTipRow[] =
          ownersSorted.length > 0
            ? ownersSorted.map((o) => ({
                code: o,
                name: "",
                pct: null,
              }))
            : [{ code: "보유자 정보 없음", name: "", pct: null }];
        return {
          key: r.key,
          displaySymbol: r.displaySymbol,
          displayName: r.displayName,
          symbolsForAlert: [r.key],
          valueKrw: r.valueKrw,
          costKrw: r.costKrw,
          pnlKrw,
          pnlPct,
          ownerCount: r.owners.size,
          ownersLabel: ownersSorted.join(", "),
          ownerBreakdown,
          tooltipHeader,
          tooltipCompositionRows,
          tooltipOwnerValueRows,
          tooltipOwnerPnlRows,
          tooltipOwnersListRows,
        };
      })
  }, [enrichedPositions]);

  /** 동일 차트 그룹명끼리 합산(그룹 미입력 종목은 티커별로 동일 키 규칙) */
  const holdingsAggregatedByChartGroup = useMemo(() => {
    type Acc = {
      key: string;
      displaySymbol: string;
      valueKrw: number;
      costKrw: number;
      owners: Set<string>;
      /** 티커 → 구성란 표시(해외=티커, 국내=종목명) */
      symbolLineLabel: Map<string, string>;
      bestName: string;
      byOwner: Map<string, { valueKrw: number; costKrw: number }>;
    };
    const map = new Map<string, Acc>();
    for (const p of enrichedPositions) {
      if (!isStockRowForSymbolAggregate(p)) continue;
      const symKey = aggregateSymbolKeyForHoldings(p.symbol);
      const symDisplay = p.symbol.trim();
      const nm = (p.name ?? "").trim();
      const cg = (p.chartGroup ?? "").trim();
      const bucketKey = cg ? `g:${cg}` : `s:${symKey}`;
      const cur = map.get(bucketKey);
      const line = chartGroupCompositionLabel(p);
      if (!cur) {
        map.set(bucketKey, {
          key: bucketKey,
          displaySymbol: cg || symDisplay,
          valueKrw: p.valueKrw,
          costKrw: p.costKrw,
          owners: new Set([p.owner]),
          symbolLineLabel: new Map([[symDisplay, line]]),
          bestName: nm || symDisplay,
          byOwner: new Map([[p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw }]]),
        });
      } else {
        cur.valueKrw += p.valueKrw;
        cur.costKrw += p.costKrw;
        cur.owners.add(p.owner);
        const prevLine = cur.symbolLineLabel.get(symDisplay);
        if (prevLine === undefined) {
          cur.symbolLineLabel.set(symDisplay, line);
        } else if (p.currency !== "USD" && p.currency !== "EUR" && line.length > prevLine.length) {
          cur.symbolLineLabel.set(symDisplay, line);
        }
        if (nm.length > cur.bestName.length) cur.bestName = nm;
        const om = cur.byOwner.get(p.owner);
        if (!om) {
          cur.byOwner.set(p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw });
        } else {
          om.valueKrw += p.valueKrw;
          om.costKrw += p.costKrw;
        }
      }
    }
    return [...map.values()].map((r) => {
      const pnlKrw = r.valueKrw - r.costKrw;
      const pnlPct = r.costKrw > 0 ? (pnlKrw / r.costKrw) * 100 : null;
      const ownersSorted = [...r.owners].sort((a, b) => a.localeCompare(b, "ko"));
      const partsOrdered = [...r.symbolLineLabel.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([, lab]) => lab);
      const groupKind = r.key.startsWith("g:");
      const displayName = groupKind
        ? partsOrdered.length <= 1
          ? partsOrdered[0] ?? (r.bestName || r.displaySymbol)
          : `${partsOrdered.length}개 종목 · ${partsOrdered.slice(0, 5).join(", ")}${partsOrdered.length > 5 ? " …" : ""}`
        : r.bestName;
      const ownerBreakdown = [...r.byOwner.entries()]
        .map(([owner, v]) => ({
          owner,
          valueKrw: v.valueKrw,
          costKrw: v.costKrw,
          pnlKrw: v.valueKrw - v.costKrw,
        }))
        .sort((a, b) => a.owner.localeCompare(b.owner, "ko"));
      const dailyPctForSym = (symDisplay: string): number | null => {
        const ep = enrichedPositions.find(
          (e) => isStockRowForSymbolAggregate(e) && e.symbol.trim() === symDisplay,
        );
        if (!ep || ep.previousClose === null || ep.previousClose <= 0) return null;
        return ((ep.currentPrice - ep.previousClose) / ep.previousClose) * 100;
      };
      const tooltipCompositionRows: HoldingsAggTipRow[] = [...r.symbolLineLabel.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([sym, line]) => ({
          code: sym,
          name: line,
          pct: dailyPctForSym(sym),
        }));
      const tooltipHeader = r.displaySymbol.trim().toUpperCase();
      const tooltipOwnerValueRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
        code: o.owner,
        name: `${fmtInt(o.valueKrw)}원`,
        pct: r.valueKrw > 0 ? (o.valueKrw / r.valueKrw) * 100 : null,
      }));
      const tooltipOwnerPnlRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
        code: o.owner,
        name: `${fmtInt(o.pnlKrw)}원`,
        pct: Math.abs(pnlKrw) > 1e-9 ? (o.pnlKrw / pnlKrw) * 100 : null,
      }));
      const tooltipOwnersListRows: HoldingsAggTipRow[] =
        ownersSorted.length > 0
          ? ownersSorted.map((o) => ({
              code: o,
              name: "",
              pct: null,
            }))
          : [{ code: "보유자 정보 없음", name: "", pct: null }];
      const symbolsForAlert = [...r.symbolLineLabel.keys()].map((s) =>
        aggregateSymbolKeyForHoldings(s),
      );
      return {
        key: r.key,
        displaySymbol: r.displaySymbol,
        displayName,
        symbolsForAlert,
        valueKrw: r.valueKrw,
        costKrw: r.costKrw,
        pnlKrw,
        pnlPct,
        ownerCount: r.owners.size,
        ownersLabel: ownersSorted.join(", "),
        ownerBreakdown,
        tooltipHeader,
        tooltipCompositionRows,
        tooltipOwnerValueRows,
        tooltipOwnerPnlRows,
        tooltipOwnersListRows,
      };
    });
  }, [enrichedPositions]);

  const holdingsAggSource =
    holdingsBySymbolView === "chartGroup"
      ? holdingsAggregatedByChartGroup
      : holdingsAggregatedBySymbol;

  const holdingsAggregatedBySymbolSorted = useMemo(() => {
    const rows = holdingsAggSource.slice();
    const cmpPctDesc = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    };
    switch (holdingsBySymbolSort) {
      case "name":
        rows.sort((a, b) =>
          a.displayName.localeCompare(b.displayName, "ko", { sensitivity: "base" }),
        );
        break;
      case "valueKrw":
        rows.sort(
          (a, b) =>
            b.valueKrw - a.valueKrw || a.displaySymbol.localeCompare(b.displaySymbol, "en"),
        );
        break;
      case "pnlPct":
        rows.sort(
          (a, b) =>
            cmpPctDesc(a.pnlPct, b.pnlPct) || b.valueKrw - a.valueKrw,
        );
        break;
      case "pnlKrw":
        rows.sort((a, b) => b.pnlKrw - a.pnlKrw || b.valueKrw - a.valueKrw);
        break;
      case "owners":
        rows.sort(
          (a, b) =>
            b.ownerCount - a.ownerCount || b.valueKrw - a.valueKrw,
        );
        break;
      default:
        break;
    }
    return rows;
  }, [holdingsAggSource, holdingsBySymbolSort]);

  const holdingsSymbolGrandTotals = useMemo(() => {
    const v = holdingsAggregatedBySymbol.reduce((s, r) => s + r.valueKrw, 0);
    const c = holdingsAggregatedBySymbol.reduce((s, r) => s + r.costKrw, 0);
    const pnl = v - c;
    const pct = c > 0 ? (pnl / c) * 100 : null;
    return { valueKrw: v, costKrw: c, pnlKrw: pnl, pnlPct: pct };
  }, [holdingsAggregatedBySymbol]);

  const alertLineHits = useMemo(() => {
    const out: Array<{
      key: string;
      owner: string;
      symbol: string;
      name: string;
      reasons: string[];
      currentPrice: number;
      returnPct: number | null;
    }> = [];
    for (const p of enrichedPositions) {
      const alertKey = positionAlertKey(p.owner, p.symbol);
      const rule = resolveAlertRule(alertThresholdsByKey, p.owner, p.symbol);
      if (!hasAlertThresholdRule(rule)) continue;
      const returnPct = positionReturnPctForAlert(p);
      const { hit, reasons } = evaluateAlertRule(rule, {
        price: typeof p.currentPrice === "number" && Number.isFinite(p.currentPrice) ? p.currentPrice : null,
        returnPct,
      });
      if (hit) {
        out.push({
          key: alertKey,
          owner: p.owner,
          symbol: p.symbol,
          name: p.name,
          reasons,
          currentPrice: p.currentPrice,
          returnPct,
        });
      }
    }
    return out;
  }, [enrichedPositions, alertThresholdsByKey]);

  const alertLineHitsByOwner = useMemo(() => {
    const map = new Map<string, typeof alertLineHits>();
    for (const h of alertLineHits) {
      const list = map.get(h.owner) ?? [];
      list.push(h);
      map.set(h.owner, list);
    }
    const orderedOwners: string[] = [];
    for (const o of ownerNames) {
      if (map.has(o)) orderedOwners.push(o);
    }
    for (const o of map.keys()) {
      if (!orderedOwners.includes(o)) orderedOwners.push(o);
    }
    return orderedOwners.map((owner) => ({
      owner,
      hits: (map.get(owner) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, "ko", { sensitivity: "base" }),
      ),
    }));
  }, [alertLineHits, ownerNames]);

  const summaryCards = useMemo(() => {
    const stockValue = enrichedPositions.reduce((sum, position) => sum + position.valueKrw, 0);
    const stockCost = enrichedPositions.reduce((sum, position) => sum + position.costKrw, 0);
    const totalValue = stockValue + totalCashKrw;
    const costBasis = stockCost + totalCashKrw;
    const totalProfit = totalValue - costBasis;
    const totalReturnPct = costBasis > 0 ? (totalProfit / costBasis) * 100 : 0;

    return [
      {
        label: "전체 수익률 (원화 기준)",
        value: `${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`,
        sub: "투입(주식 원가+현금) 대비 평가",
        change: "",
        positive: totalReturnPct >= 0,
      },
      {
        label: "평가손익 (주식·원화)",
        value: `₩${fmtInt(totalProfit)}`,
        sub: "현금은 손익 없이 원금으로 포함",
        change: "",
        positive: totalProfit >= 0,
      },
    ];
  }, [enrichedPositions, totalCashKrw, usdKrw]);

  /** 상단 3칸 요약(미니 KIS 대시보드) — 보유 수는 티커 기준 유니크 */
  const kisMetrics = useMemo(() => {
    const stockValue = enrichedPositions.reduce((s, p) => s + p.valueKrw, 0);
    const totalAppraisal = stockValue + totalCashKrw;
    const uniqueTickers = new Set(positions.map((p) => p.symbol.trim().toUpperCase()));
    return {
      totalAppraisal,
      deposit: totalCashKrw,
      uniqueTickerCount: uniqueTickers.size,
    };
  }, [enrichedPositions, totalCashKrw, positions]);

  const allocationByOwner = useMemo(() => {
    return ownerNames.map((ownerName) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);
      // chartGroup이 있으면 그룹명 기준, 없으면 symbol 기준으로 차트 슬라이스 합산
      const groupMap = new Map<string, {
        displayName: string;
        allEntries: { name: string; symbol: string; value: number }[];
        value: number;
        weightedChangeSum: number;
        prevCloseValueSum: number;
      }>();
      for (const position of items) {
        const v = Math.max(0, Number.isFinite(position.valueKrw) ? position.valueKrw : 0);
        const prevClose =
          typeof position.previousClose === "number" && position.previousClose > 0
            ? position.previousClose
            : null;
        const dailyChangePct = prevClose !== null ? ((position.currentPrice - prevClose) / prevClose) * 100 : null;
        const groupKey = position.chartGroup?.trim() || position.symbol;
        const existing = groupMap.get(groupKey);
        if (existing) {
          existing.value += v;
          if (dailyChangePct !== null) {
            existing.weightedChangeSum += dailyChangePct * v;
            existing.prevCloseValueSum += v;
          }
          const entry = existing.allEntries.find(
            (e) => e.symbol === position.symbol && e.name === position.name,
          );
          if (entry) {
            entry.value += v;
          } else {
            existing.allEntries.push({ name: position.name, symbol: position.symbol, value: v });
          }
        } else {
          groupMap.set(groupKey, {
            displayName: position.chartGroup?.trim() || position.name,
            allEntries: [{ name: position.name, symbol: position.symbol, value: v }],
            value: v,
            weightedChangeSum: dailyChangePct !== null ? dailyChangePct * v : 0,
            prevCloseValueSum: dailyChangePct !== null ? v : 0,
          });
        }
      }
      const stockSlices = Array.from(groupMap.entries()).map(
        ([groupKey, { displayName, allEntries, value, weightedChangeSum, prevCloseValueSum }]) => ({
          name: `stk|${groupKey}|${ownerName}`,
          displayName,
          ticker: groupKey,
          allEntries: allEntries.map((entry) => ({
            name: entry.name,
            symbol: entry.symbol,
            value: entry.value,
          })),
          value,
          changePct: prevCloseValueSum > 0 ? weightedChangeSum / prevCloseValueSum : null,
        }),
      );

      const chartCashStockSlice = stockSlices.find((s) => s.ticker === "현금");
      const stockSlicesNoBundledCash = stockSlices.filter((s) => s.ticker !== "현금");

      const c = cashByOwner[ownerName] ?? { usd: 0, krw: 0 };
      const usd = Number.isFinite(c.usd) ? Math.max(0, c.usd) : 0;
      const krw = Number.isFinite(c.krw) ? Math.max(0, c.krw) : 0;
      const usdCashKrw = usd * usdKrw;

      /** 예수금(USD/KRW) + 차트그룹「현금」종목을 하나의 현금 조각으로 */
      type CashAgg = {
        name: string;
        displayName: string;
        ticker: string;
        allEntries: { name: string; symbol: string; value: number }[];
        value: number;
        changePct: number | null;
      };
      const cashBundleParts: CashAgg["allEntries"] = [];
      if (usdCashKrw > 0) {
        cashBundleParts.push({ name: "USD 현금", symbol: "", value: usdCashKrw });
      }
      if (krw > 0) {
        cashBundleParts.push({ name: "KRW 현금", symbol: "", value: krw });
      }
      const hasUsdDeposit = usdCashKrw > 0;
      const hasKrwDeposit = krw > 0;
      if (chartCashStockSlice) {
        for (const ent of chartCashStockSlice.allEntries) {
          const sym = typeof ent.symbol === "string" ? ent.symbol.trim() : "";
          const nm = typeof ent.name === "string" ? ent.name.trim() : "";
          if (sym === "" && nm === "USD 현금" && hasUsdDeposit) continue;
          if (sym === "" && nm === "KRW 현금" && hasKrwDeposit) continue;
          cashBundleParts.push({
            name: ent.name,
            symbol: typeof ent.symbol === "string" ? ent.symbol : "",
            value: ent.value,
          });
        }
      }
      const mergedCashEntries = mergeCashBundleDisplayEntries(cashBundleParts);
      const cashBundleValue = mergedCashEntries.reduce((s, e) => s + e.value, 0);

      const extra: CashAgg[] = [];
      if (cashBundleValue > 0 && mergedCashEntries.length > 0) {
        extra.push({
          name: `cash-bundle|${ownerName}`,
          displayName: "현금",
          ticker: "현금",
          allEntries: mergedCashEntries,
          value: cashBundleValue,
          changePct: chartCashStockSlice?.changePct ?? null,
        });
      }

      const merged = [...stockSlicesNoBundledCash, ...extra];
      const total = merged.reduce((sum, item) => sum + item.value, 0);
      const data = merged.map((item) => ({
        ...item,
        allEntries: item.allEntries.map((entry) => ({
          name: entry.name,
          symbol: entry.symbol,
          weight: total > 0 ? (entry.value / total) * 100 : 0,
        })),
        weight: total > 0 ? (item.value / total) * 100 : 0,
      }));
      return { ownerName, data, total };
    });
  }, [ownerNames, enrichedPositions, cashByOwner, usdKrw]);

  const positionsByOwner = useMemo(() => {
    return ownerNames.map((ownerName) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);
      const sectionStockValue = items.reduce((sum, item) => sum + item.valueKrw, 0);
      const sectionStockCost = items.reduce((sum, item) => sum + item.costKrw, 0);
      const c = cashByOwner[ownerName] ?? { usd: 0, krw: 0 };
      const sectionCashKrw = c.krw + c.usd * usdKrw;
      const sectionTotal = sectionStockValue + sectionCashKrw;
      /** 주식 원가 + 현금(원화 환산) — 상단 카드와 동일한 투입 기준 */
      const sectionCostBasis = sectionStockCost + sectionCashKrw;
      const sectionPnL = sectionTotal - sectionCostBasis;
      const sectionPnLPct =
        sectionCostBasis > 0 ? (sectionPnL / sectionCostBasis) * 100 : 0;
      return {
        ownerName,
        items,
        sectionStockValue,
        sectionStockCost,
        sectionCashKrw,
        sectionTotal,
        sectionCostBasis,
        sectionPnL,
        sectionPnLPct,
        cashUsd: c.usd,
        cashKrw: c.krw,
      };
    });
  }, [ownerNames, enrichedPositions, cashByOwner, usdKrw]);

  /** 보유자별 그룹 오늘 등락 요약 (내림차순 정렬) */
  const ownerGroupDailySummary = useMemo(() => {
    return positionsByOwner.map((group) => {
      const blocks = buildHoldingsGroupBlocks(group.items);
      const groups = blocks.map((block) => {
        const dailyChangeKrw = block.items.reduce((sum, p) => {
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
        const dailyChangePct = prevSumKrw > 0 ? (dailyChangeKrw / prevSumKrw) * 100 : null;
        const holdingsItems = (() => {
          const seen = new Set<string>();
          return block.items.flatMap((p) => {
            const sym = typeof p.symbol === "string" ? p.symbol.trim() : "";
            const nm = typeof p.name === "string" ? p.name.trim() : "";
            const key = sym || nm;
            if (!key || seen.has(key)) return [];
            seen.add(key);
            const pct =
              typeof p.previousClose === "number" && p.previousClose > 0
                ? ((p.currentPrice - p.previousClose) / p.previousClose) * 100
                : null;
            return [{ ticker: sym || nm, name: nm || sym, pct }];
          });
        })();
        // 그룹이 없는 단일 국내 종목은 라벨이 티커 코드(예: A446770)뿐이므로,
        // 화면에는 종목명을 노출한다(없으면 티커 유지). 해외 티커(SNDK 등)는 그대로.
        const displayLabel = isKrxListedEquityCode(block.label)
          ? block.items.find((p) => typeof p.name === "string" && p.name.trim())?.name?.trim() ||
            block.label
          : block.label;
        return { label: displayLabel, dailyChangeKrw, dailyChangePct, holdingsItems };
      }).sort((a, b) => b.dailyChangeKrw - a.dailyChangeKrw);
      const totalDailyKrw = groups.reduce((s, g) => s + g.dailyChangeKrw, 0);
      const prevStockKrw = group.items.reduce((s, p) => {
        if (p.previousClose === null) return s;
        const v =
          p.currency === "USD" ? p.previousClose * p.quantity * usdKrw
          : p.currency === "EUR" ? p.previousClose * p.quantity * eurKrw
          : p.previousClose * p.quantity;
        return s + v;
      }, 0);
      const prevTotalKrw = prevStockKrw + group.sectionCashKrw;
      const totalDailyPct = prevTotalKrw > 0 ? (totalDailyKrw / prevTotalKrw) * 100 : null;
      return { ownerName: group.ownerName, groups, totalDailyKrw, totalDailyPct };
    });
  }, [positionsByOwner, usdKrw, eurKrw]);

  // 보유자 표시 순서는 ownerNames 배열을 기준으로 한다(드래그 재정렬 시 ownerNames를 바꿔
  // 요약 카드·보유종목 그리드가 함께 같은 순서로 정렬되게 함). ownerNames는 로컬·서버에 동기화됨.
  const allocationByOwnerForGrid = useMemo(
    () => sortPortfolioGridRows(allocationByOwner, ownerNames),
    [allocationByOwner, ownerNames],
  );

  const ownerGroupDailySummaryForGrid = useMemo(
    () => sortPortfolioGridRows(ownerGroupDailySummary, ownerNames),
    [ownerGroupDailySummary, ownerNames],
  );

  const handleReorderOwners = useCallback((orderedOwnerNames: string[]) => {
    setOwnerNames((prev) => {
      const inOrder = orderedOwnerNames.filter((n) => prev.includes(n));
      const rest = prev.filter((n) => !inOrder.includes(n));
      const next = [...inOrder, ...rest];
      // 순서가 동일하면 state 갱신 생략(불필요한 재렌더·동기화 방지)
      if (next.length === prev.length && next.every((n, i) => n === prev[i])) return prev;
      return next;
    });
    markLocalChanged();
  }, []);

  const dailyLiveChangeByDate = useMemo<Record<string, DailyLiveChange>>(() => {
    const date = todayKST();

    // 소유자별 전일 기준 총액 (prevStock + 현금) — aggregateOwnerTotals가 올바른 %를 계산하려면
    // 각 그룹의 changePct 분모를 "그룹 자체 기준"이 아닌 "소유자 전체 기준"으로 통일해야 함
    const ownerPrevKrwMap = new Map<string, number>(
      positionsByOwner.map((g) => {
        const prevStock = g.items.reduce((s, p) => {
          if (p.previousClose === null) return s;
          const v =
            p.currency === "USD" ? p.previousClose * p.quantity * usdKrw
            : p.currency === "EUR" ? p.previousClose * p.quantity * eurKrw
            : p.previousClose * p.quantity;
          return s + v;
        }, 0);
        return [g.ownerName, prevStock + g.sectionCashKrw] as [string, number];
      }),
    );

    const ownerChanges = ownerGroupDailySummary
      .flatMap((owner) => {
        const ownerPrevKrw = ownerPrevKrwMap.get(owner.ownerName) ?? 0;
        return owner.groups.map((g) => ({
          name: `${owner.ownerName} · ${g.label}`,
          changeKrw: g.dailyChangeKrw,
          // 소유자 전체 전일 총액 대비 %로 통일 → aggregateOwnerTotals 합산이 정확해짐
          changePct: ownerPrevKrw > 0 ? (g.dailyChangeKrw / ownerPrevKrw) * 100 : g.dailyChangePct,
        }));
      })
      .sort((a, b) => Math.abs(b.changeKrw) - Math.abs(a.changeKrw));

    const totalChangeKrw = ownerGroupDailySummary.reduce((sum, owner) => sum + owner.totalDailyKrw, 0);
    const prevTotalKrw = [...ownerPrevKrwMap.values()].reduce((s, v) => s + v, 0);

    return {
      [date]: {
        date,
        changeKrw: totalChangeKrw,
        changePct: prevTotalKrw > 0 ? (totalChangeKrw / prevTotalKrw) * 100 : null,
        ownerChanges,
        compareNote: "실시간 전일종가 기준",
      },
    };
  }, [ownerGroupDailySummary, positionsByOwner, usdKrw, eurKrw]);

  const dailyTrendTradeMarkers = useMemo<DailyTradeMarker[]>(() => {
    const acc: DailyTradeMarker[] = [];
    for (const b of buyJournal) {
      acc.push({
        id: b.id,
        isoDate: b.date,
        kind: "buy",
        owner: b.owner,
        stockName: b.name,
        symbol: b.symbol,
        qty: b.qty,
        unitPrice: b.buyPrice,
        totalKrw: b.totalKrw,
        currency: b.currency,
        ...(b.currency === "KRW" ? {} : { fxRate: b.fxRate }),
      });
    }
    for (const [owner, entries] of Object.entries(sellLog)) {
      for (const e of entries) {
        const fx = Number(e.fxRate) > 0 ? Number(e.fxRate) : 1;
        const totalKrw =
          e.currency === "KRW" ? e.qty * e.sellPrice : e.qty * e.sellPrice * fx;
        const costBasisKrw =
          e.currency === "KRW" ? e.avgPrice * e.qty : e.avgPrice * e.qty * fx;
        const realizedPct =
          costBasisKrw > 0 ? (e.realizedKrw / costBasisKrw) * 100 : null;
        acc.push({
          id: e.id,
          isoDate: e.date,
          kind: "sell",
          owner,
          stockName: e.name,
          symbol: e.symbol,
          qty: e.qty,
          unitPrice: e.sellPrice,
          totalKrw,
          currency: e.currency,
          realizedKrw: e.realizedKrw,
          realizedPct,
          costBasisKrw,
          ...(e.currency === "KRW" ? {} : { fxRate: fx }),
        });
      }
    }
    return acc;
  }, [buyJournal, sellLog]);

  // 시세 로드 완료 후 오늘 스냅샷 자동 저장 (하루 1회 로컬 + 서버)
  useEffect(() => {
    if (!isHydrated) return;
    const hasRealPrices = positionsByOwner.some((g) => g.sectionTotal > 0);
    if (!hasRealPrices) return;
    // 환율 미확보(폴백 상수 1350/1450 사용 중) + 해당 통화 보유 시 → 스냅샷 저장 보류.
    // 폴백 환율로 미국·유럽 평가액이 통째로 왜곡돼 가짜 등락이 기록되는 것을 막는다.
    const hasUsdHolding = positions.some((p) => p.currency === "USD");
    const hasEurHolding = positions.some((p) => p.currency === "EUR");
    const fxMissing =
      (hasUsdHolding && marketQuery.data?.usdKrw == null) ||
      (hasEurHolding && marketQuery.data?.eurKrw == null);
    if (fxMissing) return;
    const today = todayKST();
    const ownerValues: Record<string, number> = {};
    const breakdownValues: Record<string, number> = {};
    let totalValue = 0;
    for (const g of positionsByOwner) {
      ownerValues[g.ownerName] = g.sectionTotal;
      totalValue += g.sectionTotal;

      // 달력 툴팁에서 "어떤 자산(그룹)이 변동했는지" 보여주기 위한 상세 스냅샷
      const blocks = buildHoldingsGroupBlocks(g.items);
      for (const block of blocks) {
        breakdownValues[`${g.ownerName} · ${block.label}`] = block.sumKrw;
      }
      if (g.sectionCashKrw > 0) {
        breakdownValues[`${g.ownerName} · 현금`] = g.sectionCashKrw;
      }
    }
    const snap: DailySnapshot = { date: today, ownerValues, breakdownValues, totalValue, savedAt: Date.now() };
    // 로컬 저장 (항상 오늘 최신값으로 갱신)
    saveDailySnapshot(snap);
    setDailySnapshots(loadDailySnapshots());

    // ── 어제 스냅샷 백필(보존 우선) ───────────────────────────────────────────
    //   어제 값을 매번 "현재 포지션 × 전일 종가 + 현재 현금"으로 덮어쓰면,
    //   오늘 입금/출금·매매가 어제 칸으로 새어 들어가 자산 추이가 왜곡된다.
    //   (예: 오늘 현금 1,000만 입금 → 어제 값도 1,000만 부풀려져 입금 점프가 사라짐)
    //   → 어제 기록이 이미 있으면 그날 실제값을 보존하고, 전혀 없을 때만 추정값으로 채운다.
    //   "어제 대비 등락률"은 dailyLiveChangeByDate가 실시간 동일포지션 기준으로 별도 계산하므로
    //   어제 스냅샷을 덮어쓰지 않아도 등락률 표시는 영향받지 않는다.
    const yday = yesterdayKST();
    const ydayAlreadyRecorded = loadDailySnapshots().some((s) => s.date === yday);
    if (!ydayAlreadyRecorded) {
      const prevOwnerValues: Record<string, number> = {};
      const prevBreakdownValues: Record<string, number> = {};
      let prevTotalValue = 0;
      for (const g of positionsByOwner) {
        const prevStock = g.items.reduce((s, p) => {
          const price = (typeof p.previousClose === "number" && p.previousClose > 0)
            ? p.previousClose : p.currentPrice;
          const v =
            p.currency === "USD" ? price * p.quantity * usdKrw
            : p.currency === "EUR" ? price * p.quantity * eurKrw
            : price * p.quantity;
          return s + v;
        }, 0);
        const ownerPrevTotal = prevStock + g.sectionCashKrw;
        prevOwnerValues[g.ownerName] = ownerPrevTotal;
        prevTotalValue += ownerPrevTotal;
        const blocks = buildHoldingsGroupBlocks(g.items);
        for (const block of blocks) {
          const blockPrev = block.items.reduce((s, p) => {
            const price = (typeof p.previousClose === "number" && p.previousClose > 0)
              ? p.previousClose : p.currentPrice;
            const v =
              p.currency === "USD" ? price * p.quantity * usdKrw
              : p.currency === "EUR" ? price * p.quantity * eurKrw
              : price * p.quantity;
            return s + v;
          }, 0);
          prevBreakdownValues[`${g.ownerName} · ${block.label}`] = blockPrev;
        }
        if (g.sectionCashKrw > 0) {
          prevBreakdownValues[`${g.ownerName} · 현금`] = g.sectionCashKrw;
        }
      }
      if (prevTotalValue > 0) {
        saveDailySnapshot({
          date: yday,
          ownerValues: prevOwnerValues,
          breakdownValues: prevBreakdownValues,
          totalValue: prevTotalValue,
          savedAt: Date.now(),
        });
        setDailySnapshots(loadDailySnapshots());
      }
    }

    // 서버 저장: KST 16~18시(장 마감 직후)에만 push
    // → 한국 장 마감(15:30) 후 종가 + 전일 미국 종가 기준으로, 매일 동일 시점(종가)으로 기록.
    // → 18시 이후(미국장 진행 중) push를 막아, 저녁 중간 시세가 그 날 값으로 굳는 것을 방지.
    //   (서버 크론도 KST 16·17시에 같은 종가 기준으로 기록하므로 시점이 일치함)
    try {
      const key = window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "";
      const nowKstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
      const isKoreanCloseWindow = nowKstHour >= 16 && nowKstHour < 18; // KST 16:00~17:59
      if (key.length >= 8 && isKoreanCloseWindow) {
        // 오늘 스냅샷 push
        const pushedDate = window.localStorage.getItem(SNAPSHOT_PUSHED_DATE_KEY) ?? "";
        const pushedTotal = Number(window.localStorage.getItem(SNAPSHOT_PUSHED_TOTAL_KEY) ?? "0");
        const valueDiff = pushedTotal > 0 ? Math.abs(totalValue - pushedTotal) / pushedTotal : 1;
        if (pushedDate !== today || valueDiff >= 0.01) {
          void fetch("/api/snapshot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sync_key: key, date: today, ownerValues, breakdownValues, totalValue }),
          }).then((r) => {
            if (r.ok) {
              safeSetItem(SNAPSHOT_PUSHED_DATE_KEY, today);
              safeSetItem(SNAPSHOT_PUSHED_TOTAL_KEY, String(totalValue));
            }
          }).catch(() => {});
        }
        // ※ 어제(이전 날짜) 스냅샷은 클라이언트가 push하지 않는다.
        //   서버 크론(/api/cron/daily-snapshot, KST 16·17시)이 매일 그날의 실제값을 기록하므로,
        //   클라이언트가 "현재 포지션 × 전일 종가"로 재계산해 덮어쓰면 과거 실제값이 훼손된다.
      }
    } catch {}
  }, [positionsByOwner, isHydrated, usdKrw, eurKrw]);

  /** pull → 있으면 반영, 없으면 이 기기(pos/cash/정렬)를 push (최초 기기·키 저장 직후 공통) */
  const syncWithServerForKey = useCallback(
    async (
      key: string,
      pos: Position[],
      cash: CashByOwner,
      holdingsSort: Record<OwnerName, HoldingsSortMode>,
      sellLogByOwner: Record<string, SellLogEntry[]>,
      buyJournalEntries: BuyJournalEntry[],
      owners: OwnerName[],
      /** true이면 로컬 변경 여부와 무관하게 항상 pull 우선 */
      forcePull = false,
    ) => {
    setSyncBusy(true);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull", key }),
      });
      const j = (await r.json()) as {
        error?: string;
        found?: boolean;
        positions?: unknown;
        cash_by_owner?: unknown;
        holdings_sort_by_owner?: unknown;
        sell_log_by_owner?: unknown;
        buy_journal?: unknown;
        owner_names?: unknown;
        target_stock_weight_by_owner?: unknown;
        owner_scratchpad_by_owner?: unknown;
        rebalance_calculator_by_owner?: unknown;
        alert_thresholds_by_position?: unknown;
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "동기화를 사용할 수 없습니다.");
        return;
      }
      if (j.found) {
        const serverTs = typeof j.updated_at === "string" ? j.updated_at.trim() : "";
        const lastSyncTs = (window.localStorage.getItem(LAST_SYNC_TS_KEY) ?? "").trim();
        const hasLocalChanges = window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) === "1";

        const cacheMissing = isLocalPortfolioCacheCleared();
        const serverNewer = isServerSnapshotNewerThanLocal(serverTs, lastSyncTs);

        // ── 충돌 감지: 이 기기에 미저장 변경이 있고(서버에 안 올라감) 서버가 더 최신 ──
        //   = 다른 기기가 마지막 동기화 이후 서버에 새 데이터를 올렸음.
        //   이 기기 데이터로 그냥 push하면 다른 기기의 변경이 유실되므로
        //   (C) 덮어쓰기 전 서버 상태를 자동 백업하고 (A) 사용자에게 방향을 확인한다.
        let conflictChoice: "push" | "applyServer" | null = null;
        if (hasLocalChanges && serverNewer && !forcePull) {
          const localChangedAtRaw = (window.localStorage.getItem(LOCAL_CHANGES_AT_KEY) ?? "").trim();
          const lastSyncAgeMs = (() => {
            const t = Date.parse(lastSyncTs);
            return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
          })();
          if (localChangedAtRaw.length === 0) {
            // 수정 시각 기록이 없는 플래그 = 매수저널·알림설정 자동 이행(사용자 수정 아님).
            // 묻지 않고 서버 최신을 따른다 — "취소를 눌러도 충돌창이 계속 뜨는" 반복 방지.
            // (적용 후 자동 이행 데이터는 auto-push가 조용히 다시 서버에 올린다)
            conflictChoice = "applyServer";
          } else if (lastSyncAgeMs < CONFLICT_AUTO_PUSH_IF_SYNCED_WITHIN_MS) {
            // 이 기기는 방금 전까지 서버와 같은 상태였음 → 데이터가 낡지 않았으므로
            // 묻지 않고 이 기기 변경을 우선 저장한다(활발히 수정 중 모달 폭탄 방지).
            // 덮어쓰기 전 서버 상태는 자동 백업되어 복원 가능.
            try {
              await fetch("/api/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sync_key: key }),
              });
            } catch {
              // 백업 실패해도 진행 — 이 기기 기준 데이터가 최신 작업본
            }
            conflictChoice = "push";
            setSyncMessage("다른 기기의 저장과 겹쳐 이 기기 변경을 우선 저장했습니다. (직전 서버 상태는 자동 백업됨)");
          } else {
            // 이 기기가 오래(10분+) 동기화되지 않았던 경우(며칠 묵은 탭 등)만 사용자에게 확인.
            // C: 덮어쓰기로 사라질 "현재 서버 상태"를 백업 테이블에 자동 저장 (snapshot 생략 = 서버가 자기 상태를 백업)
            try {
              await fetch("/api/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sync_key: key }),
              });
            } catch {
              // 백업 실패해도 동기화 흐름은 계속 (아래 확인에서 사용자가 판단)
            }
            // A: 어느 쪽을 살릴지 확인 (각 데이터의 시각을 함께 표기)
            const serverTimeLabel = formatKstForConflict(serverTs);
            const localTimeLabel = formatKstForConflict(localChangedAtRaw);
            const overwrite = window.confirm(
              [
                "⚠️ 동기화 충돌",
                "",
                `서버: 다른 기기에서 저장한 더 최신 데이터 (${serverTimeLabel} 저장)`,
                `이 기기: 아직 서버에 올리지 않은 변경 (${localTimeLabel} 마지막 수정)`,
                "",
                `[확인] 이 기기 데이터(${localTimeLabel} 수정)로 서버를 덮어씁니다.`,
                "         (직전 서버 상태는 방금 자동 백업되어 복원 가능)",
                `[취소] 서버 데이터(${serverTimeLabel} 저장)를 이 기기로 불러옵니다.`,
                "         (이 기기의 미저장 변경은 버려집니다)",
              ].join("\n"),
            );
            conflictChoice = overwrite ? "push" : "applyServer";
          }
        }

        const shouldApplyServer =
          forcePull ||
          conflictChoice === "applyServer" ||
          (!hasLocalChanges && (serverNewer || (lastSyncTs.length > 0 && cacheMissing)));

        if (shouldApplyServer) {
          // ─ forcePull(키 변경 시) 또는 서버가 더 최신이고 로컬 미반영 변경 없음 → 서버 데이터를 적용
          //   (동기 시각만 남고 positions/owner_names 키는 지운 경우에도 서버 스냅샷을 다시 적용)
          setSyncMessage("서버에서 최신 잔고를 불러왔습니다.");
          skipMarkLocalChangedRef.current = 2;
          skipOwnerLocalChangedRef.current = 1;
          skipSellLogLocalChangedRef.current = 1;
          const valid = Array.isArray(j.positions)
            ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
            : [];
          const pulledOwners = inferOwnerNamesFromSyncPayload(j);
          const allowedOwners = new Set(pulledOwners);
          const filtered = valid.filter((p) => allowedOwners.has(p.owner));
          setPositions(mergeDuplicatePositions(filtered));
          setCashByOwner(normalizeCashStrict(j.cash_by_owner, pulledOwners));
          setHoldingsSortByOwner(normalizeHoldingsSortStrict(j.holdings_sort_by_owner, pulledOwners));
          setSellLog(normalizeSellLogStrict(j.sell_log_by_owner, pulledOwners));
          setOwnerNames(pulledOwners);
          const clockToStore = serverTs.length > 0 ? serverTs : new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, clockToStore);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, clockToStore);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
          setLastSyncedAt(clockToStore);
          setLastSellLogSyncedAt(clockToStore);
          setSellLogDirty(false);
          mergeAndPersistTargetStockWeightsFromServer(j.target_stock_weight_by_owner);
          mergeAndPersistOwnerScratchpadsFromServer(j.owner_scratchpad_by_owner);
          mergeAndPersistRebalanceCalculatorFromServer(j.rebalance_calculator_by_owner);
          const localAlerts = loadAlertThresholdsFromStorage();
          const fromServerAlerts = mergeAlertThresholdsFromServer(
            j.alert_thresholds_by_position,
            pulledOwners,
          );
          const mergedAlerts = mergeAlertThresholdsOnPull(
            localAlerts,
            j.alert_thresholds_by_position,
            pulledOwners,
          );
          setAlertThresholdsByKey(mergedAlerts);
          safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(mergedAlerts));
          skipAlertThresholdsHydrateRef.current = 1;
          // 자동 이행 플래그는 10분 간격으로만 재시도 — 업로드 실패가 반복돼도 push 폭주 방지
          const allowAutoKeep = canMarkAutoMigrationKeep();
          let autoKeepFired = false;
          if (
            allowAutoKeep &&
            Object.keys(fromServerAlerts).length === 0 &&
            Object.keys(mergedAlerts).length > 0
          ) {
            // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만 — 충돌창 판단에서 제외됨
            safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
            autoKeepFired = true;
          }
          // 매수저널: 서버에 있으면 교체, 서버가 비어있으면(컬럼 신설 직후 등)
          // 이 기기 기록을 보존하고 다음 push로 서버에 올린다.
          const serverBuyJournal = normalizeBuyJournalStrict(j.buy_journal, pulledOwners);
          if (serverBuyJournal.length > 0) {
            skipBuyJournalLocalChangedRef.current = 1;
            setBuyJournal(serverBuyJournal);
          } else if (allowAutoKeep && buyJournalEntries.length > 0) {
            // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만 — 충돌창 판단에서 제외됨
            safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
            autoKeepFired = true;
          }
          if (autoKeepFired) recordAutoMigrationKeep();
        } else if (hasLocalChanges) {
          // ─ 로컬에 미반영 변경이 있고 충돌이 없거나(서버가 더 최신이 아님)
          //   충돌 시 사용자가 "이 기기로 덮어쓰기"를 선택한 경우 → 로컬을 서버에 올림.
          //   (충돌 시 직전 서버 상태는 위에서 자동 백업됨)
          const rPush = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "push",
              key,
              positions: pos,
              cashByOwner: cash,
              holdingsSortByOwner: holdingsSort,
              sellLogByOwner,
              buyJournal: buyJournalEntries,
              ownerNames: owners,
              targetStockWeightByOwner: loadAllTargetStockWeights(),
              ownerScratchpadByOwner: loadAllOwnerScratchpads(),
              rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
              usdKrw: fxRef.current.usd,
              eurKrw: fxRef.current.eur,
              ...getAlertThresholdsPayload(),
            }),
          });
          const jPush = (await rPush.json()) as { ok?: boolean; updated_at?: string; error?: string };
          if (!rPush.ok) {
            setSyncMessage(jPush.error ?? "서버 업로드 실패");
          } else {
            const pushedTs = jPush.updated_at ?? new Date().toISOString();
            safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
            safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
            window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
            clearLocalChanged();
            setSyncMessage("이 기기의 변경 데이터를 서버에 올렸습니다.");
            setLastSyncedAt(pushedTs);
            setLastSellLogSyncedAt(pushedTs);
            setSellLogDirty(false);
          }
        } else {
          // ─ 이미 동기화된 상태
          if (!lastSyncTs) {
            // 최초 연결 시 lastSyncTs 를 서버 기준으로 초기화
            safeSetItem(
              LAST_SYNC_TS_KEY,
              serverTs.length > 0 ? serverTs : new Date().toISOString(),
            );
          }
          setSyncMessage("서버와 동기화 상태입니다.");
          setLastSyncedAt(
            serverTs.length > 0 ? serverTs : lastSyncTs || new Date().toISOString(),
          );
        }
      } else {
        // ─ 서버에 데이터 없음
        if (forcePull) {
          // 키 변경·초기화 직후: 빈 state를 서버에 올리지 않음. 새 키로 깨끗하게 시작.
          setSyncMessage("새 동기화 키입니다. 데이터를 입력하면 자동으로 서버에 저장됩니다.");
          return;
        }
        // ─ 최초 등록: 이 기기 내용을 처음 올림
        const r2 = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "push",
            key,
            positions: pos,
            cashByOwner: cash,
            holdingsSortByOwner: holdingsSort,
            sellLogByOwner,
            buyJournal: buyJournalEntries,
            ownerNames: owners,
            targetStockWeightByOwner: loadAllTargetStockWeights(),
            ownerScratchpadByOwner: loadAllOwnerScratchpads(),
            rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
            usdKrw: fxRef.current.usd,
            eurKrw: fxRef.current.eur,
            ...getAlertThresholdsPayload(),
          }),
        });
        const j2 = (await r2.json()) as { ok?: boolean; updated_at?: string; error?: string };
        if (!r2.ok) {
          setSyncMessage(j2.error ?? "서버 업로드 실패");
        } else {
          const pushedTs = j2.updated_at ?? new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
          setSyncMessage("서버에 기존 데이터가 없어 이 기기 내용을 올렸습니다.");
          setLastSyncedAt(pushedTs);
          setLastSellLogSyncedAt(pushedTs);
          setSellLogDirty(false);
        }
      }
    } catch {
      setSyncMessage("네트워크 오류로 동기화에 실패했습니다.");
    } finally {
      setSyncBusy(false);
    }
  },
  [],
  );

  useEffect(() => {
    void fetch("/api/sync")
      .then((r) => r.json())
      .then((j: { ok?: boolean }) => {
        setServerHealth(j.ok === true ? "ok" : "error");
      })
      .catch(() => setServerHealth("error"));
  }, []);

  useEffect(() => {
    const pos = loadPositions();
    const cash = loadCashByOwner();
    const log = loadSellLog();
    const buyJ = loadBuyJournal();
    const owners = loadOwnerNames(); // SSR 불일치 방지로 useState 초기값은 DEFAULT — 여기서 실제 로컬 값 로드
    skipMarkLocalChangedRef.current = 2; // 디스크→state 재적용은 "수정"이 아님
    skipSellLogLocalChangedRef.current = 1;
    skipOwnerLocalChangedRef.current = 1; // 초기 로드 시 ownerNames 효과가 로컬 변경으로 오인되는 것을 방지
    setPositions(pos);
    setCashByOwner(cash);
    skipBuyJournalLocalChangedRef.current = 1;
    setBuyJournal(buyJ);
    setSellLog(log);
    setOwnerNames(owners);
    const loadedAlerts = loadAlertThresholdsFromStorage();
    skipAlertThresholdsHydrateRef.current = 1;
    setAlertThresholdsByKey(loadedAlerts);
    // URL ?key=... 파라미터가 있으면 localStorage보다 우선 적용 (북마크 복원용)
    const urlKey = (() => {
      try {
        const p = new URLSearchParams(window.location.search).get("key") ?? "";
        return p.trim();
      } catch { return ""; }
    })();
    const savedKey = urlKey.length >= 8
      ? urlKey
      : (typeof window !== "undefined" ? window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "" : "");
    // URL 파라미터 키가 localStorage 키와 다르면 덮어씀
    if (urlKey.length >= 8 && urlKey !== window.localStorage.getItem(SYNC_KEY_STORAGE)) {
      safeSetItem(SYNC_KEY_STORAGE, urlKey);
    }
    const savedSellLogSyncTs =
      typeof window !== "undefined" ? window.localStorage.getItem(LAST_SELL_LOG_SYNC_TS_KEY) ?? "" : "";
    const savedSellLogDirty =
      typeof window !== "undefined" ? window.localStorage.getItem(SELL_LOG_DIRTY_KEY) === "1" : false;
    setCloudSyncKey(savedKey);
    setSyncKeyDraft(savedKey);
    setLastSellLogSyncedAt(savedSellLogSyncTs.trim() || null);
    setSellLogDirty(savedSellLogDirty);
    const savedLastSyncTs =
      typeof window !== "undefined" ? window.localStorage.getItem(LAST_SYNC_TS_KEY) ?? "" : "";
    setLastSyncedAt(savedLastSyncTs.trim() || null);
    const storedAuto = typeof window !== "undefined" ? window.localStorage.getItem(AUTO_SYNC_STORAGE) : null;
    const auto = storedAuto !== "0"; // 명시적으로 끈 경우(0)만 false, 나머지는 기본 true
    setAutoSync(auto);
    const holdSort = loadHoldingsSort();
    setHoldingsSortByOwner(holdSort);
    try {
      setShowHoldingsAlertColumn(
        window.localStorage.getItem(HOLDINGS_ALERT_COLUMN_VISIBLE_KEY) === "1",
      );
    } catch {
      setShowHoldingsAlertColumn(false);
    }
    try {
      const aggCol = window.localStorage.getItem(AGG_ALERT_COLUMN_VISIBLE_KEY);
      setShowAggAlertColumn(aggCol === null ? true : aggCol === "1");
    } catch {
      setShowAggAlertColumn(true);
    }
    setIsHydrated(true);

    if (savedKey.length < 8) {
      setSyncReady(true);
      return;
    }

    void (async () => {
      await syncWithServerForKey(savedKey, pos, cash, holdSort, log, buyJ, loadOwnerNames());
      setSyncReady(true);
    })();
  }, [syncWithServerForKey]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(HOLDINGS_SORT_STORAGE_KEY, JSON.stringify(holdingsSortByOwner));
  }, [holdingsSortByOwner, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(STORAGE_KEY, JSON.stringify(positions));
    if (skipMarkLocalChangedRef.current > 0) {
      skipMarkLocalChangedRef.current -= 1;
    } else {
      // 사용자가 직접 수정한 경우 → 다음 동기화 시 Push 유도
      markLocalChanged();
    }
  }, [positions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(CASH_STORAGE_KEY, JSON.stringify(cashByOwner));
    if (skipMarkLocalChangedRef.current > 0) {
      skipMarkLocalChangedRef.current -= 1;
    } else {
      markLocalChanged();
    }
  }, [cashByOwner, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(alertThresholdsByKey));
    if (skipAlertThresholdsHydrateRef.current > 0) {
      skipAlertThresholdsHydrateRef.current -= 1;
    } else {
      markLocalChanged();
    }
  }, [alertThresholdsByKey, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(HOLDINGS_ALERT_COLUMN_VISIBLE_KEY, showHoldingsAlertColumn ? "1" : "0");
  }, [showHoldingsAlertColumn, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(AGG_ALERT_COLUMN_VISIBLE_KEY, showAggAlertColumn ? "1" : "0");
  }, [showAggAlertColumn, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(SELL_LOG_KEY, JSON.stringify(sellLog));
    if (skipSellLogLocalChangedRef.current > 0) {
      skipSellLogLocalChangedRef.current -= 1;
    } else {
      markLocalChanged();
      safeSetItem(SELL_LOG_DIRTY_KEY, "1");
      setSellLogDirty(true);
    }
  }, [sellLog, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(BUY_JOURNAL_KEY, JSON.stringify(buyJournal));
    if (skipBuyJournalLocalChangedRef.current > 0) {
      skipBuyJournalLocalChangedRef.current -= 1;
    } else {
      // 사용자가 매수 기록을 추가·수정한 경우 → 다음 동기화 시 Push 유도
      markLocalChanged();
    }
  }, [buyJournal, isHydrated]);

  // 로컬 스냅샷 읽기 + 동기화 키가 있으면 서버 스냅샷도 병합
  // cloudSyncKey 의존: 키가 뒤늦게 설정돼도(UI 입력·URL 파라미터 등) 서버 fetch가 즉시 재실행됨
  useEffect(() => {
    if (!isHydrated) return;
    const local = loadDailySnapshots();
    setDailySnapshots(local);

    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setCronDailySnapshotRecordedAt(null);
      return;
    }

    void fetch(`/api/snapshot?sync_key=${encodeURIComponent(key)}&days=180`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          json: {
            snapshots?: DailySnapshot[];
            latestDailySnapshotRecordedAt?: string | null;
          } | null,
        ) => {
        if (!json) return;
        const snaps = json.snapshots ?? [];
        if (
          typeof json.latestDailySnapshotRecordedAt === "string" &&
          json.latestDailySnapshotRecordedAt.trim()
        ) {
          setCronDailySnapshotRecordedAt(json.latestDailySnapshotRecordedAt.trim());
        } else {
          setCronDailySnapshotRecordedAt(null);
        }
        if (!snaps.length) return;
        // 서버 스냅샷과 로컬 스냅샷 병합
        // ★ 경쟁 조건 방지: 서버 응답이 올 때 최신 localStorage를 다시 읽어서 병합합니다.
        //   (effect 시작 이후 saveDailySnapshot으로 새로 저장된 데이터를 포함시키기 위함)
        const freshLocal = loadDailySnapshots();
        const localMap = new Map(freshLocal.map((s) => [s.date, s]));
        const mergeToday = todayKST();
        for (const s of snaps) {
          const existing = localMap.get(s.date);

          const serverLooksEmpty =
            !Number.isFinite(s.totalValue) ||
            s.totalValue <= 0 ||
            !s.ownerValues ||
            Object.keys(s.ownerValues).length === 0;
          const localLooksValid =
            !!existing &&
            Number.isFinite(existing.totalValue) &&
            existing.totalValue > 0 &&
            !!existing.ownerValues &&
            Object.keys(existing.ownerValues).length > 0;

          if (serverLooksEmpty && localLooksValid) continue;

          // 시점 일관성: 과거 날짜는 서버(크론 KST 16:00 종가)를 신뢰하고,
          // 오늘은 로컬(실시간)을 우선한다.
          //  - 과거를 로컬 우선으로 두면, 저녁(미국장)에 앱을 켰을 때의 중간 시세가
          //    그 날 값으로 굳어 종가 기준과 어긋난 가짜 변동이 생긴다.
          //  - 오늘은 아직 진행 중이라 실시간 로컬값이 더 최신이라 우선.
          const isPastDay = s.date < mergeToday;
          const preferServer = isPastDay;

          if (localLooksValid && !serverLooksEmpty) {
            const base = preferServer ? s : existing!;
            const other = preferServer ? existing! : s;
            const baseOwners = new Set(Object.keys(base.ownerValues ?? {}));
            const extraOwnerValues: Record<string, number> = {};
            const extraBreakdown: Record<string, number> = {};
            for (const [owner, val] of Object.entries(other.ownerValues ?? {})) {
              if (!baseOwners.has(owner)) extraOwnerValues[owner] = val;
            }
            for (const [key, val] of Object.entries(other.breakdownValues ?? {})) {
              const ownerPart = key.split(" · ")[0] ?? "";
              if (!baseOwners.has(ownerPart)) extraBreakdown[key] = val;
            }
            const mergedOwnerValues = { ...(base.ownerValues ?? {}), ...extraOwnerValues };
            const mergedBreakdown = { ...(base.breakdownValues ?? {}), ...extraBreakdown };
            // totalValue는 항상 ownerValues의 합과 일치해야 함.
            // 보충된 보유자(extraOwnerValues)가 있으면 base.totalValue로는 과소 계상되므로 재계산.
            const mergedTotalValue = Object.values(mergedOwnerValues).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
            localMap.set(s.date, {
              ...base,
              ownerValues: mergedOwnerValues,
              breakdownValues: Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
              totalValue: mergedTotalValue,
            });
            continue;
          }

          localMap.set(s.date, s);
        }
        const merged = [...localMap.values()].sort((a, b) => a.date.localeCompare(b.date));
        setDailySnapshots(merged);
        safeSetItem(DAILY_SNAPSHOTS_KEY, JSON.stringify(merged));
      })
      .catch(() => {});
  }, [isHydrated, cloudSyncKey]);

  useEffect(() => {
    if (!isHydrated || !syncReady || !autoSync || cloudSyncKey.length < 8) return;
    // 로컬 변경이 없으면 불필요한 push를 생략 — Pull 직후 state가 바뀌어도 push 안 함
    if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
    if (pushDebounceRef.current) clearTimeout(pushDebounceRef.current);
    pushDebounceRef.current = setTimeout(async () => {
      // debounce 후 다시 확인 (그 사이 pull이 들어왔을 수 있음)
      if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
      // ── 덮어쓰기 가드: push 전에 서버가 더 최신인지 확인 ──
      // 모바일에서 며칠 전 열어둔 탭이 복원된 채 수정하면, 다른 기기가 올린
      // 최신 서버 데이터를 옛 state로 통째로 덮어쓸 수 있다. 서버 updated_at이
      // 로컬 마지막 동기 시각보다 새로우면 블라인드 push 대신 충돌 플로우
      // (서버 상태 자동 백업 + 사용자 확인)로 위임한다.
      // meta 확인 자체가 실패하면(네트워크 등) 기존 동작대로 push를 진행한다.
      try {
        const metaRes = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "meta", key: cloudSyncKey }),
        });
        if (metaRes.ok) {
          const meta = (await metaRes.json().catch(() => ({}))) as {
            found?: boolean;
            updated_at?: string | null;
          };
          const serverTs = typeof meta.updated_at === "string" ? meta.updated_at : "";
          const lastSyncTs = window.localStorage.getItem(LAST_SYNC_TS_KEY) ?? "";
          if (meta.found && isServerSnapshotNewerThanLocal(serverTs, lastSyncTs)) {
            setSyncMessage("서버에 다른 기기의 최신 데이터가 있어 확인이 필요합니다.");
            await syncWithServerForKey(
              cloudSyncKey,
              positions,
              cashByOwner,
              holdingsSortByOwner,
              sellLog,
              buyJournal,
              ownerNames,
            );
            return;
          }
        }
      } catch {
        // meta 확인 실패는 무시하고 평소대로 push
      }
      if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
      void fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key: cloudSyncKey,
          // 라이브 시세를 currentPrice에 실어 보내 서버·크론 폴백값을 최신화(가짜 등락 방지)
          positions: positionsWithLivePrices(positions, marketQuery.data?.quotes),
          cashByOwner,
          holdingsSortByOwner,
          sellLogByOwner: sellLog,
          buyJournal,
          ownerNames,
          targetStockWeightByOwner: loadAllTargetStockWeights(),
          ownerScratchpadByOwner: loadAllOwnerScratchpads(),
          rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
          // 동기화 시점 환율 — 텔레그램이 "대시보드가 본 값"을 그대로 재현하는 데 사용
          usdKrw: fxRef.current.usd,
          eurKrw: fxRef.current.eur,
          ...getAlertThresholdsPayload(),
        }),
      }).then(async (r) => {
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
          const pushedTs = j.updated_at ?? new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
          setLastSyncedAt(pushedTs);
          setLastSellLogSyncedAt(pushedTs);
          setSellLogDirty(false);
          setSyncMessage("서버에 자동 저장했습니다.");
        } else {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          setSyncMessage(j.error ?? "자동 저장 실패(서버 응답 오류). GET /api/sync 로 상태를 확인하세요.");
        }
      });
    }, 2000);
    return () => {
      if (pushDebounceRef.current) clearTimeout(pushDebounceRef.current);
    };
    // marketQuery.data?.quotes는 의도적으로 deps에서 제외 — 시세 틱마다 push가 트리거되면 안 됨.
    // push 시점에 클로저로 현재 시세를 읽어 currentPrice만 실어 보낸다(데이터 변경 시에만 push).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, cashByOwner, holdingsSortByOwner, sellLog, buyJournal, ownerNames, alertThresholdsByKey, isHydrated, syncReady, autoSync, cloudSyncKey, syncWithServerForKey]);

  /** 탭 복귀 재동기화 마지막 실행 시각 — 잦은 포커스 전환 시 과도한 pull 방지(60초 스로틀) */
  const visibilityResyncLastRunRef = useRef(0);

  // ── 탭 복귀 시 재동기화 ──
  // pull은 원래 페이지 로드 시 1회뿐이라, 모바일 브라우저가 며칠 전 탭을
  // 새로고침 없이 복원하면 옛 데이터가 그대로 보였다. 탭이 다시 보일 때
  // syncWithServerForKey를 돌려 서버가 더 최신이면 받아오고(로컬 변경 없을 때),
  // 충돌이면 기존 확인 플로우를 태운다.
  useEffect(() => {
    if (!isHydrated || !syncReady || !autoSync || cloudSyncKey.length < 8) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - visibilityResyncLastRunRef.current < 60_000) return;
      if (syncBusy) return;
      visibilityResyncLastRunRef.current = now;
      void syncWithServerForKey(
        cloudSyncKey,
        positions,
        cashByOwner,
        holdingsSortByOwner,
        sellLog,
        buyJournal,
        ownerNames,
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [isHydrated, syncReady, autoSync, cloudSyncKey, positions, cashByOwner, holdingsSortByOwner, sellLog, buyJournal, ownerNames, syncBusy, syncWithServerForKey]);

  async function handlePullCloud() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    setSyncBusy(true);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull", key }),
      });
      const j = (await r.json()) as {
        error?: string;
        found?: boolean;
        positions?: unknown;
        cash_by_owner?: unknown;
        holdings_sort_by_owner?: unknown;
        sell_log_by_owner?: unknown;
        buy_journal?: unknown;
        owner_names?: unknown;
        target_stock_weight_by_owner?: unknown;
        owner_scratchpad_by_owner?: unknown;
        rebalance_calculator_by_owner?: unknown;
        alert_thresholds_by_position?: unknown;
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "불러오기 실패");
        return;
      }
      if (j.found) {
        skipMarkLocalChangedRef.current = 2;
        skipOwnerLocalChangedRef.current = 1;
        skipSellLogLocalChangedRef.current = 1;
        const valid = Array.isArray(j.positions)
          ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
          : [];
        const pulledOwners = inferOwnerNamesFromSyncPayload(j);
        const allowedOwners = new Set(pulledOwners);
        const filtered = valid.filter((p) => allowedOwners.has(p.owner));
        setPositions(mergeDuplicatePositions(filtered));
        setCashByOwner(normalizeCashStrict(j.cash_by_owner, pulledOwners));
        setHoldingsSortByOwner(normalizeHoldingsSortStrict(j.holdings_sort_by_owner, pulledOwners));
        setSellLog(normalizeSellLogStrict(j.sell_log_by_owner, pulledOwners));
        setOwnerNames(pulledOwners);
        if (typeof j.updated_at === "string") {
          safeSetItem(LAST_SYNC_TS_KEY, j.updated_at);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, j.updated_at);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
        }
        // 매수저널: 서버에 있으면 교체, 비어있으면 이 기기 기록 보존(다음 push로 올림).
        // HAS_LOCAL_CHANGES 설정은 위의 removeItem 이후여야 지워지지 않는다.
        // 자동 이행 플래그는 10분 간격으로만 재시도(push 폭주 방지).
        const allowAutoKeepPull = canMarkAutoMigrationKeep();
        let autoKeepFiredPull = false;
        const pulledBuyJournal = normalizeBuyJournalStrict(j.buy_journal, pulledOwners);
        if (pulledBuyJournal.length > 0) {
          skipBuyJournalLocalChangedRef.current = 1;
          setBuyJournal(pulledBuyJournal);
        } else if (allowAutoKeepPull && buyJournal.length > 0) {
          // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만
          safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
          autoKeepFiredPull = true;
        }
        setSyncMessage("서버에서 불러왔습니다.");
        setLastSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
        setLastSellLogSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
        setSellLogDirty(false);
        mergeAndPersistTargetStockWeightsFromServer(j.target_stock_weight_by_owner);
        mergeAndPersistOwnerScratchpadsFromServer(j.owner_scratchpad_by_owner);
        mergeAndPersistRebalanceCalculatorFromServer(j.rebalance_calculator_by_owner);
        const localAlertsPull = loadAlertThresholdsFromStorage();
        const fromServerPull = mergeAlertThresholdsFromServer(
          j.alert_thresholds_by_position,
          pulledOwners,
        );
        const mergedPullAlerts = mergeAlertThresholdsOnPull(
          localAlertsPull,
          j.alert_thresholds_by_position,
          pulledOwners,
        );
        setAlertThresholdsByKey(mergedPullAlerts);
        safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(mergedPullAlerts));
        skipAlertThresholdsHydrateRef.current = 1;
        if (
          allowAutoKeepPull &&
          Object.keys(fromServerPull).length === 0 &&
          Object.keys(mergedPullAlerts).length > 0
        ) {
          // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만
          safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
          autoKeepFiredPull = true;
        }
        if (autoKeepFiredPull) recordAutoMigrationKeep();
        // 관심종목도 서버에서 다시 불러오기
        setWatchlistLoaded(false);
      } else {
        setSyncMessage("서버에 아직 데이터가 없습니다. 먼저 이 기기에서 올리기를 해 보세요.");
      }
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function handlePushCloud() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    setSyncBusy(true);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key,
          positions,
          cashByOwner,
          holdingsSortByOwner,
          sellLogByOwner: sellLog,
          buyJournal,
          ownerNames,
          targetStockWeightByOwner: loadAllTargetStockWeights(),
          ownerScratchpadByOwner: loadAllOwnerScratchpads(),
          rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
          usdKrw: fxRef.current.usd,
          eurKrw: fxRef.current.eur,
          ...getAlertThresholdsPayload(),
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "업로드 실패");
      } else {
        const pushedTs = (j as { updated_at?: string }).updated_at ?? new Date().toISOString();
        safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
        safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
        window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
        clearLocalChanged();
        setSyncMessage("서버에 올렸습니다.");
        setLastSyncedAt(pushedTs);
        setLastSellLogSyncedAt(pushedTs);
        setSellLogDirty(false);
      }
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  /** 이 기기 localStorage·state 기준 전체 스냅샷(기준선·목표비중·메모 등 포함) */
  const buildLocalSnapshotForBackup = useCallback(() => {
    safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(alertThresholdsByKey));
    return {
      positions,
      cash_by_owner: cashByOwner,
      holdings_sort_by_owner: holdingsSortByOwner,
      sell_log_by_owner: sellLog,
      owner_names: ownerNames,
      target_stock_weight_by_owner: loadAllTargetStockWeights(),
      owner_scratchpad_by_owner: loadAllOwnerScratchpads(),
      rebalance_calculator_by_owner: buildRebalanceCalculatorByOwnerFromLocal(),
      alert_thresholds_by_position: getAlertThresholdsForSync(),
      // 매수 일지는 로컬 전용이므로 메인 sync에는 없지만 백업에는 포함(브라우저 캐시 삭제 대비)
      buy_journal_entries: buyJournal,
      source_updated_at: lastSyncedAt ?? new Date().toISOString(),
    };
  }, [
    positions,
    cashByOwner,
    holdingsSortByOwner,
    sellLog,
    ownerNames,
    buyJournal,
    alertThresholdsByKey,
    lastSyncedAt,
  ]);

  /** 현재 기기의 수기 입력 전체를 백업 테이블에 저장합니다. */
  async function handleBackupSnapshot() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    const ok = window.confirm(
      [
        "이 기기에 있는 데이터를 백업합니다.",
        "",
        "포함: 종목·현금·보유자·매도일지·보유 순서·목표 비중·메모·리밸런스 계산·기준선(익·손 %·가격) 등",
        "",
        "백업을 진행할까요?",
      ].join("\n"),
    );
    if (!ok) return;

    setSyncBusy(true);
    try {
      const r = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: key, snapshot: buildLocalSnapshotForBackup() }),
      });
      const j = (await r.json()) as { ok?: boolean; message?: string; error?: string; warning?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "백업 실패");
      } else {
        setSyncMessage(j.warning ?? j.message ?? "백업을 저장했습니다.");
        void refreshLatestBackupAt();
      }
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  /** 서버에 쌓인 백업 행을 JSON 파일로 내려받습니다(브라우저 다운로드). */
  async function handleDownloadBackups() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    const ok = window.confirm(
      [
        "① 이 기기의 잔고·기준선·목표비중 등 수기 입력을 백업 테이블에 한 줄 추가하고,",
        "② 이어서 서버에 쌓인 백업 목록을 JSON 파일로 내려받습니다.",
        "",
        "내려받은 파일은 내 PC의 다운로드 폴더 등에 남습니다. 웹이 그 파일을 대신 지우지는 못합니다(브라우저 보안). 필요 없으면 직접 삭제하세요.",
        "",
        "파일에는 동기화 키와 백업 데이터가 들어갑니다. 타인과 공유하지 마세요.",
        "",
        "진행할까요?",
      ].join("\n"),
    );
    if (!ok) return;

    setSyncBusy(true);
    try {
      const rSnap = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: key, snapshot: buildLocalSnapshotForBackup() }),
      });
      const jSnap = (await rSnap.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!rSnap.ok) {
        setSyncMessage(
          jSnap.error ??
            (rSnap.status === 404
              ? "서버에 해당 키의 잔고가 없어 백업을 만들 수 없습니다. 먼저 동기화해 주세요."
              : "백업(스냅샷 저장)에 실패했습니다."),
        );
        return;
      }

      const r = await fetch(`/api/backup/export?sync_key=${encodeURIComponent(key)}`);
      const text = await r.text();
      if (!r.ok) {
        let msg = "백업 내려받기 실패";
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        setSyncMessage(msg);
        return;
      }
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `portfolio-backups-${new Date().toISOString().slice(0, 19).replace(/:/g, "-").replace("T", "_")}.json`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSyncMessage("서버에 백업 한 줄을 추가한 뒤, JSON을 내려받았습니다.");
      void refreshLatestBackupAt();
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  /** 백업 JSON 파일을 읽어 선택 목록을 띄웁니다. 실제 복원은 handleRestoreSpecificBackup에서. */
  async function handleRestoreFromBackupFile(ev: ChangeEvent<HTMLInputElement>) {
    const input = ev.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    let text: string;
    try {
      text = await file.text();
    } catch {
      setSyncMessage("파일을 읽을 수 없습니다.");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      setSyncMessage("JSON 형식이 아닙니다.");
      return;
    }

    if (!raw || typeof raw !== "object") {
      setSyncMessage("파일 내용이 올바르지 않습니다.");
      return;
    }

    const root = raw as { format?: unknown; sync_key?: unknown; backups?: unknown };
    if (
      root.format !== "portfolio_snapshot_backups_v1" ||
      !Array.isArray(root.backups) ||
      root.backups.length === 0
    ) {
      setSyncMessage("이 앱에서 내려받은 백업 파일이 아니거나, 백업 목록이 비어 있습니다.");
      return;
    }

    const parsed = (root.backups as unknown[]).filter(
      (b): b is { id?: string; created_at: string; snapshot: Record<string, unknown> } =>
        b !== null &&
        typeof b === "object" &&
        typeof (b as { created_at?: unknown }).created_at === "string" &&
        typeof (b as { snapshot?: unknown }).snapshot === "object",
    );

    if (parsed.length === 0) {
      setSyncMessage("백업 항목을 파싱하지 못했습니다.");
      return;
    }

    setPendingBackups(parsed);
    setPendingBackupFileKey(typeof root.sync_key === "string" ? root.sync_key.trim() : "");
    setSyncMessage("");
  }

  /** 선택한 인덱스의 백업을 서버에 push한 뒤 화면을 갱신합니다. */
  async function handleRestoreSpecificBackup(idx: number) {
    const backups = pendingBackups;
    if (!backups || idx < 0 || idx >= backups.length) return;

    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }

    const fileKey = pendingBackupFileKey;
    if (fileKey && fileKey !== key) {
      const okKey = window.confirm(
        [
          "파일에 적힌 동기화 키와 현재 이 기기 키가 다릅니다.",
          `파일 키 끝 4자: …${fileKey.slice(-4)}`,
          `현재 키 끝 4자: …${key.slice(-4)}`,
          "",
          "현재 키로 서버에 올릴까요? (잘못 고르면 다른 키의 데이터를 덮어씁니다.)",
        ].join("\n"),
      );
      if (!okKey) return;
    }

    const entry = backups[idx];
    const kstTime = new Date(entry.created_at).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const ok = window.confirm(
      [
        `백업 시각: ${kstTime} (KST)`,
        "",
        "이 시점의 백업으로 서버 메인 잔고를 덮어쓴 뒤, 화면을 서버에서 다시 불러옵니다.",
        "",
        "복원할까요?",
      ].join("\n"),
    );
    if (!ok) return;

    setSyncBusy(true);
    try {
      const s = entry.snapshot;
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key,
          positions: s.positions ?? [],
          cashByOwner: s.cash_by_owner ?? {},
          holdingsSortByOwner: s.holdings_sort_by_owner ?? {},
          sellLogByOwner: s.sell_log_by_owner ?? {},
          ownerNames: s.owner_names ?? [],
          ...("target_stock_weight_by_owner" in s && s.target_stock_weight_by_owner != null
            ? { targetStockWeightByOwner: s.target_stock_weight_by_owner }
            : {}),
          ...("owner_scratchpad_by_owner" in s && s.owner_scratchpad_by_owner != null
            ? { ownerScratchpadByOwner: s.owner_scratchpad_by_owner }
            : {}),
          ...("rebalance_calculator_by_owner" in s && s.rebalance_calculator_by_owner != null
            ? { rebalanceCalculatorByOwner: s.rebalance_calculator_by_owner }
            : {}),
          ...("alert_thresholds_by_position" in s && s.alert_thresholds_by_position != null
            ? { alertThresholdsByPosition: s.alert_thresholds_by_position }
            : {}),
          ...(Array.isArray(s.buy_journal_entries) && s.buy_journal_entries.length > 0
            ? { buyJournal: s.buy_journal_entries }
            : {}),
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "복원(서버 반영)에 실패했습니다.");
        return;
      }
      // 매수 일지: 위 push로 서버에도 반영되지만, 직후 pull 전에 화면이 비지 않도록 로컬도 즉시 복원
      if (Array.isArray(s.buy_journal_entries) && s.buy_journal_entries.length > 0) {
        safeSetItem(BUY_JOURNAL_KEY, JSON.stringify(s.buy_journal_entries));
        skipBuyJournalLocalChangedRef.current = 1;
        setBuyJournal(loadBuyJournal());
      }
      setPendingBackups(null);
      await handlePullCloud();
      setSyncMessage(`${kstTime} 백업으로 복원했습니다.`);
      void refreshLatestBackupAt();
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleSaveSyncKey() {
    const k = syncKeyDraft.trim();
    if (k.length < 8) {
      setSyncMessage("동기화 키는 8자 이상으로 정해 주세요.");
      return;
    }
    const prevKey = cloudSyncKey.trim();
    const isKeyChange = k !== prevKey && prevKey.length >= 8;

    if (isKeyChange) {
      // 키가 바뀌는 경우: React state 비동기 갱신·여러 useEffect 타이밍 경쟁으로
      // 옛 키 데이터가 남거나 빈 데이터가 새어나가는 문제를 원천 차단하기 위해
      // 로컬 데이터를 모두 지우고 페이지를 새로 로드한다.
      // 새로 로드되면 hydration 경로가 새 키로 서버에서 깨끗하게 pull한다(검증된 경로).
      const keysToRemove = [
        LEGACY_POSITIONS_STORAGE_KEY, CASH_STORAGE_KEY,
        HOLDINGS_SORT_STORAGE_KEY, DAILY_SNAPSHOTS_KEY, SELL_LOG_KEY,
        BUY_JOURNAL_KEY, LAST_SYNC_TS_KEY, LAST_SELL_LOG_SYNC_TS_KEY,
        SELL_LOG_DIRTY_KEY, HAS_LOCAL_CHANGES_KEY, LOCAL_CHANGES_AT_KEY, SNAPSHOT_PUSHED_DATE_KEY,
        SNAPSHOT_PUSHED_TOTAL_KEY, ALERT_THRESHOLDS_STORAGE_KEY,
        TARGET_WEIGHT_STORAGE_KEY, CALCULATOR_TARGET_STORAGE_KEY,
        OWNER_SCRATCHPAD_STORAGE_KEY,
      ];
      keysToRemove.forEach((key) => window.localStorage.removeItem(key));
      // STORAGE_KEY는 제거하면 재로드 시 샘플 데이터(DEFAULT_POSITIONS)가 뜨므로 빈 배열로 덮어씀
      safeSetItem(STORAGE_KEY, "[]");
      safeSetItem(SYNC_KEY_STORAGE, k);
      setSyncMessage("동기화 키를 변경했습니다. 새 키 데이터를 불러오는 중…");
      // 새 키로 페이지 재로드 → hydration이 서버에서 새 키 데이터를 pull
      window.location.href = `${window.location.pathname}?key=${encodeURIComponent(k)}`;
      return;
    }

    // 같은 키 재저장: 로컬 변경이 없으면 서버에서 pull
    const isFirstValidKeySave = prevKey.length < 8 && k.length >= 8;
    const noLocalChanges = window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1";
    const shouldForcePull = isFirstValidKeySave || noLocalChanges;
    if (shouldForcePull) {
      clearLocalChanged();
      window.localStorage.removeItem(LAST_SYNC_TS_KEY);
    }

    safeSetItem(SYNC_KEY_STORAGE, k);
    setCloudSyncKey(k);
    setSyncMessage("키를 저장했습니다. 서버와 맞추는 중…");
    await syncWithServerForKey(
      k,
      positions,
      cashByOwner,
      holdingsSortByOwner,
      sellLog,
      buyJournal,
      ownerNames,
      shouldForcePull,
    );
  }

  async function handleClearLocalData() {
    const keysToRemove = [
      STORAGE_KEY,
      LEGACY_POSITIONS_STORAGE_KEY,
      CASH_STORAGE_KEY,
      HOLDINGS_SORT_STORAGE_KEY,
      DAILY_SNAPSHOTS_KEY,
      SELL_LOG_KEY,
      BUY_JOURNAL_KEY,
      LAST_SYNC_TS_KEY,
      LAST_SELL_LOG_SYNC_TS_KEY,
      SELL_LOG_DIRTY_KEY,
      HAS_LOCAL_CHANGES_KEY,
      LOCAL_CHANGES_AT_KEY,
      SNAPSHOT_PUSHED_DATE_KEY,
      SNAPSHOT_PUSHED_TOTAL_KEY,
      ALERT_THRESHOLDS_STORAGE_KEY,
      TARGET_WEIGHT_STORAGE_KEY,
      CALCULATOR_TARGET_STORAGE_KEY,
      OWNER_SCRATCHPAD_STORAGE_KEY,
    ];
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
    // 자동 push 트리거 방지
    skipMarkLocalChangedRef.current = 10;
    skipOwnerLocalChangedRef.current = 5;
    skipSellLogLocalChangedRef.current = 5;
    setPositions([]);
    setCashByOwner(DEFAULT_CASH_BY_OWNER);
    setSellLog({});
    setBuyJournal([]);
    setWatchlistRows([]);
    setWatchlistLoaded(true);
    setPendingClearConfirm(false);

    // 서버의 "현재 키" 행도 빈 데이터로 덮어쓴다(보유자 목록은 유지).
    //  안 그러면 '키 저장'·'서버에서 불러오기' 때 서버에 남은 옛 데이터가 다시 살아난다.
    //  다른 동기화 키 행은 키마다 별도 행이라 영향받지 않는다.
    const key = cloudSyncKey.trim();
    if (key.length >= 8) {
      setSyncBusy(true);
      setSyncMessage("비우기 전에 서버 백업 중…");
      // 안전장치: 비우기 직전에 현재 서버 상태를 백업 테이블에 자동 저장(실수 대비, 복원 가능)
      try {
        await fetch("/api/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sync_key: key }),
        });
      } catch {
        // 백업 실패해도 초기화는 진행 (아래에서 비움)
      }
      setSyncMessage("서버의 이 키 데이터를 비우는 중…");
      try {
        const r = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "push",
            key,
            positions: [],
            cashByOwner: DEFAULT_CASH_BY_OWNER,
            holdingsSortByOwner: {},
            sellLogByOwner: {},
            ownerNames,
            targetStockWeightByOwner: {},
            ownerScratchpadByOwner: {},
            rebalanceCalculatorByOwner: {},
            alertThresholdsByPosition: {},
          }),
        });
        // 관심종목도 서버에서 비운다
        await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sync_key: key, entries: [] }),
        });
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
          const ts = j.updated_at ?? new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, ts);
          setLastSyncedAt(ts);
          setSyncMessage("초기화 완료. 서버의 이 키 데이터까지 비웠습니다. (직전 상태는 자동 백업되어 「백업에서 복원」으로 되살릴 수 있습니다)");
        } else {
          setSyncMessage("로컬은 비웠지만 서버 비우기에 실패했습니다. '서버로 올리기'를 눌러 주세요.");
        }
      } catch {
        setSyncMessage("로컬은 비웠지만 네트워크 오류로 서버 비우기에 실패했습니다.");
      } finally {
        setSyncBusy(false);
      }
    } else {
      setSyncMessage("초기화 완료(로컬). 동기화 키가 없어 서버는 변경하지 않았습니다.");
    }
  }

  useEffect(() => {
    if (!syncReady || !cloudSyncKey || cloudSyncKey.length < 8 || watchlistLoaded) return;
    setWatchlistLoaded(true);
    void (async () => {
      try {
        const r = await fetch(`/api/watchlist?sync_key=${encodeURIComponent(cloudSyncKey)}`);
        const j = (await r.json()) as {
          ok?: boolean;
          entries?: Array<{ symbol: string; name?: string; group?: string; owner?: string; owners?: string[] }>;
        };
        if (r.ok && j.entries && j.entries.length > 0) {
          setWatchlistRows(
            j.entries.map((e) => {
              const owners =
                Array.isArray(e.owners) && e.owners.length > 0
                  ? e.owners
                  : e.owner
                    ? [e.owner]
                    : [WATCHLIST_OWNER_ALL];
              return {
                symbol: e.symbol,
                name: e.name ?? "",
                group: e.group ?? "",
                owners,
              };
            }),
          );
        }
      } catch {
        // ignore
      }
    })();
  }, [syncReady, cloudSyncKey, watchlistLoaded]);

  async function handleSaveWatchlist() {
    if (!cloudSyncKey || cloudSyncKey.length < 8) {
      setWatchlistMessage("먼저 동기화 키를 저장해 주세요.");
      return;
    }
    setWatchlistBusy(true);
    setWatchlistMessage("");
    try {
      const entries = watchlistRows
        .map((row) => ({
          symbol: row.symbol.trim().toUpperCase(),
          ...(row.name.trim() ? { name: row.name.trim() } : {}),
          ...(row.group?.trim() ? { group: row.group.trim() } : {}),
          ...(row.owners?.includes(WATCHLIST_OWNER_ALL)
            ? {}
            : row.owners && row.owners.length > 0
              ? { owners: row.owners }
              : {}),
        }))
        .filter((e) => e.symbol.length > 0);
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: cloudSyncKey, entries }),
      });
      const j = (await res.json()) as { error?: string };
      setWatchlistMessage(res.ok ? "관심종목을 저장했습니다." : (j.error ?? "저장 실패"));
    } catch {
      setWatchlistMessage("네트워크 오류입니다.");
    } finally {
      setWatchlistBusy(false);
    }
  }

  async function handleTelegramTest(dryRun: boolean) {
    if (!cloudSyncKey || cloudSyncKey.length < 8) {
      setTelegramTestResult({ ok: false, error: "먼저 동기화 키를 저장해 주세요." });
      return;
    }
    setTelegramTestBusy(true);
    setTelegramTestResult(null);
    try {
      const res = await fetch("/api/alert/kakao-price-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sync_key: cloudSyncKey,
          dry_run: dryRun,
          // 실제 발송은 같은 날 여러 번 눌러도 브리핑을 다시 보낼 수 있게 함 (Cron과 별개 manual 로그 무시)
          ...(dryRun ? {} : { force_resend: true }),
        }),
      });
      const j = await res.json() as typeof telegramTestResult;
      setTelegramTestResult(j);
    } catch {
      setTelegramTestResult({ ok: false, error: "네트워크 오류입니다." });
    } finally {
      setTelegramTestBusy(false);
    }
  }

  // 종목 추가 후 티커 입력칸 자동 포커스
  useEffect(() => {
    if (focusSymbolTrigger === 0) return;
    addSymbolInputRef.current?.focus();
  }, [focusSymbolTrigger]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const savedScrollY = window.scrollY;

    // 붙여넣기 오류가 남아 있으면 저장 차단
    if (buyPasteError && !buyPasteError.startsWith("ℹ️")) {
      return;
    }

    const quantity = Number(form.quantity);
    const avgPrice = Number(form.avgPrice);

    if (!form.symbol.trim()) {
      setBuyPasteError("ℹ️ 티커(종목코드)를 입력해주세요.");
      return;
    }
    if (!form.name.trim()) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return;

    const purchaseUsdKrwNum = Number(form.purchaseUsdKrw);
    const purchaseEurKrwNum = Number(form.purchaseEurKrw);
    /** USD 매수: 매입 USD/KRW가 비어 있으면 현재 환율로 원화 차감(달러 예수 부족 시) */
    const effectivePurchaseUsdKrw =
      Number.isFinite(purchaseUsdKrwNum) && purchaseUsdKrwNum > 0 ? purchaseUsdKrwNum : usdKrw;
    /** EUR 매수: 매입환율 필드가 비어 있거나 잘못되면 현재 EUR/KRW로 원화 차감 */
    const effectivePurchaseEurKrw =
      Number.isFinite(purchaseEurKrwNum) && purchaseEurKrwNum > 0 ? purchaseEurKrwNum : eurKrw;
    if (form.currency === "USD") {
      if (!Number.isFinite(effectivePurchaseUsdKrw) || effectivePurchaseUsdKrw <= 0) return;
    }
    if (form.currency === "EUR") {
      if (!Number.isFinite(effectivePurchaseEurKrw) || effectivePurchaseEurKrw <= 0) return;
    }

    const ownersOrdered = ownerNames.filter((o) => form.selectedOwners.includes(o));
    if (ownersOrdered.length === 0) return;

    const symbol = form.symbol.trim().toUpperCase();
    const nameTrimmed = form.name.trim();
    const accountType: "해외주식" | "국내주식" =
      form.currency === "KRW" ? "국내주식" : "해외주식";
    const accountName = accountType === "국내주식" ? "국내주식-주계좌" : "미국주식-주계좌";

    for (const own of ownersOrdered) {
      const existing = positions.find(
        (p) => p.owner === own && p.symbol === symbol && p.currency === form.currency,
      );
      if (existing && existing.name.trim() !== nameTrimmed) {
        setAddPositionError(
          `「${own}」에 이미 등록된 ${symbol}의 종목명은 「${existing.name.trim()}」입니다. 기존과 동일한 종목명으로 맞춘 뒤 추가해 주세요.`,
        );
        return;
      }
    }
    setAddPositionError("");

    const shortOwners: OwnerName[] = [];
    /** USD 매수 보유자별: 달러로 전액 vs 원화로 전액 */
    let usdDeductPlans: Record<string, { deductUsd: number; deductKrw: number }> | null = null;
    let fxDeductUsd = 0;
    let fxDeductKrw = 0;

    if (form.currency === "USD") {
      usdDeductPlans = {};
      for (const owner of ownersOrdered) {
        const w = cashByOwner[owner] ?? { usd: 0, krw: 0 };
        const plan = usdPurchaseCashPlan(quantity, avgPrice, effectivePurchaseUsdKrw, w);
        if (!plan) shortOwners.push(owner);
        else usdDeductPlans[owner] = plan;
      }
    } else {
      const { deductUsd, deductKrw } = purchaseCashDeduction({
        currency: form.currency,
        quantity,
        avgPrice,
        purchaseEurKrw: form.currency === "EUR" ? effectivePurchaseEurKrw : purchaseEurKrwNum,
      });
      fxDeductUsd = deductUsd;
      fxDeductKrw = deductKrw;
      for (const owner of ownersOrdered) {
        const w = cashByOwner[owner] ?? { usd: 0, krw: 0 };
        const usdOk = fxDeductUsd <= CASH_CHECK_EPS || w.usd >= fxDeductUsd - CASH_CHECK_EPS;
        const krwOk = fxDeductKrw <= CASH_CHECK_EPS || w.krw >= fxDeductKrw - CASH_CHECK_EPS;
        if (!usdOk || !krwOk) shortOwners.push(owner);
      }
    }
    if (shortOwners.length > 0) {
      const msg =
        shortOwners.length === ownersOrdered.length
          ? "매입에 필요한 금액(주문+수수료)보다 현금 잔고가 적습니다."
          : `매입에 필요한 금액(주문+수수료)보다 현금이 부족한 보유자: ${shortOwners.join(", ")}`;
      setAddPositionError(msg);
      showActionErrorToast("현금이 부족합니다.");
      return;
    }

    const cg = form.chartGroup.trim();
    // 매수일: 입력했으면 그 날짜, 아니면 오늘(KST)
    const ymdCandidateForBase = form.purchaseDateForFx.trim();
    const tradeDateForBase =
      /^\d{4}-\d{2}-\d{2}$/.test(ymdCandidateForBase) ? ymdCandidateForBase : todayKST();
    // USD 매수인데 매입환율을 직접/정산조회로 확정하지 못했으면(빈칸 → 현재환율 임시),
    // 매수일을 저장하고 정산대기로 표시 → T+2 09:00 KST 지나면 자동으로 정산환율 보정
    const usdFxFinalized =
      form.currency === "USD" && Number.isFinite(purchaseUsdKrwNum) && purchaseUsdKrwNum > 0;
    const usdFxPending = form.currency === "USD" && !usdFxFinalized;
    const base: Omit<Position, "owner"> = {
      symbol,
      name: nameTrimmed,
      quantity,
      avgPrice,
      currentPrice: avgPrice,
      currency: form.currency,
      accountType,
      accountName,
      ...(form.currency === "USD"
        ? { purchaseUsdKrw: effectivePurchaseUsdKrw, purchaseDate: tradeDateForBase }
        : {}),
      ...(form.currency === "EUR" ? { purchaseEurKrw: effectivePurchaseEurKrw } : {}),
      ...(usdFxPending
        ? { purchaseFxPending: true, purchaseFxAtAdd: effectivePurchaseUsdKrw }
        : {}),
      ...(cg ? { chartGroup: cg } : {}),
    };

    const needsAlertThresholdPrompt = ownersOrdered.some((owner) => {
      const posKey = makePositionKey({ owner, symbol, currency: form.currency });
      const isNewPosition = !positions.some((p) => makePositionKey(p) === posKey);
      if (!isNewPosition) return false;
      return !hasAlertThresholdRule(resolveAlertRule(alertThresholdsByKey, owner, symbol));
    });

    setPositions((prev) => {
      let acc = prev;
      for (const owner of ownersOrdered) {
        const nextEntry: Position = { ...base, owner };
        acc = applyPositionUpsert(acc, nextEntry);
      }
      return acc;
    });

    setCashByOwner((prev) => {
      const next = { ...prev };
      for (const owner of ownersOrdered) {
        const w = next[owner] ?? { usd: 0, krw: 0 };
        const plan = usdDeductPlans?.[owner];
        if (plan) {
          next[owner] = { usd: w.usd - plan.deductUsd, krw: w.krw - plan.deductKrw };
        } else {
          next[owner] = { usd: w.usd - fxDeductUsd, krw: w.krw - fxDeductKrw };
        }
      }
      return next;
    });

    const ymdCandidate = form.purchaseDateForFx.trim();
    const tradeDate =
      /^\d{4}-\d{2}-\d{2}$/.test(ymdCandidate) ? ymdCandidate : todayKST();

    const newBuys: BuyJournalEntry[] = ownersOrdered.map((owner) => {
      const fx =
        form.currency === "KRW"
          ? 1
          : form.currency === "USD"
            ? effectivePurchaseUsdKrw
            : effectivePurchaseEurKrw;
      const totalKrw =
        form.currency === "KRW" ? quantity * avgPrice : quantity * avgPrice * fx;
      const id =
        typeof globalThis.crypto !== "undefined" &&
        typeof globalThis.crypto.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `buy-${Date.now()}-${symbol}-${owner}`;
      return {
        id,
        date: tradeDate,
        owner,
        symbol,
        name: nameTrimmed,
        qty: quantity,
        buyPrice: avgPrice,
        currency: form.currency,
        fxRate: fx,
        totalKrw,
        ...(usdFxPending && form.currency === "USD" ? { fxPending: true } : {}),
      };
    });

    setBuyJournal((prev) => [...prev, ...newBuys].slice(-BUY_JOURNAL_MAX));

    setForm({
      symbol: "",
      name: "",
      quantity: "",
      avgPrice: "",
      purchaseUsdKrw: "",
      purchaseEurKrw: "",
      purchaseDateForFx: "",
      chartGroup: "",
      currency: form.currency,
      accountType,
      selectedOwners: form.selectedOwners,
    });

    if (needsAlertThresholdPrompt) {
      setShowHoldingsAlertColumn(true);
      showActionSuccessToast(
        "종목이 반영되었습니다. 「종목별 합산」에서 익·손 %를, 보유 표 「기준선」열에서 익·손 가격을 입력한 뒤 저장해 주세요.",
      );
    } else {
      showActionSuccessToast("종목이 정상적으로 반영되었습니다.");
    }

    // 누락 보유자 추적 업데이트
    setAddOwnerTracker((prev) => {
      const idx = prev.findIndex((e) => e.symbol === symbol);
      const prevDone = idx >= 0 ? prev[idx].doneOwners : [];
      const updated = {
        symbol,
        name: nameTrimmed,
        isKorean: form.currency === "KRW",
        doneOwners: [...new Set([...prevDone, ...ownersOrdered])],
      };
      if (idx >= 0) return prev.map((e, i) => (i === idx ? updated : e));
      return [...prev, updated];
    });

    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScrollY, behavior: "instant" });
    });
    setFocusSymbolTrigger((n) => n + 1);
  }

  // ── 이미지 파싱 → 매수 일괄 반영 ──────────────────────────────────────────
  function handleImageBuyConfirm(trades: ConfirmedBuyTrade[]) {
    for (const t of trades) {
      const symbol = (t.symbol || t.name).trim().toUpperCase();
      const nameTrimmed = t.name.trim();
      const accountType: "해외주식" | "국내주식" = t.currency === "KRW" ? "국내주식" : "해외주식";
      const accountName = accountType === "국내주식" ? "국내주식-주계좌" : "미국주식-주계좌";
      const ownersOrdered = ownerNames.filter((o) => t.owners.includes(o));
      if (!symbol || !nameTrimmed || t.qty <= 0 || t.price <= 0 || ownersOrdered.length === 0) continue;

      setPositions((prev) => {
        const next = [...prev];
        for (const owner of ownersOrdered) {
          const idx = next.findIndex(
            (p) => p.owner === owner && p.symbol === symbol && p.currency === t.currency,
          );
          if (idx >= 0) {
            const existing = next[idx];
            const totalQty = existing.quantity + t.qty;
            const blendedAvg = (existing.quantity * existing.avgPrice + t.qty * t.price) / totalQty;
            next[idx] = { ...existing, quantity: totalQty, avgPrice: blendedAvg };
          } else {
            next.push({
              symbol,
              name: nameTrimmed,
              quantity: t.qty,
              avgPrice: t.price,
              currentPrice: t.price,
              currency: t.currency,
              purchaseUsdKrw: t.currency === "USD" ? (usdKrw ?? undefined) : undefined,
              purchaseEurKrw: t.currency === "EUR" ? (eurKrw ?? undefined) : undefined,
              // USD는 매수일(t.date) 저장 + 정산대기 → T+2 지나면 정산환율로 자동 보정
              ...(t.currency === "USD" && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
                ? { purchaseDate: t.date, purchaseFxPending: true, purchaseFxAtAdd: usdKrw ?? undefined }
                : {}),
              accountType,
              accountName,
              owner,
            });
          }
        }
        return next;
      });

      const newBuys: BuyJournalEntry[] = ownersOrdered.map((owner) => {
        const fx = t.currency === "KRW" ? 1 : t.currency === "USD" ? (usdKrw ?? 1) : (eurKrw ?? 1);
        return {
          id: `buy-img-${Date.now()}-${symbol}-${owner}`,
          date: t.date,
          owner,
          symbol,
          name: nameTrimmed,
          qty: t.qty,
          buyPrice: t.price,
          currency: t.currency,
          fxRate: fx,
          totalKrw: t.currency === "KRW" ? t.qty * t.price : t.qty * t.price * fx,
          ...(t.currency === "USD" && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? { fxPending: true } : {}),
        };
      });
      setBuyJournal((prev) => [...prev, ...newBuys].slice(-BUY_JOURNAL_MAX));
    }
    showActionSuccessToast(`매수 ${trades.length}건이 반영되었습니다.`);
  }

  // ── 이미지 파싱 → 매도 일괄 반영 ──────────────────────────────────────────
  function handleImageSellConfirm(trades: ConfirmedSellTrade[]) {
    setSellLog((prev) => {
      const next = { ...prev };
      for (const t of trades) {
        if (!t.owner || !t.name || t.qty <= 0 || t.sellPrice <= 0) continue;
        const fx = t.fxRate > 0 ? t.fxRate : t.currency === "KRW" ? 1 : (usdKrw ?? 1);
        const avgP = t.avgPrice > 0 ? t.avgPrice : t.sellPrice;
        const realizedKrw =
          t.currency === "KRW"
            ? (t.sellPrice - avgP) * t.qty
            : (t.sellPrice - avgP) * t.qty * fx;
        const entry: SellLogEntry = {
          id: `sell-img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          date: t.date,
          symbol: (t.symbol || t.name).trim().toUpperCase(),
          name: t.name.trim(),
          qty: t.qty,
          sellPrice: t.sellPrice,
          avgPrice: avgP,
          currency: t.currency,
          fxRate: fx,
          realizedKrw,
        };
        next[t.owner] = [...(next[t.owner] ?? []), entry];
      }
      return next;
    });
    showActionSuccessToast(`매도 ${trades.length}건이 반영되었습니다.`);
  }

  function handleDeleteRow(rowIndex: number) {
    if (rowIndex < 0) return;
    setPositions((prev) => prev.filter((_, idx) => idx !== rowIndex));
  }

  function startEditRow(p: Position, rowIndex: number) {
    if (rowIndex < 0) return;
    setEditingRowIndex(rowIndex);
    setEditSymbol(p.symbol);
    setEditName(p.name);
    setEditChartGroup(p.chartGroup ?? "");
    setEditQuantity(String(p.quantity));
    setEditAvgPrice(String(p.avgPrice));
    setEditPurchaseUsdKrw(
      p.currency === "USD" ? String(p.purchaseUsdKrw ?? "") : "",
    );
    setEditPurchaseEurKrw(
      p.currency === "EUR" ? String(p.purchaseEurKrw ?? "") : "",
    );
  }

  function cancelEditRow() {
    setEditingRowIndex(null);
    setPendingSaveConfirm(false);
    setEditSymbol("");
    setEditName("");
    setEditChartGroup("");
    setEditQuantity("");
    setEditAvgPrice("");
    setEditPurchaseUsdKrw("");
    setEditPurchaseEurKrw("");
  }

  function saveEditRow() {
    if (editingRowIndex === null) return;
    const q = Number(editQuantity);
    const a = Number(editAvgPrice);
    const px = Number(editPurchaseUsdKrw);
    const peur = Number(editPurchaseEurKrw);
    const sym = editSymbol.trim().toUpperCase();
    const nm = editName.trim();
    const cg = editChartGroup.trim() || undefined;
    if (!sym || !nm) return;
    if (!Number.isFinite(q) || q <= 0) return;
    if (!Number.isFinite(a) || a <= 0) return;
    setPositions((prev) =>
      prev.map((p, idx) => {
        if (idx !== editingRowIndex) return p;
        if (p.currency === "USD") {
          if (!Number.isFinite(px) || px <= 0) return p;
          // 직접 환율을 입력하면 정산대기·추가당시환율 내역 해제(자동 보정이 덮어쓰지 않도록)
          const { purchaseFxPending: _dropPending, purchaseFxAtAdd: _dropAtAdd, ...rest } = p;
          void _dropPending;
          void _dropAtAdd;
          return { ...rest, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a, purchaseUsdKrw: px };
        }
        if (p.currency === "EUR") {
          if (!Number.isFinite(peur) || peur <= 0) return p;
          return { ...p, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a, purchaseEurKrw: peur };
        }
        return { ...p, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a };
      }),
    );
    cancelEditRow();
  }

  function moveRow(rowIndex: number, direction: "up" | "down") {
    setPositions((prev) => {
      const idx = rowIndex;
      if (idx < 0 || idx >= prev.length) return prev;
      const owner = prev[idx].owner;
      const ownerIndices = prev
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.owner === owner)
        .map(({ i }) => i);
      const posInOwner = ownerIndices.indexOf(idx);
      if (direction === "up" && posInOwner === 0) return prev;
      if (direction === "down" && posInOwner === ownerIndices.length - 1) return prev;
      const swapIdx =
        direction === "up" ? ownerIndices[posInOwner - 1] : ownerIndices[posInOwner + 1];
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  }

  const holdingsDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  /** 입력 순 보기: 종목 행 순서 드래그 시 positions 배열을 보유자 구간 안에서 재배열 */
  function reorderHoldingsDrag(owner: string, e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeIdx = Number(active.id);
    const overIdx = Number(over.id);
    if (
      !Number.isFinite(activeIdx) ||
      !Number.isFinite(overIdx) ||
      activeIdx < 0 ||
      overIdx < 0
    ) {
      return;
    }
    setPositions((prev) => {
      const globalIndices = prev.map((p, i) => (p.owner === owner ? i : -1)).filter((i) => i >= 0);
      const oldPos = globalIndices.indexOf(activeIdx);
      const newPos = globalIndices.indexOf(overIdx);
      if (oldPos < 0 || newPos < 0) return prev;
      const ownerSlice = globalIndices.map((gi) => prev[gi]);
      const movedSlice = arrayMove(ownerSlice, oldPos, newPos);
      const next = [...prev];
      globalIndices.forEach((gi, k) => {
        next[gi] = movedSlice[k];
      });
      return next;
    });
  }

  function handleAddOwner() {
    const next = window.prompt("추가할 보유자 이름을 입력하세요.");
    const name = next?.trim();
    if (!name) return;
    if (ownerNames.includes(name)) return;
    setOwnerNames((prev) => [...prev, name]);
    setCashByOwner((prev) => ({ ...prev, [name]: prev[name] ?? { usd: 0, krw: 0 } }));
    setHoldingsSortByOwner((prev) => ({ ...prev, [name]: prev[name] ?? "manual" }));
    markLocalChanged();
  }

  function handleRenameOwner(name: string) {
    const next = window.prompt("새 보유자 이름", name);
    const renamed = next?.trim();
    if (!renamed || renamed === name) return;
    if (ownerNames.includes(renamed)) return;
    setOwnerNames((prev) => prev.map((n) => (n === name ? renamed : n)));
    setPositions((prev) => prev.map((p) => (p.owner === name ? { ...p, owner: renamed } : p)));
    setCashByOwner((prev) => {
      const current = prev[name] ?? { usd: 0, krw: 0 };
      const rest = { ...prev };
      delete rest[name];
      return { ...rest, [renamed]: current };
    });
    setHoldingsSortByOwner((prev) => {
      const current = prev[name] ?? "manual";
      const rest = { ...prev };
      delete rest[name];
      return { ...rest, [renamed]: current };
    });
    setForm((prev) => ({
      ...prev,
      selectedOwners: prev.selectedOwners.map((o) => (o === name ? renamed : o)),
    }));
    setSellLog((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      next[renamed] = [...(next[renamed] ?? []), ...next[name]];
      delete next[name];
      return next;
    });
    setSellLogForm((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      next[renamed] = next[name];
      delete next[name];
      return next;
    });
    markLocalChanged();
  }

  function handleDeleteOwner(name: string) {
    if (ownerNames.length <= 1) return;
    const hasData =
      positions.some((p) => p.owner === name) ||
      (cashByOwner[name]?.usd ?? 0) > 0 ||
      (cashByOwner[name]?.krw ?? 0) > 0;
    const ok = window.confirm(
      hasData
        ? `${name} 보유자를 삭제하면 연결된 종목/현금도 함께 삭제됩니다. 계속할까요?`
        : `${name} 보유자를 삭제할까요?`,
    );
    if (!ok) return;
    const fallbackOwner = ownerNames.find((n) => n !== name) ?? "김승주";
    setOwnerNames((prev) => prev.filter((n) => n !== name));
    setPositions((prev) => prev.filter((p) => p.owner !== name));
    setCashByOwner((prev) => {
      const rest = { ...prev };
      delete rest[name];
      return rest;
    });
    setHoldingsSortByOwner((prev) => {
      const rest = { ...prev };
      delete rest[name];
      return rest;
    });
    setForm((prev) => {
      const selected = prev.selectedOwners.filter((o) => o !== name);
      return { ...prev, selectedOwners: selected.length > 0 ? selected : [fallbackOwner] };
    });
    setSellLog((prev) => { const next = { ...prev }; delete next[name]; return next; });
    setSellLogForm((prev) => { const next = { ...prev }; delete next[name]; return next; });
    markLocalChanged();
  }

  const holdingsViewOwner = activeTopNav.startsWith("owner-")
    ? activeTopNav.slice("owner-".length)
    : null;
  const positionsByOwnerForTab = useMemo(() => {
    if (!holdingsViewOwner) return positionsByOwner;
    return positionsByOwner.filter((g) => g.ownerName === holdingsViewOwner);
  }, [holdingsViewOwner, positionsByOwner]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeTopNav]);

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100">
      {actionSuccessToast ? (
        <div
          className="center-toast-enter pointer-events-none fixed left-1/2 top-1/2 z-[60] w-max max-w-[min(88vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-slate-900/72 px-7 py-5 text-center shadow-2xl backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <div className="mb-2 text-3xl leading-none text-emerald-400">✓</div>
          <p className="text-sm font-medium leading-snug text-slate-100">{actionSuccessToast}</p>
        </div>
      ) : null}
      {actionErrorToast ? (
        <div
          className="pointer-events-none fixed bottom-16 left-1/2 z-[60] max-w-[min(90vw,24rem)] -translate-x-1/2 rounded-lg border border-rose-500/55 bg-rose-950/95 px-4 py-2.5 text-center text-sm font-medium text-rose-100 shadow-lg shadow-rose-950/55 sm:bottom-20"
          role="alert"
          aria-live="assertive"
        >
          {actionErrorToast}
        </div>
      ) : null}
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

      <div className="mx-auto w-full max-w-[1600px] px-2 py-4 sm:py-6 md:px-4">
        <main className="min-w-0">
          <div
            className={cn(
              activeTopNav === "dashboard" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "dashboard"}
          >
          <div className="space-y-4 font-sans sm:space-y-6">

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  { key: "appr", label: "총 평가금액", sub: "실시간", value: `₩${fmtInt(kisMetrics.totalAppraisal)}` },
                  { key: "dep", label: "예수금(현금)", sub: "USD·KRW 합산", value: `₩${fmtInt(kisMetrics.deposit)}` },
                  { key: "cnt", label: "보유 종목 수", sub: "고유 티커", value: String(kisMetrics.uniqueTickerCount) },
                ] as const
              ).map((c) => (
                <div
                  key={c.key}
                  className="rounded-lg border border-slate-700/80 bg-slate-800/60 p-3 shadow-sm sm:p-4"
                >
                  <p className="text-[11px] font-medium text-slate-400 sm:text-xs">{c.label}</p>
                  <p className="mt-1 text-lg font-bold tabular-nums text-white sm:text-xl">{c.value}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500 sm:text-[11px]">{c.sub}</p>
                </div>
              ))}
            </section>

            <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {summaryCards.map((card) => (
                <div
                  key={card.label}
                  className="rounded-lg border border-slate-700/80 bg-slate-800/60 p-3 shadow-sm sm:p-4"
                >
                  <p className="text-[11px] font-medium text-slate-400 sm:text-xs">{card.label}</p>
                  <p
                    className={cn(
                      "mt-1 text-lg font-bold tabular-nums sm:text-xl",
                      card.positive === true
                        ? "text-red-400"
                        : card.positive === false
                          ? "text-sky-400"
                          : "text-white",
                    )}
                  >
                    {card.value}
                  </p>
                  {card.sub ? (
                    <p className="mt-0.5 text-[10px] text-slate-500 sm:text-[11px]">{card.sub}</p>
                  ) : null}
                  {card.change ? (
                    <p className="mt-0.5 text-[10px] font-medium text-red-400 sm:text-[11px]">{card.change}</p>
                  ) : null}
                </div>
              ))}
            </section>

            <section
              className="rounded-lg border border-amber-500/35 bg-amber-950/20 px-3 py-3 sm:px-4"
              aria-label="기준선 도달 종목"
            >
              <h2 className="text-sm font-semibold text-amber-100 sm:text-base">기준선 도달 종목</h2>
              <p className="mt-1 text-[10px] text-amber-200/70 sm:text-[11px]">
                「종목별 합산」의 수익률 %·「보유 종목」표의 익·손 가격
                조건 중 <span className="font-medium text-amber-100">현재 만족</span>하는 종목만 여기 모읍니다. 시세는
                약 30초 주기로 갱신됩니다.
              </p>
              {alertLineHits.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  조건을 만족하는 종목이 없습니다. (기준을 입력하지 않았거나, 아직 도달하지 않은 경우)
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {alertLineHitsByOwner.map(({ owner, hits }) => (
                    <div
                      key={owner}
                      className="overflow-hidden rounded-md border border-amber-500/25 bg-slate-950/40"
                    >
                      <p className="border-b border-amber-500/20 bg-amber-950/30 px-2 py-1.5 text-xs font-semibold text-amber-100">
                        {owner}
                        <span className="ml-1.5 font-normal text-amber-200/70">({hits.length}종목)</span>
                      </p>
                      <Table className="text-[11px]">
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="h-7 px-2 py-1">종목</TableHead>
                            <TableHead className="h-7 px-2 py-1">조건</TableHead>
                            <TableHead className="h-7 px-2 py-1 text-right tabular-nums">현재가</TableHead>
                            <TableHead className="h-7 px-2 py-1 text-right tabular-nums">수익률</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {hits.map((h) => (
                            <TableRow key={h.key} className="border-amber-500/10">
                              <TableCell className="max-w-[7rem] px-2 py-1.5 align-top">
                                <span className="block truncate font-medium text-slate-100">{h.name}</span>
                                <span className="block truncate text-[10px] text-slate-500">{h.symbol}</span>
                              </TableCell>
                              <TableCell className="max-w-[6.5rem] px-2 py-1.5 align-top text-[10px] leading-snug text-amber-100/90">
                                {h.reasons.join(" · ")}
                              </TableCell>
                              <TableCell className="whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums text-slate-300">
                                {h.currentPrice.toLocaleString(MONEY_INT_LOCALE, {
                                  maximumFractionDigits: 6,
                                })}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums font-medium",
                                  h.returnPct != null
                                    ? signedPnlTextClass(h.returnPct)
                                    : "text-slate-500",
                                )}
                              >
                                {h.returnPct != null
                                  ? `${h.returnPct >= 0 ? "+" : ""}${h.returnPct.toFixed(2)}%`
                                  : "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="space-y-4">
            <h2 className="font-semibold">포트폴리오 비중 (가족·퇴직연금)</h2>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div className="col-span-1 sm:col-span-2">
                <PortfolioAllOwnersTodayProfitCard
                  owners={ownerGroupDailySummaryForGrid.map((o) => {
                    const pos = positionsByOwner.find((g) => g.ownerName === o.ownerName);
                    return {
                      ...o,
                      sectionPnL: pos?.sectionPnL ?? 0,
                      sectionPnLPct: pos?.sectionPnLPct ?? 0,
                    };
                  })}
                  onReorder={handleReorderOwners}
                />
              </div>
              {/* 트리맵(ResponsiveContainer)은 dashboard 탭이 활성이고 클라이언트 하이드레이션이 완료된 이후에만 마운트
                  — display:none 상태에서 width/height=-1 오류 방지, SSR↔CSR Recharts 불일치(hydration #418) 방지 */}
              {activeTopNav === "dashboard" && isHydrated && allocationByOwnerForGrid.map(({ ownerName, data, total }) => {
                const pos = positionsByOwner.find((g) => g.ownerName === ownerName);
                return <FamilyAllocationDonut
                  key={ownerName}
                  ownerName={ownerName}
                  data={data}
                  total={total}
                  sectionPnL={pos?.sectionPnL}
                  sectionPnLPct={pos?.sectionPnLPct}
                  watchlistEntries={watchlistRows.filter(
                    (row) =>
                      !!row.symbol?.trim() &&
                      (!row.owners ||
                        row.owners.length === 0 ||
                        row.owners.includes(WATCHLIST_OWNER_ALL) ||
                        row.owners.includes(ownerName)),
                  )}
                  cloudSyncKey={cloudSyncKey}
                />;
              })}
            </div>
          </section>
          </div>
          <div
            className={cn(
              activeTopNav === "section-trend" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-trend"}
          >
          {/* 차트는 섹션이 활성일 때만 마운트 — display:none 컨테이너에서 ResponsiveContainer가 width/height=-1을 보고하는 문제 방지 */}
          {activeTopNav === "section-trend" && (
            <>
          {/* 일별 자산 추이 — 총 평가금액 추이 */}
          <section id="section-trend" className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 text-base font-semibold text-slate-100 sm:text-lg">
              총 평가금액 추이
            </h2>
            <p className="mb-1 text-[10px] text-slate-500 sm:text-xs">
              (일별 자산 추이) 앱·서버에 저장된 날만 쌓입니다(최대 180일). 동기화 키로 서버 누적도 불러옵니다.
            </p>
            <div className="mt-2 min-h-[200px] rounded-md border border-slate-700/50 bg-slate-900/30 p-1">
            <DailyTrendChart
              snapshots={dailySnapshots}
              ownerNames={ownerNames}
              liveChangeByDate={dailyLiveChangeByDate}
              tradeMarkers={dailyTrendTradeMarkers}
            />
            </div>
          </section>
          <DailyChangeCalendar snapshots={dailySnapshots} liveChangeByDate={dailyLiveChangeByDate} cronRecordedAt={cronDailySnapshotRecordedAt} />
            </>
          )}

          </div>
          <div
            className={cn(
              activeTopNav === "dashboard" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "dashboard"}
          >
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
          </div>

          {/* 리밸런싱 계산기 (구버전·숨김) */}
          <section id="section-rebalance-old" className="hidden rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">리밸런싱 계산기</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              그룹별 목표 비중(%)을 입력하면 필요한 매수/매도 금액과 주수를 자동으로 계산합니다.
            </p>
            <RebalancingCalculator
              allocationByOwner={allocationByOwner}
              enrichedPositions={enrichedPositions}
              usdKrw={usdKrw}
              eurKrw={eurKrw}
              marketQuotes={marketQuery.data?.quotes}
              watchlistRows={watchlistRows}
              watchlistOwnerAllToken={WATCHLIST_OWNER_ALL}
              cloudSyncKey={cloudSyncKey}
            />
          </section>

          <div
            className={cn(
              activeTopNav === "section-holdings" ||
                activeTopNav === "section-holdings-by-symbol" ||
                activeTopNav.startsWith("owner-")
                ? "block"
                : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={
              !(
                activeTopNav === "section-holdings" ||
                activeTopNav === "section-holdings-by-symbol" ||
                activeTopNav.startsWith("owner-")
              )
            }
          >
          {(activeTopNav === "section-holdings" || activeTopNav.startsWith("owner-")) ? (
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
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="w-28 rounded-md border bg-background px-2 py-1.5 text-right tabular-nums"
                        placeholder="0"
                        value={
                          group.cashUsd === 0
                            ? ""
                            : Math.round(group.cashUsd * 100) / 100
                        }
                        onChange={(e) => {
                          const raw = e.target.value;
                          const n = Number(raw);
                          setCashByOwner((prev) => ({
                            ...prev,
                            [group.ownerName]: {
                              ...prev[group.ownerName],
                              usd:
                                raw === "" || !Number.isFinite(n)
                                  ? 0
                                  : Math.round(n * 100) / 100,
                            },
                          }));
                        }}
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
          ) : null}

          {activeTopNav === "section-holdings-by-symbol" ? (
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
          ) : null}

          </div>

          <div
            className={cn(
              activeTopNav === "section-add" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-add"}
          >
          <section id="section-add" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold">종목 추가</h2>
              <button
                type="button"
                className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
                onClick={() => setShowTradeImageImport(true)}
              >
                📋 문자/이미지로 거래 입력
              </button>
            </div>
            <div className="mb-4 rounded-xl border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">보유자 관리</p>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all hover:bg-muted active:scale-95"
                  onClick={handleAddOwner}
                >
                  + 보유자 추가
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ownerNames.map((name) => (
                  <div key={name} className="flex items-center gap-1 rounded-md border bg-background px-2 py-1">
                    <span className="text-xs font-medium">{name}</span>
                    <button
                      type="button"
                      className="rounded px-1 text-[11px] text-muted-foreground hover:bg-muted"
                      onClick={() => handleRenameOwner(name)}
                    >
                      이름수정
                    </button>
                    <button
                      type="button"
                      className="rounded px-1 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                      disabled={ownerNames.length <= 1}
                      onClick={() => handleDeleteOwner(name)}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            </div>
            {/* ── 미래에셋 체결 알림 붙여넣기 (매수) ── */}
            <div className="mb-4 rounded-xl border border-slate-700/50 bg-slate-900/30 p-3">
              <p className="mb-1.5 text-[11px] font-semibold text-slate-300">
                증권사 체결 알림 붙여넣기 <span className="font-normal text-slate-500">— 미래에셋·하나·메리츠증권 체결 알림 텍스트를 그대로 붙여넣으면 자동 입력됩니다</span>
              </p>
              <textarea
                rows={3}
                placeholder={"[미래에셋증권] 전량체결 또는 [하나증권] 퇴직연금 매매체결 안내\n체결 알림 텍스트를 그대로 붙여넣으세요"}
                className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70"
                value={buyPasteText}
                onChange={(e) => {
                  const text = e.target.value;
                  setBuyPasteText(text);
                  if (!text.trim()) { setBuyPasteError(""); return; }
                  const parsed = parseBrokerNotification(text);
                  if (!parsed) {
                    setBuyPasteError("지원하지 않는 형식입니다. (미래에셋·하나·메리츠증권 체결 알림만 지원)");
                    return;
                  }
                  if (parsed.tradeType === "sell") {
                    setBuyPasteError("⚠️ 매도 체결 내역입니다. '실현손익 입력' 탭에 붙여넣어 주세요.");
                    return;
                  }
                  const autoOwner = resolveBrokerOwner(parsed, ownerNames) || undefined;
                  // 기존 보유 종목 검색 (심볼 또는 종목명으로)
                  const existingPos = positions.find(
                    (p) => (parsed.symbol && p.symbol === parsed.symbol) || p.name === parsed.name,
                  );
                  // 티커가 없으면 관심종목에서 종목명으로 티커를 끌어온다
                  const wlMatch = !existingPos && !parsed.symbol
                    ? watchlistRows.find((w) => w.symbol && w.name && w.name.trim() === parsed.name.trim())
                    : undefined;
                  // 기존 보유면 저장된 티커·종목명 사용, 신규면 알림 내용/관심종목 사용
                  const resolvedSymbol = existingPos ? existingPos.symbol : (parsed.symbol || wlMatch?.symbol || "");
                  const resolvedName = existingPos ? existingPos.name : (wlMatch?.name || parsed.name);
                  const isNewStock = !existingPos && !parsed.symbol && !wlMatch;
                  const ownerUnresolved = !autoOwner && !!parsed.accountName;
                  setBuyPasteError(
                    isNewStock && ownerUnresolved
                      ? "ℹ️ 보유 목록에 없는 종목입니다. 티커와 담당자를 직접 입력해주세요."
                      : isNewStock
                        ? "ℹ️ 보유 목록에 없는 종목입니다. 티커(종목코드)를 직접 입력해주세요."
                        : ownerUnresolved
                          ? `ℹ️ 계좌명(${parsed.accountName})으로 담당자를 특정할 수 없습니다. 담당자를 직접 선택해주세요.`
                          : "",
                  );
                  setForm((prev) => ({
                    ...prev,
                    symbol: resolvedSymbol,
                    name: resolvedName,
                    quantity: String(parsed.qty),
                    avgPrice: String(parsed.price),
                    currency: parsed.currency,
                    ...(parsed.date ? { purchaseDateForFx: parsed.date } : {}),
                    ...(autoOwner ? { selectedOwners: [autoOwner] } : {}),
                  }));
                  setBuyPasteText("");
                }}
              />
              {buyPasteError && (
                <p className={`mt-1 text-[11px] font-medium ${buyPasteError.startsWith("ℹ️") ? "text-blue-400" : "text-red-400"}`}>
                  {buyPasteError}
                </p>
              )}
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              담당자를 선택한 뒤 추가하세요.
              같은 티커·담당자·계좌(해외/국내+계좌명)·통화로 다시 추가하면 기존 줄에{" "}
              <span className="font-medium text-foreground">수량이 더해지고 평단은 가중평균</span>으로
              갱신됩니다. 이 경우{" "}
              <span className="font-medium text-foreground">종목명은 기존 줄과 정확히 같아야</span> 하며
              다르면 저장되지 않습니다.
              국내 주식은 6자리 종목코드(예: <span className="font-medium text-foreground">005930</span>)
              또는 <span className="font-medium text-foreground">KRX:005930</span> 형식으로 입력하면 실시간 시세가 반영됩니다.
              KOSDAQ은 <span className="font-medium text-foreground">KQ:293490</span> 형식을 사용하세요.
              유로 표시 종목은 통화를 <span className="font-medium text-foreground">EUR</span>로 두고, 티커는 Yahoo Finance 심볼(예: 유럽{" "}
              <span className="font-medium text-foreground">ASML.AS</span>, 에르메스{" "}
              <span className="font-medium text-foreground">RMS</span> 또는 <span className="font-medium text-foreground">RMS.PA</span>
              )을 입력하면 시세가 반영됩니다.
              <span className="font-medium text-foreground">차트 그룹</span>에{" "}
              <span className="font-medium text-foreground">현금</span>을 넣으면 원형 차트·보유 표에서 현금과
              MMF 등 현금성 자산 줄을 같은 조각으로 합산할 수 있습니다.
            </p>
            <form
              onSubmit={handleSubmit}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6"
            >
              <datalist id="holdings-chart-group-presets">
                {HOLDINGS_CHART_GROUP_PRESETS.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
              <div className="col-span-2 flex flex-col gap-2 sm:col-span-3 md:col-span-6">
                <span className="text-[11px] font-medium text-muted-foreground">담당자</span>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                  {ownerNames.map((name) => {
                    const isSelected = form.selectedOwners.includes(name);
                    const anySelected = form.selectedOwners.length > 0;
                    return (
                    <label
                      key={name}
                      className={`flex cursor-pointer items-center gap-1.5 text-sm select-none transition-opacity ${anySelected && !isSelected ? "opacity-30" : "opacity-100"}`}
                    >
                      <input
                        type="radio"
                        name="buy-form-owner"
                        className="cursor-pointer accent-primary"
                        checked={isSelected}
                        onChange={() => {
                          skipAddFormAutoNameRef.current = false;
                          skipAddFormAutoChartGroupRef.current = false;
                          setForm((prev) => ({ ...prev, selectedOwners: [name] }));
                        }}
                      />
                      <span className={isSelected ? "font-semibold text-foreground" : ""}>{name}</span>
                    </label>
                    );
                  })}
                </div>
              </div>
              <div className="relative min-w-0">
                <input
                  ref={addSymbolInputRef}
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm leading-tight"
                  placeholder="티커 (예: NVDA, 005930)"
                  value={form.symbol}
                  onChange={(e) => {
                    handleAddSymbolInput(e.target.value);
                    setHoldingsTickerSuggestOpen(true);
                  }}
                  onFocus={() => setHoldingsTickerSuggestOpen(true)}
                  onBlur={() => {
                    window.setTimeout(() => setHoldingsTickerSuggestOpen(false), 120);
                  }}
                  onKeyDown={(e) => {
                    if (!holdingsTickerSuggestOpen || filteredHoldingsTickers.length === 0) return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHoldingsTickerSuggestHl((h) =>
                        Math.min(filteredHoldingsTickers.length - 1, h + 1),
                      );
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHoldingsTickerSuggestHl((h) => Math.max(0, h - 1));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const o = filteredHoldingsTickers[holdingsTickerSuggestHl];
                      if (o) {
                        handleAddSymbolInput(o.symbol);
                        setHoldingsTickerSuggestOpen(false);
                      }
                    } else if (e.key === "Escape") {
                      setHoldingsTickerSuggestOpen(false);
                    }
                  }}
                  autoComplete="off"
                  required
                />
                {holdingsTickerSuggestOpen && filteredHoldingsTickers.length > 0 ? (
                  <ul
                    role="listbox"
                    className="absolute left-0 right-0 top-full z-[80] mt-0.5 max-h-36 overflow-y-auto rounded-md border border-border bg-popover py-0.5 text-popover-foreground shadow-md"
                  >
                    {filteredHoldingsTickers.map((o, i) => (
                      <li key={o.symbol}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === holdingsTickerSuggestHl}
                          className={cn(
                            "flex w-full min-w-0 items-center gap-1 truncate px-2 py-0.5 text-left text-[11px] leading-snug",
                            i === holdingsTickerSuggestHl ? "bg-muted" : "hover:bg-muted/80",
                          )}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleAddSymbolInput(o.symbol);
                            setHoldingsTickerSuggestOpen(false);
                          }}
                        >
                          <span className="shrink-0 font-medium tabular-nums">{o.symbol}</span>
                          {o.name ? (
                            <span className="min-w-0 truncate text-muted-foreground">
                              ({o.name})
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="종목명"
                value={form.name}
                onChange={(e) => {
                  const v = e.target.value;
                  skipAddFormAutoNameRef.current = v.trim() !== "";
                  setForm((prev) => ({ ...prev, name: v }));
                }}
                required
              />
              <input
                type="number"
                min="0.000001"
                step="any"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="수량"
                value={form.quantity}
                onChange={(e) => setForm((prev) => ({ ...prev, quantity: e.target.value }))}
                required
              />
              <input
                type="number"
                min="0.000001"
                step="any"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="평단가"
                value={form.avgPrice}
                onChange={(e) => setForm((prev) => ({ ...prev, avgPrice: e.target.value }))}
                required
              />
              {/* 매입 환율: USD/EUR 해외 통화일 때 표시, 평단가 바로 다음 */}
              {form.currency === "USD" ? (
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={`매입 USD/KRW (예: ${fmtInt(usdKrw)})`}
                  value={form.purchaseUsdKrw}
                  onChange={(e) => {
                    addFormFxManualRef.current = true;
                    setForm((prev) => ({ ...prev, purchaseUsdKrw: e.target.value }));
                  }}
                />
              ) : form.currency === "EUR" ? (
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={`매입 EUR/KRW (예: ${fmtInt(eurKrw)})`}
                  value={form.purchaseEurKrw}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, purchaseEurKrw: e.target.value }))
                  }
                />
              ) : (
                <div />
              )}
              {form.currency === "USD" ? (
                <div className="col-span-2 flex flex-col gap-1 sm:col-span-3 md:col-span-6">
                  <label className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">매입일 (선택)</span>
                    <input
                      type="date"
                      className="rounded-md border bg-background px-2 py-1.5 text-sm"
                      value={form.purchaseDateForFx}
                      onChange={(e) => {
                        addFormFxManualRef.current = false;
                        setForm((prev) => ({ ...prev, purchaseDateForFx: e.target.value }));
                      }}
                    />
                    {purchaseFxAutoBusy ? (
                      <span className="text-[11px] text-muted-foreground">환율 조회 중…</span>
                    ) : null}
                  </label>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    입력하면 매입일 다음날부터 이틀째 되는 날{" "}
                    <span className="font-medium text-foreground">09:00 한국시각</span> 부근 Yahoo
                    USD/KRW로 매입 환율 칸을 채웁니다. 증권사 결제(T+2 영업일 등)와 다를 수 있습니다.
                  </p>
                </div>
              ) : null}
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={form.currency}
                onChange={(e) => {
                  const c = e.target.value as "USD" | "EUR" | "KRW";
                  skipAddFormAutoNameRef.current = false;
                  skipAddFormAutoChartGroupRef.current = false;
                  addFormFxManualRef.current = false;
                  setForm((prev) => ({
                    ...prev,
                    currency: c,
                    accountType: c === "KRW" ? "국내주식" : "해외주식",
                    purchaseUsdKrw: c === "USD" ? prev.purchaseUsdKrw : "",
                    purchaseEurKrw: c === "EUR" ? prev.purchaseEurKrw : "",
                    purchaseDateForFx: c === "USD" ? prev.purchaseDateForFx : "",
                  }));
                }}
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="KRW">KRW</option>
              </select>
              <input
                className="col-span-2 rounded-md border bg-background px-3 py-2 text-sm sm:col-span-3 md:col-span-6"
                placeholder="차트 그룹 (선택 · 예: 현금, MMF 등 현금성 자산)"
                value={form.chartGroup}
                onChange={(e) => {
                  const v = e.target.value;
                  skipAddFormAutoChartGroupRef.current = v.trim() !== "";
                  setForm((prev) => ({ ...prev, chartGroup: v }));
                }}
                list="holdings-chart-group-presets"
                autoComplete="off"
              />
              {addPositionError ? (
                <p
                  role="alert"
                  className="col-span-2 text-sm text-destructive sm:col-span-3 md:col-span-6"
                >
                  {addPositionError}
                </p>
              ) : null}
              <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-3 md:col-span-6">
                <span className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {form.currency === "KRW" ? "국내주식" : "해외주식"}
                </span>
                <button
                  type="submit"
                  disabled={!!(buyPasteError && !buyPasteError.startsWith("ℹ️"))}
                  className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  추가
                </button>
              </div>
            </form>

            {/* ── 종목 추가 누락 보유자 알림 ──────────────────────────────────── */}
            {addOwnerTracker.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5">
                {addOwnerTracker.map((item) => {
                  const missing = ownerNames.filter((n) => !item.doneOwners.includes(n));
                  const allDone = missing.length === 0;
                  const displayLabel = item.isKorean ? item.name : item.symbol;
                  return (
                    <div
                      key={item.symbol}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                        allDone
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : "border-amber-500/35 bg-amber-500/8 text-amber-200"
                      }`}
                    >
                      <span className="shrink-0 text-sm">{allDone ? "✓" : "⚠️"}</span>
                      <span className="font-semibold">{displayLabel}</span>
                      {allDone ? (
                        <span className="text-emerald-400">— 모든 보유자 입력 완료</span>
                      ) : (
                        <span>
                          — 아직 미입력:{" "}
                          <strong className="text-amber-300">{missing.join(", ")}</strong>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setAddOwnerTracker((prev) =>
                            prev.filter((e) => e.symbol !== item.symbol),
                          )
                        }
                        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label="알림 닫기"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="mt-2 text-xs text-muted-foreground">
              현금(USD·KRW)은 아래 각 보유 종목 표 상단에서 입력합니다. 전체 현금
              합계(원화): ₩{fmtInt(totalCashKrw)}
            </p>
          </section>
          </div>

          <div
            className={cn(
              activeTopNav === "section-realized" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-realized"}
          >
          <section id="section-realized" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-semibold">실현손익 입력</h2>
              <button
                type="button"
                className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
                onClick={() => setShowTradeImageImport(true)}
              >
                📋 문자/이미지로 거래 입력
              </button>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              종목 추가 아래에서 보유자별 매도 기록을 입력합니다. 실현손익은 매도 체결 금액(원화換算)에{" "}
              <span className="font-medium text-foreground">{((TRADING_FEE_RATE * 100).toFixed(1))}%</span>
              매도 수수료를 차감한 금액입니다.
            </p>
            {(() => {
              const owner = sellLogOwnerForSection;
              const listViewOwner = sellLogListViewOwner;
              const listLog = sellLog[listViewOwner] ?? [];
              // 기록 목록 표에서 e.realizedKrw를 표시하므로 합계도 동일 기준으로 통일
              const listTotalRealizedKrw = listLog.reduce((s, e) => s + e.realizedKrw, 0);
              // 총이익(손실 미차감): 이익 항목만 합산
              const listGrossRealizedKrw = listLog.reduce((s, e) => s + (e.realizedKrw > 0 ? e.realizedKrw : 0), 0);
              const log = sellLog[owner] ?? [];
              // 순손익(손실 차감): 이익 - 손실
              const totalRealized = log.reduce((s, e) => s + e.realizedKrw, 0);
              // 총이익(손실 미차감): 이익 항목만 합산
              const grossRealized = log.reduce((s, e) => s + (e.realizedKrw > 0 ? e.realizedKrw : 0), 0);
              const allSellLogEntries: SellLogEntry[] = Object.values(sellLog).flat();
              type SymPnlRow = {
                date: string;
                symbol: string;
                name: string;
                qty: number;
                costKrw: number;
                realizedKrw: number;
              };
              const symPnlByDateSymbol = new Map<string, SymPnlRow>();
              const dailyRealizedAllOwners = new Map<string, number>();
              for (const e of allSellLogEntries) {
                const rk = e.realizedKrw; // 저장된 값 사용(목록 표와 동일 기준)
                dailyRealizedAllOwners.set(e.date, (dailyRealizedAllOwners.get(e.date) ?? 0) + rk);
                const dsKey = `${e.date}::${e.symbol}`;
                const prev =
                  symPnlByDateSymbol.get(dsKey) ??
                  ({
                    date: e.date,
                    symbol: e.symbol,
                    name: e.name,
                    qty: 0,
                    costKrw: 0,
                    realizedKrw: 0,
                  } satisfies SymPnlRow);
                const fx = e.fxRate ?? 1;
                const costKrw = e.currency === "KRW" ? e.avgPrice * e.qty : e.avgPrice * e.qty * fx;
                symPnlByDateSymbol.set(dsKey, {
                  date: e.date,
                  symbol: e.symbol,
                  name: e.name,
                  qty: prev.qty + e.qty,
                  costKrw: prev.costKrw + costKrw,
                  realizedKrw: prev.realizedKrw + rk,
                });
              }
              const symPnlList = [...symPnlByDateSymbol.values()];
              const symPnlDatesDesc = [...new Set(symPnlList.map((r) => r.date))].sort((a, b) =>
                b.localeCompare(a),
              );
              const symPnlByDate = new Map<string, SymPnlRow[]>();
              for (const r of symPnlList) {
                const list = symPnlByDate.get(r.date) ?? [];
                list.push(r);
                symPnlByDate.set(r.date, list);
              }
              for (const d of symPnlByDate.keys()) {
                symPnlByDate.get(d)!.sort((a, b) => b.realizedKrw - a.realizedKrw);
              }

              const listByDate = new Map<string, SellLogEntry[]>();
              for (const e of listLog) {
                const list = listByDate.get(e.date) ?? [];
                list.push(e);
                listByDate.set(e.date, list);
              }
              const listDatesDesc = [...listByDate.keys()].sort((a, b) => b.localeCompare(a));
              for (const d of listByDate.keys()) {
                listByDate.get(d)!.sort((a, b) => b.id.localeCompare(a.id));
              }
              const listDailyRealized = (d: string) =>
                (listByDate.get(d) ?? []).reduce((s, e) => s + e.realizedKrw, 0);

              // ── 종목별 합산 ────────────────────────────────────────────
              const symActiveOwners = sellLogSymOwnerFilter.length === 0 ? ownerNames : sellLogSymOwnerFilter;
              const symFilteredEntries = symActiveOwners.flatMap((o) => sellLog[o] ?? []);
              type SymSummaryRow = { symbol: string; name: string; count: number; totalQty: number; totalRealizedKrw: number };
              const symSummaryMap = new Map<string, SymSummaryRow>();
              for (const e of symFilteredEntries) {
                const prev = symSummaryMap.get(e.symbol) ?? { symbol: e.symbol, name: e.name, count: 0, totalQty: 0, totalRealizedKrw: 0 };
                symSummaryMap.set(e.symbol, {
                  ...prev,
                  count: prev.count + 1,
                  totalQty: prev.totalQty + e.qty,
                  totalRealizedKrw: prev.totalRealizedKrw + e.realizedKrw,
                });
              }
              const symSummaryRows = [...symSummaryMap.values()].sort((a, b) => b.totalRealizedKrw - a.totalRealizedKrw);
              const symSummaryTotal = symSummaryRows.reduce((s, r) => s + r.totalRealizedKrw, 0);
              const symSummaryGrossTotal = symSummaryRows.reduce((s, r) => s + (r.totalRealizedKrw > 0 ? r.totalRealizedKrw : 0), 0);
              const toggleSymOwner = (name: string) => {
                setSellLogSymOwnerFilter((prev) => {
                  const current = prev.length === 0 ? ownerNames : prev;
                  const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
                  if (next.length === 0) return prev; // 최소 1명 유지
                  return next.length === ownerNames.length ? [] : next; // 전체 선택이면 빈 배열(=전체)
                });
              };
              // ────────────────────────────────────────────────────────────

              const ownerTickerOptions = Array.from(
                new Map(
                  positions.map((p) => [
                    p.symbol,
                    { symbol: p.symbol, name: p.name, avgPrice: p.avgPrice, currency: p.currency },
                  ]),
                ).values(),
              ).sort((a, b) => a.symbol.localeCompare(b.symbol));
              const defaultSellLogBlank = (sectionOwnerKey: string) => ({
                date: new Date().toISOString().slice(0, 10),
                symbol: "",
                name: "",
                qty: "",
                sellPrice: "",
                avgPrice: "",
                currency: "USD" as const,
                fxRate: String(Math.round(usdKrw)),
                note: "",
                selectedOwners: [sectionOwnerKey] as OwnerName[],
                ownerOverrides: {},
                editingId: null as string | null,
              });

              const form = sellLogForm[owner] ?? defaultSellLogBlank(owner);

              /** 폼 상태는 보유자(섹션)별 분리 저장. `sellLogOwnerForSection`을 바꿀 때는 `formOwnerKey`에 새 키를 넘기지 않으면 버그(틀린 보유자 슬롯에 쓸 수 있음) */
              const setForm2 = (
                patch: Partial<typeof form>,
                formOwnerKey = owner,
              ) => {
                setSellLogForm((prev) => {
                  const prevForm = prev[formOwnerKey];
                  const base = prevForm ?? defaultSellLogBlank(formOwnerKey);
                  return { ...prev, [formOwnerKey]: { ...base, ...patch } };
                });
                setSellLogErrorByOwner((prevErr) => ({ ...prevErr, [formOwnerKey]: "" }));
              };
              const selectedSymbol = form.symbol.trim().toUpperCase();
              const ownersWithTicker = selectedSymbol
                ? ownerNames.filter((name) =>
                    positions.some((p) => p.owner === name && p.symbol === selectedSymbol),
                  )
                : [];
              const calcRealized = (entry: typeof form) => {
                const qty = Number(entry.qty);
                const sell = Number(entry.sellPrice);
                const avg = Number(entry.avgPrice);
                const fx = Number(entry.fxRate) || 1;
                if (!Number.isFinite(qty) || !Number.isFinite(sell) || !Number.isFinite(avg)) return 0;
                return calcSellRealizedKrw({
                  qty,
                  sellPrice: sell,
                  avgPrice: avg,
                  currency: entry.currency,
                  fxRate: fx,
                });
              };
              const handleTickerChange = (nextSymbol: string) => {
                const selected = ownerTickerOptions.find((x) => x.symbol === nextSymbol);
                if (!selected) return setForm2({ symbol: nextSymbol }, owner);
                const ownersForSymbol = ownerNames.filter((name) =>
                  positions.some((p) => p.owner === name && p.symbol === selected.symbol),
                );
                const nextOwner = ownersForSymbol[0] ?? owner;
                const nextFxRate =
                  selected.currency === "KRW" ? "1" : selected.currency === "EUR" ? String(Math.round(eurKrw)) : String(Math.round(usdKrw));
                const ownerPos = positions.find((p) => p.owner === nextOwner && p.symbol === selected.symbol);
                const ownerFxRate =
                  selected.currency === "KRW"
                    ? "1"
                    : selected.currency === "EUR"
                      ? String(Math.round(ownerPos?.purchaseEurKrw ?? eurKrw))
                      : String(Math.round(ownerPos?.purchaseUsdKrw ?? usdKrw));
                setSellLogOwnerForSection(nextOwner);
                setForm2(
                  {
                    symbol: selected.symbol,
                    name: selected.name,
                    avgPrice: ownerPos ? String(ownerPos.avgPrice) : String(selected.avgPrice),
                    currency: selected.currency,
                    fxRate: ownerFxRate || nextFxRate,
                    selectedOwners: ownersForSymbol.length > 0 ? [ownersForSymbol[0]] : [],
                    ownerOverrides: {},
                  },
                  nextOwner,
                );
              };
              const handleSave = () => {
                const symbol = form.symbol.trim().toUpperCase();
                const sell = Number(form.sellPrice);
                if (!symbol || !Number.isFinite(sell) || sell <= 0) return;
                const targetOwner = form.selectedOwners[0] ?? owner;
                const hasHolding = (ownerName: string) => positions.some((p) => p.owner === ownerName && p.symbol === symbol);
                if (!hasHolding(targetOwner)) {
                  setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: `오류: ${targetOwner} 보유자에게 ${symbol} 보유 내역이 없습니다.` }));
                  return;
                }
                const reduceByOwner = new Map<string, number>();
                if (!form.editingId) {
                  const q = Number(form.qty);
                  if (Number.isFinite(q) && q > 0) {
                    reduceByOwner.set(targetOwner, q);
                  }
                  const insufficientOwners: string[] = [];
                  for (const [targetOwner, q] of reduceByOwner) {
                    const holdingQty = positions
                      .filter((p) => p.owner === targetOwner && p.symbol === symbol)
                      .reduce((s, p) => s + p.quantity, 0);
                    if (holdingQty + 1e-9 < q) {
                      insufficientOwners.push(`${targetOwner}(보유 ${holdingQty}, 입력 ${q})`);
                    }
                  }
                  if (insufficientOwners.length > 0) {
                    setSellLogErrorByOwner((prev) => ({
                      ...prev,
                      [owner]: `오류: 보유수량보다 많이 입력했습니다. ${insufficientOwners.join(", ")}`,
                    }));
                    return;
                  }
                }
                const qty = Number(form.qty);
                const avg = Number(form.avgPrice);
                const fx = Number(form.fxRate) || 1;
                const entry: SellLogEntry = {
                  id: form.editingId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  date: form.date,
                  symbol,
                  name: form.name.trim() || symbol,
                  qty,
                  sellPrice: sell,
                  avgPrice: avg,
                  currency: form.currency,
                  fxRate: fx,
                  realizedKrw: calcSellRealizedKrw({
                    qty,
                    sellPrice: sell,
                    avgPrice: avg,
                    currency: form.currency,
                    fxRate: fx,
                  }),
                  note: form.note.trim() || undefined,
                };
                if (!form.editingId) {
                  setSellLog((prev) => {
                    const q = Number(form.qty);
                    const a = Number(form.avgPrice);
                    const f = Number(form.fxRate) || 1;
                    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(a) || a <= 0) return prev;
                    const e2: SellLogEntry = {
                      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      date: form.date,
                      symbol,
                      name: form.name.trim() || symbol,
                      qty: q,
                      sellPrice: sell,
                      avgPrice: a,
                      currency: form.currency,
                      fxRate: f,
                      realizedKrw: calcSellRealizedKrw({ qty: q, sellPrice: sell, avgPrice: a, currency: form.currency, fxRate: f }),
                      note: form.note.trim() || undefined,
                    };
                    return { ...prev, [targetOwner]: [...(prev[targetOwner] ?? []), e2] };
                  });
                  // 매도대금 현금 자동 반영 — 매도 수수료(0.2%) 차감한 순입금액 기준
                  // (매수는 수수료 포함 차감, 실현손익도 수수료 차감하므로 입금도 net로 통일)
                  setCashByOwner((prev) => {
                    let next = { ...prev };
                    const formFx = Number(form.fxRate) || eurKrw; // EUR 원화 환산은 입력 환율 우선
                    for (const [targetOwner, q] of reduceByOwner) {
                      const currentCash = next[targetOwner] ?? { usd: 0, krw: 0 };
                      const netProceeds = q * sell * (1 - TRADING_FEE_RATE);
                      if (form.currency === "KRW") {
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            krw: currentCash.krw + netProceeds,
                          },
                        };
                      } else if (form.currency === "USD") {
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            usd: currentCash.usd + netProceeds,
                          },
                        };
                      } else {
                        // EUR: 입력 환율(form.fxRate)로 원화 환산해 입금
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            krw: currentCash.krw + netProceeds * formFx,
                          },
                        };
                      }
                    }
                    return next;
                  });
                  setPositions((prev) => {
                    let next = [...prev];
                    for (const [targetOwner, q] of reduceByOwner) {
                      let remain = q;
                      next = next.map((p) => {
                        if (remain <= 0 || p.owner !== targetOwner || p.symbol !== symbol) return p;
                        const cut = Math.min(p.quantity, remain);
                        remain -= cut;
                        return { ...p, quantity: p.quantity - cut };
                      });
                      next = next.filter((p) => p.quantity > 0);
                    }
                    return next;
                  });
                } else {
                  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(avg) || avg <= 0) return;
                  setSellLog((prev) => {
                    const existing = prev[owner] ?? [];
                    return { ...prev, [owner]: existing.map((e) => (e.id === form.editingId ? entry : e)) };
                  });
                }
                const newRealizedSaveOk =
                  !form.editingId &&
                  Number.isFinite(Number(form.qty)) &&
                  Number(form.qty) > 0 &&
                  Number.isFinite(Number(form.avgPrice)) &&
                  Number(form.avgPrice) > 0;
                if (form.editingId || newRealizedSaveOk) {
                  showActionSuccessToast("실현손익이 정상적으로 반영되었습니다.");
                }
                // 누락 보유자 추적 업데이트 (신규 저장만)
                if (newRealizedSaveOk) {
                  setSellOwnerTracker((prev) => {
                    const sym = symbol;
                    const dt = form.date;
                    const prevDone = prev?.symbol === sym && prev?.date === dt ? prev.doneOwners : [];
                    return { symbol: sym, date: dt, doneOwners: [...new Set([...prevDone, targetOwner])] };
                  });
                }
                setForm2({
                  symbol: "", name: "", qty: "", sellPrice: "", avgPrice: "",
                  currency: "USD", fxRate: String(Math.round(usdKrw)),
                  note: "", selectedOwners: [owner], ownerOverrides: {}, editingId: null,
                });
                setSellTickerSearch((prev) => { const next = { ...prev }; delete next[owner]; return next; });
                window.setTimeout(() => { sellTickerInputRefs.current[owner]?.focus(); }, 0);
              };
              const handleListEdit = (e: SellLogEntry) => {
                setSellLogOwnerForSection(listViewOwner);
                setSellLogForm((prev) => {
                  const base =
                    prev[listViewOwner] ?? {
                      date: new Date().toISOString().slice(0, 10),
                      symbol: "",
                      name: "",
                      qty: "",
                      sellPrice: "",
                      avgPrice: "",
                      currency: "USD" as const,
                      fxRate: String(Math.round(usdKrw)),
                      note: "",
                      selectedOwners: [listViewOwner],
                      ownerOverrides: {},
                      editingId: null,
                    };
                  return {
                    ...prev,
                    [listViewOwner]: {
                      ...base,
                      date: e.date,
                      symbol: e.symbol,
                      name: e.name,
                      qty: String(e.qty),
                      sellPrice: String(e.sellPrice),
                      avgPrice: String(e.avgPrice),
                      currency: e.currency,
                      fxRate: String(e.fxRate),
                      note: e.note ?? "",
                      selectedOwners: [listViewOwner],
                      ownerOverrides: {},
                      editingId: e.id,
                    },
                  };
                });
                setSellLogErrorByOwner((p) => ({ ...p, [listViewOwner]: "" }));
              };
              const handleListDelete = (id: string) => {
                setSellLog((prev) => ({
                  ...prev,
                  [listViewOwner]: (prev[listViewOwner] ?? []).filter((x) => x.id !== id),
                }));
              };
              const preview = calcRealized(form);
              return (
                <div className="space-y-2">
                  {/* ── 미래에셋 체결 알림 붙여넣기 (매도) ── */}
                  <div className="rounded-xl border border-slate-700/50 bg-slate-900/30 p-3">
                    <p className="mb-1.5 text-[11px] font-semibold text-slate-300">
                      증권사 체결 알림 붙여넣기 <span className="font-normal text-slate-500">— 미래에셋·하나·메리츠증권 체결 알림 텍스트를 그대로 붙여넣으면 자동 입력됩니다</span>
                    </p>
                    <textarea
                      rows={3}
                      placeholder={"[미래에셋증권] 전량체결 또는 [하나증권] 퇴직연금 매매체결 안내\n체결 알림 텍스트를 그대로 붙여넣으세요"}
                      className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70"
                      value={sellPasteText}
                      onChange={(e) => {
                        const text = e.target.value;
                        setSellPasteText(text);
                        if (!text.trim()) {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "" }));
                          return;
                        }
                        const parsed = parseBrokerNotification(text);
                        if (!parsed) {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "지원하지 않는 형식입니다. (미래에셋·하나·메리츠증권 체결 알림만 지원)" }));
                          return;
                        }
                        if (parsed.tradeType === "buy") {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "⚠️ 매수 체결 내역입니다. '종목 추가' 탭에 붙여넣어 주세요." }));
                          return;
                        }
                        // 증권사/계좌종류/계좌번호로 보유자 자동 전환
                        const resolvedBrokerOwner = resolveBrokerOwner(parsed, ownerNames);
                        const ownerUnresolved = !resolvedBrokerOwner && !!parsed.accountName;
                        const autoOwner = resolvedBrokerOwner || owner;
                        if (autoOwner !== owner) setSellLogOwnerForSection(autoOwner);
                        // 해당 보유자의 포지션에서 티커·평균단가 자동 조회
                        const pos = positions.find(
                          (p) => p.owner === autoOwner && (
                            (parsed.symbol && p.symbol === parsed.symbol) || p.name === parsed.name
                          ),
                        );
                        const resolvedSellSymbol = pos ? pos.symbol : (parsed.symbol || "");
                        const resolvedSellName = pos ? pos.name : parsed.name;
                        const avgPrice = pos ? String(pos.avgPrice) : "";
                        const fxRate = parsed.currency === "KRW" ? "1"
                          : parsed.currency === "EUR" ? String(Math.round(eurKrw))
                          : String(Math.round(usdKrw));
                        // 담당자 미특정 안내 (우선순위 1)
                        if (ownerUnresolved) {
                          setSellLogErrorByOwner((prev) => ({
                            ...prev,
                            [autoOwner]: `ℹ️ 계좌명(${parsed.accountName})으로 담당자를 특정할 수 없습니다. 담당자를 직접 선택해주세요.`,
                          }));
                        } else if (!pos && !parsed.symbol) {
                          setSellLogErrorByOwner((prev) => ({
                            ...prev,
                            [autoOwner]: "ℹ️ 보유 목록에 없는 종목입니다. 티커(종목코드)를 직접 입력해주세요.",
                          }));
                        } else if (!pos && parsed.symbol) {
                          setSellLogErrorByOwner((prev) => ({
                            ...prev,
                            [autoOwner]: "ℹ️ 보유 목록에 없는 종목입니다. 평균매입단가를 직접 입력해주세요.",
                          }));
                        } else {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [autoOwner]: "" }));
                        }
                        setForm2(
                          {
                            symbol: resolvedSellSymbol,
                            name: resolvedSellName,
                            qty: String(parsed.qty),
                            sellPrice: String(parsed.price),
                            avgPrice,
                            currency: parsed.currency,
                            fxRate: pos
                              ? (parsed.currency === "USD" ? String(Math.round(pos.purchaseUsdKrw ?? usdKrw))
                                : parsed.currency === "EUR" ? String(Math.round(pos.purchaseEurKrw ?? eurKrw))
                                : "1")
                              : fxRate,
                            selectedOwners: [autoOwner],
                            ...(parsed.date ? { date: parsed.date } : {}),
                          },
                          autoOwner,
                        );
                        setSellPasteText("");
                      }}
                    />
                    {sellLogErrorByOwner[owner] && (
                      <p className={`mt-1.5 text-[11px] font-medium ${sellLogErrorByOwner[owner].startsWith("ℹ️") ? "text-blue-400" : "text-red-400"}`}>
                        {sellLogErrorByOwner[owner]}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      보유자는 전부 표시됩니다(해당 티커를 안 갖고 있으면 &quot;· 미보유&quot;). 그 티커는 실제로 보유한 보유자만 저장됩니다.
                    </span>
                    <button
                      type="button"
                      className="text-xs underline-offset-2 hover:underline text-right leading-relaxed"
                      onClick={() => setSellLogDetailOpenOwner(owner)}
                    >
                      <span className="text-muted-foreground">총이익 </span>
                      <span className={`font-semibold tabular-nums ${grossRealized > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                        {grossRealized >= 0 ? "+" : ""}₩{fmtInt(grossRealized)}
                      </span>
                      <span className="mx-1 text-muted-foreground">/</span>
                      <span className="text-muted-foreground">순손익 </span>
                      <span className={`font-bold tabular-nums ${totalRealized > 0 ? "text-red-500" : totalRealized < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                        {totalRealized >= 0 ? "+" : ""}₩{fmtInt(totalRealized)}
                      </span>
                    </button>
                  </div>
                  <div className="rounded-xl border border-slate-700/50 bg-slate-900/30 p-3 space-y-3 text-xs">
                    {/* 행 1: 날짜 · 티커 · 통화 */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">날짜</span>
                        <input type="date" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 outline-none focus:border-indigo-500/70" value={form.date} onChange={(e) => setForm2({ date: e.target.value })} />
                      </label>
                      <label className="relative flex flex-col gap-1 sm:col-span-2">
                        <span className="text-[10px] font-medium text-slate-400">티커 / 종목명</span>
                        {(() => {
                          const q = (sellTickerSearch[owner] ?? "").toLowerCase();
                          const filtered = ownerTickerOptions.filter((opt) =>
                            !q || opt.symbol.toLowerCase().includes(q) || opt.name.toLowerCase().includes(q)
                          );
                          const hl = sellTickerHl[owner] ?? 0;
                          const selectByIndex = (idx: number) => {
                            const opt = filtered[idx];
                            if (!opt) return;
                            handleTickerChange(opt.symbol);
                            setSellTickerSearch((prev) => { const next = { ...prev }; delete next[owner]; return next; });
                            setSellTickerOpen((prev) => ({ ...prev, [owner]: false }));
                            setSellTickerHl((prev) => ({ ...prev, [owner]: 0 }));
                          };
                          return (
                            <>
                              <input
                                ref={(el) => { sellTickerInputRefs.current[owner] = el; }}
                                className="w-full rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70"
                                placeholder="티커 또는 종목명 검색"
                                value={sellTickerSearch[owner] ?? (form.symbol ? `${form.symbol}(${form.name})` : "")}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setSellTickerSearch((prev) => ({ ...prev, [owner]: v }));
                                  setSellTickerOpen((prev) => ({ ...prev, [owner]: true }));
                                  setSellTickerHl((prev) => ({ ...prev, [owner]: 0 }));
                                  if (v === "") handleTickerChange("");
                                }}
                                onFocus={() => setSellTickerOpen((prev) => ({ ...prev, [owner]: true }))}
                                onBlur={() => window.setTimeout(() => setSellTickerOpen((prev) => ({ ...prev, [owner]: false })), 150)}
                                onKeyDown={(e) => {
                                  if (!sellTickerOpen[owner] || filtered.length === 0) return;
                                  if (e.key === "ArrowDown") { e.preventDefault(); setSellTickerHl((prev) => ({ ...prev, [owner]: Math.min((prev[owner] ?? 0) + 1, filtered.length - 1) })); }
                                  else if (e.key === "ArrowUp") { e.preventDefault(); setSellTickerHl((prev) => ({ ...prev, [owner]: Math.max((prev[owner] ?? 0) - 1, 0) })); }
                                  else if (e.key === "Enter") { e.preventDefault(); selectByIndex(hl); }
                                  else if (e.key === "Escape") { setSellTickerOpen((prev) => ({ ...prev, [owner]: false })); }
                                }}
                                autoComplete="off"
                              />
                              {sellTickerOpen[owner] && filtered.length > 0 && (
                                <ul
                                  className="absolute left-0 top-full z-50 mt-0.5 max-h-48 w-max min-w-full overflow-y-auto rounded border shadow-lg"
                                  style={{ background: "var(--background, #18181b)", color: "inherit" }}
                                  onMouseDown={(e) => e.preventDefault()}
                                >
                                  {filtered.map((opt, idx) => (
                                    <li
                                      key={opt.symbol}
                                      className="cursor-pointer px-2 py-1"
                                      style={{ background: idx === hl ? "var(--accent, #27272a)" : "transparent" }}
                                      onMouseEnter={() => setSellTickerHl((prev) => ({ ...prev, [owner]: idx }))}
                                      onMouseDown={(e) => { e.preventDefault(); selectByIndex(idx); }}
                                    >
                                      <span className="font-mono">{opt.symbol}</span>
                                      <span className="ml-1 text-muted-foreground">{opt.name}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </>
                          );
                        })()}
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">통화</span>
                        <select className="cursor-pointer rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 outline-none focus:border-indigo-500/70" value={form.currency} onChange={(e) => setForm2({ currency: e.target.value as "USD" | "EUR" | "KRW" })}>
                          <option value="USD">USD</option><option value="EUR">EUR</option><option value="KRW">KRW</option>
                        </select>
                      </label>
                    </div>

                    {/* 행 2: 담당자 (라디오 버튼) */}
                    <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-3 py-2">
                      <p className="mb-2 text-[10px] font-medium text-slate-400">담당자</p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {ownerNames.map((name) => {
                          const isSelected = (form.selectedOwners[0] ?? "") === name;
                          const anySelected = form.selectedOwners.length > 0;
                          const noHolding = Boolean(selectedSymbol) && !ownersWithTicker.includes(name);
                          return (
                            <label
                              key={name}
                              className={`flex cursor-pointer items-center gap-1.5 select-none transition-opacity ${anySelected && !isSelected ? "opacity-30" : "opacity-100"}`}
                            >
                              <input
                                type="radio"
                                name={`sell-form-owner-${owner}`}
                                className="cursor-pointer accent-primary"
                                checked={isSelected}
                                onChange={() => {
                                  const match = positions.find((p) => p.owner === name && p.symbol === selectedSymbol);
                                  const matchedFxRate = form.currency === "KRW" ? "1"
                                    : form.currency === "EUR" ? String(Math.round(match?.purchaseEurKrw ?? eurKrw))
                                    : String(Math.round(match?.purchaseUsdKrw ?? usdKrw));
                                  setSellLogOwnerForSection(name);
                                  setForm2(
                                    {
                                      symbol: form.symbol, name: form.name, date: form.date,
                                      qty: form.qty, sellPrice: form.sellPrice, note: form.note,
                                      currency: form.currency, editingId: form.editingId,
                                      selectedOwners: [name], ownerOverrides: {},
                                      avgPrice: match ? String(match.avgPrice) : form.avgPrice,
                                      fxRate: matchedFxRate,
                                    },
                                    name,
                                  );
                                }}
                              />
                              <span className={`text-sm ${isSelected ? "font-semibold text-foreground" : ""}`}>
                                {name}
                                {noHolding && <span className="ml-0.5 text-[10px] text-slate-500">· 미보유</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    {/* 행 3: 수량 · 매도가 · 매수평단가 · 매입환율 */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">수량</span>
                        <input type="number" min="0" step="any" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.qty} onChange={(e) => setForm2({ qty: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">매도가</span>
                        <input type="number" min="0" step="any" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.sellPrice} onChange={(e) => setForm2({ sellPrice: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">매수평단가</span>
                        <input type="number" min="0" step="any" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.avgPrice} onChange={(e) => setForm2({ avgPrice: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">매입 환율 (₩)</span>
                        <input type="number" min="0" step="1" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.fxRate} onChange={(e) => setForm2({ fxRate: e.target.value })} />
                      </label>
                    </div>

                    {/* 행 4: 메모 · 저장 */}
                    <div className="flex gap-2">
                      <input className="flex-1 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="메모 (선택)" value={form.note} onChange={(e) => setForm2({ note: e.target.value })} />
                      <button
                        type="button"
                        disabled={!!(sellLogErrorByOwner[owner] && sellLogErrorByOwner[owner].startsWith("⚠️"))}
                        className="shrink-0 cursor-pointer rounded-md bg-primary px-4 py-1.5 font-semibold text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={handleSave}
                      >
                        {form.editingId ? "수정 저장" : "+ 기록 추가"}
                      </button>
                    </div>

                    {/* 실현손익 예상 */}
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold">
                        실현손익 예상: <span className={preview >= 0 ? "text-red-400" : "text-blue-400"}>{preview >= 0 ? "+" : ""}₩{fmtInt(preview)}</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground">(매도 {(TRADING_FEE_RATE * 100).toFixed(1)}% 반영)</span>
                    </div>

                    {/* ── 실현손익 누락 보유자 알림 ──────────────────────────── */}
                    {sellOwnerTracker && (() => {
                      const holders = ownerNames.filter((n) =>
                        positions.some((p) => p.owner === n && p.symbol === sellOwnerTracker.symbol),
                      );
                      const missing = holders.filter((n) => !sellOwnerTracker.doneOwners.includes(n));
                      const allDone = missing.length === 0;
                      return (
                        <div
                          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                            allDone
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                              : "border-amber-500/35 bg-amber-500/8 text-amber-200"
                          }`}
                        >
                          <span className="shrink-0 text-sm">{allDone ? "✓" : "⚠️"}</span>
                          <span className="font-semibold">{sellOwnerTracker.symbol}</span>
                          <span className="text-[10px] text-muted-foreground">{sellOwnerTracker.date}</span>
                          {allDone ? (
                            <span className="text-emerald-400">— 보유자 전원 입력 완료</span>
                          ) : (
                            <span>
                              — 아직 미입력:{" "}
                              <strong className="text-amber-300">{missing.join(", ")}</strong>
                            </span>
                          )}
                          {!allDone && (
                            <button
                              type="button"
                              onClick={() => setSellOwnerTracker(null)}
                              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                              aria-label="알림 닫기"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {symPnlList.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border bg-muted/20 p-2">
                      <div className="mb-2 flex justify-end">
                        <button
                          type="button"
                          className="rounded border px-2 py-0.5 text-[10px] hover:bg-muted"
                          onClick={() =>
                            setShowSymbolPnl((prev) => ({
                              ...prev,
                              [REALIZED_SYMBOL_PNL_TOGGLE_KEY]: !prev[REALIZED_SYMBOL_PNL_TOGGLE_KEY],
                            }))
                          }
                        >
                          {showSymbolPnl[REALIZED_SYMBOL_PNL_TOGGLE_KEY]
                            ? "종목별 접기 ▲"
                            : "종목별 손익 ▼ (전원 합산)"}
                        </button>
                      </div>
                      {showSymbolPnl[REALIZED_SYMBOL_PNL_TOGGLE_KEY] && (
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
                            {symPnlDatesDesc.map((d) => {
                              const daySum = dailyRealizedAllOwners.get(d) ?? 0;
                              const dayRows = symPnlByDate.get(d) ?? [];
                              return (
                                <Fragment key={d}>
                                  <tr className="border-b border-border/50 bg-muted/50">
                                    <td colSpan={5} className="py-1.5 pl-1 text-[10px] font-semibold sm:text-xs">
                                      <span className="text-sm tabular-nums text-foreground sm:text-base">
                                        {d}
                                      </span>
                                      <span className="ml-2 text-muted-foreground">— 당일 합산 실현손익</span>{" "}
                                      <span
                                        className={
                                          daySum > 0
                                            ? "text-red-500"
                                            : daySum < 0
                                              ? "text-blue-500"
                                              : "text-muted-foreground"
                                        }
                                      >
                                        {daySum >= 0 ? "+" : ""}₩{fmtInt(daySum)}
                                      </span>
                                    </td>
                                  </tr>
                                  {dayRows.map((s) => {
                                    const pct = s.costKrw > 0 ? (s.realizedKrw / s.costKrw) * 100 : 0;
                                    return (
                                      <tr
                                        key={`${d}-${s.symbol}`}
                                        className="border-b border-border/30 last:border-0"
                                      >
                                        <td className="py-1 pr-2">
                                          <span className="font-medium">{s.name}</span>
                                          <span className="ml-1 text-muted-foreground">{s.symbol}</span>
                                        </td>
                                        <td className="py-1 pr-2 text-right tabular-nums">{s.qty}</td>
                                        <td className="py-1 pr-2 text-right tabular-nums">
                                          ₩{fmtInt(s.costKrw)}
                                        </td>
                                        <td
                                          className={`py-1 pr-2 text-right tabular-nums font-semibold ${s.realizedKrw > 0 ? "text-red-500" : s.realizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                        >
                                          {s.realizedKrw >= 0 ? "+" : ""}₩
                                          {fmtInt(s.realizedKrw)}
                                        </td>
                                        <td
                                          className={`py-1 text-right tabular-nums font-semibold ${pct > 0 ? "text-red-500" : pct < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                        >
                                          {pct >= 0 ? "+" : ""}
                                          {pct.toFixed(2)}%
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                  <div className="overflow-x-auto rounded-lg border bg-muted/20 p-2">
                    <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold">기록 목록</p>
                        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span>열람</span>
                          <select
                            className="max-w-[10rem] cursor-pointer rounded border bg-background px-2 py-0.5 text-xs"
                            value={sellLogListViewOwner}
                            onChange={(e) => setSellLogListViewOwner(e.target.value)}
                          >
                            {ownerNames.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <span className="text-[10px] text-muted-foreground tabular-nums">({listLog.length}건)</span>
                        {listLog.length > 0 ? (
                          <span className="text-[10px] text-muted-foreground">
                            · 총이익{" "}
                            <span className={`tabular-nums font-semibold ${listGrossRealizedKrw > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                              {listGrossRealizedKrw >= 0 ? "+" : ""}₩{fmtInt(listGrossRealizedKrw)}
                            </span>
                            {" / "}순손익{" "}
                            <span
                              className={`tabular-nums font-semibold ${
                                listTotalRealizedKrw > 0
                                  ? "text-red-500"
                                  : listTotalRealizedKrw < 0
                                    ? "text-blue-500"
                                    : "text-muted-foreground"
                              }`}
                            >
                              {listTotalRealizedKrw >= 0 ? "+" : ""}₩{fmtInt(listTotalRealizedKrw)}
                            </span>
                            <span className="opacity-70">
                              {" "}
                              (수수료 {(TRADING_FEE_RATE * 100).toFixed(1)}% 반영)
                            </span>
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="w-fit rounded border px-2 py-0.5 text-[10px] hover:bg-muted sm:ml-auto"
                        onClick={() => setSellLogListExpanded((v) => !v)}
                      >
                        {sellLogListExpanded ? "접기 ▲" : "펼치기 ▼"}
                      </button>
                    </div>
                    {sellLogListExpanded ? (
                      listLog.length > 0 ? (
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="py-1 pr-2 text-left font-medium">종목</th>
                              <th className="py-1 pr-2 text-right font-medium">수량</th>
                              <th className="py-1 pr-2 text-right font-medium">매도가</th>
                              <th className="py-1 pr-2 text-right font-medium">평단가</th>
                              <th className="py-1 pr-2 text-right font-medium">실현손익</th>
                              <th className="py-1 text-right font-medium">관리</th>
                            </tr>
                          </thead>
                          <tbody>
                            {listDatesDesc.map((d) => {
                              const dayEnt = listByDate.get(d) ?? [];
                              const dayTotal = listDailyRealized(d);
                              return (
                                <Fragment key={`list-${d}`}>
                                  <tr className="border-b border-border/50 bg-muted/40">
                                    <td colSpan={6} className="px-0 py-0">
                                      <div className="flex flex-col gap-0.5 px-1 py-2 sm:flex-row sm:items-baseline sm:gap-3">
                                        <span className="text-sm font-bold tabular-nums tracking-tight text-foreground sm:text-base">
                                          {d}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground sm:text-[11px]">
                                          당일 합산 실현손익
                                        </span>
                                        <span
                                          className={`text-xs font-semibold tabular-nums sm:text-sm ${dayTotal > 0 ? "text-red-500" : dayTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                        >
                                          {dayTotal >= 0 ? "+" : ""}₩{fmtInt(dayTotal)}
                                        </span>
                                      </div>
                                    </td>
                                  </tr>
                                  {dayEnt.map((e) => (
                                    <tr key={e.id} className="border-b border-border/30 last:border-0">
                                      <td className="py-1 pr-2">
                                        {e.name} <span className="text-muted-foreground">({e.symbol})</span>
                                      </td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{e.qty}</td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{e.sellPrice}</td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{e.avgPrice}</td>
                                      <td
                                        className={`py-1 pr-2 text-right tabular-nums font-semibold ${calcSellRealizedKrw(e) > 0 ? "text-red-500" : calcSellRealizedKrw(e) < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                      >
                                        {calcSellRealizedKrw(e) >= 0 ? "+" : ""}₩
                                        {fmtInt(calcSellRealizedKrw(e))}
                                      </td>
                                      <td className="py-1 text-right">
                                        <div className="flex justify-end gap-1">
                                          <button
                                            type="button"
                                            className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                                            onClick={() => handleListEdit(e)}
                                          >
                                            수정
                                          </button>
                                          <button
                                            type="button"
                                            className="rounded border px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                                            onClick={() => handleListDelete(e.id)}
                                          >
                                            삭제
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">이 보유자의 매도 기록이 없습니다.</p>
                      )
                    ) : null}
                  </div>

                  {/* 종목별 합산 패널 */}
                  <div className="overflow-x-auto rounded-lg border bg-muted/20 p-2">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold">종목별 합산</p>
                        {/* 보유자 필터 토글 버튼 */}
                        <div className="flex flex-wrap gap-1">
                          {ownerNames.map((name) => {
                            const active = sellLogSymOwnerFilter.length === 0 || sellLogSymOwnerFilter.includes(name);
                            return (
                              <button
                                key={name}
                                type="button"
                                onClick={() => toggleSymOwner(name)}
                                className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                                  active
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:bg-muted"
                                }`}
                              >
                                {name}
                              </button>
                            );
                          })}
                        </div>
                        {symSummaryRows.length > 0 && (
                          <span className={`text-[10px] tabular-nums font-semibold ${symSummaryTotal > 0 ? "text-red-500" : symSummaryTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                            합산 {symSummaryTotal >= 0 ? "+" : ""}₩{fmtInt(Math.round(symSummaryTotal))}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="w-fit rounded border px-2 py-0.5 text-[10px] hover:bg-muted"
                        onClick={() => setSellLogSymSummaryExpanded((v) => !v)}
                      >
                        {sellLogSymSummaryExpanded ? "접기 ▲" : "펼치기 ▼"}
                      </button>
                    </div>
                    {sellLogSymSummaryExpanded && (
                      symSummaryRows.length > 0 ? (
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="py-1 pr-2 text-left font-medium">종목</th>
                              <th className="py-1 pr-2 text-right font-medium">거래 횟수</th>
                              <th className="py-1 pr-2 text-right font-medium">총 수량</th>
                              <th className="py-1 text-right font-medium">실현손익 합계</th>
                            </tr>
                          </thead>
                          <tbody>
                            {symSummaryRows.map((row) => (
                              <tr key={row.symbol} className="border-b border-border/30 last:border-0 hover:bg-muted/30">
                                <td className="py-1 pr-2">
                                  <span className="font-medium">{row.name}</span>
                                  <span className="ml-1 text-[10px] text-muted-foreground">({row.symbol})</span>
                                </td>
                                <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{row.count}회</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{row.totalQty}</td>
                                <td className={`py-1 text-right tabular-nums font-semibold ${row.totalRealizedKrw > 0 ? "text-red-500" : row.totalRealizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                  {row.totalRealizedKrw >= 0 ? "+" : ""}₩{fmtInt(Math.round(row.totalRealizedKrw))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-border">
                              <td className="py-1.5 pr-2 text-[10px] text-muted-foreground" colSpan={3}>총이익 (손실 미차감)</td>
                              <td className={`py-1.5 text-right tabular-nums text-xs font-semibold ${symSummaryGrossTotal > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                                {symSummaryGrossTotal >= 0 ? "+" : ""}₩{fmtInt(Math.round(symSummaryGrossTotal))}
                              </td>
                            </tr>
                            <tr className="border-t border-border/50">
                              <td className="py-1.5 pr-2 text-xs font-bold text-foreground" colSpan={3}>순손익 (손실 차감)</td>
                              <td className={`py-1.5 text-right tabular-nums text-xs font-bold ${symSummaryTotal > 0 ? "text-red-500" : symSummaryTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                {symSummaryTotal >= 0 ? "+" : ""}₩{fmtInt(Math.round(symSummaryTotal))}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">선택한 보유자의 매도 기록이 없습니다.</p>
                      )
                    )}
                  </div>
                </div>
              );
            })()}
          </section>
          </div>

          <div
            className={cn(
              activeTopNav === "section-rebalance" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-rebalance"}
          >
          {/* 리밸런싱 계산기 */}
          <section id="section-rebalance" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">리밸런싱 계산기</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              그룹별 목표 비중(%)을 입력하면 필요한 매수/매도 금액과 주수를 자동으로 계산합니다.
            </p>
            <RebalancingCalculator
              allocationByOwner={allocationByOwner}
              enrichedPositions={enrichedPositions}
              usdKrw={usdKrw}
              eurKrw={eurKrw}
              marketQuotes={marketQuery.data?.quotes}
              watchlistRows={watchlistRows}
              watchlistOwnerAllToken={WATCHLIST_OWNER_ALL}
              cloudSyncKey={cloudSyncKey}
            />
          </section>
          </div>

          <div
            className={cn(
              activeTopNav === "section-watchlist" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-watchlist"}
          >
          {/* 관심종목 (텔레그램 MA·RSI·BB·VOL) */}
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
          </div>

          <div
            className={cn(
              activeTopNav === "section-telegram" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-telegram"}
          >
          {/* 텔레그램 가격 변동 알림 섹션 */}
          <section id="section-telegram" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">📲 텔레그램 가격 변동 알림</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              크론 자동 발송은 <b>본인 동기화 키</b> 한 계정만 대상으로 하려면 Vercel에{" "}
              <code className="rounded bg-muted px-1">TELEGRAM_ALERT_SYNC_KEY</code>를 동기화 키와 동일하게 설정하세요.
              Supabase 포트폴리오·시세 기준 <b>총 평가·전일 대비 수익률·종목 등락</b> HTML 브리핑이{" "}
              <b>KST 09:30, 14:00, 24:00</b> (평일만, 주말 미발송) (<code className="rounded bg-muted px-1">vercel.json</code>{" "}
              <code className="rounded bg-muted px-1">slot</code>)에 발송됩니다. 관심종목 MA·RSI·BB·VOL 요약은 위에서 저장한
              목록을 이어서 보냅니다. 환경변수:{" "}
              <code className="rounded bg-muted px-1">TELEGRAM_BOT_TOKEN</code>,{" "}
              <code className="rounded bg-muted px-1">TELEGRAM_CHAT_ID</code>,{" "}
              <code className="rounded bg-muted px-1">CRON_SECRET</code>. 브리핑 슬롯 로그는{" "}
              <code className="rounded bg-muted px-1">price_move_alert_logs_briefing_slot.sql</code> 마이그레이션을
              적용했는지 확인하세요.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-md border px-4 py-2 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                disabled={telegramTestBusy}
                onClick={() => handleTelegramTest(true)}
              >
                {telegramTestBusy ? "점검 중…" : "🔍 진단 (전송 없음)"}
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-md border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm text-blue-600 transition-all duration-100 hover:bg-blue-500/20 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                disabled={telegramTestBusy}
                onClick={() => handleTelegramTest(false)}
              >
                {telegramTestBusy ? "전송 중…" : "📨 테스트 전송 (실제 발송)"}
              </button>
            </div>
            {telegramTestResult && (
              <div className={`mt-3 rounded-lg border p-3 text-xs ${telegramTestResult.ok ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
                {!telegramTestResult.ok ? (
                  <div className="space-y-1">
                    <p className="font-semibold text-red-500">❌ {telegramTestResult.error}</p>
                    {telegramTestResult.detail && Object.entries(telegramTestResult.detail).map(([k, v]) => (
                      <p key={k}><span className="text-muted-foreground">{k}:</span> {v}</p>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="font-semibold text-green-600">✅ {telegramTestResult.message}</p>
                    {telegramTestResult.env && (
                      <div className="flex gap-4">
                        {Object.entries(telegramTestResult.env).map(([k, v]) => (
                          <p key={k}><span className="text-muted-foreground">{k}:</span> {v}</p>
                        ))}
                      </div>
                    )}
                    {telegramTestResult.alreadySentToday && telegramTestResult.alreadySentToday.length > 0 && (
                      <p className="text-muted-foreground">오늘 이미 발송됨: {telegramTestResult.alreadySentToday.join(", ")}</p>
                    )}
                    {telegramTestResult.symbols && telegramTestResult.symbols.length > 0 && (
                      <div>
                        <p className="mb-1 font-medium text-muted-foreground">종목별 현재 변동률:</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
                          {telegramTestResult.symbols.map((s) => (
                            <p key={s.symbol} className={s.willAlert ? "font-semibold text-red-500" : ""}>
                              {s.symbol}: {s.changePct != null ? `${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(2)}%` : "시세 없음"}
                              {s.willAlert ? " ⚠️" : ""}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                    {telegramTestResult.watchlistSignals && telegramTestResult.watchlistSignals.length > 0 && (
                      <div className="mt-2 border-t pt-2">
                        <p className="mb-1 font-medium text-muted-foreground">관심종목 시그널 (진단):</p>
                        <ul className="space-y-1 text-[11px]">
                          {(telegramTestResult.watchlistSignals as Array<{
                            symbol: string;
                            name: string;
                            ma: string;
                            rsi: string;
                            bb: string;
                            vol: string;
                            overall: string;
                            summaryKo: string;
                          }>).map((w) => (
                            <li key={w.symbol}>
                              <span className="font-medium">{w.name}</span> ({w.symbol}) — {w.overall} · MA:{w.ma} RSI:{w.rsi} BB:{w.bb} VOL:{w.vol} — {w.summaryKo}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
          </div>

          <div
            className={cn(
              activeTopNav === "section-sync" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-sync"}
          >
          <Card id="section-sync" className="border-dashed">
            <CardHeader className="pb-2">
              <CardDescription>클라우드 동기화 (폰·PC 같은 데이터)</CardDescription>
              <CardTitle className="text-lg">동기화 키</CardTitle>
              <p className="text-xs text-muted-foreground">
                다른 PC·폰에서는 브라우저마다 저장소가 달라서, 집에서 쓰는 동기화 키를 그대로 입력한 뒤
                「키 저장」만 하면 서버에서 자동으로 불러옵니다. 키는 비밀번호처럼 길게 정하세요.
              </p>
              <p className="text-xs text-muted-foreground">
                서버(Supabase) 연결:{" "}
                {serverHealth === "loading" ? (
                  <span>확인 중…</span>
                ) : serverHealth === "ok" ? (
                  <span className="text-emerald-600 dark:text-emerald-400">정상</span>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400">
                    문제 있음 — Vercel 환경 변수{" "}
                    <code className="rounded bg-muted px-1">NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
                    <code className="rounded bg-muted px-1">SUPABASE_SERVICE_ROLE_KEY</code> 확인 후
                    재배포
                  </span>
                )}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-xs text-muted-foreground" htmlFor="sync-key">
                    동기화 키 (8자 이상)
                  </label>
                  <input
                    id="sync-key"
                    type="password"
                    autoComplete="off"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="예: 우리가족포트폴리오2026"
                    value={syncKeyDraft}
                    onChange={(e) => setSyncKeyDraft(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95"
                  onClick={handleSaveSyncKey}
                >
                  키 저장
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handlePullCloud}
                >
                  서버에서 불러오기
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handlePushCloud}
                >
                  서버로 올리기
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-dashed px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handleBackupSnapshot}
                >
                  백업
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-dashed px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={handleDownloadBackups}
                >
                  백업 내려받기
                </button>
                <input
                  ref={restoreBackupFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleRestoreFromBackupFile}
                />
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-dashed px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={syncBusy}
                  onClick={() => restoreBackupFileInputRef.current?.click()}
                >
                  백업에서 복원
                </button>
                <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
                  <input
                    type="checkbox"
                    className="cursor-pointer accent-primary"
                    checked={autoSync}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setAutoSync(v);
                      safeSetItem(AUTO_SYNC_STORAGE, v ? "1" : "0");
                    }}
                  />
                  변경 시 자동으로 서버에 저장 (2초 후)
                </label>
              </div>
              <div className="border-t pt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  현재 동기화 키의 데이터(보유 종목·현금·관심 종목·목표 비율 등)를 <strong className="text-foreground">로컬과 서버에서 모두 비웁니다.</strong> 보유자 목록은 유지됩니다. <strong className="text-foreground">다른 동기화 키의 데이터는 키마다 별도로 저장되어 영향받지 않습니다.</strong> 비우기 직전 서버 상태는 <strong className="text-foreground">자동 백업</strong>되어 「백업에서 복원」으로 되살릴 수 있습니다.
                </p>
                {pendingClearConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-destructive font-medium">이 키의 서버 데이터까지 비웁니다. 진행할까요?</span>
                    <button
                      type="button"
                      className="cursor-pointer rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-all duration-100 hover:bg-destructive/90 active:scale-95"
                      onClick={handleClearLocalData}
                    >
                      확인 (초기화)
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-all duration-100 hover:bg-muted active:scale-95"
                      onClick={() => setPendingClearConfirm(false)}
                    >
                      취소
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border border-destructive/50 px-3 py-1.5 text-sm text-destructive transition-all duration-100 hover:bg-destructive/10 active:scale-95"
                    onClick={() => setPendingClearConfirm(true)}
                  >
                    이 키 데이터 초기화 (로컬+서버)
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                「백업」은 서버에 올라간 잔고를 백업 테이블에 한 줄씩 추가합니다(최대 1년, 500건).
                목표 비중과 리밸 계산기의 종목 분배·모드까지 동일 스키마(sync)로 포함됩니다. 「백업 내려받기」는 먼저 백업을 저장한 뒤 JSON으로 다운로드. 「백업에서 복원」은 JSON을 업로드하면 <strong className="font-medium text-foreground">시점 목록이 표시되며 원하는 시점을 선택해 복원</strong>할 수 있습니다.
              </p>

              {/* 백업 시점 선택 복원 UI */}
              {pendingBackups && pendingBackups.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-amber-200">
                      복원할 시점을 선택하세요 ({pendingBackups.length}건)
                    </p>
                    <button
                      type="button"
                      className="text-[10px] text-zinc-500 hover:text-zinc-300 transition"
                      onClick={() => { setPendingBackups(null); setSyncMessage(""); }}
                    >
                      취소
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                    {pendingBackups.map((b, idx) => {
                      const kstTime = new Date(b.created_at).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                        year: "numeric", month: "2-digit", day: "2-digit",
                        hour: "2-digit", minute: "2-digit", second: "2-digit",
                      });
                      const posCount = Array.isArray((b.snapshot as { positions?: unknown }).positions)
                        ? (b.snapshot.positions as unknown[]).length
                        : "?";
                      const srcAt = typeof (b.snapshot as { source_updated_at?: unknown }).source_updated_at === "string"
                        ? new Date((b.snapshot as { source_updated_at: string }).source_updated_at).toLocaleString("ko-KR", {
                            timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
                            hour: "2-digit", minute: "2-digit",
                          })
                        : null;
                      return (
                        <button
                          key={b.id ?? idx}
                          type="button"
                          disabled={syncBusy}
                          onClick={() => void handleRestoreSpecificBackup(idx)}
                          className="w-full flex items-center justify-between gap-3 rounded border border-white/10 bg-zinc-900/60 px-3 py-1.5 text-left text-xs hover:bg-zinc-800 transition disabled:opacity-50"
                        >
                          <span className="font-mono tabular-nums text-zinc-200">{kstTime}</span>
                          <span className="shrink-0 text-zinc-500">
                            {posCount}종목{srcAt ? ` · 데이터 ${srcAt}` : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-amber-400/80">⚠ 선택 시 서버 메인 잔고를 해당 시점으로 덮어씁니다.</p>
                </div>
              )}
              {syncMessage ? (
                <p className="text-xs text-muted-foreground">{syncMessage}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                매도 기록 동기화:{" "}
                {sellLogDirty ? (
                  <span className="text-amber-600">로컬 변경 있음 (서버 반영 대기)</span>
                ) : lastSellLogSyncedAt ? (
                  <span>
                    최신 반영{" "}
                    {new Date(lastSellLogSyncedAt).toLocaleString("ko-KR", {
                      hour12: false,
                    })}
                  </span>
                ) : (
                  <span>아직 반영 이력 없음</span>
                )}
              </p>
              {syncBusy ? <p className="text-xs text-amber-600">동기화 중…</p> : null}
              {lastSyncedAt ? (
                <p className="text-xs text-muted-foreground">
                  마지막 동기 시각: {new Date(lastSyncedAt).toLocaleString()}
                </p>
              ) : null}
              {syncReady && cloudSyncKey.trim().length >= 8 && hasLoadedLatestBackup ? (
                <p className="text-xs text-muted-foreground">
                  서버 최근 백업:{" "}
                  {latestBackupAt ? (
                    <span className="font-medium text-foreground">
                      {new Date(latestBackupAt).toLocaleString()}
                    </span>
                  ) : (
                    <span>아직 없음 (「백업」 또는 「백업 내려받기」로 저장)</span>
                  )}
                </p>
              ) : null}
            </CardContent>
          </Card>
          </div>

        </main>
      </div>

      {showTradeImageImport && (
        <TradeImageImport
          ownerNames={ownerNames}
          knownSecurities={[
            ...watchlistRows.map((w) => ({ symbol: w.symbol, name: w.name })),
            ...positions.map((p) => ({ symbol: p.symbol, name: p.name })),
          ].filter((s) => s.symbol && s.name)}
          onBuyConfirm={handleImageBuyConfirm}
          onSellConfirm={handleImageSellConfirm}
          onClose={() => setShowTradeImageImport(false)}
        />
      )}

      <TechnicalSignalDetailModal
        open={signalDetailTarget !== null}
        onClose={() => setSignalDetailTarget(null)}
        symbol={signalDetailTarget?.symbol ?? ""}
        name={signalDetailTarget?.name ?? ""}
        prices={
          signalDetailTarget
            ? (historyQuery.data?.history?.[signalDetailTarget.symbol] ?? [])
            : []
        }
      />
      {sellLogDetailOpenOwner !== null && (
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
      )}
    </div>
  );
}
