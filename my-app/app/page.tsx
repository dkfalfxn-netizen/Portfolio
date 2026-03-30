"use client";

import { useQuery } from "@tanstack/react-query";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FamilyAllocationDonut } from "@/components/family-allocation-chart";
import { IntradaySparkline } from "@/components/intraday-sparkline";
import { LivePriceCell } from "@/components/live-price-cell";
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
  currency: "USD" | "KRW";
  /** 해외(USD) 매수 시점 USD/KRW — 원화 매입원가·원화 수익률에 사용 */
  purchaseUsdKrw?: number;
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
  fetchedAt: number;
};

const STORAGE_KEY = "portfolio_positions_v1";
const CASH_STORAGE_KEY = "portfolio_cash_v1";
const SYNC_KEY_STORAGE = "portfolio_sync_key_v1";
const AUTO_SYNC_STORAGE = "portfolio_auto_sync_v1";
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
  {
    symbol: "TSM",
    name: "Taiwan Semi",
    quantity: 50,
    avgPrice: 138.4,
    currentPrice: 146.1,
    currency: "USD",
    purchaseUsdKrw: 1350,
    accountType: "해외주식",
    accountName: "미국주식-주계좌",
    owner: "강희진",
  },
  {
    symbol: "KRX:005930",
    name: "삼성전자",
    quantity: 120,
    avgPrice: 70400,
    currentPrice: 73800,
    currency: "KRW",
    accountType: "국내주식",
    accountName: "국내주식-주계좌",
    owner: "김도율",
  },
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

/** 같은 담당자·같은 티커·같은 계좌·같은 통화면 한 줄로 합칩니다(가중 평단). */
function makePositionKey(p: Pick<Position, "owner" | "symbol" | "accountType" | "accountName" | "currency">) {
  return `${p.owner}|${p.symbol}|${p.accountType}|${p.accountName}|${p.currency}`;
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
    const nextPurchase =
      mergedPurchase ?? existing.purchaseUsdKrw ?? p.purchaseUsdKrw;
    map.set(key, {
      ...existing,
      quantity: newQty,
      avgPrice: newAvg,
      currentPrice: p.currentPrice,
      name: existing.name || p.name,
      ...(existing.currency === "USD" && nextPurchase != null && nextPurchase > 0
        ? { purchaseUsdKrw: nextPurchase }
        : {}),
    });
  }
  return Array.from(map.values());
}

function isValidPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Position>;
  const purchaseOk =
    item.purchaseUsdKrw === undefined ||
    (typeof item.purchaseUsdKrw === "number" &&
      Number.isFinite(item.purchaseUsdKrw) &&
      item.purchaseUsdKrw > 0);
  return (
    typeof item.symbol === "string" &&
    typeof item.name === "string" &&
    typeof item.quantity === "number" &&
    typeof item.avgPrice === "number" &&
    typeof item.currentPrice === "number" &&
    (item.currency === "USD" || item.currency === "KRW") &&
    (item.accountType === "해외주식" || item.accountType === "국내주식") &&
    typeof item.accountName === "string" &&
    isOwnerName(item.owner) &&
    purchaseOk
  );
}

function loadPositions(): Position[] {
  if (typeof window === "undefined") return DEFAULT_POSITIONS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POSITIONS;
    const parsed = JSON.parse(raw) as unknown;
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
          (legacy.currency !== "USD" && legacy.currency !== "KRW")
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
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editSymbol, setEditSymbol] = useState("");
  const [editName, setEditName] = useState("");
  const [editChartGroup, setEditChartGroup] = useState("");
  const [editQuantity, setEditQuantity] = useState("");
  const [editAvgPrice, setEditAvgPrice] = useState("");
  const [editPurchaseUsdKrw, setEditPurchaseUsdKrw] = useState("");

  const [cloudSyncKey, setCloudSyncKey] = useState("");
  const [syncKeyDraft, setSyncKeyDraft] = useState("");
  const [autoSync, setAutoSync] = useState(false);
  const [syncReady, setSyncReady] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [serverHealth, setServerHealth] = useState<"loading" | "ok" | "error">("loading");
  const pushDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 알림 설정 상태
  type AlertRule = { owner: string; symbol: string; minPct: string; maxPct: string };
  const [alertEmail, setAlertEmail] = useState("");
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");
  const [alertLoaded, setAlertLoaded] = useState(false);

  // 가상 매수 시뮬레이터 상태
  const [simForm, setSimForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    currency: "USD" as "USD" | "KRW",
    owner: "김승주" as OwnerName,
  });

  const [form, setForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    purchaseUsdKrw: "",
    currency: "USD" as "USD" | "KRW",
    accountType: "해외주식" as "해외주식" | "국내주식",
    accountName: "미국주식-주계좌",
    owner: "김승주" as OwnerName,
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

  const usdKrw = marketQuery.data?.usdKrw ?? 1350;

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
      const previousClose =
        typeof q?.previousClose === "number" && q.previousClose > 0 ? q.previousClose : null;
      const currentPrice = livePrice ?? position.currentPrice;
      const pnl = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
      /** 매입 시 환율 없으면 현재 환율로 원가 추정(기존 데이터 호환) */
      const purchaseFx =
        position.currency === "USD" ? (position.purchaseUsdKrw ?? usdKrw) : 1;
      const valueKrw =
        position.quantity * currentPrice * (position.currency === "USD" ? usdKrw : 1);
      const costKrw = position.quantity * position.avgPrice * purchaseFx;
      /** 해외(USD): 달러 주가 수익률(종목 통화) */
      const pnlUsdPct = position.currency === "USD" ? pnl : null;
      /** 해외(USD): 매입 환율 기준 원화 매입액 대비 현재 원화 평가 수익률 */
      const pnlKrwEquityPct =
        position.currency === "USD" && costKrw > 0
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
        pnlKrwEquityPct,
      };
    });
  }, [positions, marketQuery.data, usdKrw]);

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
        sub: `주식 ₩${Math.round(stockValue).toLocaleString()} · 현금 ₩${Math.round(totalCashKrw).toLocaleString()}`,
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
  }, [enrichedPositions, totalCashKrw]);

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
      const c = cashByOwner[ownerName];
      const sectionCashKrw = c.krw + c.usd * usdKrw;
      const sectionTotal = sectionStockValue + sectionCashKrw;
      return {
        ownerName,
        items,
        sectionStockValue,
        sectionCashKrw,
        sectionTotal,
        cashUsd: c.usd,
        cashKrw: c.krw,
      };
    });
  }, [enrichedPositions, cashByOwner, usdKrw]);

  /** pull → 있으면 반영, 없으면 이 기기(pos/cash)를 push (최초 기기·키 저장 직후 공통) */
  const syncWithServerForKey = useCallback(async (key: string, pos: Position[], cash: CashByOwner) => {
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
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "동기화를 사용할 수 없습니다.");
        return;
      }
      if (j.found) {
        const valid = Array.isArray(j.positions)
          ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
          : [];
        setPositions(mergeDuplicatePositions(valid));
        setCashByOwner(normalizeCashFromServer(j.cash_by_owner));
        setSyncMessage("서버에서 잔고를 불러왔습니다. (다른 PC와 같은 키면 같은 데이터입니다.)");
        setLastSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
      } else {
        const r2 = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "push",
            key,
            positions: pos,
            cashByOwner: cash,
          }),
        });
        const j2 = (await r2.json()) as { error?: string };
        if (!r2.ok) setSyncMessage(j2.error ?? "서버 업로드 실패");
        else {
          setSyncMessage("서버에 기존 데이터가 없어 이 기기 내용을 올렸습니다.");
          setLastSyncedAt(new Date().toISOString());
        }
      }
    } catch {
      setSyncMessage("네트워크 오류로 동기화에 실패했습니다.");
    } finally {
      setSyncBusy(false);
    }
  }, []);

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
    setPositions(pos);
    setCashByOwner(cash);
    const savedKey = typeof window !== "undefined" ? window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "" : "";
    setCloudSyncKey(savedKey);
    setSyncKeyDraft(savedKey);
    const auto = typeof window !== "undefined" && window.localStorage.getItem(AUTO_SYNC_STORAGE) === "1";
    setAutoSync(auto);
    setIsHydrated(true);

    if (savedKey.length < 8) {
      setSyncReady(true);
      return;
    }

    void (async () => {
      await syncWithServerForKey(savedKey, pos, cash);
      setSyncReady(true);
    })();
  }, [syncWithServerForKey]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  }, [positions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(CASH_STORAGE_KEY, JSON.stringify(cashByOwner));
  }, [cashByOwner, isHydrated]);

  useEffect(() => {
    if (!isHydrated || !syncReady || !autoSync || cloudSyncKey.length < 8) return;
    if (pushDebounceRef.current) clearTimeout(pushDebounceRef.current);
    pushDebounceRef.current = setTimeout(() => {
      void fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key: cloudSyncKey,
          positions,
          cashByOwner,
        }),
      }).then(async (r) => {
        if (r.ok) {
          setLastSyncedAt(new Date().toISOString());
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
  }, [positions, cashByOwner, isHydrated, syncReady, autoSync, cloudSyncKey]);

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
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "불러오기 실패");
        return;
      }
      if (j.found) {
        const valid = Array.isArray(j.positions)
          ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
          : [];
        setPositions(mergeDuplicatePositions(valid));
        setCashByOwner(normalizeCashFromServer(j.cash_by_owner));
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
        body: JSON.stringify({ action: "push", key, positions, cashByOwner }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) setSyncMessage(j.error ?? "업로드 실패");
      else {
        setSyncMessage("서버에 올렸습니다.");
        setLastSyncedAt(new Date().toISOString());
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
    await syncWithServerForKey(k, positions, cashByOwner);
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

  // 가상 매수 시뮬레이션 계산
  const simResult = useMemo(() => {
    const qty = Number(simForm.quantity);
    const price = Number(simForm.avgPrice);
    if (!simForm.symbol || !qty || !price || qty <= 0 || price <= 0) return null;

    const simValueKrw = qty * price * (simForm.currency === "USD" ? usdKrw : 1);
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
  }, [simForm, positionsByOwner, usdKrw]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const quantity = Number(form.quantity);
    const avgPrice = Number(form.avgPrice);

    if (!form.symbol.trim() || !form.name.trim()) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return;

    const purchaseUsdKrwNum = Number(form.purchaseUsdKrw);
    if (form.currency === "USD") {
      if (!Number.isFinite(purchaseUsdKrwNum) || purchaseUsdKrwNum <= 0) return;
    }

    const symbol = form.symbol.trim().toUpperCase();
    const accountName = form.accountName.trim() || "기본계좌";
    const nextEntry: Position = {
      symbol,
      name: form.name.trim(),
      quantity,
      avgPrice,
      currentPrice: avgPrice,
      currency: form.currency,
      accountType: form.accountType,
      accountName,
      owner: form.owner,
      ...(form.currency === "USD" ? { purchaseUsdKrw: purchaseUsdKrwNum } : {}),
    };

    setPositions((prev) => {
      const key = makePositionKey(nextEntry);
      const idx = prev.findIndex((p) => makePositionKey(p) === key);
      if (idx === -1) return [...prev, nextEntry];
      const existing = prev[idx];
      const newQty = existing.quantity + quantity;
      const newAvg =
        (existing.quantity * existing.avgPrice + quantity * avgPrice) / newQty;
      const mergedPurchase = blendPurchaseUsdKrw(existing, nextEntry);
      const merged: Position = {
        ...existing,
        quantity: newQty,
        avgPrice: newAvg,
        currentPrice: existing.currentPrice,
        name: form.name.trim() || existing.name,
      };
      if (nextEntry.currency === "USD") {
        const px =
          mergedPurchase ?? existing.purchaseUsdKrw ?? nextEntry.purchaseUsdKrw;
        if (px != null && px > 0) merged.purchaseUsdKrw = px;
      } else {
        delete merged.purchaseUsdKrw;
      }
      return prev.map((p, i) => (i === idx ? merged : p));
    });

    setForm({
      symbol: "",
      name: "",
      quantity: "",
      avgPrice: "",
      purchaseUsdKrw: "",
      currency: form.currency,
      accountType: form.accountType,
      accountName: form.accountName,
      owner: form.owner,
    });
  }

  function handleDeleteRow(rowKey: string) {
    setPositions((prev) => prev.filter((p) => makePositionKey(p) !== rowKey));
  }

  function startEditRow(p: Position) {
    const key = makePositionKey(p);
    setEditingRowKey(key);
    setEditSymbol(p.symbol);
    setEditName(p.name);
    setEditChartGroup(p.chartGroup ?? "");
    setEditQuantity(String(p.quantity));
    setEditAvgPrice(String(p.avgPrice));
    setEditPurchaseUsdKrw(
      p.currency === "USD" ? String(p.purchaseUsdKrw ?? "") : "",
    );
  }

  function cancelEditRow() {
    setEditingRowKey(null);
    setEditSymbol("");
    setEditName("");
    setEditChartGroup("");
    setEditQuantity("");
    setEditAvgPrice("");
    setEditPurchaseUsdKrw("");
  }

  function saveEditRow() {
    if (!editingRowKey) return;
    const q = Number(editQuantity);
    const a = Number(editAvgPrice);
    const px = Number(editPurchaseUsdKrw);
    const sym = editSymbol.trim().toUpperCase();
    const nm = editName.trim();
    const cg = editChartGroup.trim() || undefined;
    if (!sym || !nm) return;
    if (!Number.isFinite(q) || q <= 0) return;
    if (!Number.isFinite(a) || a <= 0) return;
    setPositions((prev) =>
      prev.map((p) => {
        if (makePositionKey(p) !== editingRowKey) return p;
        if (p.currency === "USD") {
          if (!Number.isFinite(px) || px <= 0) return p;
          return { ...p, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a, purchaseUsdKrw: px };
        }
        return { ...p, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a };
      }),
    );
    cancelEditRow();
  }

  function moveRow(rowKey: string, direction: "up" | "down") {
    setPositions((prev) => {
      const idx = prev.findIndex((p) => makePositionKey(p) === rowKey);
      if (idx === -1) return prev;
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
      <div className="mx-auto flex w-full max-w-7xl gap-6 px-4 py-6 md:px-6">
        <aside className="hidden w-64 shrink-0 rounded-2xl border bg-card p-4 shadow-sm md:block">
          <h2 className="mb-6 text-lg font-semibold">포트폴리오</h2>
          <nav className="space-y-2 text-sm">
            <a className="block cursor-pointer rounded-lg bg-primary px-3 py-2 text-primary-foreground transition-all duration-100 active:scale-95">
              대시보드
            </a>
            <a className="block cursor-pointer rounded-lg px-3 py-2 transition-all duration-100 hover:bg-muted active:scale-95">
              계좌관리
            </a>
            <a className="block cursor-pointer rounded-lg px-3 py-2 transition-all duration-100 hover:bg-muted active:scale-95">
              설정
            </a>
          </nav>
        </aside>

        <main className="flex-1 space-y-6">
          <header>
            <h1 className="text-2xl font-bold tracking-tight">주식 대시보드</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              가족(담당자)별·계좌별 자산과 종목별 수익률을 한눈에 확인합니다.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              환율(USD/KRW): {usdKrw.toLocaleString()} | 시세 갱신:{" "}
              {marketQuery.data?.fetchedAt
                ? new Date(marketQuery.data.fetchedAt).toLocaleTimeString()
                : "대기 중"}
            </p>
          </header>

          <Card className="border-dashed">
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

          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">보유 종목 (가족·퇴직연금)</h2>
            </div>
            <div className="space-y-5 p-4">
              {positionsByOwner.map((group) => (
                <div key={group.ownerName} className="rounded-xl border">
                  <div className="flex flex-col gap-2 border-b bg-muted/30 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="font-semibold">보유 종목({group.ownerName})</p>
                    <div className="text-right text-sm">
                      <p className="font-semibold">
                        총 평가(주식+현금): ₩{Math.round(group.sectionTotal).toLocaleString()}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        주식 ₩{Math.round(group.sectionStockValue).toLocaleString()} · 현금 ₩
                        {Math.round(group.sectionCashKrw).toLocaleString()}{" "}
                        <span className="hidden sm:inline">
                          (USD {group.cashUsd.toLocaleString()} / KRW{" "}
                          {group.cashKrw.toLocaleString()})
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
                        <TableHead
                          className="w-[72px] px-1 py-1.5 text-center"
                          title="당일 분봉 기준 가격 흐름"
                        >
                          일중
                        </TableHead>
                        <TableHead className="px-3 py-1.5 text-right">수량</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">수익률</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">평단가</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">매입환율</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">현재가</TableHead>
                        <TableHead className="px-3 py-1.5 text-right">평가금액</TableHead>
                        <TableHead className="px-3 py-1.5 w-[140px]">수정/삭제</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.items.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={9}
                            className="px-3 py-4 text-center text-xs text-muted-foreground"
                          >
                            등록된 종목이 없습니다.
                          </TableCell>
                        </TableRow>
                      ) : (
                        group.items.map((position, posIdx) => {
                          const rowKey = makePositionKey(position);
                          const isEditing = editingRowKey === rowKey;
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
                                  className="w-32 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground"
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
                                <p className="font-medium">{position.name}</p>
                                <p className="text-xs text-muted-foreground">{position.symbol}</p>
                                {position.chartGroup && (
                                  <p className="mt-0.5 w-fit rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    그룹: {position.chartGroup}
                                  </p>
                                )}
                              </>
                            )}
                          </TableCell>
                          <TableCell className="px-2 py-1.5 align-middle">
                            <div className="flex justify-center">
                              <IntradaySparkline
                                points={marketQuery.data?.intraday?.[position.symbol] ?? []}
                              />
                            </div>
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
                            {position.currency === "USD" &&
                            position.pnlUsdPct != null &&
                            position.pnlKrwEquityPct != null ? (
                              <div className="flex flex-col items-end gap-0.5 leading-tight">
                                <span>
                                  USD {position.pnlUsdPct >= 0 ? "+" : ""}
                                  {position.pnlUsdPct.toFixed(2)}%
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
                                  {position.currency === "USD" ? (
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
                            ) : (
                              "—"
                            )}
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
                                  : undefined
                              }
                            />
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right align-top">
                            <p className="text-[16px] font-semibold tabular-nums leading-none">
                              ₩{Math.round(position.valueKrw).toLocaleString()}
                            </p>
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
                                    title="위로"
                                    className="cursor-pointer rounded border px-1.5 py-0.5 text-xs transition-all duration-100 hover:bg-muted active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
                                    disabled={posIdx === 0}
                                    onClick={() => moveRow(rowKey, "up")}
                                  >
                                    ▲
                                  </button>
                                  <button
                                    type="button"
                                    title="아래로"
                                    className="cursor-pointer rounded border px-1.5 py-0.5 text-xs transition-all duration-100 hover:bg-muted active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
                                    disabled={posIdx === group.items.length - 1}
                                    onClick={() => moveRow(rowKey, "down")}
                                  >
                                    ▼
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all duration-100 hover:bg-muted active:scale-95"
                                  onClick={() => startEditRow(position)}
                                >
                                  수정
                                </button>
                                <button
                                  type="button"
                                  className="cursor-pointer rounded-md border px-2 py-1 text-xs text-destructive transition-all duration-100 hover:bg-destructive/10 active:scale-95"
                                  onClick={() => handleDeleteRow(rowKey)}
                                >
                                  삭제
                                </button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border bg-card p-4 shadow-sm">
            <h2 className="mb-3 font-semibold">종목 추가</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              같은 티커·담당자·계좌(해외/국내+계좌명)·통화로 추가하면 기존 줄에{" "}
              <span className="font-medium text-foreground">수량이 더해지고 평단은 가중평균</span>으로
              갱신됩니다.
              국내 주식은 6자리 종목코드(예: <span className="font-medium text-foreground">005930</span>)
              또는 <span className="font-medium text-foreground">KRX:005930</span> 형식으로 입력하면 실시간 시세가 반영됩니다.
              KOSDAQ은 <span className="font-medium text-foreground">KQ:293490</span> 형식을 사용하세요.
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
              {/* 매입 환율: USD일 때만 표시, 평단가 바로 다음 */}
              {form.currency === "USD" ? (
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  required
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={`매입환율 (예: ${Math.round(usdKrw)})`}
                  value={form.purchaseUsdKrw}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, purchaseUsdKrw: e.target.value }))
                  }
                />
              ) : (
                <div />
              )}
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={form.currency}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    currency: e.target.value as "USD" | "KRW",
                    accountType: e.target.value === "KRW" ? "국내주식" : "해외주식",
                    purchaseUsdKrw: e.target.value === "KRW" ? "" : prev.purchaseUsdKrw,
                  }))
                }
              >
                <option value="USD">USD</option>
                <option value="KRW">KRW</option>
              </select>
              <div className="col-span-2 flex flex-wrap gap-2 sm:col-span-3 md:col-span-6">
                <select
                  className="min-w-[7rem] rounded-md border bg-background px-3 py-2 text-sm"
                  value={form.owner}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      owner: e.target.value as OwnerName,
                    }))
                  }
                  aria-label="담당자"
                >
                  {OWNER_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  className="min-w-[110px] rounded-md border bg-background px-3 py-2 text-sm"
                  value={form.accountType}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      accountType: e.target.value as "해외주식" | "국내주식",
                    }))
                  }
                >
                  <option value="해외주식">해외주식</option>
                  <option value="국내주식">국내주식</option>
                </select>
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
          <section className="rounded-2xl border bg-card p-4 shadow-sm">
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

          {/* 가상 매수 시뮬레이터 섹션 */}
          <section className="rounded-2xl border bg-card p-4 shadow-sm">
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
                onChange={(e) => setSimForm((p) => ({ ...p, currency: e.target.value as "USD" | "KRW" }))}
              >
                <option value="USD">USD</option>
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
                  onClick={() => setSimForm({ symbol: "", name: "", quantity: "", avgPrice: "", currency: "USD", owner: "김승주" })}
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

        </main>
      </div>
    </div>
  );
}
