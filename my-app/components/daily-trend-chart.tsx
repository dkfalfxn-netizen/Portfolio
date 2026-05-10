"use client";

import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailySnapshot } from "@/app/page";
import { fmtInt, fmtUsdNumber, fmtEurNumber } from "@/lib/format-money";

const OWNER_COLORS: Record<string, string> = {
  김승주: "#22d3ee",
  강희진: "#a78bfa",
  김도율: "#34d399",
  김찬율: "#fb923c",
  퇴직연금: "#f472b6",
  전체: "#e2e8f0",
};

/** 차트·툴팁에서 사용하는 거래 마커 */
export type DailyTradeMarker = {
  /** 리스트 키용(있으면 사용) */
  id?: string;
  isoDate: string;
  kind: "buy" | "sell";
  owner: string;
  stockName: string;
  symbol: string;
  qty: number;
  unitPrice: number;
  /** 거래 금액 원화 환산(대략적 총액) */
  totalKrw: number;
  currency: "USD" | "EUR" | "KRW";
  /** USD/EUR 일 때 표시용 */
  fxRate?: number;
};

function fmt(n: number) {
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(1)}억`;
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(0)}만`;
  return `₩${fmtInt(n)}`;
}
function fmtFull(n: number) {
  return `₩${fmtInt(n)}`;
}

function fmtUnitPrice(m: DailyTradeMarker): string {
  if (m.currency === "KRW") return `₩${fmtInt(m.unitPrice)}`;
  if (m.currency === "USD") return `$${fmtUsdNumber(m.unitPrice)}`;
  return `€${fmtEurNumber(m.unitPrice)}`;
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

type TradeHover = {
  x: number;
  y: number;
  trades: DailyTradeMarker[];
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

const Y_PAD_RATIO = 0.025;

function computeYDomain(
  rows: Array<Record<string, string | number>>,
  keys: string[],
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    for (const k of keys) {
      const v = row[k];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const d = Math.max(Math.abs(min) * 0.03, 1);
    return [min - d, max + d];
  }
  const span = max - min;
  const pad = span * Y_PAD_RATIO;
  return [min - pad, max + pad];
}

type ScatterPoint = {
  isoDate: string;
  owner: string;
  y: number;
  trades: DailyTradeMarker[];
};

type Props = {
  snapshots: DailySnapshot[];
  ownerNames: readonly string[];
  liveChangeByDate?: Record<string, LiveChange>;
  tradeMarkers?: DailyTradeMarker[];
};

export function DailyTrendChart({ snapshots, ownerNames, liveChangeByDate, tradeMarkers = [] }: Props) {
  const [displayMode, setDisplayMode] = useState<"chart" | "table">("chart");
  const [valueAxisMode, setValueAxisMode] = useState<"krw" | "return">("krw");
  const [range, setRange] = useState<30 | 90 | 180>(90);
  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltip | null>(null);
  const [tradeHover, setTradeHover] = useState<TradeHover | null>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);

  const filtered = snapshots.slice(-range);
  const firstFull = filtered[0]?.date;
  const lastFull = filtered[filtered.length - 1]?.date;
  const visibleOwners = useMemo(() => [...ownerNames, "전체"] as string[], [ownerNames]);
  /** 금액 모드에서는 총자산(전체) 라인을 빼고 보유자별만 표시 → Y축이 개별 추이에 맞게 확대됨 */
  const chartLineKeys = useMemo(
    () => (valueAxisMode === "krw" ? [...ownerNames] : visibleOwners),
    [valueAxisMode, ownerNames, visibleOwners],
  );

  const chartData = useMemo(() => {
    const first = filtered[0];
    if (!first) return [];
    return filtered.map((s) => {
      const row: Record<string, string | number> = { isoDate: s.date, date: s.date.slice(5) };
      for (const o of chartLineKeys) {
        const raw = Math.round(o === "전체" ? s.totalValue : (s.ownerValues[o] ?? 0));
        if (valueAxisMode === "return") {
          const b = o === "전체" ? first.totalValue : (first.ownerValues[o] ?? 0);
          row[o] = b > 0 ? ((raw / b) - 1) * 100 : 0;
        } else {
          row[o] = raw;
        }
      }
      return row;
    });
  }, [filtered, valueAxisMode, chartLineKeys]);

  const [yMin, yMax] = useMemo(
    () => computeYDomain(chartData, chartLineKeys),
    [chartData, chartLineKeys],
  );

  const snapshotDateSet = useMemo(() => new Set(filtered.map((s) => s.date)), [filtered]);

  const tradeScatterData = useMemo(() => {
    const groups = new Map<string, DailyTradeMarker[]>();
    for (const m of tradeMarkers) {
      if (!snapshotDateSet.has(m.isoDate)) continue;
      if (!visibleOwners.includes(m.owner)) continue;
      const key = `${m.isoDate}\t${m.owner}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    const pts: ScatterPoint[] = [];
    for (const [, trades] of groups) {
      const isoDate = trades[0]!.isoDate;
      const owner = trades[0]!.owner;
      const row = chartData.find((r) => r.isoDate === isoDate);
      if (!row) continue;
      const y = row[owner];
      if (typeof y !== "number" || !Number.isFinite(y)) continue;
      pts.push({ isoDate, owner, y, trades });
    }
    return pts;
  }, [tradeMarkers, snapshotDateSet, visibleOwners, chartData]);

  if (filtered.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        데이터가 아직 없습니다. 매일 앱을 방문하면 자동으로 기록됩니다.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {filtered.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">저장된 일자 {filtered.length}일</span>
          {firstFull && lastFull ? (
            <>
              {" "}
              ({firstFull} ~ {lastFull})
            </>
          ) : null}
          . 30·90·180일은 <span className="underline decoration-dotted">보여줄 최대 구간</span>이며, 그 안에서
          실제로 기록된 날만 차트에 표시됩니다.
          <span className="block mt-1">
            세로축은 선택한 구간의 최소·최대 평가액(또는 수익률)에 맞춰 자동으로 맞춰지며, 위아래로 약 2.5% 여백을 둡니다.{" "}
            <span className="text-muted-foreground/90">
              금액 차트는 보유자별 선만 표시하고 총자산(전체) 선은 빼 두었습니다. 수익률 모드에서는 전체·보유자가 함께 표시됩니다.
            </span>
          </span>
          <span className="block mt-1 text-muted-foreground/90">
            거래 점은 해당 일자에 일별 스냅샷이 있을 때만 보입니다.{" "}
            <span className="font-medium text-foreground/80">매도</span>는「매도 기록」,{" "}
            <span className="font-medium text-foreground/80">매수</span>는 이 기기에서「종목 추가」로
            남긴 저널(브라우저에만 저장됩니다)을 사용합니다.
          </span>
        </p>
      )}
      {/* 컨트롤 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {([30, 90, 180] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`cursor-pointer rounded px-2.5 py-1 text-xs transition-all ${
                range === r ? "bg-primary text-primary-foreground" : "border hover:bg-muted"
              }`}
            >
              {r}일
            </button>
          ))}
          {(["krw", "return"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setValueAxisMode(m)}
              aria-pressed={valueAxisMode === m}
              className={`cursor-pointer rounded px-2.5 py-1 text-xs transition-all ${
                valueAxisMode === m ? "bg-primary text-primary-foreground" : "border hover:bg-muted"
              }`}
            >
              {m === "krw" ? "금액" : "수익률"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["chart", "table"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setDisplayMode(m)}
              className={`cursor-pointer rounded px-2.5 py-1 text-xs transition-all ${
                displayMode === m ? "bg-primary text-primary-foreground" : "border hover:bg-muted"
              }`}
            >
              {m === "chart" ? "차트" : "표"}
            </button>
          ))}
        </div>
      </div>

      {displayMode === "chart" ? (
        <div className="h-[504px] w-full sm:h-[576px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
              <XAxis
                dataKey="isoDate"
                type="category"
                tickFormatter={(v: string) => (typeof v === "string" ? v.slice(5) : String(v))}
                tick={{ fontSize: 10, fill: "#71717a" }}
                interval="preserveStartEnd"
              />
              <YAxis
                type="number"
                domain={[yMin, yMax]}
                tick={{ fontSize: 10, fill: "#71717a" }}
                tickFormatter={(v: number) =>
                  valueAxisMode === "return" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : fmt(v)
                }
                width={56}
              />
              <Tooltip
                shared={false}
                isAnimationActive={false}
                cursor={{ stroke: "rgba(148,163,184,0.35)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  if (tradeHover) return null;
                  if (!active || !payload?.length) return null;
                  const row = payload[0];
                  if (!row) return null;
                  const name = String(row.name ?? "");
                  const v = Number(row.value ?? 0);
                  const display =
                    valueAxisMode === "return"
                      ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
                      : fmtFull(v);
                  const iso = (row.payload as Record<string, unknown>)?.isoDate as string | undefined;
                  const dotColor = OWNER_COLORS[name] ?? "#94a3b8";
                  return (
                    <div
                      className="rounded-lg border border-white/12 px-3 py-2 text-xs shadow-lg"
                      style={{
                        background: "rgba(9,9,11,0.95)",
                      }}
                    >
                      {iso ? <p className="mb-1.5 text-[11px] text-zinc-400">{iso}</p> : null}
                      <p className="leading-snug text-foreground">
                        <span className="font-medium" style={{ color: dotColor }}>
                          {name}
                        </span>
                        <span className="text-zinc-500"> · </span>
                        <span className="tabular-nums">{display}</span>
                      </p>
                    </div>
                  );
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={8} />
              {chartLineKeys.map((o) => (
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
              <Scatter
                data={tradeScatterData}
                dataKey="y"
                fill="transparent"
                isAnimationActive={false}
                legendType="none"
                shape={(shapeProps: {
                  cx?: number;
                  cy?: number;
                  payload?: ScatterPoint;
                }) => {
                  const { cx = 0, cy = 0, payload } = shapeProps;
                  const trades = payload?.trades;
                  if (!trades?.length) return null;
                  const hasBuy = trades.some((t) => t.kind === "buy");
                  const hasSell = trades.some((t) => t.kind === "sell");
                  const r = 4;
                  const stroke = "rgba(0,0,0,0.35)";
                  const hitR = hasBuy && hasSell ? 12 : 8;
                  const showTip = (e: ReactMouseEvent<SVGCircleElement>) =>
                    setTradeHover({ x: e.clientX, y: e.clientY, trades });
                  return (
                    <g>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={hitR}
                        fill="transparent"
                        style={{ pointerEvents: "auto", cursor: "default" }}
                        onMouseEnter={showTip}
                        onMouseMove={showTip}
                        onMouseLeave={() => setTradeHover(null)}
                      />
                      {hasBuy ? (
                        <circle
                          cx={cx}
                          cy={hasSell ? cy - 6 : cy}
                          r={r}
                          fill="#22c55e"
                          stroke={stroke}
                          strokeWidth={1}
                          style={{ pointerEvents: "none" }}
                        />
                      ) : null}
                      {hasSell ? (
                        <circle
                          cx={cx}
                          cy={hasBuy ? cy + 6 : cy}
                          r={r}
                          fill="#ef4444"
                          stroke={stroke}
                          strokeWidth={1}
                          style={{ pointerEvents: "none" }}
                        />
                      ) : null}
                    </g>
                  );
                }}
              />
            </ComposedChart>
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
                    <th key={`${o}-val`} className="pb-1 px-2 text-right font-normal">
                      평가액
                    </th>
                    <th key={`${o}-chg`} className="pb-1 px-1 text-right font-normal">
                      전일비
                    </th>
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
                        ? o === "전체"
                          ? prev.totalValue
                          : (prev.ownerValues[o] ?? 0)
                        : null;
                      const live = liveChangeByDate?.[s.date];
                      const liveDiff = live
                        ? o === "전체"
                          ? live.changeKrw
                          : live.ownerChanges
                              .filter((row) => row.name.startsWith(`${o} · `))
                              .reduce((sum, row) => sum + row.changeKrw, 0)
                        : null;
                      const livePct = live ? (o === "전체" ? live.changePct : null) : null;
                      const diff =
                        liveDiff !== null ? liveDiff : prevVal !== null ? val - prevVal : null;
                      const diffPct =
                        livePct !== null
                          ? livePct
                          : prevVal && prevVal > 0 && diff !== null
                            ? (diff / prevVal) * 100
                            : null;
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
                            {diff === null ? (
                              "—"
                            ) : diff === 0 ? (
                              "±0"
                            ) : (
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
                                  setHoverTooltip((prev2) => (prev2 ? { ...prev2, x, y } : prev2));
                                }}
                                onMouseLeave={() => setHoverTooltip(null)}
                              >
                                <span>
                                  {diff > 0 ? "+" : ""}
                                  {fmtFull(Math.round(diff))}
                                </span>
                                {diffPct !== null && (
                                  <span className="text-[10px] opacity-75">
                                    {diff > 0 ? "+" : ""}
                                    {diffPct.toFixed(1)}%
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
                  <p key={line} className="text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tradeHover && displayMode === "chart" && (
        <div
          className="pointer-events-none fixed z-[200] min-w-[240px] max-w-[min(380px,calc(100vw-24px))] rounded-xl border bg-popover p-3 text-xs shadow-lg"
          style={(() => {
            const pad = 12;
            const wEst = 320;
            const placeRight = tradeHover.x < window.innerWidth * 0.45;
            const left = placeRight
              ? Math.min(tradeHover.x + pad, window.innerWidth - wEst - pad)
              : Math.max(pad, tradeHover.x - wEst - pad);
            const top = Math.min(
              Math.max(pad, tradeHover.y - 8),
              window.innerHeight - 120,
            );
            return { left, top };
          })()}
        >
          {tradeHover.trades.map((t) => (
            <div
              key={t.id ?? `${t.kind}-${t.isoDate}-${t.owner}-${t.symbol}-${t.qty}-${t.unitPrice}`}
              className="mb-3 last:mb-0"
            >
              <p className="mb-1 font-semibold text-foreground">
                <span className={t.kind === "buy" ? "text-emerald-400" : "text-red-400"}>
                  {t.kind === "buy" ? "매수" : "매도"}
                </span>
                {" · "}
                {t.stockName}
                {t.symbol ? ` (${t.symbol})` : ""}
              </p>
              <p className="text-muted-foreground">
                보유자 {t.owner} · 수량 {fmtUsdNumber(t.qty, 0, 6)} · 단가 {fmtUnitPrice(t)}
              </p>
              {t.currency !== "KRW" && t.fxRate != null && t.fxRate > 0 && (
                <p className="text-[10px] text-muted-foreground/80">적용 환율 ₩{fmtInt(t.fxRate)}</p>
              )}
              <p className="mt-0.5 font-medium text-foreground">거래 총액(원화 환산) {fmtFull(Math.round(t.totalKrw))}</p>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
