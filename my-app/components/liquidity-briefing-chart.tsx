"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type LiquidityHistoryRow = {
  date: string;
  netLiquidity: number | null;
  netLiquidityPct: number | null;
  dxy: number | null;
  us10y: number | null;
  hySpread: number | null;
  vix: number | null;
  btc: number | null;
  gold: number | null;
  aiSummary: string;
};

type Props = {
  rows: LiquidityHistoryRow[];
};

function fmtNum(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "N/A";
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function LiquidityBriefingChart({ rows }: Props) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">유동성 브리핑 데이터가 아직 없습니다.</p>;
  }

  const last = rows[rows.length - 1];
  const chartRows = rows.map((r) => ({
    date: r.date.slice(5),
    netLiquidityB: r.netLiquidity !== null ? r.netLiquidity / 1000 : null,
    dxy: r.dxy,
    us10y: r.us10y,
    vix: r.vix,
  }));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded border bg-muted/20 p-2">
          <p className="text-muted-foreground">순유동성</p>
          <p className="font-semibold">${fmtNum(last.netLiquidity !== null ? last.netLiquidity / 1000 : null, 1)}B</p>
        </div>
        <div className="rounded border bg-muted/20 p-2">
          <p className="text-muted-foreground">DXY</p>
          <p className="font-semibold">{fmtNum(last.dxy, 2)}</p>
        </div>
        <div className="rounded border bg-muted/20 p-2">
          <p className="text-muted-foreground">미10년</p>
          <p className="font-semibold">{fmtNum(last.us10y, 2)}%</p>
        </div>
        <div className="rounded border bg-muted/20 p-2">
          <p className="text-muted-foreground">VIX</p>
          <p className="font-semibold">{fmtNum(last.vix, 2)}</p>
        </div>
      </div>

      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#71717a" }} />
            <YAxis yAxisId="liq" tick={{ fontSize: 10, fill: "#71717a" }} width={56} />
            <YAxis yAxisId="idx" orientation="right" tick={{ fontSize: 10, fill: "#71717a" }} width={42} />
            <Tooltip
              contentStyle={{
                background: "rgba(9,9,11,0.95)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Line yAxisId="liq" type="monotone" dataKey="netLiquidityB" name="순유동성($B)" stroke="#22d3ee" dot={false} strokeWidth={2} />
            <Line yAxisId="idx" type="monotone" dataKey="dxy" name="DXY" stroke="#f59e0b" dot={false} />
            <Line yAxisId="idx" type="monotone" dataKey="us10y" name="미10년(%)" stroke="#a78bfa" dot={false} />
            <Line yAxisId="idx" type="monotone" dataKey="vix" name="VIX" stroke="#fb7185" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded-lg border bg-muted/20 p-3">
        <p className="mb-1 text-xs text-muted-foreground">AI 요약</p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {last.aiSummary || "AI 요약이 아직 없습니다."}
        </p>
      </div>
    </div>
  );
}
