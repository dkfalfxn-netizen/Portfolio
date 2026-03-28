"use client";

import { useQuery } from "@tanstack/react-query";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { FamilyAllocationDonut } from "@/components/family-allocation-chart";
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

const OWNER_NAMES = ["김승주", "강희진", "김도율", "김찬율"] as const;
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
};

type MarketResponse = {
  quotes: Record<string, { price: number | null; currency: string | null }>;
  usdKrw: number | null;
  fetchedAt: number;
};

const STORAGE_KEY = "portfolio_positions_v1";
const CASH_STORAGE_KEY = "portfolio_cash_v1";
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

export default function Home() {
  const [positions, setPositions] = useState<Position[]>(DEFAULT_POSITIONS);
  const [cashByOwner, setCashByOwner] = useState<CashByOwner>(DEFAULT_CASH_BY_OWNER);
  const [isHydrated, setIsHydrated] = useState(false);
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editAvgPrice, setEditAvgPrice] = useState("");
  const [editPurchaseUsdKrw, setEditPurchaseUsdKrw] = useState("");

  const [form, setForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    currentPrice: "",
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
      const livePrice = marketQuery.data?.quotes?.[position.symbol]?.price;
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
      const stockSlices = items.map((position, idx) => {
        const v = position.valueKrw;
        const value = Math.max(0, Number.isFinite(v) ? v : 0);
        return {
          /** Recharts·범례 충돌 방지: 계좌까지 포함한 고유 키 */
          name: `stk|${position.symbol}|${position.accountType}|${position.accountName}|${idx}`,
          displayName: position.name,
          value,
        };
      });
      const c = cashByOwner[ownerName];
      const usd = Number.isFinite(c.usd) ? Math.max(0, c.usd) : 0;
      const krw = Number.isFinite(c.krw) ? Math.max(0, c.krw) : 0;
      const usdCashKrw = usd * usdKrw;
      const extra: { name: string; displayName: string; value: number }[] = [];
      if (usdCashKrw > 0) {
        extra.push({
          name: `cash-usd|${ownerName}`,
          displayName: "USD 현금",
          value: usdCashKrw,
        });
      }
      if (krw > 0) {
        extra.push({
          name: `cash-krw|${ownerName}`,
          displayName: "KRW 현금",
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

  useEffect(() => {
    setPositions(loadPositions());
    setCashByOwner(loadCashByOwner());
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  }, [positions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(CASH_STORAGE_KEY, JSON.stringify(cashByOwner));
  }, [cashByOwner, isHydrated]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const quantity = Number(form.quantity);
    const avgPrice = Number(form.avgPrice);
    const currentPrice = Number(form.currentPrice);

    if (!form.symbol.trim() || !form.name.trim()) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

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
      currentPrice: currentPrice || avgPrice,
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
        currentPrice: currentPrice || existing.currentPrice,
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
      currentPrice: "",
      purchaseUsdKrw: "",
      currency: form.currency,
      accountType: form.accountType,
      accountName: form.accountName,
      owner: form.owner,
    });
  }

  function startEditRow(p: Position) {
    const key = makePositionKey(p);
    setEditingRowKey(key);
    setEditQuantity(String(p.quantity));
    setEditAvgPrice(String(p.avgPrice));
    setEditPurchaseUsdKrw(
      p.currency === "USD" ? String(p.purchaseUsdKrw ?? "") : "",
    );
  }

  function cancelEditRow() {
    setEditingRowKey(null);
    setEditQuantity("");
    setEditAvgPrice("");
    setEditPurchaseUsdKrw("");
  }

  function saveEditRow() {
    if (!editingRowKey) return;
    const q = Number(editQuantity);
    const a = Number(editAvgPrice);
    const px = Number(editPurchaseUsdKrw);
    if (!Number.isFinite(q) || q <= 0) return;
    if (!Number.isFinite(a) || a <= 0) return;
    setPositions((prev) =>
      prev.map((p) => {
        if (makePositionKey(p) !== editingRowKey) return p;
        if (p.currency === "USD") {
          if (!Number.isFinite(px) || px <= 0) return p;
          return { ...p, quantity: q, avgPrice: a, purchaseUsdKrw: px };
        }
        return { ...p, quantity: q, avgPrice: a };
      }),
    );
    cancelEditRow();
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl gap-6 px-4 py-6 md:px-6">
        <aside className="hidden w-64 shrink-0 rounded-2xl border bg-card p-4 shadow-sm md:block">
          <h2 className="mb-6 text-lg font-semibold">포트폴리오</h2>
          <nav className="space-y-2 text-sm">
            <a className="block rounded-lg bg-primary px-3 py-2 text-primary-foreground">
              대시보드
            </a>
            <a className="block rounded-lg px-3 py-2 hover:bg-muted">
              계좌관리
            </a>
            <a className="block rounded-lg px-3 py-2 hover:bg-muted">
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
            <h2 className="font-semibold">포트폴리오 비중 (가족별)</h2>
            <p className="text-xs text-muted-foreground">
              도넛 중앙은 담당자명과 평가 합계, 상단은 범례입니다. 비중 5% 미만 조각은 퍼센트만 생략됩니다.
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

          <section className="rounded-2xl border bg-card p-4 shadow-sm">
            <h2 className="mb-3 font-semibold">종목 추가</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              같은 티커·담당자·계좌(해외/국내+계좌명)·통화로 추가하면 기존 줄에{" "}
              <span className="font-medium text-foreground">수량이 더해지고 평단은 가중평균</span>으로
              갱신됩니다.
            </p>
            <form
              onSubmit={handleSubmit}
              className="grid grid-cols-1 gap-3 md:grid-cols-7"
            >
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="티커 (예: NVDA)"
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
              <input
                type="number"
                min="0.000001"
                step="any"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="현재가"
                value={form.currentPrice}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, currentPrice: e.target.value }))
                }
                required
              />
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
              <div className="flex flex-wrap gap-2 md:col-span-2">
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
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                  추가
                </button>
              </div>
              {form.currency === "USD" ? (
                <div className="mt-3 flex flex-col gap-1 md:col-span-7">
                  <label className="text-xs font-medium text-muted-foreground">
                    매입 환율 (USD 1달러당 원화, 매수 시점)
                  </label>
                  <input
                    type="number"
                    min="0.000001"
                    step="any"
                    required
                    className="max-w-xs rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder={`예: ${Math.round(usdKrw)}`}
                    value={form.purchaseUsdKrw}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, purchaseUsdKrw: e.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    원화 매입원가·원화 수익률에 반영됩니다. 위 환율 배지({usdKrw.toLocaleString()})는
                    시세·평가액용 현재 환율입니다.
                  </p>
                </div>
              ) : null}
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              현금(USD·KRW)은 아래 가족별 보유 종목 표 상단에서 담당자마다 입력합니다. 전체 현금
              합계(원화): ₩{Math.round(totalCashKrw).toLocaleString()}
            </p>
          </section>

          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">보유 종목 (가족별)</h2>
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
                  <Table className="min-w-full text-sm">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead className="px-4 py-3">종목</TableHead>
                        <TableHead className="px-4 py-3 text-right">수량</TableHead>
                        <TableHead className="px-4 py-3 text-right">평단가</TableHead>
                        <TableHead className="px-4 py-3 text-right">매입환율</TableHead>
                        <TableHead className="px-4 py-3 text-right">현재가</TableHead>
                        <TableHead className="px-4 py-3 text-right">수익률</TableHead>
                        <TableHead className="px-4 py-3">계좌</TableHead>
                        <TableHead className="px-4 py-3 w-[140px]">수정</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.items.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="px-4 py-6 text-center text-sm text-muted-foreground"
                          >
                            등록된 종목이 없습니다.
                          </TableCell>
                        </TableRow>
                      ) : (
                        group.items.map((position) => {
                          const rowKey = makePositionKey(position);
                          const isEditing = editingRowKey === rowKey;
                          return (
                        <TableRow key={rowKey}>
                          <TableCell className="px-4 py-3">
                            <p className="font-medium">{position.name}</p>
                            <p className="text-xs text-muted-foreground">{position.symbol}</p>
                          </TableCell>
                          <TableCell className="px-4 py-3 text-right">
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
                          <TableCell className="px-4 py-3 text-right">
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
                          <TableCell className="px-4 py-3 text-right text-xs">
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
                          <TableCell className="px-4 py-3 text-right">
                            {position.currentPrice.toLocaleString()} {position.currency}
                            <p className="text-xs text-muted-foreground">
                              원화: ₩
                              {Math.round(
                                position.currentPrice * (position.currency === "USD" ? usdKrw : 1),
                              ).toLocaleString()}
                            </p>
                          </TableCell>
                          <TableCell
                            className={`px-4 py-3 text-right font-semibold ${
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
                              </div>
                            ) : (
                              `${position.pnl.toFixed(2)}%`
                            )}
                          </TableCell>
                          <TableCell className="px-4 py-3 text-sm">
                            <span className="text-muted-foreground">{position.accountType}</span>
                            <span className="mx-1">·</span>
                            {position.accountName}
                          </TableCell>
                          <TableCell className="px-4 py-3">
                            {isEditing ? (
                              <div className="flex flex-col gap-1">
                                <button
                                  type="button"
                                  className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
                                  onClick={saveEditRow}
                                >
                                  저장
                                </button>
                                <button
                                  type="button"
                                  className="rounded-md border px-2 py-1 text-xs"
                                  onClick={cancelEditRow}
                                >
                                  취소
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                                onClick={() => startEditRow(position)}
                              >
                                수정
                              </button>
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
        </main>
      </div>
    </div>
  );
}
