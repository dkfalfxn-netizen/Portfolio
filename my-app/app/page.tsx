"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FamilyAllocationDonut } from "@/components/family-allocation-chart";
import { IntradaySparkline } from "@/components/intraday-sparkline";
import { LivePriceCell } from "@/components/live-price-cell";
import { DailyTrendChart } from "@/components/daily-trend-chart";
import { DailyChangeCalendar } from "@/components/daily-change-calendar";
import { RebalancingCalculator } from "@/components/rebalancing-calculator";
import { TechnicalSignalDetailModal } from "@/components/technical-signal-detail-modal";
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

const OWNER_NAMES = ["김승주", "강희진", "김도율", "김찬율", "퇴직연금"] as const;
type OwnerName = (typeof OWNER_NAMES)[number];

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

/** 로컬 저장 키 — v1에서 한 번만 마이그레이션 후 v2만 사용 */
const STORAGE_KEY = "portfolio_positions_v2";
const LEGACY_POSITIONS_STORAGE_KEY = "portfolio_positions_v1";
const CASH_STORAGE_KEY = "portfolio_cash_v1";
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
 * 사용자가 마지막 동기화 이후 로컬에서 데이터를 수정했으면 "1".
 * 페이지 로드·서버 Pull로 상태가 바뀔 때는 설정하지 않는다.
 */
const HAS_LOCAL_CHANGES_KEY = "portfolio_has_local_changes_v1";
/**
 * 오늘 서버에 push한 날짜 ("YYYY-MM-DD") 와 그때의 totalValue.
 * 날짜가 같아도 totalValue가 1% 이상 달라지면 재push해 현금 변경을 반영한다.
 */
const SNAPSHOT_PUSHED_DATE_KEY = "portfolio_snapshot_pushed_date_v1";
const SNAPSHOT_PUSHED_TOTAL_KEY = "portfolio_snapshot_pushed_total_v1";
/** 일별 스냅샷 최대 보관 일수 */
const SNAPSHOT_MAX_DAYS = 180;

export type DailySnapshot = {
  date: string; // YYYY-MM-DD
  ownerValues: Record<string, number>; // ownerName → 총 평가액(KRW)
  breakdownValues?: Record<string, number>; // "owner · group" 또는 "owner · 현금" → 평가액(KRW)
  totalValue: number;
};

type DailyLiveChange = {
  date: string;
  changeKrw: number;
  changePct: number | null;
  ownerChanges: Array<{ name: string; changeKrw: number; changePct: number | null }>;
  compareNote?: string;
};

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
    window.localStorage.setItem(DAILY_SNAPSHOTS_KEY, JSON.stringify(updated));
  } catch {}
}

function todayKST(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 보유 종목 표시 순: 입력 순(저장된 배열 순) / 평가금액 / 차트 그룹 */
type HoldingsSortMode = "manual" | "valueAsc" | "valueDesc" | "group";

function defaultHoldingsSort(): Record<OwnerName, HoldingsSortMode> {
  return {
    김승주: "manual",
    강희진: "manual",
    김도율: "manual",
    김찬율: "manual",
    퇴직연금: "manual",
  };
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
  const o = raw as Record<string, unknown>;
  for (const name of OWNER_NAMES) {
    const v = o[name];
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
  return typeof value === "string" && (OWNER_NAMES as readonly string[]).includes(value);
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
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
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
    for (const name of OWNER_NAMES) {
      if (obj[name] !== undefined) {
        next[name] = parseCashPair(obj[name]);
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_CASH_BY_OWNER };
  }
}

function normalizeCashFromServer(raw: unknown): CashByOwner {
  const base: CashByOwner = { ...DEFAULT_CASH_BY_OWNER };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  for (const name of OWNER_NAMES) {
    if (obj[name] !== undefined) {
      base[name] = parseCashPair(obj[name]);
    }
  }
  return base;
}

export default function Home() {
  const [positions, setPositions] = useState<Position[]>(DEFAULT_POSITIONS);
  const [cashByOwner, setCashByOwner] = useState<CashByOwner>(DEFAULT_CASH_BY_OWNER);
  const [isHydrated, setIsHydrated] = useState(false);
  const [dailySnapshots, setDailySnapshots] = useState<DailySnapshot[]>([]);
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

  const [cloudSyncKey, setCloudSyncKey] = useState("");
  const [syncKeyDraft, setSyncKeyDraft] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [syncReady, setSyncReady] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [serverHealth, setServerHealth] = useState<"loading" | "ok" | "error">("loading");
  const pushDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * positions/cash useEffect에서 HAS_LOCAL_CHANGES_KEY 설정을 건너뛸 횟수.
   * - 최초 하이드레이션(디스크→state 재적용)이나 서버 Pull 반영 시에는
   *   "사용자가 수정"한 것이 아니므로 로컬 변경 플래그를 올리지 않아야 한다.
   * - setPositions + setCashByOwner를 한 번 호출할 때마다 2를 설정.
   */
  const skipMarkLocalChangedRef = useRef(0);
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

  type WatchlistRow = { symbol: string; name: string };
  const [watchlistRows, setWatchlistRows] = useState<WatchlistRow[]>([]);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchlistMessage, setWatchlistMessage] = useState("");

  // 가상 매수 시뮬레이터 상태
  const [simForm, setSimForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    currency: "USD" as "USD" | "EUR" | "KRW",
    owner: "김승주" as OwnerName,
  });

  const [form, setForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    purchaseUsdKrw: "",
    purchaseEurKrw: "",
    currency: "USD" as "USD" | "EUR" | "KRW",
    accountType: "해외주식" as "해외주식" | "국내주식",
    accountName: "미국주식-주계좌",
    /** 종목 추가 시 한 번에 넣을 담당자(복수) */
    selectedOwners: ["김승주"] as OwnerName[],
  });

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
    refetchInterval: 10000,
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

  const usdKrw = marketQuery.data?.usdKrw ?? 1350;
  const eurKrw = marketQuery.data?.eurKrw ?? 1450;

  const totalCashKrw = useMemo(() => {
    return OWNER_NAMES.reduce((sum, owner) => {
      const c = cashByOwner[owner];
      return sum + c.krw + c.usd * usdKrw;
    }, 0);
  }, [cashByOwner, usdKrw]);

  const enrichedPositions = useMemo(() => {
    return positions.map((position) => {
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
      const pnl = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
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
      const costKrw = position.quantity * position.avgPrice * purchaseFx;
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
        label: "총 자산 (원화)",
        value: `₩${Math.round(totalValue).toLocaleString()}`,
        sub: `약 ${formatKrwApproxAsUsd(totalValue, usdKrw)} · 주식 ₩${Math.round(stockValue).toLocaleString()} · 현금 ₩${Math.round(totalCashKrw).toLocaleString()}`,
        change: "",
        positive: null as boolean | null,
      },
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

  const allocationByOwner = useMemo(() => {
    return OWNER_NAMES.map((ownerName) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);
      // chartGroup이 있으면 그룹명 기준, 없으면 symbol 기준으로 차트 슬라이스 합산
      const groupMap = new Map<string, {
        displayName: string;
        allEntries: { name: string; symbol: string }[];
        value: number;
      }>();
      for (const position of items) {
        const v = Math.max(0, Number.isFinite(position.valueKrw) ? position.valueKrw : 0);
        const groupKey = position.chartGroup?.trim() || position.symbol;
        const existing = groupMap.get(groupKey);
        if (existing) {
          existing.value += v;
          if (!existing.allEntries.some((e) => e.symbol === position.symbol && e.name === position.name)) {
            existing.allEntries.push({ name: position.name, symbol: position.symbol });
          }
        } else {
          groupMap.set(groupKey, {
            displayName: position.chartGroup?.trim() || position.name,
            allEntries: [{ name: position.name, symbol: position.symbol }],
            value: v,
          });
        }
      }
      const stockSlices = Array.from(groupMap.entries()).map(([groupKey, { displayName, allEntries, value }]) => ({
        name: `stk|${groupKey}|${ownerName}`,
        displayName,
        ticker: groupKey,
        allEntries,
        value,
      }));

      const c = cashByOwner[ownerName];
      const usd = Number.isFinite(c.usd) ? Math.max(0, c.usd) : 0;
      const krw = Number.isFinite(c.krw) ? Math.max(0, c.krw) : 0;
      const usdCashKrw = usd * usdKrw;
      const extra: { name: string; displayName: string; ticker: string; allEntries: { name: string; symbol: string }[]; value: number }[] = [];
      if (usdCashKrw > 0) {
        extra.push({
          name: `cash-usd|${ownerName}`,
          displayName: "USD 현금",
          ticker: "USD 현금",
          allEntries: [{ name: "USD 현금", symbol: "" }],
          value: usdCashKrw,
        });
      }
      if (krw > 0) {
        extra.push({
          name: `cash-krw|${ownerName}`,
          displayName: "KRW 현금",
          ticker: "KRW 현금",
          allEntries: [{ name: "KRW 현금", symbol: "" }],
          value: krw,
        });
      }
      const merged = [...stockSlices, ...extra];
      const total = merged.reduce((sum, item) => sum + item.value, 0);
      const data = merged.map((item) => ({
        ...item,
        weight: total > 0 ? (item.value / total) * 100 : 0,
      }));
      return { ownerName, data, total };
    });
  }, [enrichedPositions, cashByOwner, usdKrw]);

  const positionsByOwner = useMemo(() => {
    return OWNER_NAMES.map((ownerName) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);
      const sectionStockValue = items.reduce((sum, item) => sum + item.valueKrw, 0);
      const sectionStockCost = items.reduce((sum, item) => sum + item.costKrw, 0);
      const c = cashByOwner[ownerName];
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
  }, [enrichedPositions, cashByOwner, usdKrw]);

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
    const ownerChanges = ownerGroupDailySummary
      .flatMap((owner) => owner.groups.map((g) => ({
        name: `${owner.ownerName} · ${g.label}`,
        changeKrw: g.dailyChangeKrw,
        changePct: g.dailyChangePct,
      })))
      .sort((a, b) => Math.abs(b.changeKrw) - Math.abs(a.changeKrw));

    const totalChangeKrw = ownerGroupDailySummary.reduce((sum, owner) => sum + owner.totalDailyKrw, 0);
    const prevTotalKrw = positionsByOwner.reduce((sum, group) => {
      const prevStock = group.items.reduce((s, p) => {
        if (p.previousClose === null) return s;
        const v =
          p.currency === "USD" ? p.previousClose * p.quantity * usdKrw
          : p.currency === "EUR" ? p.previousClose * p.quantity * eurKrw
          : p.previousClose * p.quantity;
        return s + v;
      }, 0);
      return sum + prevStock + group.sectionCashKrw;
    }, 0);
    const totalChangePct = prevTotalKrw > 0 ? (totalChangeKrw / prevTotalKrw) * 100 : null;

    return {
      [date]: {
        date,
        changeKrw: totalChangeKrw,
        changePct: totalChangePct,
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
    const snap: DailySnapshot = { date: today, ownerValues, breakdownValues, totalValue };
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
              window.localStorage.setItem(SNAPSHOT_PUSHED_DATE_KEY, today);
              window.localStorage.setItem(SNAPSHOT_PUSHED_TOTAL_KEY, String(totalValue));
            }
          }).catch(() => {});
        }
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsByOwner, isHydrated]);

  /** pull → 있으면 반영, 없으면 이 기기(pos/cash/정렬)를 push (최초 기기·키 저장 직후 공통) */
  const syncWithServerForKey = useCallback(
    async (
      key: string,
      pos: Position[],
      cash: CashByOwner,
      holdingsSort: Record<OwnerName, HoldingsSortMode>,
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
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "동기화를 사용할 수 없습니다.");
        return;
      }
      if (j.found) {
        const serverTs = typeof j.updated_at === "string" ? j.updated_at : "";
        const lastSyncTs = window.localStorage.getItem(LAST_SYNC_TS_KEY) ?? "";
        const hasLocalChanges = window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) === "1";

        if (serverTs > lastSyncTs && !hasLocalChanges) {
          // ─ 서버가 더 최신이고 로컬 미반영 변경 없음 → 서버 데이터를 적용
          setSyncMessage("서버에서 최신 잔고를 불러왔습니다.");
          skipMarkLocalChangedRef.current = 2;
          const valid = Array.isArray(j.positions)
            ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
            : [];
          setPositions(mergeDuplicatePositions(valid));
          setCashByOwner(normalizeCashFromServer(j.cash_by_owner));
          setHoldingsSortByOwner(normalizeHoldingsSortFromServer(j.holdings_sort_by_owner));
          window.localStorage.setItem(LAST_SYNC_TS_KEY, serverTs);
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
          setLastSyncedAt(serverTs);
        } else if (hasLocalChanges && pos.length > 0) {
          // ─ 로컬에 미반영 변경이 있음 → 서버 타임스탬프와 무관하게 로컬을 서버에 올림
          // (서버가 더 최신이더라도 사용자가 방금 입력한 데이터를 잃지 않는 것이 우선)
          const rPush = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "push", key, positions: pos, cashByOwner: cash, holdingsSortByOwner: holdingsSort }),
          });
          const jPush = (await rPush.json()) as { ok?: boolean; updated_at?: string; error?: string };
          if (!rPush.ok) {
            setSyncMessage(jPush.error ?? "서버 업로드 실패");
          } else {
            const pushedTs = jPush.updated_at ?? new Date().toISOString();
            window.localStorage.setItem(LAST_SYNC_TS_KEY, pushedTs);
            window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
            setSyncMessage("이 기기의 변경 데이터를 서버에 올렸습니다.");
            setLastSyncedAt(pushedTs);
          }
        } else {
          // ─ 이미 동기화된 상태
          if (!lastSyncTs) {
            // 최초 연결 시 lastSyncTs 를 서버 기준으로 초기화
            window.localStorage.setItem(LAST_SYNC_TS_KEY, serverTs);
          }
          setSyncMessage("서버와 동기화 상태입니다.");
          setLastSyncedAt(serverTs || lastSyncTs);
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
          }),
        });
        const j2 = (await r2.json()) as { ok?: boolean; updated_at?: string; error?: string };
        if (!r2.ok) {
          setSyncMessage(j2.error ?? "서버 업로드 실패");
        } else {
          const pushedTs = j2.updated_at ?? new Date().toISOString();
          window.localStorage.setItem(LAST_SYNC_TS_KEY, pushedTs);
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
          setSyncMessage("서버에 기존 데이터가 없어 이 기기 내용을 올렸습니다.");
          setLastSyncedAt(pushedTs);
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
    skipMarkLocalChangedRef.current = 2; // 디스크→state 재적용은 "수정"이 아님
    setPositions(pos);
    setCashByOwner(cash);
    const savedKey = typeof window !== "undefined" ? window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "" : "";
    setCloudSyncKey(savedKey);
    setSyncKeyDraft(savedKey);
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
      await syncWithServerForKey(savedKey, pos, cash, holdSort);
      setSyncReady(true);
    })();
  }, [syncWithServerForKey]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(HOLDINGS_SORT_STORAGE_KEY, JSON.stringify(holdingsSortByOwner));
  }, [holdingsSortByOwner, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    if (skipMarkLocalChangedRef.current > 0) {
      skipMarkLocalChangedRef.current -= 1;
    } else {
      // 사용자가 직접 수정한 경우 → 다음 동기화 시 Push 유도
      window.localStorage.setItem(HAS_LOCAL_CHANGES_KEY, "1");
    }
  }, [positions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(CASH_STORAGE_KEY, JSON.stringify(cashByOwner));
    if (skipMarkLocalChangedRef.current > 0) {
      skipMarkLocalChangedRef.current -= 1;
    } else {
      window.localStorage.setItem(HAS_LOCAL_CHANGES_KEY, "1");
    }
  }, [cashByOwner, isHydrated]);

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
          // 서버 값이 비정상적으로 비어있을 때(totalValue<=0)는
          // 로컬에 유효 값이 있으면 로컬을 우선합니다.
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
          localMap.set(s.date, s);
        }
        const merged = [...localMap.values()].sort((a, b) => a.date.localeCompare(b.date));
        setDailySnapshots(merged);
        // 서버 스냅샷도 로컬에 캐시
        window.localStorage.setItem(DAILY_SNAPSHOTS_KEY, JSON.stringify(merged));
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
        }),
      }).then(async (r) => {
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
          const pushedTs = j.updated_at ?? new Date().toISOString();
          window.localStorage.setItem(LAST_SYNC_TS_KEY, pushedTs);
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
          setLastSyncedAt(pushedTs);
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
  }, [positions, cashByOwner, holdingsSortByOwner, isHydrated, syncReady, autoSync, cloudSyncKey]);

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
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "불러오기 실패");
        return;
      }
      if (j.found) {
        skipMarkLocalChangedRef.current = 2;
        const valid = Array.isArray(j.positions)
          ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
          : [];
        setPositions(mergeDuplicatePositions(valid));
        setCashByOwner(normalizeCashFromServer(j.cash_by_owner));
        setHoldingsSortByOwner(normalizeHoldingsSortFromServer(j.holdings_sort_by_owner));
        if (typeof j.updated_at === "string") {
          window.localStorage.setItem(LAST_SYNC_TS_KEY, j.updated_at);
          window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
        }
        setSyncMessage("서버에서 불러왔습니다.");
        setLastSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
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
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "업로드 실패");
      } else {
        const pushedTs = (j as { updated_at?: string }).updated_at ?? new Date().toISOString();
        window.localStorage.setItem(LAST_SYNC_TS_KEY, pushedTs);
        window.localStorage.removeItem(HAS_LOCAL_CHANGES_KEY);
        setSyncMessage("서버에 올렸습니다.");
        setLastSyncedAt(pushedTs);
      }
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
    window.localStorage.setItem(SYNC_KEY_STORAGE, k);
    setCloudSyncKey(k);
    setSyncMessage("키를 저장했습니다. 서버와 맞추는 중…");
    await syncWithServerForKey(k, positions, cashByOwner, holdingsSortByOwner);
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
        const j = (await r.json()) as { ok?: boolean; entries?: Array<{ symbol: string; name?: string }> };
        if (r.ok && j.entries && j.entries.length > 0) {
          setWatchlistRows(
            j.entries.map((e) => ({ symbol: e.symbol, name: e.name ?? "" })),
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

  // 가상 매수 시뮬레이션 계산
  const simResult = useMemo(() => {
    const qty = Number(simForm.quantity);
    const price = Number(simForm.avgPrice);
    if (!simForm.symbol || !qty || !price || qty <= 0 || price <= 0) return null;

    const simValueKrw =
      qty *
      price *
      (simForm.currency === "USD" ? usdKrw : simForm.currency === "EUR" ? eurKrw : 1);
    const ownerData = positionsByOwner.find((g) => g.ownerName === simForm.owner);
    if (!ownerData) return null;

    const beforeTotal = ownerData.sectionTotal;
    const afterTotal = beforeTotal + simValueKrw;

    const rows = ownerData.items.map((p) => {
      const beforePct = beforeTotal > 0 ? (p.valueKrw / beforeTotal) * 100 : 0;
      const afterPct = afterTotal > 0 ? (p.valueKrw / afterTotal) * 100 : 0;
      return { label: `${p.name} (${p.symbol})`, beforePct, afterPct, delta: afterPct - beforePct };
    });

    // 추가될 종목의 비중
    const newBeforePct = 0;
    const newAfterPct = afterTotal > 0 ? (simValueKrw / afterTotal) * 100 : 0;
    rows.push({
      label: `${simForm.symbol.toUpperCase()} (신규)`,
      beforePct: newBeforePct,
      afterPct: newAfterPct,
      delta: newAfterPct,
    });

    return { beforeTotal, afterTotal, simValueKrw, rows };
  }, [simForm, positionsByOwner, usdKrw, eurKrw]);

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

    const ownersOrdered = OWNER_NAMES.filter((o) => form.selectedOwners.includes(o));
    if (ownersOrdered.length === 0) return;

    const symbol = form.symbol.trim().toUpperCase();
    const accountType: "해외주식" | "국내주식" =
      form.currency === "KRW" ? "국내주식" : "해외주식";
    const accountName = form.accountName.trim() || "기본계좌";
    const base: Omit<Position, "owner"> = {
      symbol,
      name: form.name.trim(),
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
      accountName: form.accountName,
      selectedOwners: form.selectedOwners,
    });

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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex w-full gap-3 px-2 py-4 sm:gap-4 sm:py-6 md:px-4">
        <aside className="hidden w-48 shrink-0 md:block">
          <div className="sticky top-6 rounded-2xl border bg-card p-3 shadow-sm">
            <h2 className="mb-3 px-1 text-sm font-semibold">포트폴리오</h2>
            <nav className="space-y-0.5 text-sm">
              {([
                { id: "section-trend",     icon: "📈", label: "일별 자산 추이" },
                { id: "section-rebalance", icon: "⚖️", label: "리밸런싱 계산기" },
              ] as const).map(({ id, icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                >
                  <span className="leading-none">{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
              {/* 보유 종목 + 하위 메뉴 */}
              <button
                type="button"
                onClick={() => document.getElementById("section-holdings")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium transition-colors hover:bg-muted"
              >
                <span>📋</span>
                <span>보유 종목</span>
              </button>
              <div className="ml-4 space-y-0.5 border-l border-border/50 pl-2">
                {OWNER_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => document.getElementById(`owner-${name}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    className="flex w-full items-center rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {name}
                  </button>
                ))}
              </div>
              {([
                { id: "section-add",       icon: "➕", label: "종목 추가" },
                { id: "section-alert",     icon: "🔔", label: "이메일 알림" },
                { id: "section-watchlist", icon: "⭐", label: "관심종목" },
                { id: "section-telegram",  icon: "📲", label: "텔레그램" },
                { id: "section-simulator", icon: "🧮", label: "가상 매수" },
                { id: "section-sync",      icon: "🔑", label: "동기화 키" },
              ] as const).map(({ id, icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                >
                  <span className="leading-none">{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          </div>
        </aside>

        <main className="flex-1 space-y-4 sm:space-y-6">
          <header>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">주식 대시보드</h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              가족(담당자)별·계좌별 자산과 종목별 수익률을 한눈에 확인합니다.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              환율 USD/KRW: {usdKrw.toLocaleString()} · EUR/KRW: {eurKrw.toLocaleString()} | 시세 갱신:{" "}
              {marketQuery.data?.fetchedAt
                ? new Date(marketQuery.data.fetchedAt).toLocaleTimeString()
                : "대기 중"}
            </p>
          </header>

          {/* 모바일 전용 빠른 이동 메뉴 (정보/순서/기능은 PC와 동일) */}
          <section className="md:hidden">
            <div className="rounded-xl border bg-card p-2 shadow-sm">
              <div className="mb-2 overflow-x-auto">
                <div className="flex min-w-max items-center gap-1.5">
                  {([
                    { id: "section-trend", icon: "📈", label: "일별 자산 추이" },
                    { id: "section-rebalance", icon: "⚖️", label: "리밸런싱" },
                    { id: "section-holdings", icon: "📋", label: "보유 종목" },
                    { id: "section-add", icon: "➕", label: "종목 추가" },
                    { id: "section-alert", icon: "🔔", label: "이메일 알림" },
                    { id: "section-watchlist", icon: "⭐", label: "관심종목" },
                    { id: "section-telegram", icon: "📲", label: "텔레그램" },
                    { id: "section-simulator", icon: "🧮", label: "가상 매수" },
                    { id: "section-sync", icon: "🔑", label: "동기화 키" },
                  ] as const).map(({ id, icon, label }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() =>
                        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }
                      className="shrink-0 rounded-md border bg-background px-2.5 py-1.5 text-xs"
                    >
                      <span className="mr-1">{icon}</span>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <div className="flex min-w-max items-center gap-1.5">
                  {OWNER_NAMES.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() =>
                        document.getElementById(`owner-${name}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }
                      className="shrink-0 rounded-md border bg-background px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {summaryCards.map((card) => (
              <Card key={card.label}>
                <CardHeader>
                  <CardDescription>{card.label}</CardDescription>
                  <CardTitle
                    className={`text-2xl ${
                      card.positive === true
                        ? "text-red-600"
                        : card.positive === false
                          ? "text-blue-600"
                          : ""
                    }`}
                  >
                    {card.value}
                  </CardTitle>
                  {card.sub ? (
                    <p className="text-xs text-muted-foreground">{card.sub}</p>
                  ) : null}
                </CardHeader>
                {card.change ? (
                  <CardContent className="pt-0">
                    <p className="text-sm font-medium text-red-500">{card.change}</p>
                  </CardContent>
                ) : null}
              </Card>
            ))}
          </section>

          <section className="space-y-4">
            <h2 className="font-semibold">포트폴리오 비중 (가족·퇴직연금)</h2>
            <p className="text-xs text-muted-foreground">
              도넛 중앙은 담당자명과 평가 합계, 상단은 범례입니다. 조각 안에 비중(%)이 표시됩니다.
            </p>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {allocationByOwner.map(({ ownerName, data, total }) => (
                <FamilyAllocationDonut
                  key={ownerName}
                  ownerName={ownerName}
                  data={data}
                  total={total}
                />
              ))}
            </div>
          </section>

          {/* 일별 자산 추이 */}
          <section id="section-trend" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">일별 자산 추이</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              앱을 연 날·서버에 저장된 날에만 일별 평가액이 쌓입니다 (최대 180일). 과거가 비어 있으면 그
              이전에는 기록이 없던 것입니다(미방문, 다른 브라우저, 초기화 등). 동기화 키가 있으면 서버에
              누적된 날짜도 함께 불러옵니다.
            </p>
            <DailyTrendChart snapshots={dailySnapshots} ownerNames={OWNER_NAMES} liveChangeByDate={dailyLiveChangeByDate} />
          </section>
          <DailyChangeCalendar snapshots={dailySnapshots} liveChangeByDate={dailyLiveChangeByDate} />

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

          <div id="section-holdings" className="flex flex-col gap-4 xl:flex-row xl:items-start">
          <section className="min-w-0 flex-1 overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">보유 종목 (가족·퇴직연금)</h2>
            </div>
            <div className="space-y-5 p-4">
              {positionsByOwner.map((group) => {
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
                      <p className="font-semibold">보유 종목({group.ownerName})</p>
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
                              const rowIndex = positions.findIndex((p) => p === position);
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
              {ownerGroupDailySummary.map((owner) => (
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

          <section id="section-add" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-3 font-semibold">종목 추가</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              담당자를 여러 명 선택하면 같은 티커·수량·평단으로 각각 한 줄씩 추가됩니다.
              같은 티커·담당자·계좌(해외/국내+계좌명)·통화로 다시 추가하면 기존 줄에{" "}
              <span className="font-medium text-foreground">수량이 더해지고 평단은 가중평균</span>으로
              갱신됩니다.
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
                  {OWNER_NAMES.map((name) => (
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
                              ? OWNER_NAMES.filter(
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
              <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-3 md:col-span-6">
                <span className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {form.currency === "KRW" ? "국내주식" : "해외주식"}
                </span>
                <input
                  className="min-w-[120px] flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="계좌명 (예: 연금계좌)"
                  value={form.accountName}
                  onChange={(e) => setForm((prev) => ({ ...prev, accountName: e.target.value }))}
                />
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
                      {OWNER_NAMES.map((n) => (
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
                  onClick={() => setWatchlistRows((prev) => [...prev, { symbol: "", name: "" }])}
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

          {/* 텔레그램 가격 변동 알림 섹션 */}
          <section id="section-telegram" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">📲 텔레그램 가격 변동 알림</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              크론 자동 발송은 <b>본인 동기화 키</b> 한 계정만 대상으로 하려면 Vercel에{" "}
              <code className="rounded bg-muted px-1">TELEGRAM_ALERT_SYNC_KEY</code>를 동기화 키와 동일하게 설정하세요.
              Supabase 포트폴리오·시세 기준 <b>총 평가·전일 대비 수익률·종목 등락</b> HTML 브리핑이{" "}
              <b>KST 01:00·09:30·12:00·15:40·23:00</b>(<code className="rounded bg-muted px-1">vercel.json</code>{" "}
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

          {/* 가상 매수 시뮬레이터 섹션 */}
          <section id="section-simulator" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">가상 매수 시뮬레이터</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              종목을 추가로 매수했을 때의 예상 비중 변화를 미리 확인합니다.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="티커 (예: NVDA)"
                value={simForm.symbol}
                onChange={(e) => setSimForm((p) => ({ ...p, symbol: e.target.value }))}
              />
              <input
                type="number"
                min="0"
                step="any"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="수량"
                value={simForm.quantity}
                onChange={(e) => setSimForm((p) => ({ ...p, quantity: e.target.value }))}
              />
              <input
                type="number"
                min="0"
                step="any"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="매수 단가"
                value={simForm.avgPrice}
                onChange={(e) => setSimForm((p) => ({ ...p, avgPrice: e.target.value }))}
              />
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={simForm.currency}
                onChange={(e) =>
                  setSimForm((p) => ({ ...p, currency: e.target.value as "USD" | "EUR" | "KRW" }))
                }
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="KRW">KRW</option>
              </select>
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={simForm.owner}
                onChange={(e) => setSimForm((p) => ({ ...p, owner: e.target.value as OwnerName }))}
              >
                {OWNER_NAMES.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button
                type="button"
                  className="cursor-pointer rounded-md border px-3 py-2 text-sm transition-all duration-100 hover:bg-muted active:scale-95"
                  onClick={() =>
                    setSimForm({
                      symbol: "",
                      name: "",
                      quantity: "",
                      avgPrice: "",
                      currency: "USD",
                      owner: "김승주",
                    })
                  }
              >
                초기화
              </button>
            </div>

            {simResult && (
              <div className="mt-4 space-y-2">
                <p className="text-sm font-medium">
                  {simForm.owner} 총 평가: ₩{Math.round(simResult.beforeTotal).toLocaleString()}
                  {" → "}
                  <span className="text-primary">₩{Math.round(simResult.afterTotal).toLocaleString()}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    (매수 금액 ₩{Math.round(simResult.simValueKrw).toLocaleString()} 추가)
                  </span>
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="pb-1 text-left font-medium">종목</th>
                        <th className="pb-1 text-right font-medium">현재 비중</th>
                        <th className="pb-1 text-right font-medium">매수 후 비중</th>
                        <th className="pb-1 text-right font-medium">변화</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simResult.rows.map((row) => (
                        <tr key={row.label} className="border-b last:border-0">
                          <td className="py-1.5 pr-4">{row.label}</td>
                          <td className="py-1.5 text-right text-muted-foreground">
                            {row.beforePct.toFixed(1)}%
                          </td>
                          <td className="py-1.5 text-right font-medium text-primary">
                            {row.afterPct.toFixed(1)}%
                          </td>
                          <td
                            className={`py-1.5 text-right text-xs font-medium ${
                              row.delta > 0 ? "text-red-500" : row.delta < 0 ? "text-blue-500" : "text-muted-foreground"
                            }`}
                          >
                            {row.delta > 0 ? "+" : ""}{row.delta.toFixed(1)}%p
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {!simResult && simForm.symbol && (
              <p className="mt-3 text-xs text-muted-foreground">수량과 매수 단가를 입력하면 결과가 표시됩니다.</p>
            )}
          </section>

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
                <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
                  <input
                    type="checkbox"
                    className="cursor-pointer accent-primary"
                    checked={autoSync}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setAutoSync(v);
                      window.localStorage.setItem(AUTO_SYNC_STORAGE, v ? "1" : "0");
                    }}
                  />
                  변경 시 자동으로 서버에 저장 (2초 후)
                </label>
              </div>
              {syncMessage ? (
                <p className="text-xs text-muted-foreground">{syncMessage}</p>
              ) : null}
              {syncBusy ? <p className="text-xs text-amber-600">동기화 중…</p> : null}
              {lastSyncedAt ? (
                <p className="text-xs text-muted-foreground">
                  마지막 동기 시각: {new Date(lastSyncedAt).toLocaleString()}
                </p>
              ) : null}
            </CardContent>
          </Card>

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
    </div>
  );
}
