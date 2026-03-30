"use client";

import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
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
  value: number;
  weight: number;
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
  return (
    <div className="rounded-lg border border-white/15 bg-zinc-950/95 px-3 py-2 text-xs shadow-[0_0_20px_rgba(0,229,255,0.15)] backdrop-blur-md">
      <p className="font-semibold text-foreground">{p.displayName}</p>
      <p className="text-muted-foreground">
        {formatKrw(p.value)} · {p.weight.toFixed(1)}%
      </p>
    </div>
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
  if (data.length === 0) {
    return (
      <div
        className="relative overflow-hidden rounded-2xl border border-white/[0.08] p-4"
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
        <p className="flex min-h-[200px] items-center justify-center text-sm text-zinc-500">
          보유 종목·현금 없음
        </p>
      </div>
    );
  }

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-white/[0.08] p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
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
      {/* 상단 글래스 범례 */}
      <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 backdrop-blur-md">
        {data.map((d, i) => {
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

      <div className="relative h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="58%"
              outerRadius="82%"
              paddingAngle={2.5}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={1}
              cornerRadius={4}
              labelLine={false}
              label={(props: PieLabelRenderProps) => {
                const pct = (props.percent ?? 0) * 100;
                if (pct < 5) return null;
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
                    className="pointer-events-none select-none text-[11px] font-semibold"
                    style={{
                      textShadow: `0 0 8px ${c}, 0 0 2px rgba(0,0,0,0.9)`,
                    }}
                  >
                    {pct.toFixed(0)}%
                  </text>
                );
              }}
            >
              {data.map((entry, index) => {
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
            <Tooltip content={<NeonTooltip />} />
          </PieChart>
        </ResponsiveContainer>

        {/* 중앙 허브 (이름 + 합계) */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className="flex h-[88px] w-[88px] flex-col items-center justify-center rounded-full border border-white/10 bg-zinc-950/90 text-center backdrop-blur-sm"
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
            <span className="mt-0.5 max-w-[88px] truncate text-xs font-bold tabular-nums text-zinc-100">
              {formatKrw(total)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
