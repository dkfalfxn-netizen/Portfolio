"use client";

import { useQuery } from "@tanstack/react-query";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
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

type Position = {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  currency: "USD" | "KRW";
  accountType: "해외주식" | "국내주식";
  accountName: string;
};

type MarketResponse = {
  quotes: Record<string, { price: number | null; currency: string | null }>;
  usdKrw: number | null;
  fetchedAt: number;
};

const STORAGE_KEY = "portfolio_positions_v1";
const CASH_STORAGE_KEY = "portfolio_cash_v1";
const CHART_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#ea580c",
  "#16a34a",
  "#0d9488",
  "#4f46e5",
  "#ca8a04",
];

const DEFAULT_POSITIONS: Position[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    quantity: 36,
    avgPrice: 795.5,
    currentPrice: 902.2,
    currency: "USD",
    accountType: "해외주식",
    accountName: "미국주식-주계좌",
  },
  {
    symbol: "TSM",
    name: "Taiwan Semi",
    quantity: 50,
    avgPrice: 138.4,
    currentPrice: 146.1,
    currency: "USD",
    accountType: "해외주식",
    accountName: "미국주식-주계좌",
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
  },
];

const DEFAULT_CASH = {
  usd: 0,
  krw: 0,
};

function isValidPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Position>;
  return (
    typeof item.symbol === "string" &&
    typeof item.name === "string" &&
    typeof item.quantity === "number" &&
    typeof item.avgPrice === "number" &&
    typeof item.currentPrice === "number" &&
    (item.currency === "USD" || item.currency === "KRW") &&
    (item.accountType === "해외주식" || item.accountType === "국내주식") &&
    typeof item.accountName === "string"
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
        } satisfies Position;
      })
      .filter((item): item is Position => item !== null);
    return migrated.length > 0 ? migrated : DEFAULT_POSITIONS;
  } catch {
    return DEFAULT_POSITIONS;
  }
}

function loadCash(): { usd: number; krw: number } {
  if (typeof window === "undefined") return DEFAULT_CASH;
  try {
    const raw = window.localStorage.getItem(CASH_STORAGE_KEY);
    if (!raw) return DEFAULT_CASH;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return DEFAULT_CASH;
    const usd = Number((parsed as { usd?: unknown }).usd ?? 0);
    const krw = Number((parsed as { krw?: unknown }).krw ?? 0);
    return {
      usd: Number.isFinite(usd) && usd >= 0 ? usd : 0,
      krw: Number.isFinite(krw) && krw >= 0 ? krw : 0,
    };
  } catch {
    return DEFAULT_CASH;
  }
}

export default function Home() {
  const [positions, setPositions] = useState<Position[]>(DEFAULT_POSITIONS);
  const [cash, setCash] = useState(DEFAULT_CASH);
  const [isHydrated, setIsHydrated] = useState(false);

  const [form, setForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    currentPrice: "",
    currency: "USD" as "USD" | "KRW",
    accountType: "해외주식" as "해외주식" | "국내주식",
    accountName: "미국주식-주계좌",
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
    enabled: positions.length > 0,
    refetchInterval: 10000,
  });

  const usdKrw = marketQuery.data?.usdKrw ?? 1350;
  const cashKrw = cash.krw + cash.usd * usdKrw;

  const enrichedPositions = useMemo(() => {
    return positions.map((position) => {
      const livePrice = marketQuery.data?.quotes?.[position.symbol]?.price;
      const currentPrice = livePrice ?? position.currentPrice;
      const pnl = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
      const fxRate = position.currency === "USD" ? usdKrw : 1;
      const valueKrw = position.quantity * currentPrice * fxRate;
      const costKrw = position.quantity * position.avgPrice * fxRate;
      return { ...position, currentPrice, pnl, valueKrw, costKrw };
    });
  }, [positions, marketQuery.data, usdKrw]);

  const summaryCards = useMemo(() => {
    const stockValue = enrichedPositions.reduce((sum, position) => sum + position.valueKrw, 0);
    const stockCost = enrichedPositions.reduce((sum, position) => sum + position.costKrw, 0);
    const totalValue = stockValue + cashKrw;
    const totalCost = stockCost + cashKrw;
    const totalProfit = totalValue - totalCost;
    const totalReturn = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    const dailyProfit = totalProfit * 0.18;
    const dailyReturn = totalValue > 0 ? (dailyProfit / totalValue) * 100 : 0;

    return [
      {
        label: "총 자산 (KRW)",
        value: `₩${Math.round(totalValue).toLocaleString()}`,
        change: `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`,
      },
      {
        label: "당일 수익금",
        value: `₩${Math.round(dailyProfit).toLocaleString()}`,
        change: `${dailyReturn >= 0 ? "+" : ""}${dailyReturn.toFixed(2)}%`,
      },
      {
        label: "총 누적 수익",
        value: `₩${Math.round(totalProfit).toLocaleString()}`,
        change: `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`,
      },
    ];
  }, [enrichedPositions, cashKrw]);

  const allocationData = useMemo(() => {
    const stockData = enrichedPositions.map((position) => ({
      name: position.symbol,
      displayName: position.name,
      value: position.valueKrw,
    }));
    const cashData = [
      {
        name: "USD 현금",
        displayName: "USD 현금",
        value: cash.usd * usdKrw,
      },
      {
        name: "KRW 현금",
        displayName: "KRW 현금",
        value: cash.krw,
      },
    ].filter((item) => item.value > 0);
    const merged = [...stockData, ...cashData];
    const totalValue = merged.reduce((sum, item) => sum + item.value, 0);
    return merged.map((item) => ({
      ...item,
      weight: totalValue > 0 ? (item.value / totalValue) * 100 : 0,
    }));
  }, [enrichedPositions, cash.krw, cash.usd, usdKrw]);

  const positionsByAccount = useMemo(() => {
    const map = new Map<string, typeof enrichedPositions>();
    for (const position of enrichedPositions) {
      const key = `${position.accountType}|${position.accountName}`;
      const current = map.get(key) ?? [];
      current.push(position);
      map.set(key, current);
    }
    return Array.from(map.entries()).map(([key, items]) => {
      const [accountType, accountName] = key.split("|");
      const accountValue = items.reduce((sum, item) => sum + item.valueKrw, 0);
      return { accountType, accountName, items, accountValue };
    });
  }, [enrichedPositions]);

  useEffect(() => {
    setPositions(loadPositions());
    setCash(loadCash());
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  }, [positions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(CASH_STORAGE_KEY, JSON.stringify(cash));
  }, [cash, isHydrated]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const quantity = Number(form.quantity);
    const avgPrice = Number(form.avgPrice);
    const currentPrice = Number(form.currentPrice);

    if (!form.symbol.trim() || !form.name.trim()) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const pnl = ((currentPrice - avgPrice) / avgPrice) * 100;

    setPositions((prev) => [
      ...prev,
      {
        symbol: form.symbol.trim().toUpperCase(),
        name: form.name.trim(),
        quantity,
        avgPrice,
        currentPrice: currentPrice || avgPrice,
        currency: form.currency,
        accountType: form.accountType,
        accountName: form.accountName.trim() || "기본계좌",
      },
    ]);

    setForm({
      symbol: "",
      name: "",
      quantity: "",
      avgPrice: "",
      currentPrice: "",
      currency: form.currency,
      accountType: form.accountType,
      accountName: form.accountName,
    });
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
              계좌별 자산 현황과 종목별 수익률을 한눈에 확인합니다.
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
                  <CardTitle className="text-2xl">{card.value}</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-sm font-medium text-red-500">{card.change}</p>
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="rounded-2xl border bg-card p-4 shadow-sm">
            <h2 className="mb-3 font-semibold">포트폴리오 비중</h2>
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 12, right: 24, bottom: 12, left: 24 }}>
                  <Pie
                    data={allocationData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={108}
                    labelLine
                    label={(entry: { name?: string; percent?: number }) => {
                      const percent = (entry.percent ?? 0) * 100;
                      if (percent < 2.5) return "";
                      return `${entry.name ?? ""} ${percent.toFixed(1)}%`;
                    }}
                  >
                    {allocationData.map((entry, index) => (
                      <Cell
                        key={`cell-${entry.name}`}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, _name, item) => {
                      const numericValue =
                        typeof value === "number" ? value : Number(value ?? 0);
                      const payload = item.payload as {
                        value: number | string;
                        weight: number;
                        displayName: string;
                      };
                      return [
                        `₩${Math.round(numericValue).toLocaleString()} (${payload.weight.toFixed(2)}%)`,
                        payload.displayName,
                      ];
                    }}
                  />
                  <Legend
                    formatter={(value, _entry, index) => {
                      const item = allocationData[index] ?? null;
                      if (!item) return <span className="font-semibold">{value}</span>;
                      return (
                        <span className="font-semibold">
                          {value} {item.weight.toFixed(1)}%
                        </span>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-2xl border bg-card p-4 shadow-sm">
            <h2 className="mb-3 font-semibold">종목 추가</h2>
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
                    account: e.target.value === "KRW" ? "국내주식" : "해외주식",
                  }))
                }
              >
                <option value="USD">USD</option>
                <option value="KRW">KRW</option>
              </select>
              <div className="flex gap-2 md:col-span-2">
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
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="계좌명 (예: 연금계좌, 단기매매)"
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
            </form>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">USD</p>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="USD 현금"
                  value={cash.usd === 0 ? "" : cash.usd}
                  onChange={(e) =>
                    setCash((prev) => ({
                      ...prev,
                      usd: e.target.value === "" ? 0 : Number(e.target.value),
                    }))
                  }
                />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">KRW</p>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="KRW 현금"
                  value={cash.krw}
                  onChange={(e) =>
                    setCash((prev) => ({
                      ...prev,
                      krw: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0,
                    }))
                  }
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              현금 합계(원화 환산): ₩{Math.round(cashKrw).toLocaleString()} (USD {cash.usd.toLocaleString()} /
              KRW {cash.krw.toLocaleString()})
            </p>
          </section>

          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="border-b px-4 py-3">
              <h2 className="font-semibold">보유 종목 (계좌별)</h2>
            </div>
            <div className="space-y-5 p-4">
              {positionsByAccount.map((group) => (
                <div key={`${group.accountType}-${group.accountName}`} className="rounded-xl border">
                  <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2">
                    <p className="font-semibold">
                      {group.accountName} <span className="text-sm text-muted-foreground">({group.accountType})</span>
                    </p>
                    <p className="text-sm font-semibold">
                      평가액: ₩{Math.round(group.accountValue).toLocaleString()}
                    </p>
                  </div>
                  <Table className="min-w-full text-sm">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead className="px-4 py-3">종목</TableHead>
                        <TableHead className="px-4 py-3 text-right">수량</TableHead>
                        <TableHead className="px-4 py-3 text-right">평단가</TableHead>
                        <TableHead className="px-4 py-3 text-right">현재가</TableHead>
                        <TableHead className="px-4 py-3 text-right">수익률</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.items.map((position) => (
                        <TableRow key={`${group.accountName}-${position.symbol}`}>
                          <TableCell className="px-4 py-3">
                            <p className="font-medium">{position.name}</p>
                            <p className="text-xs text-muted-foreground">{position.symbol}</p>
                          </TableCell>
                          <TableCell className="px-4 py-3 text-right">{position.quantity}</TableCell>
                          <TableCell className="px-4 py-3 text-right">
                            {position.avgPrice.toLocaleString()} {position.currency}
                            <p className="text-xs text-muted-foreground">
                              원화: ₩
                              {Math.round(
                                position.avgPrice * (position.currency === "USD" ? usdKrw : 1),
                              ).toLocaleString()}
                            </p>
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
                            {position.pnl.toFixed(2)}%
                          </TableCell>
                        </TableRow>
                      ))}
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
