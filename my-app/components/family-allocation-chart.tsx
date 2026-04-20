"use client";

import { useMemo } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Treemap,
  Tooltip,
  type PieLabelRenderProps,
} from "recharts";

/** 네온 글로우용 팔레트 (한 단계 어둡게 — 채도는 유지) */
const NEON_PALETTE = [
  "#0891B2",
  "#65A30D",
  "#CA8A04",
  "#DB2777",
  "#7C3AED",
  "#0D9488",
];

export type AllocationSlice = {
  name: string;
  displayName: string;
  ticker: string;
  allEntries: { name: string; symbol: string }[];
  value: number;
  weight: number;
  changePct: number;
};

function formatKrw(n: number) {
  return `₩${Math.round(n).toLocaleString()}`;
}

function NeonTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    payload: AllocationSlice;
  }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const entries = p.allEntries.filter((e) => e.name !== "USD 현금" && e.name !== "KRW 현금");
  const isGroup = entries.length > 1;
  return (
    <div className="rounded-lg border border-white/15 bg-zinc-950/95 px-3 py-2 text-xs shadow-[0_0_20px_rgba(0,229,255,0.15)] backdrop-blur-md">
      {isGroup ? (
        <div className="mb-1.5 space-y-1">
          <p className="mb-1 font-bold text-cyan-400">{p.ticker}</p>
          {entries.map((e) => (
            <div key={`${e.symbol}-${e.name}`} className="flex items-baseline gap-1.5">
              <span className="font-semibold text-zinc-300">{e.symbol}</span>
              <span className="text-zinc-500">{e.name}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-1">
          {entries[0]?.symbol && entries[0].symbol !== entries[0].name && (
            <p className="font-bold text-cyan-400">{entries[0].symbol}</p>
          )}
          <p className="font-semibold text-foreground">{p.displayName}</p>
        </div>
      )}
      <p className="text-muted-foreground">
        {formatKrw(p.value)} · {p.weight.toFixed(1)}%
      </p>
    </div>
  );
}

function NeonTreemapNode(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  name?: string;
  value?: number;
  payload?: { ticker?: string; weight?: number; value?: number; changePct?: number };
  root?: { value?: number };
}) {
  const x = props.x ?? 0;
  const y = props.y ?? 0;
  const width = props.width ?? 0;
  const height = props.height ?? 0;
  const idx = props.index ?? 0;
  const fallbackName = props.name ?? "";
  const parsedTicker = fallbackName.startsWith("stk|") ? (fallbackName.split("|")[1] ?? fallbackName) : fallbackName;
  const ticker = props.payload?.ticker ?? parsedTicker;
  const nodeValue = props.payload?.value ?? props.value ?? 0;
  const rootValue = props.root?.value ?? 0;
  const weight = props.payload?.weight ?? (rootValue > 0 ? (nodeValue / rootValue) * 100 : 0);
  const changePct = props.payload?.changePct ?? 0;
  const c = NEON_PALETTE[idx % NEON_PALETTE.length];
  const changeColor = changePct > 0 ? "#ef4444" : changePct < 0 ? "#3b82f6" : "rgba(255,255,255,0.85)";

  if (width < 22 || height < 16) return null;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={c}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth={1}
        style={{ filter: `drop-shadow(0 0 8px ${c}66)` }}
      />
      {width > 40 && height > 22 && (
        <text x={x + 5} y={y + 13} fill="white" fontSize={11} fontWeight={700}>
          {ticker}
        </text>
      )}
      {width > 68 && height > 30 && (
        <text x={x + 5} y={y + 26} fill="rgba(255,255,255,0.85)" fontSize={10}>
          {weight.toFixed(1)}%
        </text>
      )}
      {width > 90 && height > 42 && (
        <text x={x + 5} y={y + 39} fill={changeColor} fontSize={10} fontWeight={700}>
          {changePct > 0 ? "+" : ""}
          {changePct.toFixed(2)}%
        </text>
      )}
    </g>
  );
}

export function FamilyAllocationDonut({
  ownerName,
  data,
  total,
}: {
  ownerName: string;
  data: AllocationSlice[];
  total: number;
}) {
  /** 큰 비율이 12시에서 시작해 시계 방향으로 갈수록 작아지도록 정렬 */
  const chartData = useMemo(
    () => [...data].sort((a, b) => b.value - a.value),
    [data],
  );

  if (data.length === 0) {
    return (
      <div
        className="relative rounded-2xl border border-white/[0.08] p-4"
        style={{
          backgroundImage: `
            repeating-linear-gradient(
              -42deg,
              transparent,
              transparent 10px,
              rgba(255, 255, 255, 0.025) 10px,
              rgba(255, 255, 255, 0.025) 11px
            ),
            linear-gradient(145deg, oklch(0.18 0.01 260) 0%, oklch(0.12 0.02 260) 100%)
          `,
        }}
      >
        <p className="flex min-h-[260px] items-center justify-center text-sm text-zinc-500">
          보유 종목·현금 없음
        </p>
      </div>
    );
  }

  return (
    <div
      className="relative rounded-2xl border border-white/[0.08] p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
      style={{
        backgroundImage: `
          repeating-linear-gradient(
            -42deg,
            transparent,
            transparent 10px,
            rgba(255, 255, 255, 0.03) 10px,
            rgba(255, 255, 255, 0.03) 11px
          ),
          linear-gradient(
            160deg,
            oklch(0.19 0.015 260) 0%,
            oklch(0.11 0.02 260) 55%,
            oklch(0.09 0.02 260) 100%
          )
        `,
      }}
    >
      {/* 상단 글래스 범례 — 차트와 동일: 비중 내림차순 */}
      <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 backdrop-blur-md">
        {chartData.map((d, i) => {
          const c = NEON_PALETTE[i % NEON_PALETTE.length];
          return (
            <div key={d.name} className="flex items-center gap-2 text-[11px] font-medium tracking-tight text-zinc-200">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{
                  backgroundColor: c,
                  boxShadow: `0 0 10px ${c}, 0 0 4px ${c}`,
                }}
              />
              <span title={d.displayName}>
                {d.ticker}{" "}
                <span className="text-zinc-400">{d.weight.toFixed(1)}%</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="relative h-[280px] w-full sm:h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius="52%"
                outerRadius="88%"
                startAngle={90}
                endAngle={-270}
                paddingAngle={2.5}
                stroke="rgba(255,255,255,0.12)"
                strokeWidth={1}
                cornerRadius={4}
                labelLine={false}
                label={(props: PieLabelRenderProps) => {
                  const pct = (props.percent ?? 0) * 100;
                  const RADIAN = Math.PI / 180;
                  const cx = props.cx ?? 0;
                  const cy = props.cy ?? 0;
                  const inner = Number(props.innerRadius) || 0;
                  const outer = Number(props.outerRadius) || 0;
                  const midAngle = props.midAngle ?? 0;
                  const radius = inner + (outer - inner) * 0.55;
                  const x = cx + radius * Math.cos(-midAngle * RADIAN);
                  const y = cy + radius * Math.sin(-midAngle * RADIAN);
                  const c = NEON_PALETTE[(props.index ?? 0) % NEON_PALETTE.length];
                  return (
                    <text
                      x={x}
                      y={y}
                      fill="white"
                      textAnchor="middle"
                      dominantBaseline="central"
                      className={`pointer-events-none select-none font-semibold ${
                        pct < 5 ? "text-[10px]" : "text-xs sm:text-[13px]"
                      }`}
                      style={{
                        textShadow: `0 0 8px ${c}, 0 0 2px rgba(0,0,0,0.9)`,
                      }}
                    >
                      {pct.toFixed(1)}%
                    </text>
                  );
                }}
              >
                {chartData.map((entry, index) => {
                  const c = NEON_PALETTE[index % NEON_PALETTE.length];
                  return (
                    <Cell
                      key={entry.name}
                      fill={c}
                      style={{
                        filter: `drop-shadow(0 0 6px ${c}) drop-shadow(0 0 14px ${c}55)`,
                      }}
                    />
                  );
                })}
              </Pie>
              <Tooltip
                content={<NeonTooltip />}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 50 }}
              />
            </PieChart>
          </ResponsiveContainer>

          {/* 중앙 허브 (이름 + 합계) */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className="flex h-[100px] w-[100px] flex-col items-center justify-center rounded-full border border-white/10 bg-zinc-950/90 text-center backdrop-blur-sm sm:h-[108px] sm:w-[108px]"
              style={{
                boxShadow: `
                  inset 0 2px 16px rgba(0,0,0,0.65),
                  inset 0 -1px 0 rgba(255,255,255,0.06),
                  0 0 0 1px rgba(255,255,255,0.05)
                `,
              }}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                {ownerName}
              </span>
              <span className="mt-0.5 max-w-[100px] truncate text-[13px] font-bold tabular-nums leading-tight text-zinc-100 sm:max-w-[108px] sm:text-sm">
                {formatKrw(total)}
              </span>
            </div>
          </div>
        </div>

        <div className="h-[280px] w-full rounded-xl border border-white/10 bg-zinc-950/40 p-2 sm:h-[320px]">
          <p className="mb-2 px-1 text-[11px] font-medium tracking-wide text-zinc-400">
            GROUP TREEMAP
          </p>
          <ResponsiveContainer width="100%" height="100%">
            <Treemap
              data={chartData}
              dataKey="value"
              stroke="rgba(255,255,255,0.12)"
              content={<NeonTreemapNode />}
              aspectRatio={1.6}
            />
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
