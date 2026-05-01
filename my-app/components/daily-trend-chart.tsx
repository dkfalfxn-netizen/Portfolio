"use client";

import { useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { DailySnapshot } from "@/app/page";
import { fmtInt } from "@/lib/format-money";

/** 일별 자산 추이 차트 Y축 상한 (개인 라인 가독성용, 단위: 원) */
const Y_AXIS_MAX_KRW = 300_000_000; // 3억

const OWNER_COLORS: Record<string, string> = {
  김승주: "#22d3ee",
  강희진: "#a78bfa",
  김도율: "#34d399",
  김찬율: "#fb923c",
  퇴직연금: "#f472b6",
  전체: "#e2e8f0",
};

function fmt(n: number) {
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(1)}억`;
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(0)}만`;
  return `₩${fmtInt(n)}`;
}
function fmtFull(n: number) {
  return `₩${fmtInt(n)}`;
}

type DiffTooltipData = {
  title: string;
  lines: string[];
};

type LiveChange = {
  date: string;
  changeKrw: number;
  changePct: number | null;
  ownerChanges: Array<{ name: string; changeKrw: number; changePct: number | null }>;
  compareNote?: string;
};

type HoverTooltip = {
  x: number;
  y: number;
  data: DiffTooltipData;
};

function buildDiffTooltipData(current: DailySnapshot, prev: DailySnapshot, owner: string): DiffTooltipData | null {
  const currentBreakdown = current.breakdownValues;
  const prevBreakdown = prev.breakdownValues;
  const hasBreakdown = Boolean(currentBreakdown && prevBreakdown);

  if (!hasBreakdown) {
    return {
      title: `${owner} 자산별 전일비`,
      lines: ["이 날짜는 자산별 상세 내역이 아직 저장되지 않았습니다."],
    };
  }

  const rows: Array<{ label: string; diff: number }> = [];
  const cur = currentBreakdown ?? {};
  const old = prevBreakdown ?? {};
  const allKeys = new Set([...Object.keys(cur), ...Object.keys(old)]);

  for (const key of allKeys) {
    if (owner !== "전체" && !key.startsWith(`${owner} · `)) continue;
    const diff = (cur[key] ?? 0) - (old[key] ?? 0);
    if (diff === 0) continue;
    rows.push({
      label: owner === "전체" ? key : key.replace(`${owner} · `, ""),
      diff,
    });
  }

  if (rows.length === 0) return null;

  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const lines = rows.map((r) => `${r.label}: ${r.diff > 0 ? "+" : ""}${fmtInt(r.diff)}원`);
  return {
    title: `${owner} 자산별 전일비`,
    lines,
  };
}

function buildLiveTooltipData(owner: string, live: LiveChange): DiffTooltipData | null {
  const rows = live.ownerChanges
    .filter((row) => owner === "전체" || row.name.startsWith(`${owner} · `))
    .map((row) => ({
      label: owner === "전체" ? row.name : row.name.replace(`${owner} · `, ""),
      diff: row.changeKrw,
    }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  if (rows.length === 0) return null;
  const lines = rows.map((r) => `${r.label}: ${r.diff > 0 ? "+" : ""}${fmtInt(r.diff)}원`);
  return {
    title: `${owner} 자산별 전일비`,
    lines,
  };
}

type Props = {
  snapshots: DailySnapshot[];
  ownerNames: readonly string[];
  liveChangeByDate?: Record<string, LiveChange>;
};

export function DailyTrendChart({ snapshots, ownerNames, liveChangeByDate }: Props) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const [range, setRange] = useState<30 | 90 | 180>(90);
  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltip | null>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);

  const filtered = snapshots.slice(-range);
  const firstFull = filtered[0]?.date;
  const lastFull = filtered[filtered.length - 1]?.date;

  if (filtered.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        데이터가 아직 없습니다. 매일 앱을 방문하면 자동으로 기록됩니다.
      </p>
    );
  }

  // recharts용 데이터
  const chartData = filtered.map((s) => {
    const row: Record<string, string | number> = { date: s.date.slice(5) }; // MM-DD
    for (const o of ownerNames) {
      row[o] = Math.round(s.ownerValues[o] ?? 0);
    }
    row["전체"] = Math.round(s.totalValue ?? 0);
    return row;
  });

  const visibleOwners = [...ownerNames, "전체"];

  return (
    <div className="space-y-3">
      {filtered.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">
            저장된 일자 {filtered.length}일
          </span>
          {firstFull && lastFull ? (
            <>
              {" "}
              ({firstFull} ~ {lastFull})
            </>
          ) : null}
          . 30·90·180일은 <span className="underline decoration-dotted">보여줄 최대 구간</span>이며,
          그 안에서 실제로 기록된 날만 차트에 표시됩니다.
          <span className="block mt-1">차트 세로축은 0~3억으로 고정되어 있습니다. 전체 자산이 3억을 넘으면 선이 위로 잘릴 수 있습니다.</span>
        </p>
      )}
      {/* 컨트롤 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {([30, 90, 180] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`cursor-pointer rounded px-2.5 py-1 text-xs transition-all ${
                range === r
                  ? "bg-primary text-primary-foreground"
                  : "border hover:bg-muted"
              }`}
            >
              {r}일
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["chart", "table"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`cursor-pointer rounded px-2.5 py-1 text-xs transition-all ${
                mode === m
                  ? "bg-primary text-primary-foreground"
                  : "border hover:bg-muted"
              }`}
            >
              {m === "chart" ? "차트" : "표"}
            </button>
          ))}
        </div>
      </div>

      {mode === "chart" ? (
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "#71717a" }}
                interval="preserveStartEnd"
              />
              <YAxis
                type="number"
                domain={[0, Y_AXIS_MAX_KRW]}
                allowDataOverflow
                niceTicks="none"
                ticks={[0, 75_000_000, 150_000_000, 225_000_000, Y_AXIS_MAX_KRW]}
                tick={{ fontSize: 10, fill: "#71717a" }}
                tickFormatter={(v: number) => fmt(v)}
                width={56}
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(9,9,11,0.95)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v, name) => [fmtFull(Number(v ?? 0)), String(name)]}
                labelStyle={{ color: "#a1a1aa", marginBottom: 4 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
              />
              {visibleOwners.map((o) => (
                <Line
                  key={o}
                  type="monotone"
                  dataKey={o}
                  stroke={OWNER_COLORS[o] ?? "#94a3b8"}
                  strokeWidth={o === "전체" ? 2 : 1.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                  strokeDasharray={o === "전체" ? "6 3" : undefined}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div ref={tableWrapRef} className="relative overflow-x-auto overflow-y-visible">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-1.5 pr-3 text-left font-medium">날짜</th>
                {visibleOwners.map((o) => (
                  <th key={o} className="py-1.5 px-2 text-right font-medium" colSpan={2}>
                    {o}
                  </th>
                ))}
              </tr>
              <tr className="border-b text-[10px] text-muted-foreground/60">
                <th className="pb-1 pr-3" />
                {visibleOwners.map((o) => (
                  <>
                    <th key={`${o}-val`} className="pb-1 px-2 text-right font-normal">평가액</th>
                    <th key={`${o}-chg`} className="pb-1 px-1 text-right font-normal">전일비</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...filtered].reverse().map((s) => {
                const prevIdx = filtered.findIndex((x) => x.date === s.date) - 1;
                const prev = prevIdx >= 0 ? filtered[prevIdx] : null;
                return (
                  <tr key={s.date} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-1.5 pr-3 font-medium tabular-nums">{s.date}</td>
                    {visibleOwners.map((o) => {
                      const val = o === "전체" ? s.totalValue : (s.ownerValues[o] ?? 0);
                      const prevVal = prev
                        ? o === "전체" ? prev.totalValue : (prev.ownerValues[o] ?? 0)
                        : null;
                      const live = liveChangeByDate?.[s.date];
                      const liveDiff = live
                        ? o === "전체"
                          ? live.changeKrw
                          : live.ownerChanges
                              .filter((row) => row.name.startsWith(`${o} · `))
                              .reduce((sum, row) => sum + row.changeKrw, 0)
                        : null;
                      const livePct = live
                        ? o === "전체"
                          ? live.changePct
                          : null
                        : null;
                      const diff = liveDiff !== null ? liveDiff : (prevVal !== null ? val - prevVal : null);
                      const diffPct = livePct !== null ? livePct : (prevVal && prevVal > 0 && diff !== null ? (diff / prevVal) * 100 : null);
                      const diffTooltip = live
                        ? buildLiveTooltipData(o, live)
                        : prev && diff !== null && diff !== 0
                          ? buildDiffTooltipData(s, prev, o)
                          : null;
                      return (
                        <>
                          <td key={`${o}-val`} className="py-1.5 px-2 text-right tabular-nums font-medium">
                            {fmtFull(Math.round(val))}
                          </td>
                          <td
                            key={`${o}-chg`}
                            className={`py-1.5 px-1 text-right tabular-nums text-[11px] ${
                              diff === null
                                ? "text-muted-foreground/40"
                                : diff > 0
                                ? "text-red-400"
                                : diff < 0
                                ? "text-blue-400"
                                : "text-muted-foreground/40"
                            }`}
                          >
                            {diff === null ? "—" : diff === 0 ? "±0" : (
                              <div
                                className={`flex flex-col items-end gap-0 ${diffTooltip ? "cursor-help" : ""}`}
                                onMouseEnter={(e) => {
                                  if (!diffTooltip) return;
                                  const viewportPadding = 16;
                                  const x = Math.min(
                                    Math.max(e.clientX, viewportPadding),
                                    window.innerWidth - viewportPadding,
                                  );
                                  const y = Math.min(
                                    Math.max(e.clientY, viewportPadding),
                                    window.innerHeight - viewportPadding,
                                  );
                                  setHoverTooltip({
                                    x,
                                    y,
                                    data: diffTooltip,
                                  });
                                }}
                                onMouseMove={(e) => {
                                  if (!diffTooltip) return;
                                  const viewportPadding = 16;
                                  const x = Math.min(
                                    Math.max(e.clientX, viewportPadding),
                                    window.innerWidth - viewportPadding,
                                  );
                                  const y = Math.min(
                                    Math.max(e.clientY, viewportPadding),
                                    window.innerHeight - viewportPadding,
                                  );
                                  setHoverTooltip((prev) => (
                                    prev ? { ...prev, x, y } : prev
                                  ));
                                }}
                                onMouseLeave={() => setHoverTooltip(null)}
                              >
                                <span>{diff > 0 ? "+" : ""}{fmtFull(Math.round(diff))}</span>
                                {diffPct !== null && (
                                  <span className="text-[10px] opacity-75">
                                    {diff > 0 ? "+" : ""}{diffPct.toFixed(1)}%
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hoverTooltip && (
            <div
              className="pointer-events-none fixed z-[100] min-w-[220px] max-w-[360px] rounded-xl border bg-popover p-3 text-xs shadow-lg"
              style={{
                left: hoverTooltip.x,
                top: hoverTooltip.y + 12,
                transform: "translate(-50%, 0)",
              }}
            >
              <p className="mb-2 font-semibold text-foreground">{hoverTooltip.data.title}</p>
              <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {hoverTooltip.data.lines.map((line) => (
                  <p key={line} className="text-muted-foreground">{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
