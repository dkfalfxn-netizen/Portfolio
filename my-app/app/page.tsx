"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChangeEvent,
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FamilyAllocationDonut } from "@/components/family-allocation-chart";
import { IntradaySparkline } from "@/components/intraday-sparkline";
import { LivePriceCell } from "@/components/live-price-cell";
import { DailyTrendChart } from "@/components/daily-trend-chart";
import { DailyChangeCalendar } from "@/components/daily-change-calendar";
import { RebalancingCalculator } from "@/components/rebalancing-calculator";
import { TechnicalSignalDetailModal } from "@/components/technical-signal-detail-modal";
import { LiquiditySection } from "@/components/liquidity-section";
import { cn } from "@/lib/utils";
import {
  HAS_LOCAL_CHANGES_KEY,
  loadAllTargetStockWeights,
  mergeAndPersistTargetStockWeightsFromServer,
} from "@/lib/portfolio-target-weights";
import { mergeAndPersistOwnerScratchpadsFromServer, loadAllOwnerScratchpads } from "@/lib/portfolio-owner-scratchpad";
import { todayKST } from "@/lib/date-utils";
import type { LiquidityHistoryRow } from "@/components/liquidity-briefing-chart";
import {
  calculateBollingerSignal,
  calculateMACrossoverSignal,
  calculateRSISignal,
  calculateVolumeSignal,
  type DailyPrice as SignalDailyPrice,
  type TradeSignal,
} from "@/lib/signals";
import { shouldShowDailyChangeVsPreviousClose } from "@/lib/trading-calendar";
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

const DEFAULT_OWNER_NAMES = ["김승주", "강희진", "김도율", "김찬율", "퇴직연금"] as const;
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
  accountType: "해외주식" | "국내주식";
  accountName: string;
  owner: OwnerName;
  /** 원형 차트에서 같은 값끼리 합산할 그룹명 (미입력 시 티커 기준) */
  chartGroup?: string;
};

type MarketResponse = {
  quotes: Record<
    string,
    { price: number | null; currency: string | null; previousClose: number | null }
  >;
  /** 티커별 당일 분봉 종가 시계열 */
  intraday?: Record<string, number[]>;
  usdKrw: number | null;
  eurKrw: number | null;
  fetchedAt: number;
};

type HistoryResponse = {
  history: Record<string, SignalDailyPrice[]>;
  fetchedAt?: number;
};

type LiquidityHistoryResponse = {
  ok: boolean;
  rows: LiquidityHistoryRow[];
};

type FedBriefApiResponse = {
  ok: boolean;
  summary: string | null;
  reportDate: string | null;
  error?: string;
  hint?: string;
  message?: string;
  titles?: string[];
  sources?: { title: string; url: string }[];
  /** `headlines-with-links`: 크론 v2 포맷(참고 링크 블록 포함). */
  briefingFormat?: "headlines-with-links" | "legacy";
};

type ThemesBriefApiResponse = {
  ok: boolean;
  summary: string | null;
  reportDate: string | null;
  error?: string;
  hint?: string;
  message?: string;
  titles?: string[];
  sources?: { title: string; url: string }[];
  briefingFormat?: "headlines-with-links" | "legacy";
};

/** 로컬 저장 키 — v1에서 한 번만 마이그레이션 후 v2만 사용 */
const STORAGE_KEY = "portfolio_positions_v2";
const LEGACY_POSITIONS_STORAGE_KEY = "portfolio_positions_v1";
const CASH_STORAGE_KEY = "portfolio_cash_v1";
const OWNER_NAMES_STORAGE_KEY = "portfolio_owner_names_v1";
const SYNC_KEY_STORAGE = "portfolio_sync_key_v1";
const AUTO_SYNC_STORAGE = "portfolio_auto_sync_v1";
const HOLDINGS_SORT_STORAGE_KEY = "portfolio_holdings_sort_v1";
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
const LAST_SELL_LOG_SYNC_TS_KEY = "portfolio_last_sell_log_sync_ts_v1";
const SELL_LOG_DIRTY_KEY = "portfolio_sell_log_dirty_v1";
const TRADING_FEE_RATE = 0.002; // 0.2%
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

function calcSellRealizedKrw(entry: Pick<SellLogEntry, "qty" | "sellPrice" | "avgPrice" | "currency" | "fxRate">): number {
  const qty = Number(entry.qty);
  const sell = Number(entry.sellPrice);
  const avg = Number(entry.avgPrice);
  const fx = Number(entry.fxRate) || 1;
  if (!Number.isFinite(qty) || !Number.isFinite(sell) || !Number.isFinite(avg)) return 0;
  const gross =
    entry.currency === "KRW"
      ? (sell - avg) * qty
      : (sell - avg) * qty * fx;
  // 종목 추가 직후 -0.2%가 반영되도록 매입 원가 기준 수수료를 차감
  const buyNotionalKrw =
    entry.currency === "KRW" ? avg * qty : avg * qty * fx;
  return gross - buyNotionalKrw * TRADING_FEE_RATE;
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
      out[owner] = entries.filter(
        (e): e is SellLogEntry =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as SellLogEntry).id === "string" &&
          typeof (e as SellLogEntry).symbol === "string" &&
          typeof (e as SellLogEntry).qty === "number" &&
          typeof (e as SellLogEntry).realizedKrw === "number",
      );
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
  },
];

function positionsForOwner(
  seed: Omit<Position, "owner">[],
  owner: OwnerName,
): Position[] {
  return seed.map((p) => ({ ...p, owner }));
}

const DEFAULT_POSITIONS: Position[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    quantity: 36,
    avgPrice: 795.5,
    currentPrice: 902.2,
    currency: "USD",
    purchaseUsdKrw: 1350,
    accountType: "해외주식",
    accountName: "미국주식-주계좌",
    owner: "김승주",
  },
  ...positionsForOwner(SEED_강희진_보유, "강희진"),
  ...positionsForOwner(SEED_강희진_보유, "김도율"),
  ...positionsForOwner(SEED_강희진_보유, "김찬율"),
];

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
    return v.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return v.toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
    base[name] = entries.filter(
      (e): e is SellLogEntry =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as SellLogEntry).id === "string" &&
        typeof (e as SellLogEntry).symbol === "string" &&
        typeof (e as SellLogEntry).name === "string" &&
        typeof (e as SellLogEntry).qty === "number" &&
        typeof (e as SellLogEntry).sellPrice === "number" &&
        typeof (e as SellLogEntry).avgPrice === "number" &&
        ((e as SellLogEntry).currency === "USD" ||
          (e as SellLogEntry).currency === "EUR" ||
          (e as SellLogEntry).currency === "KRW") &&
        typeof (e as SellLogEntry).fxRate === "number" &&
        typeof (e as SellLogEntry).realizedKrw === "number",
    );
  }
  return base;
}

/**
 * 서버 `updated_at`이 로컬 `portfolio_last_sync_ts_v1`보다 새로운지.
 * 로컬 시각이 비어 있으면(저장소 삭제·최초) 항상 true → 서버 스냅샷을 반영해야 함.
 * 문자열만 `>`로 비교하면 `"" > ""`가 false가 되어 pull 적용이 건너뛰어질 수 있다.
 */
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
  const [ownerNames, setOwnerNames] = useState<OwnerName[]>(() => loadOwnerNames());
  const [positions, setPositions] = useState<Position[]>(DEFAULT_POSITIONS);
  const [cashByOwner, setCashByOwner] = useState<CashByOwner>(DEFAULT_CASH_BY_OWNER);
  const [isHydrated, setIsHydrated] = useState(false);
  const [dailySnapshots, setDailySnapshots] = useState<DailySnapshot[]>([]);
  const [sellLog, setSellLog] = useState<Record<string, SellLogEntry[]>>({});
  const [showSymbolPnl, setShowSymbolPnl] = useState<Record<string, boolean>>({});
  const [sellLogErrorByOwner, setSellLogErrorByOwner] = useState<Record<string, string>>({});
  const [sellLogOwnerForSection, setSellLogOwnerForSection] = useState<string>("김승주");
  /** 실현손익 '기록 목록' 열람용 보유자(입력 폼의 보유자와 독립) */
  const [sellLogListViewOwner, setSellLogListViewOwner] = useState<string>("김승주");
  /** 기록 목록 UI 접힘(기본 접힘) */
  const [sellLogListExpanded, setSellLogListExpanded] = useState(false);
  const [sellLogForm, setSellLogForm] = useState<Record<string, {
    date: string; symbol: string; name: string; qty: string;
    sellPrice: string; avgPrice: string; currency: "USD" | "EUR" | "KRW"; fxRate: string; note: string;
    selectedOwners: string[];
    ownerOverrides: Record<string, { qty: string; avgPrice: string; fxRate: string }>;
    editingId: string | null;
  }>>({});
  const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
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
  const skipOwnerLocalChangedRef = useRef(0);
  const skipSellLogLocalChangedRef = useRef(0);
  const [holdingsSortByOwner, setHoldingsSortByOwner] =
    useState<Record<OwnerName, HoldingsSortMode>>(defaultHoldingsSort);

  // 알림 설정 상태
  type AlertRule = { owner: string; symbol: string; minPct: string; maxPct: string };
  const [alertEmail, setAlertEmail] = useState("");
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");
  const [alertLoaded, setAlertLoaded] = useState(false);

  // 텔레그램 가격 변동 알림 테스트 상태
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

  const [form, setForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    purchaseUsdKrw: "",
    purchaseEurKrw: "",
    currency: "USD" as "USD" | "EUR" | "KRW",
    accountType: "해외주식" as "해외주식" | "국내주식",
    /** 종목 추가 시 한 번에 넣을 담당자(복수) */
    selectedOwners: ["김승주"] as OwnerName[],
  });
  const [addPositionError, setAddPositionError] = useState("");
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

  useEffect(
    () => () => {
      if (actionSuccessToastTimerRef.current) {
        clearTimeout(actionSuccessToastTimerRef.current);
      }
    },
    [],
  );

  /** 상단 내비 활성 항목(스크롤 앵커 id 또는 dashboard) */
  const [activeTopNav, setActiveTopNav] = useState<string>("dashboard");
  const holdingsNavRef = useRef<HTMLDivElement>(null);
  const holdingsMenuRef = useRef<HTMLDivElement>(null);
  const [holdingsNavOpen, setHoldingsNavOpen] = useState(false);
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
  }, [form.symbol, form.name, form.currency, form.selectedOwners]);

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
      safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
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

  const marketSymbols = useMemo(
    () => [...new Set(positions.map((position) => position.symbol))].join(","),
    [positions],
  );

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

  const liquidityHistoryQuery = useQuery<LiquidityHistoryResponse>({
    queryKey: ["liquidity-history"],
    queryFn: async () => {
      const res = await fetch("/api/liquidity/history");
      if (!res.ok) throw new Error("데이터 분석(지표) 조회 실패");
      return res.json() as Promise<LiquidityHistoryResponse>;
    },
    staleTime: 1000 * 60 * 60,
    refetchInterval: 1000 * 60 * 60,
  });

  const fedBriefQuery = useQuery<FedBriefApiResponse>({
    queryKey: ["macro-fed-brief"],
    queryFn: async () => {
      const res = await fetch("/api/macro/fed-brief", { cache: "no-store" });
      return res.json() as Promise<FedBriefApiResponse>;
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  const themesBriefQuery = useQuery<ThemesBriefApiResponse>({
    queryKey: ["macro-themes-brief"],
    queryFn: async () => {
      const res = await fetch("/api/macro/themes-brief", { cache: "no-store" });
      return res.json() as Promise<ThemesBriefApiResponse>;
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  const fedNote = useMemo(() => {
    if (fedBriefQuery.isError) return { tone: "warn" as const, text: "연준·금리 뉴스 요약 API를 불러오지 못했습니다." };
    const d = fedBriefQuery.data;
    if (!d) return null;
    if (d.ok === false) {
      const t = [d.error, d.hint].filter(Boolean).join(" ");
      return t ? { tone: "warn" as const, text: t } : null;
    }
    if (d.summary) return null;
    return { tone: "info" as const, text: d.message ?? "아직 요약이 없습니다." };
  }, [fedBriefQuery.isError, fedBriefQuery.data]);

  const themesNote = useMemo(() => {
    if (themesBriefQuery.isError) return { tone: "warn" as const, text: "AI·방산 뉴스 요약 API를 불러오지 못했습니다." };
    const d = themesBriefQuery.data;
    if (!d) return null;
    if (d.ok === false) {
      const t = [d.error, d.hint].filter(Boolean).join(" ");
      return t ? { tone: "warn" as const, text: t } : null;
    }
    if (d.summary) return null;
    return { tone: "info" as const, text: d.message ?? "아직 요약이 없습니다." };
  }, [themesBriefQuery.isError, themesBriefQuery.data]);

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

  const usdKrw = marketQuery.data?.usdKrw ?? 1350;
  const eurKrw = marketQuery.data?.eurKrw ?? 1450;

  const totalCashKrw = useMemo(() => {
    return ownerNames.reduce((sum, owner) => {
      const c = cashByOwner[owner] ?? { usd: 0, krw: 0 };
      return sum + c.krw + c.usd * usdKrw;
    }, 0);
  }, [ownerNames, cashByOwner, usdKrw]);

  const enrichedPositions = useMemo(() => {
    return positions.map((position, sourceIndex) => {
      const q = marketQuery.data?.quotes?.[position.symbol];
      const livePrice = q?.price;
      const rawPreviousClose =
        typeof q?.previousClose === "number" && q.previousClose > 0 ? q.previousClose : null;
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
      };
    });
  }, [positions, marketQuery.data, usdKrw, eurKrw]);

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
        value: `₩${Math.round(totalProfit).toLocaleString()}`,
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

      const c = cashByOwner[ownerName] ?? { usd: 0, krw: 0 };
      const usd = Number.isFinite(c.usd) ? Math.max(0, c.usd) : 0;
      const krw = Number.isFinite(c.krw) ? Math.max(0, c.krw) : 0;
      const usdCashKrw = usd * usdKrw;
      const extra: {
        name: string;
        displayName: string;
        ticker: string;
        allEntries: { name: string; symbol: string; value: number }[];
        value: number;
        changePct: number | null;
      }[] = [];
      if (usdCashKrw > 0) {
        extra.push({
          name: `cash-usd|${ownerName}`,
          displayName: "USD 현금",
          ticker: "USD 현금",
          allEntries: [{ name: "USD 현금", symbol: "", value: usdCashKrw }],
          value: usdCashKrw,
          changePct: null,
        });
      }
      if (krw > 0) {
        extra.push({
          name: `cash-krw|${ownerName}`,
          displayName: "KRW 현금",
          ticker: "KRW 현금",
          allEntries: [{ name: "KRW 현금", symbol: "", value: krw }],
          value: krw,
          changePct: null,
        });
      }
      const merged = [...stockSlices, ...extra];
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
        return { label: block.label, dailyChangeKrw, dailyChangePct };
      }).sort((a, b) => b.dailyChangeKrw - a.dailyChangeKrw);
      const totalDailyKrw = groups.reduce((s, g) => s + g.dailyChangeKrw, 0);
      return { ownerName: group.ownerName, groups, totalDailyKrw };
    });
  }, [positionsByOwner, usdKrw, eurKrw]);

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

  // 시세 로드 완료 후 오늘 스냅샷 자동 저장 (하루 1회 로컬 + 서버)
  useEffect(() => {
    if (!isHydrated) return;
    const hasRealPrices = positionsByOwner.some((g) => g.sectionTotal > 0);
    if (!hasRealPrices) return;
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

    // 서버 저장: KST 16시(오후 4시) 이후에만 push
    // → 한국 장 마감(15:30) 후 종가 기준으로 저장해 일별 비교가 정확해짐
    // → 미국 장 시작(22:30 KST) 전이라 전일 미국 종가 기준도 충족
    try {
      const key = window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "";
      const nowKstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
      const isAfterKoreanClose = nowKstHour >= 16; // KST 16:00 이후
      if (key.length >= 8 && isAfterKoreanClose) {
        const pushedDate = window.localStorage.getItem(SNAPSHOT_PUSHED_DATE_KEY) ?? "";
        const pushedTotal = Number(window.localStorage.getItem(SNAPSHOT_PUSHED_TOTAL_KEY) ?? "0");
        // 오늘 이미 push했더라도 1% 이상 차이 나면 재전송 (현금 추가/삭제 반영)
        const valueDiff = pushedTotal > 0 ? Math.abs(totalValue - pushedTotal) / pushedTotal : 1;
        if (pushedDate !== today || valueDiff >= 0.01) {
          void fetch("/api/snapshot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sync_key: key,
              date: today,
              ownerValues,
              breakdownValues,
              totalValue,
            }),
          }).then((r) => {
            if (r.ok) {
              safeSetItem(SNAPSHOT_PUSHED_DATE_KEY, today);
              safeSetItem(SNAPSHOT_PUSHED_TOTAL_KEY, String(totalValue));
            }
          }).catch(() => {});
        }
      }
    } catch {}
  }, [positionsByOwner, isHydrated]);

  /** pull → 있으면 반영, 없으면 이 기기(pos/cash/정렬)를 push (최초 기기·키 저장 직후 공통) */
  const syncWithServerForKey = useCallback(
    async (
      key: string,
      pos: Position[],
      cash: CashByOwner,
      holdingsSort: Record<OwnerName, HoldingsSortMode>,
      sellLogByOwner: Record<string, SellLogEntry[]>,
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
        owner_names?: unknown;
        target_stock_weight_by_owner?: unknown;
        owner_scratchpad_by_owner?: unknown;
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
        if (
          forcePull ||
          (!hasLocalChanges &&
            (isServerSnapshotNewerThanLocal(serverTs, lastSyncTs) ||
              (lastSyncTs.length > 0 && cacheMissing)))
        ) {
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
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
          setLastSyncedAt(clockToStore);
          setLastSellLogSyncedAt(clockToStore);
          setSellLogDirty(false);
          mergeAndPersistTargetStockWeightsFromServer(j.target_stock_weight_by_owner);
          mergeAndPersistOwnerScratchpadsFromServer(j.owner_scratchpad_by_owner);
        } else if (hasLocalChanges) {
          // ─ 로컬에 미반영 변경이 있음 → 서버 타임스탬프와 무관하게 로컬을 서버에 올림
          // (서버가 더 최신이더라도 사용자가 방금 입력한 데이터를 잃지 않는 것이 우선)
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
              ownerNames: owners,
              targetStockWeightByOwner: loadAllTargetStockWeights(),
              ownerScratchpadByOwner: loadAllOwnerScratchpads(),
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
            window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
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
        // ─ 서버에 데이터 없음 → 이 기기 내용을 처음 올림
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
            ownerNames: owners,
            targetStockWeightByOwner: loadAllTargetStockWeights(),
            ownerScratchpadByOwner: loadAllOwnerScratchpads(),
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
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
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
    skipMarkLocalChangedRef.current = 2; // 디스크→state 재적용은 "수정"이 아님
    skipSellLogLocalChangedRef.current = 1;
    skipOwnerLocalChangedRef.current = 1; // 초기 로드 시 ownerNames 효과가 로컬 변경으로 오인되는 것을 방지
    setPositions(pos);
    setCashByOwner(cash);
    setSellLog(log);
    const savedKey = typeof window !== "undefined" ? window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "" : "";
    const savedSellLogSyncTs =
      typeof window !== "undefined" ? window.localStorage.getItem(LAST_SELL_LOG_SYNC_TS_KEY) ?? "" : "";
    const savedSellLogDirty =
      typeof window !== "undefined" ? window.localStorage.getItem(SELL_LOG_DIRTY_KEY) === "1" : false;
    setCloudSyncKey(savedKey);
    setSyncKeyDraft(savedKey);
    setLastSellLogSyncedAt(savedSellLogSyncTs.trim() || null);
    setSellLogDirty(savedSellLogDirty);
    const storedAuto = typeof window !== "undefined" ? window.localStorage.getItem(AUTO_SYNC_STORAGE) : null;
    const auto = storedAuto !== "0"; // 명시적으로 끈 경우(0)만 false, 나머지는 기본 true
    setAutoSync(auto);
    const holdSort = loadHoldingsSort();
    setHoldingsSortByOwner(holdSort);
    setIsHydrated(true);

    if (savedKey.length < 8) {
      setSyncReady(true);
      return;
    }

    void (async () => {
      await syncWithServerForKey(savedKey, pos, cash, holdSort, log, loadOwnerNames());
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
      safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
    }
  }, [positions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(CASH_STORAGE_KEY, JSON.stringify(cashByOwner));
    if (skipMarkLocalChangedRef.current > 0) {
      skipMarkLocalChangedRef.current -= 1;
    } else {
      safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
    }
  }, [cashByOwner, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(SELL_LOG_KEY, JSON.stringify(sellLog));
    if (skipSellLogLocalChangedRef.current > 0) {
      skipSellLogLocalChangedRef.current -= 1;
    } else {
      safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
      safeSetItem(SELL_LOG_DIRTY_KEY, "1");
      setSellLogDirty(true);
    }
  }, [sellLog, isHydrated]);

  // 초기 로드 시 로컬 스냅샷 읽기 + 동기화 키가 있으면 서버 스냅샷도 병합
  useEffect(() => {
    if (!isHydrated) return;
    const local = loadDailySnapshots();
    setDailySnapshots(local);

    const key = (() => {
      try { return window.localStorage.getItem(SYNC_KEY_STORAGE) ?? ""; } catch { return ""; }
    })();
    if (key.length < 8) return;

    void fetch(`/api/snapshot?sync_key=${encodeURIComponent(key)}&days=180`)
      .then((r) => r.ok ? r.json() : null)
      .then((json: { snapshots?: DailySnapshot[] } | null) => {
        if (!json?.snapshots?.length) return;
        // 서버 스냅샷과 로컬 스냅샷 병합
        // ★ 경쟁 조건 방지: 서버 응답이 올 때 최신 localStorage를 다시 읽어서 병합합니다.
        //   (effect 시작 이후 saveDailySnapshot으로 새로 저장된 데이터를 포함시키기 위함)
        const freshLocal = loadDailySnapshots();
        const localMap = new Map(freshLocal.map((s) => [s.date, s]));
        for (const s of json.snapshots) {
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

          // LWW: updated_at(서버) vs savedAt(로컬). 베이스에 없는 owner는 상대에서 보충.
          const serverTs = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
          const localTs = existing?.savedAt ?? 0;
          const serverIsNewer = serverTs > 0 && serverTs >= localTs;

          if (localLooksValid && !serverLooksEmpty) {
            const base = serverIsNewer ? s : existing!;
            const other = serverIsNewer ? existing! : s;
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
            localMap.set(s.date, {
              ...base,
              ownerValues: mergedOwnerValues,
              breakdownValues: Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
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
  }, [isHydrated]);

  useEffect(() => {
    if (!isHydrated || !syncReady || !autoSync || cloudSyncKey.length < 8) return;
    // 로컬 변경이 없으면 불필요한 push를 생략 — Pull 직후 state가 바뀌어도 push 안 함
    if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
    if (pushDebounceRef.current) clearTimeout(pushDebounceRef.current);
    pushDebounceRef.current = setTimeout(() => {
      // debounce 후 다시 확인 (그 사이 pull이 들어왔을 수 있음)
      if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
      void fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key: cloudSyncKey,
          positions,
          cashByOwner,
          holdingsSortByOwner,
          sellLogByOwner: sellLog,
          ownerNames,
          targetStockWeightByOwner: loadAllTargetStockWeights(),
          ownerScratchpadByOwner: loadAllOwnerScratchpads(),
        }),
      }).then(async (r) => {
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
          const pushedTs = j.updated_at ?? new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
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
  }, [positions, cashByOwner, holdingsSortByOwner, sellLog, ownerNames, isHydrated, syncReady, autoSync, cloudSyncKey]);

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
        owner_names?: unknown;
        target_stock_weight_by_owner?: unknown;
        owner_scratchpad_by_owner?: unknown;
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
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
        }
        setSyncMessage("서버에서 불러왔습니다.");
        setLastSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
        setLastSellLogSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
        setSellLogDirty(false);
        mergeAndPersistTargetStockWeightsFromServer(j.target_stock_weight_by_owner);
        mergeAndPersistOwnerScratchpadsFromServer(j.owner_scratchpad_by_owner);
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
          ownerNames,
          targetStockWeightByOwner: loadAllTargetStockWeights(),
          ownerScratchpadByOwner: loadAllOwnerScratchpads(),
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
        window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
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

  /** 서버(Supabase)에 저장된 현재 스냅샷을 백업 테이블에 복사합니다. 메인 portfolio_snapshots는 변경하지 않습니다. */
  async function handleBackupSnapshot() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    const ok = window.confirm(
      [
        "지금 서버(Supabase)에 올라가 있는 잔고를 백업 테이블에 한 번 더 복사합니다.",
        "",
        "이 기기에서만 수정하고 아직 서버로 반영되지 않은 종목·현금·보유자 변경은 백업에 포함되지 않습니다. 먼저 「서버로 올리기」 또는 자동 저장이 끝난 뒤 누르세요.",
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
        body: JSON.stringify({ sync_key: key }),
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
        "① 먼저 지금 서버에 올라가 있는 잔고를 백업 테이블에 한 줄 추가하고,",
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
        body: JSON.stringify({ sync_key: key }),
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
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "복원(서버 반영)에 실패했습니다.");
        return;
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
    /** 이전에 유효 키가 없었던 상태(저장소 삭제 직후 등)에서 첫 저장: 기본 샘플 state가 로컬 변경으로 찍혀 push가 나가 서버를 덮는 것을 막기 위해 항상 pull */
    const isFirstValidKeySave = prevKey.length < 8 && k.length >= 8;
    if (isKeyChange) {
      // 키가 바뀌는 경우: 로컬 변경 플래그·타임스탬프를 초기화해 새 키의 서버 데이터를 항상 pull
      window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
      window.localStorage.removeItem(LAST_SYNC_TS_KEY);
    } else if (isFirstValidKeySave) {
      window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
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
      ownerNames,
      isKeyChange || isFirstValidKeySave,
    );
  }

  // 알림 설정 불러오기 (동기화 키가 준비되면 한 번)
  useEffect(() => {
    if (!syncReady || !cloudSyncKey || alertLoaded) return;
    setAlertLoaded(true);
    void (async () => {
      try {
        const r = await fetch(`/api/alert/config?sync_key=${encodeURIComponent(cloudSyncKey)}`);
        if (!r.ok) return;
        const j = (await r.json()) as { found?: boolean; email?: string; rules?: AlertRule[] };
        if (j.found) {
          setAlertEmail(j.email ?? "");
          setAlertRules(
            (j.rules ?? []).map((rule) => ({
              owner: rule.owner ?? "전체",
              symbol: rule.symbol ?? "전체",
              minPct: rule.minPct != null ? String(rule.minPct) : "",
              maxPct: rule.maxPct != null ? String(rule.maxPct) : "",
            })),
          );
        }
      } catch {
        // 네트워크 오류는 조용히 무시
      }
    })();
  }, [syncReady, cloudSyncKey, alertLoaded]);

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

  async function handleSaveAlertConfig() {
    if (!cloudSyncKey || cloudSyncKey.length < 8) {
      setAlertMessage("먼저 동기화 키를 저장해 주세요.");
      return;
    }
    if (!alertEmail.includes("@")) {
      setAlertMessage("유효한 이메일을 입력하세요.");
      return;
    }
    setAlertBusy(true);
    try {
      const rules = alertRules
        .filter((r) => r.owner && r.symbol)
        .map((r) => ({
          owner: r.owner,
          symbol: r.symbol,
          ...(r.minPct !== "" ? { minPct: Number(r.minPct) } : {}),
          ...(r.maxPct !== "" ? { maxPct: Number(r.maxPct) } : {}),
        }));
      const res = await fetch("/api/alert/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: cloudSyncKey, email: alertEmail, rules }),
      });
      const j = (await res.json()) as { error?: string };
      setAlertMessage(res.ok ? "알림 설정을 저장했습니다." : (j.error ?? "저장 실패"));
    } catch {
      setAlertMessage("네트워크 오류입니다.");
    } finally {
      setAlertBusy(false);
    }
  }

  async function handleCheckAlertNow() {
    if (!cloudSyncKey || cloudSyncKey.length < 8) {
      setAlertMessage("먼저 동기화 키를 저장해 주세요.");
      return;
    }
    setAlertBusy(true);
    try {
      const res = await fetch("/api/alert/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: cloudSyncKey }),
      });
      const j = (await res.json()) as { results?: { violations: number; sent: boolean }[]; error?: string };
      if (!res.ok) {
        setAlertMessage(j.error ?? "확인 실패");
        return;
      }
      const r = j.results?.[0];
      if (!r) {
        setAlertMessage("저장된 알림 규칙이 없습니다.");
      } else if (r.violations === 0) {
        setAlertMessage("현재 이탈 종목 없음 — 모든 비중이 정상 범위입니다.");
      } else {
        setAlertMessage(
          `${r.violations}건 이탈 감지${r.sent ? " — 이메일을 발송했습니다." : " — 이메일 발송 실패(RESEND_API_KEY 확인)"}`,
        );
      }
    } catch {
      setAlertMessage("네트워크 오류입니다.");
    } finally {
      setAlertBusy(false);
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

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const savedScrollY = window.scrollY;

    const quantity = Number(form.quantity);
    const avgPrice = Number(form.avgPrice);

    if (!form.symbol.trim() || !form.name.trim()) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return;

    const purchaseUsdKrwNum = Number(form.purchaseUsdKrw);
    const purchaseEurKrwNum = Number(form.purchaseEurKrw);
    if (form.currency === "USD") {
      if (!Number.isFinite(purchaseUsdKrwNum) || purchaseUsdKrwNum <= 0) return;
    }
    if (form.currency === "EUR") {
      if (!Number.isFinite(purchaseEurKrwNum) || purchaseEurKrwNum <= 0) return;
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

    const base: Omit<Position, "owner"> = {
      symbol,
      name: nameTrimmed,
      quantity,
      avgPrice,
      currentPrice: avgPrice,
      currency: form.currency,
      accountType,
      accountName,
      ...(form.currency === "USD" ? { purchaseUsdKrw: purchaseUsdKrwNum } : {}),
      ...(form.currency === "EUR" ? { purchaseEurKrw: purchaseEurKrwNum } : {}),
    };

    setPositions((prev) => {
      let acc = prev;
      for (const owner of ownersOrdered) {
        const nextEntry: Position = { ...base, owner };
        acc = applyPositionUpsert(acc, nextEntry);
      }
      return acc;
    });

    setForm({
      symbol: "",
      name: "",
      quantity: "",
      avgPrice: "",
      purchaseUsdKrw: "",
      purchaseEurKrw: "",
      currency: form.currency,
      accountType,
      selectedOwners: form.selectedOwners,
    });

    showActionSuccessToast("종목이 정상적으로 반영되었습니다.");

    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScrollY, behavior: "instant" });
    });
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
          return { ...p, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a, purchaseUsdKrw: px };
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

  function handleAddOwner() {
    const next = window.prompt("추가할 보유자 이름을 입력하세요.");
    const name = next?.trim();
    if (!name) return;
    if (ownerNames.includes(name)) return;
    setOwnerNames((prev) => [...prev, name]);
    setCashByOwner((prev) => ({ ...prev, [name]: prev[name] ?? { usd: 0, krw: 0 } }));
    setHoldingsSortByOwner((prev) => ({ ...prev, [name]: prev[name] ?? "manual" }));
    safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
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
    setAlertRules((prev) => prev.map((r) => ({ ...r, owner: r.owner === name ? renamed : r.owner })));
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
    safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
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
    setAlertRules((prev) => prev.map((r) => ({ ...r, owner: r.owner === name ? "전체" : r.owner })));
    setSellLog((prev) => { const next = { ...prev }; delete next[name]; return next; });
    setSellLogForm((prev) => { const next = { ...prev }; delete next[name]; return next; });
    safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
  }

  const holdingsViewOwner = activeTopNav.startsWith("owner-")
    ? activeTopNav.slice("owner-".length)
    : null;
  const positionsByOwnerForTab = useMemo(() => {
    if (!holdingsViewOwner) return positionsByOwner;
    return positionsByOwner.filter((g) => g.ownerName === holdingsViewOwner);
  }, [holdingsViewOwner, positionsByOwner]);
  const ownerGroupDailySummaryForTab = useMemo(() => {
    if (!holdingsViewOwner) return ownerGroupDailySummary;
    return ownerGroupDailySummary.filter((o) => o.ownerName === holdingsViewOwner);
  }, [holdingsViewOwner, ownerGroupDailySummary]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeTopNav]);

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100">
      {actionSuccessToast ? (
        <div
          className="pointer-events-none fixed bottom-6 left-1/2 z-[60] max-w-[min(90vw,24rem)] -translate-x-1/2 rounded-lg border border-emerald-500/45 bg-emerald-950/95 px-4 py-2.5 text-center text-sm font-medium text-emerald-100 shadow-lg shadow-emerald-950/50"
          role="status"
          aria-live="polite"
        >
          {actionSuccessToast}
        </div>
      ) : null}
      <header className="sticky top-0 z-40 border-b border-slate-800/90 bg-[#0b1220]">
        <div className="mx-auto max-w-[1600px] px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="flex items-center gap-2 text-base font-bold tracking-tight sm:text-lg">
              <span aria-hidden>📈</span>
              주식 대시보드
            </h1>
            <span className="rounded-md bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-200 ring-1 ring-rose-500/25 sm:text-[11px]">
              로컬
            </span>
            <span className="hidden text-[11px] text-slate-500 sm:inline">
              USD/KRW {usdKrw.toLocaleString()} · EUR/KRW {eurKrw.toLocaleString()}
            </span>
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
                    activeTopNav === "section-holdings" || activeTopNav.startsWith("owner-")
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
                  { id: "section-alert" as const, icon: "🔔", label: "이메일 알림" },
                  { id: "section-data" as const, icon: "📊", label: "데이터 분석" },
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
            <header
              id="section-dashboard-top"
              className="rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-3 sm:px-4"
            >
              <p className="text-sm font-bold tabular-nums text-white sm:text-base">
                가족(담당자)별·계좌별 자산과 종목별 수익률을 한눈에 확인합니다.
              </p>
              <p className="mt-0.5 text-[10px] font-medium text-slate-500 sm:text-[11px]">
                환율 USD/KRW: {usdKrw.toLocaleString()} · EUR/KRW: {eurKrw.toLocaleString()} · 시세 갱신:{" "}
                {marketQuery.data?.fetchedAt
                  ? new Date(marketQuery.data.fetchedAt).toLocaleTimeString()
                  : "대기 중"}
              </p>
            </header>

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  { key: "appr", label: "총 평가금액", sub: "실시간", value: `₩${Math.round(kisMetrics.totalAppraisal).toLocaleString()}` },
                  { key: "dep", label: "예수금(현금)", sub: "USD·KRW 합산", value: `₩${Math.round(kisMetrics.deposit).toLocaleString()}` },
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
          </div>

          <section className="space-y-4">
            <h2 className="font-semibold">포트폴리오 비중 (가족·퇴직연금)</h2>
            <p className="text-xs text-muted-foreground">
              왼쪽 트리맵은 비중(%)·당일 등락, 오른쪽은 종목별 목표 비중(%)과 달성 여부입니다. 「목표 비중 저장」으로 이
              브라우저와 서버(동기화 키가 맞는 경우)에 둘 다 남깁니다. 다른 PC에서는 먼저 『서버에서 불러오기』하세요.
            </p>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {allocationByOwner.map(({ ownerName, data, total }) => (
                <FamilyAllocationDonut
                  key={ownerName}
                  ownerName={ownerName}
                  data={data}
                  total={total}
                  watchlistEntries={watchlistRows.filter(
                    (row) =>
                      !!row.symbol?.trim() &&
                      (!row.owners ||
                        row.owners.length === 0 ||
                        row.owners.includes(WATCHLIST_OWNER_ALL) ||
                        row.owners.includes(ownerName)),
                  )}
                  cloudSyncKey={cloudSyncKey}
                />
              ))}
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
          {/* 일별 자산 추이 — 총 평가금액 추이 */}
          <section id="section-trend" className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 text-base font-semibold text-slate-100 sm:text-lg">
              총 평가금액 추이
            </h2>
            <p className="mb-1 text-[10px] text-slate-500 sm:text-xs">
              (일별 자산 추이) 앱·서버에 저장된 날만 쌓입니다(최대 180일). 동기화 키로 서버 누적도 불러옵니다.
            </p>
            <div className="mt-2 min-h-[200px] rounded-md border border-slate-700/50 bg-slate-900/30 p-1">
            <DailyTrendChart snapshots={dailySnapshots} ownerNames={ownerNames} liveChangeByDate={dailyLiveChangeByDate} />
            </div>
          </section>
          <DailyChangeCalendar snapshots={dailySnapshots} liveChangeByDate={dailyLiveChangeByDate} />

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
          <div
            className={cn(
              activeTopNav === "section-data" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-data"}
          >
          <LiquiditySection
            isLoading={liquidityHistoryQuery.isLoading}
            isError={!!liquidityHistoryQuery.error}
            rows={liquidityHistoryQuery.data?.rows ?? []}
            fedLoading={fedBriefQuery.isLoading}
            fedSummary={fedBriefQuery.data?.ok === true ? fedBriefQuery.data.summary : null}
            fedReportDate={fedBriefQuery.data?.ok === true ? fedBriefQuery.data.reportDate ?? null : null}
            fedNote={fedNote}
            themesLoading={themesBriefQuery.isLoading}
            themesSummary={themesBriefQuery.data?.ok === true ? themesBriefQuery.data.summary : null}
            themesReportDate={themesBriefQuery.data?.ok === true ? themesBriefQuery.data.reportDate ?? null : null}
            themesNote={themesNote}
          />
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
            />
          </section>

          <div
            className={cn(
              activeTopNav === "section-holdings" || activeTopNav.startsWith("owner-")
                ? "block"
                : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={
              !(activeTopNav === "section-holdings" || activeTopNav.startsWith("owner-"))
            }
          >
          <div id="section-holdings" className="flex flex-col gap-4 xl:flex-row xl:items-start">
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
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        입력 순은 ▲▼로 저장됩니다. 다른 정렬일 때는 순서 변경이 비활성화됩니다. 표는
                        차트 그룹(미입력 시 티커)별로 묶여 보입니다.
                      </p>
                    </div>
                    <div className="max-w-md space-y-1 text-right text-sm">
                      <p className="text-xs text-muted-foreground">
                        총 매입{" "}
                        <span className="font-medium tabular-nums text-foreground">
                          ₩{Math.round(group.sectionCostBasis).toLocaleString()}
                        </span>
                        <span className="hidden sm:inline">
                          {" "}
                          (주식 원가 ₩{Math.round(group.sectionStockCost).toLocaleString()} · 현금 ₩
                          {Math.round(group.sectionCashKrw).toLocaleString()})
                        </span>
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-foreground">
                        ≈ {formatKrwApproxAsUsd(group.sectionTotal, usdKrw)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">(USD)</span>
                      </p>
                      <p className="font-semibold tabular-nums">
                        총 평가(주식+현금) ₩{Math.round(group.sectionTotal).toLocaleString()}
                      </p>
                      <p
                        className={`text-sm font-semibold tabular-nums ${
                          group.sectionPnL >= 0 ? "text-red-600" : "text-blue-600"
                        }`}
                      >
                        평가손익 {group.sectionPnL >= 0 ? "+" : ""}₩
                        {Math.round(group.sectionPnL).toLocaleString()} (
                        {group.sectionPnL >= 0 ? "+" : ""}
                        {group.sectionPnLPct.toFixed(2)}%)
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        주식 평가 ₩{Math.round(group.sectionStockValue).toLocaleString()}
                        <span className="hidden sm:inline">
                          {" "}
                          · 현금 ₩{Math.round(group.sectionCashKrw).toLocaleString()} (USD{" "}
                          {group.cashUsd.toLocaleString()} / KRW {group.cashKrw.toLocaleString()})
                        </span>
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-3 border-b bg-muted/10 px-4 py-2 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">현금</span>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-muted-foreground">USD</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className="w-28 rounded-md border bg-background px-2 py-1.5 text-right"
                        placeholder="0"
                        value={group.cashUsd === 0 ? "" : group.cashUsd}
                        onChange={(e) =>
                          setCashByOwner((prev) => ({
                            ...prev,
                            [group.ownerName]: {
                              ...prev[group.ownerName],
                              usd: e.target.value === "" ? 0 : Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-muted-foreground">KRW</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        className="w-32 rounded-md border bg-background px-2 py-1.5 text-right"
                        placeholder="0"
                        value={group.cashKrw}
                        onChange={(e) =>
                          setCashByOwner((prev) => ({
                            ...prev,
                            [group.ownerName]: {
                              ...prev[group.ownerName],
                              krw: Number.isFinite(Number(e.target.value))
                                ? Number(e.target.value)
                                : 0,
                            },
                          }))
                        }
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
                            colSpan={10}
                            className="px-3 py-4 text-center text-xs text-muted-foreground"
                          >
                            등록된 종목이 없습니다.
                          </TableCell>
                        </TableRow>
                      ) : (
                        holdingsGroupBlocks.map((block) => {
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
                              <TableCell colSpan={10} className="px-0 py-0">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-l-4 border-primary/70 bg-primary/[0.07] px-3 py-2">
                                  <span className="text-base font-bold tracking-wide text-foreground">
                                    {block.label}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    {/* 오늘 등락 */}
                                    {hasChange && (
                                      <span className={`text-xs tabular-nums font-semibold ${groupDailyChangeKrw > 0 ? "text-red-400" : groupDailyChangeKrw < 0 ? "text-blue-400" : "text-muted-foreground"}`}>
                                        오늘 {groupDailyChangeKrw > 0 ? "+" : ""}
                                        {Math.round(groupDailyChangeKrw).toLocaleString()}원
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
                                        {Math.round(groupTotalPnlKrw).toLocaleString()}원
                                        <span className="ml-0.5 opacity-80">
                                          ({groupTotalPnlPct > 0 ? "+" : ""}{groupTotalPnlPct.toFixed(2)}%)
                                        </span>
                                      </span>
                                    )}
                                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums font-medium text-muted-foreground">
                                      합계 ₩{Math.round(block.sumKrw).toLocaleString()}
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
                        <TableRow key={rowKey} className="group/row">
                          <TableCell className="px-3 py-1.5">
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
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right align-top">
                            <p className="text-[16px] font-semibold tabular-nums leading-none">
                              ₩{Math.round(position.valueKrw).toLocaleString()}
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
                              krwLine={
                                position.currency === "USD"
                                  ? `₩${Math.round(
                                      position.currentPrice * usdKrw,
                                    ).toLocaleString()}`
                                  : position.currency === "EUR"
                                    ? `₩${Math.round(
                                        position.currentPrice * eurKrw,
                                      ).toLocaleString()}`
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
                          <TableCell
                            className={`px-3 py-1.5 text-right font-semibold ${
                              position.pnl >= 0 ? "text-red-500" : "text-blue-500"
                            }`}
                          >
                            {(position.currency === "USD" || position.currency === "EUR") &&
                            position.pnlKrwEquityPct != null &&
                            (position.currency === "USD"
                              ? position.pnlUsdPct != null
                              : position.pnlEurPct != null) ? (
                              <div className="flex flex-col items-end gap-0.5 leading-tight">
                                <span>
                                  {position.currency === "USD" ? "USD" : "EUR"}{" "}
                                  {(position.currency === "USD"
                                    ? position.pnlUsdPct!
                                    : position.pnlEurPct!) >= 0
                                    ? "+"
                                    : ""}
                                  {(position.currency === "USD"
                                    ? position.pnlUsdPct!
                                    : position.pnlEurPct!
                                  ).toFixed(2)}
                                  %
                                </span>
                                <span className="text-xs font-normal opacity-90">
                                  원화 {position.pnlKrwEquityPct >= 0 ? "+" : ""}
                                  {position.pnlKrwEquityPct.toFixed(2)}%
                                </span>
                                <span className="text-xs font-normal opacity-75">
                                  {position.valueKrw - position.costKrw >= 0 ? "+" : ""}₩
                                  {Math.round(position.valueKrw - position.costKrw).toLocaleString()}
                                </span>
                              </div>
                            ) : (
                              <div className="flex flex-col items-end gap-0.5 leading-tight">
                                <span>
                                  {position.pnl >= 0 ? "+" : ""}
                                  {position.pnl.toFixed(2)}%
                                </span>
                                <span className="text-xs font-normal opacity-75">
                                  {position.valueKrw - position.costKrw >= 0 ? "+" : ""}₩
                                  {Math.round(position.valueKrw - position.costKrw).toLocaleString()}
                                </span>
                              </div>
                            )}
                          </TableCell>
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
                                {position.avgPrice.toLocaleString()} {position.currency}
                                <p className="text-xs text-muted-foreground">
                                  {position.currency === "USD" || position.currency === "EUR" ? (
                                    <>
                                      원화(매입환율): ₩
                                      {Math.round(
                                        position.avgPrice * position.purchaseFxUsed,
                                      ).toLocaleString()}
                                    </>
                                  ) : (
                                    <>
                                      원화: ₩
                                      {Math.round(position.avgPrice).toLocaleString()}
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
                                  <span>
                                    {position.purchaseUsdKrw != null
                                      ? `${position.purchaseUsdKrw.toLocaleString()} ₩/$`
                                      : `${usdKrw.toLocaleString()} ₩/$`}
                                  </span>
                                  {position.purchaseUsdKrw == null ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      미입력·현재환율 추정
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
                                      ? `${position.purchaseEurKrw.toLocaleString()} ₩/EUR`
                                      : `${eurKrw.toLocaleString()} ₩/EUR`}
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
                              <div className="flex flex-col gap-1">
                                <button
                                  type="button"
                                  className="cursor-pointer rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95"
                                  onClick={saveEditRow}
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
                                  onClick={() => handleDeleteRow(rowIndex)}
                                >
                                  삭제
                                </button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                              );
                            })}
                          </Fragment>
                        );
                        })
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
                      setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "" }));
                      const sell = Number(form.sellPrice);
                      if (!form.symbol) return;
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
                        const avg = Number(form.avgPrice);
                        const fx = Number(form.fxRate) || 1;
                        if (!Number.isFinite(qty) || qty <= 0) return;
                        if (!Number.isFinite(avg) || avg <= 0) return;
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
                              누적 실현손익: {totalRealized >= 0 ? "+" : ""}₩{Math.round(totalRealized).toLocaleString()}
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
                                      <td className="py-1 pr-2 text-right tabular-nums">₩{Math.round(s.costKrw).toLocaleString()}</td>
                                      <td className={`py-1 pr-2 text-right tabular-nums font-semibold ${s.realizedKrw > 0 ? "text-red-500" : s.realizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                        {s.realizedKrw >= 0 ? "+" : ""}₩{Math.round(s.realizedKrw).toLocaleString()}
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
                                    ₩{Math.round(symPnlList.reduce((s, x) => s + x.costKrw, 0)).toLocaleString()}
                                  </td>
                                  <td className={`py-1 pr-2 text-right tabular-nums ${totalRealized > 0 ? "text-red-500" : totalRealized < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                    {totalRealized >= 0 ? "+" : ""}₩{Math.round(totalRealized).toLocaleString()}
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
                              실현손익 예상: {previewRealizedTotal >= 0 ? "+" : ""}₩{Math.round(previewRealizedTotal).toLocaleString()}
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
                            <p className="col-span-2 text-[11px] font-medium text-destructive sm:col-span-4">
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
                                      {e.currency !== "KRW" ? `$${e.sellPrice}` : `₩${e.sellPrice.toLocaleString()}`}
                                    </td>
                                    <td className="py-1 pr-2 text-right tabular-nums">
                                      {e.currency !== "KRW" ? `$${e.avgPrice}` : `₩${e.avgPrice.toLocaleString()}`}
                                    </td>
                                    <td className={`py-1 pr-2 text-right tabular-nums font-semibold ${e.realizedKrw > 0 ? "text-red-500" : e.realizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                      {e.realizedKrw >= 0 ? "+" : ""}₩{Math.round(e.realizedKrw).toLocaleString()}
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

          {/* 오늘 수익 요약 패널 */}
          <div className="shrink-0 overflow-hidden rounded-2xl border bg-card shadow-sm xl:w-56">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">오늘 수익 요약</h2>
            </div>
            <div className="divide-y">
              {ownerGroupDailySummaryForTab.map((owner) => (
                <div key={owner.ownerName} className="px-3 py-2.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-muted-foreground">{owner.ownerName}</p>
                    <p className={`text-[11px] font-bold tabular-nums ${owner.totalDailyKrw > 0 ? "text-red-400" : owner.totalDailyKrw < 0 ? "text-blue-400" : "text-muted-foreground"}`}>
                      {owner.totalDailyKrw > 0 ? "+" : ""}{Math.round(owner.totalDailyKrw).toLocaleString()}
                    </p>
                  </div>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {owner.groups.map((g) => (
                        <tr key={g.label} className="border-t border-border/40 first:border-0">
                          <td className="py-0.5 pr-1 text-muted-foreground truncate max-w-[80px]">{g.label}</td>
                          <td className={`py-0.5 text-right tabular-nums font-medium ${g.dailyChangeKrw > 0 ? "text-red-400" : g.dailyChangeKrw < 0 ? "text-blue-400" : "text-muted-foreground/50"}`}>
                            {g.dailyChangeKrw !== 0 ? `${g.dailyChangeKrw > 0 ? "+" : ""}${Math.round(g.dailyChangeKrw).toLocaleString()}` : "—"}
                          </td>
                          <td className={`py-0.5 pl-1 text-right tabular-nums ${g.dailyChangePct !== null && g.dailyChangeKrw !== 0 ? (g.dailyChangeKrw > 0 ? "text-red-400" : "text-blue-400") : "text-muted-foreground/40"}`}>
                            {g.dailyChangePct !== null && g.dailyChangeKrw !== 0
                              ? `${g.dailyChangePct > 0 ? "+" : ""}${g.dailyChangePct.toFixed(1)}%`
                              : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>

          </div>{/* flex wrapper end */}

          </div>

          <div
            className={cn(
              activeTopNav === "section-add" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-add"}
          >
          <section id="section-add" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-3 font-semibold">종목 추가</h2>
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
            <p className="mb-3 text-xs text-muted-foreground">
              담당자를 여러 명 선택하면 같은 티커·수량·평단으로 각각 한 줄씩 추가됩니다.
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
            </p>
            <form
              onSubmit={handleSubmit}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6"
            >
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="티커 (예: NVDA, 005930)"
                value={form.symbol}
                onChange={(e) => setForm((prev) => ({ ...prev, symbol: e.target.value }))}
                required
              />
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="종목명"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
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
                  required
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={`매입 USD/KRW (예: ${Math.round(usdKrw)})`}
                  value={form.purchaseUsdKrw}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, purchaseUsdKrw: e.target.value }))
                  }
                />
              ) : form.currency === "EUR" ? (
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  required
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={`매입 EUR/KRW (예: ${Math.round(eurKrw)})`}
                  value={form.purchaseEurKrw}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, purchaseEurKrw: e.target.value }))
                  }
                />
              ) : (
                <div />
              )}
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={form.currency}
                onChange={(e) => {
                  const c = e.target.value as "USD" | "EUR" | "KRW";
                  setForm((prev) => ({
                    ...prev,
                    currency: c,
                    accountType: c === "KRW" ? "국내주식" : "해외주식",
                    purchaseUsdKrw: c === "USD" ? prev.purchaseUsdKrw : "",
                    purchaseEurKrw: c === "EUR" ? prev.purchaseEurKrw : "",
                  }));
                }}
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="KRW">KRW</option>
              </select>
              <div className="col-span-2 flex flex-col gap-2 sm:col-span-3 md:col-span-6">
                <span className="text-[11px] font-medium text-muted-foreground">담당자 (복수 선택)</span>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                  {ownerNames.map((name) => (
                    <label
                      key={name}
                      className="flex cursor-pointer items-center gap-1.5 text-sm select-none"
                    >
                      <input
                        type="checkbox"
                        className="cursor-pointer accent-primary"
                        checked={form.selectedOwners.includes(name)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setForm((prev) => {
                            const next = checked
                              ? ownerNames.filter(
                                  (o) => prev.selectedOwners.includes(o) || o === name,
                                )
                              : prev.selectedOwners.filter((o) => o !== name);
                            if (next.length === 0) return prev;
                            return { ...prev, selectedOwners: next };
                          });
                        }}
                      />
                      {name}
                    </label>
                  ))}
                </div>
              </div>
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
                  className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95"
                >
                  추가
                </button>
              </div>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              현금(USD·KRW)은 아래 각 보유 종목 표 상단에서 입력합니다. 전체 현금
              합계(원화): ₩{Math.round(totalCashKrw).toLocaleString()}
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
            <h2 className="mb-2 font-semibold">실현손익 입력</h2>
            <p className="mb-3 text-xs text-muted-foreground">종목 추가 아래에서 보유자별 매도 기록을 입력합니다.</p>
            {(() => {
              const owner = sellLogOwnerForSection;
              const listViewOwner = sellLogListViewOwner;
              const listLog = sellLog[listViewOwner] ?? [];
              const log = sellLog[owner] ?? [];
              const totalRealized = log.reduce((s, e) => s + calcSellRealizedKrw(e), 0);
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
                const rk = calcSellRealizedKrw(e);
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
                (listByDate.get(d) ?? []).reduce((s, e) => s + calcSellRealizedKrw(e), 0);
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
                return entry.currency === "KRW" ? (sell - avg) * qty : (sell - avg) * qty * fx;
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
                  // 매도대금 현금 자동 반영
                  setCashByOwner((prev) => {
                    let next = { ...prev };
                    for (const [targetOwner, q] of reduceByOwner) {
                      const currentCash = next[targetOwner] ?? { usd: 0, krw: 0 };
                      const grossProceeds = q * sell;
                      if (form.currency === "KRW") {
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            krw: currentCash.krw + grossProceeds,
                          },
                        };
                      } else if (form.currency === "USD") {
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            usd: currentCash.usd + grossProceeds,
                          },
                        };
                      } else {
                        // EUR 현금 필드는 없어 원화로 환산 반영
                        const fxApplied = Number(form.fxRate) || eurKrw;
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            krw: currentCash.krw + grossProceeds * fxApplied,
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
                setForm2({
                  symbol: "", name: "", qty: "", sellPrice: "", avgPrice: "",
                  currency: "USD", fxRate: String(Math.round(usdKrw)),
                  note: "", selectedOwners: [owner], ownerOverrides: {}, editingId: null,
                });
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
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      보유자는 전부 표시됩니다(해당 티커를 안 갖고 있으면 &quot;· 미보유&quot;). 그 티커는 실제로 보유한 보유자만 저장됩니다.
                    </span>
                    <button
                      type="button"
                      className={`text-xs font-bold underline-offset-2 hover:underline ${totalRealized > 0 ? "text-red-500" : totalRealized < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                      onClick={() => setSellLogDetailOpenOwner(owner)}
                    >
                      누적 실현손익: {totalRealized >= 0 ? "+" : ""}₩{Math.round(totalRealized).toLocaleString()}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/20 p-2 text-xs sm:grid-cols-4">
                    <input type="date" className="rounded border bg-background px-1.5 py-1" value={form.date} onChange={(e) => setForm2({ date: e.target.value })} />
                    <select className="cursor-pointer rounded border bg-background px-1.5 py-1" value={form.symbol} onChange={(e) => handleTickerChange(e.target.value)}>
                      <option value="">티커 선택</option>
                      {ownerTickerOptions.map((opt) => <option key={opt.symbol} value={opt.symbol}>{opt.symbol}({opt.name})</option>)}
                    </select>
                    <select className="cursor-pointer rounded border bg-background px-1.5 py-1" value={form.currency} onChange={(e) => setForm2({ currency: e.target.value as "USD" | "EUR" | "KRW" })}>
                      <option value="USD">USD</option><option value="EUR">EUR</option><option value="KRW">KRW</option>
                    </select>
                    <div className="col-span-2 rounded border bg-muted/30 p-1.5 sm:col-span-4">
                      <p className="mb-1 text-[10px] text-muted-foreground">보유자</p>
                      <select
                        className="w-full rounded border bg-background px-1.5 py-1"
                        value={form.selectedOwners[0] ?? ""}
                        disabled={!selectedSymbol}
                        onChange={(e) => {
                          const nextOwner = e.target.value;
                          const match = positions.find((p) => p.owner === nextOwner && p.symbol === selectedSymbol);
                          const matchedFxRate =
                            form.currency === "KRW"
                              ? "1"
                              : form.currency === "EUR"
                                ? String(Math.round(match?.purchaseEurKrw ?? eurKrw))
                                : String(Math.round(match?.purchaseUsdKrw ?? usdKrw));
                          const patchOwnerKey = nextOwner || owner;
                          setSellLogOwnerForSection(nextOwner);
                          // 다른 보유자 슬롯에 병합할 때 종목·입력값이 빈 기본값만 잡혀 초기화되지 않도록 현재 폼을 함께 전달
                          setForm2(
                            {
                              symbol: form.symbol,
                              name: form.name,
                              date: form.date,
                              qty: form.qty,
                              sellPrice: form.sellPrice,
                              note: form.note,
                              currency: form.currency,
                              editingId: form.editingId,
                              selectedOwners: nextOwner ? [nextOwner] : [],
                              ownerOverrides: {},
                              avgPrice: match ? String(match.avgPrice) : form.avgPrice,
                              fxRate: matchedFxRate,
                            },
                            patchOwnerKey,
                          );
                        }}
                      >
                        <option value="">{selectedSymbol ? "보유자 선택" : "먼저 티커를 선택해 주세요."}</option>
                        {ownerNames.map((name) => {
                          const noHoldingForTicker =
                            Boolean(selectedSymbol) && !ownersWithTicker.includes(name);
                          return (
                            <option key={name} value={name}>
                              {name}
                              {noHoldingForTicker ? " · 미보유" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                    <input type="number" min="0" step="any" className="rounded border bg-background px-1.5 py-1 text-right sm:col-start-1" placeholder="수량" value={form.qty} onChange={(e) => setForm2({ qty: e.target.value })} />
                    <input type="number" min="0" step="any" className="rounded border bg-background px-1.5 py-1 text-right" placeholder="매도가" value={form.sellPrice} onChange={(e) => setForm2({ sellPrice: e.target.value })} />
                    <input type="number" min="0" step="any" className="rounded border bg-background px-1.5 py-1 text-right" placeholder="매수평단가" value={form.avgPrice} onChange={(e) => setForm2({ avgPrice: e.target.value })} />
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-muted-foreground">매입 환율(₩)</span>
                      <input type="number" min="0" step="1" className="rounded border bg-background px-1.5 py-1 text-right" placeholder="적용환율" value={form.fxRate} onChange={(e) => setForm2({ fxRate: e.target.value })} />
                    </label>
                    <input className="col-span-2 rounded border bg-background px-1.5 py-1 sm:col-span-3" placeholder="메모" value={form.note} onChange={(e) => setForm2({ note: e.target.value })} />
                    <button type="button" className="cursor-pointer rounded bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/90" onClick={handleSave}>
                      {form.editingId ? "수정 저장" : "+ 기록 추가"}
                    </button>
                    <div className="col-span-2 text-[11px] font-semibold sm:col-span-4">실현손익 예상: {preview >= 0 ? "+" : ""}₩{Math.round(preview).toLocaleString()}</div>
                    {sellLogErrorByOwner[owner] ? <p className="col-span-2 text-[11px] font-medium text-destructive sm:col-span-4">{sellLogErrorByOwner[owner]}</p> : null}
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
                                        {daySum >= 0 ? "+" : ""}₩{Math.round(daySum).toLocaleString()}
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
                                          ₩{Math.round(s.costKrw).toLocaleString()}
                                        </td>
                                        <td
                                          className={`py-1 pr-2 text-right tabular-nums font-semibold ${s.realizedKrw > 0 ? "text-red-500" : s.realizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                        >
                                          {s.realizedKrw >= 0 ? "+" : ""}₩
                                          {Math.round(s.realizedKrw).toLocaleString()}
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
                                          {dayTotal >= 0 ? "+" : ""}₩{Math.round(dayTotal).toLocaleString()}
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
                                        {Math.round(calcSellRealizedKrw(e)).toLocaleString()}
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
            />
          </section>
          </div>

          <div
            className={cn(
              activeTopNav === "section-alert" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-alert"}
          >
          {/* 알림 설정 섹션 */}
          <section id="section-alert" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">비중 이탈 이메일 알림</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              설정한 비중(%)을 벗어나면 매일 오전 9시(KST)에 이메일을 보내드립니다.
              동기화 키가 저장되어 있어야 합니다.
            </p>
            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground" htmlFor="alert-email">수신 이메일</label>
                <input
                  id="alert-email"
                  type="email"
                  className="max-w-xs rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="example@gmail.com"
                  value={alertEmail}
                  onChange={(e) => setAlertEmail(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">알림 규칙</p>
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all duration-100 hover:bg-muted active:scale-95"
                    onClick={() =>
                      setAlertRules((prev) => [
                        ...prev,
                        { owner: "전체", symbol: "전체", minPct: "", maxPct: "" },
                      ])
                    }
                  >
                    + 규칙 추가
                  </button>
                </div>
                {alertRules.length === 0 && (
                  <p className="text-xs text-muted-foreground">규칙이 없습니다. 위 버튼으로 추가하세요.</p>
                )}
                {alertRules.map((rule, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
                    <select
                      className="rounded border bg-background px-2 py-1 text-xs"
                      value={rule.owner}
                      onChange={(e) =>
                        setAlertRules((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, owner: e.target.value } : r)),
                        )
                      }
                    >
                      <option value="전체">전체</option>
                      {ownerNames.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <span className="text-xs text-muted-foreground">의</span>
                    <input
                      className="w-24 rounded border bg-background px-2 py-1 text-xs"
                      placeholder="종목 (예: NVDA)"
                      value={rule.symbol}
                      onChange={(e) =>
                        setAlertRules((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, symbol: e.target.value.toUpperCase() } : r,
                          ),
                        )
                      }
                    />
                    <span className="text-xs text-muted-foreground">비중이</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        className="w-16 rounded border bg-background px-2 py-1 text-xs text-right"
                        placeholder="최소%"
                        value={rule.minPct}
                        onChange={(e) =>
                          setAlertRules((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, minPct: e.target.value } : r)),
                          )
                        }
                      />
                      <span className="text-xs text-muted-foreground">~</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        className="w-16 rounded border bg-background px-2 py-1 text-xs text-right"
                        placeholder="최대%"
                        value={rule.maxPct}
                        onChange={(e) =>
                          setAlertRules((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, maxPct: e.target.value } : r)),
                          )
                        }
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">를 벗어나면 알림</span>
                    <button
                      type="button"
                      className="ml-auto rounded px-1.5 py-0.5 text-xs text-destructive transition-all hover:bg-destructive/10 active:scale-95"
                      onClick={() =>
                        setAlertRules((prev) => prev.filter((_, i) => i !== idx))
                      }
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={alertBusy}
                  onClick={handleSaveAlertConfig}
                >
                  알림 설정 저장
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-4 py-2 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                  disabled={alertBusy}
                  onClick={handleCheckAlertNow}
                >
                  지금 확인 (수동)
                </button>
              </div>
              {alertMessage && (
                <p className="text-xs text-muted-foreground">{alertMessage}</p>
              )}
              {alertBusy && <p className="text-xs text-amber-600">처리 중…</p>}
            </div>
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
              <p className="text-xs text-muted-foreground">
                「백업」은 서버에 올라간 잔고를 백업 테이블에 한 줄씩 추가합니다(최대 1년, 500건). 「백업 내려받기」는 먼저 백업을 저장한 뒤 JSON으로 다운로드. 「백업에서 복원」은 JSON을 업로드하면 <strong className="font-medium text-foreground">시점 목록이 표시되며 원하는 시점을 선택해 복원</strong>할 수 있습니다.
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
                        누적: {ownerTotal >= 0 ? "+" : ""}₩{Math.round(ownerTotal).toLocaleString()}
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
                                  {calcSellRealizedKrw(e) >= 0 ? "+" : ""}₩{Math.round(calcSellRealizedKrw(e)).toLocaleString()}
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
