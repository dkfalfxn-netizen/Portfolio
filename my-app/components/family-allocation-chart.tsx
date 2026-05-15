"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import {
  HAS_LOCAL_CHANGES_KEY,
  loadAllCalculatorMemberSplitModes,
  loadAllCalculatorMemberSplits,
  loadAllTargetStockWeights,
  PORTFOLIO_TARGET_REL_DEV_BAND,
  PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT,
  REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT,
  TARGET_WEIGHT_STORAGE_KEY,
} from "@/lib/portfolio-target-weights";
import {
  loadAllOwnerScratchpads,
  persistOneOwnerScratchpad,
  pushTargetWeightsAndScratchpadsToServer,
} from "@/lib/portfolio-owner-scratchpad";
import { GripVertical } from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  loadVisualOrderKeysForOwner,
  persistVisualOrderForOwner,
  REBALANCE_VISUAL_ORDER_REFRESH_EVENT,
} from "@/lib/rebalance-visual-order";
import { fmtInt } from "@/lib/format-money";
import { memberPortfolioTargetPctMap } from "@/lib/rebalance-member-portfolio-targets";
import { type SplitAmountMode, approxPortfolioPctAfterDelta, perSplitKrwCore } from "@/lib/rebalance-split-amount";
const NEON_PALETTE = [
  "#0891B2",
  "#65A30D",
  "#CA8A04",
  "#DB2777",
  "#7C3AED",
  "#0D9488",
];

/** 목표 비중 합계 100% 허용 오차 (%) */
const TARGET_SUM_TOLERANCE = 0.05;

function OwnerScratchPad({
  ownerName,
  cloudSyncKey = "",
}: {
  ownerName: string;
  /** 8자 이상이면 메모 변경 후 디바운스로 서버에도 반영 */
  cloudSyncKey?: string;
}) {
  const [text, setText] = useState("");
  const persistLocalTimerRef = useRef<number | null>(null);
  const cloudTimerRef = useRef<number | null>(null);

  const refreshFromStorage = useCallback(() => {
    const all = loadAllOwnerScratchpads();
    setText(typeof all[ownerName] === "string" ? all[ownerName] : "");
  }, [ownerName]);

  useEffect(() => {
    queueMicrotask(() => {
      refreshFromStorage();
    });
  }, [refreshFromStorage]);

  useEffect(() => {
    const onRefresh = () => refreshFromStorage();
    window.addEventListener("portfolio-owner-scratchpads-refresh", onRefresh);
    return () => window.removeEventListener("portfolio-owner-scratchpads-refresh", onRefresh);
  }, [refreshFromStorage]);

  useEffect(() => {
    return () => {
      if (persistLocalTimerRef.current != null) window.clearTimeout(persistLocalTimerRef.current);
      if (cloudTimerRef.current != null) window.clearTimeout(cloudTimerRef.current);
    };
  }, []);

  const flushCloud = useCallback(() => {
    const key = cloudSyncKey.trim();
    if (key.length < 8) return;
    void pushTargetWeightsAndScratchpadsToServer(key);
  }, [cloudSyncKey]);

  const syncHint =
    cloudSyncKey.trim().length >= 8
      ? `숫자·식 메모 (${ownerName}) — 로컬·서버(동기화 키)`
      : `숫자·식 메모 (${ownerName}) — 이 브라우저에만 저장`;

  return (
    <div className="mt-3 w-full min-w-0">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        메모·계산용
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (persistLocalTimerRef.current != null) window.clearTimeout(persistLocalTimerRef.current);
          persistLocalTimerRef.current = window.setTimeout(() => {
            persistLocalTimerRef.current = null;
            persistOneOwnerScratchpad(ownerName, v);
            if (cloudTimerRef.current != null) window.clearTimeout(cloudTimerRef.current);
            cloudTimerRef.current = window.setTimeout(() => {
              cloudTimerRef.current = null;
              flushCloud();
            }, 900);
          }, 180);
        }}
        rows={5}
        spellCheck={false}
        placeholder={syncHint}
        className="min-h-[5.5rem] w-full resize-y rounded-lg border border-white/12 bg-[#0d1118]/95 px-2 py-1.5 text-[11px] leading-snug text-zinc-200 placeholder:text-zinc-600 outline-none ring-sky-500/30 focus:ring-1"
        style={{
          boxShadow: "inset 2px 2px 5px rgba(0,0,0,0.45), inset -1px -1px 3px rgba(255,255,255,0.03)",
          fontFamily: 'ui-monospace, "Cascadia Code", monospace',
        }}
        aria-label={`${ownerName} 메모·계산용 칸`}
      />
    </div>
  );
}

function formatSavedTime(): string {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export type AllocationSlice = {
  name: string;
  displayName: string;
  ticker: string;
  allEntries: { name: string; symbol: string; weight?: number }[];
  value: number;
  weight: number;
  changePct: number | null;
};

/** 포트폴리오 비중 리밸런싱 목록에서 맨 아래로 보낼 슬라이스 (예수금·현금 조각·차트그룹「현금」합산) */
function isCashRebalanceTicker(ticker: string): boolean {
  const t = ticker.trim();
  return t === "현금" || t === "USD 현금" || t === "KRW 현금";
}

/** 현물 비중(%) 내림차순 — USD/KRW 현금 행은 제외 */
function nonCashEntriesSortedByWeight(
  allEntries: AllocationSlice["allEntries"],
): AllocationSlice["allEntries"] {
  return allEntries
    .filter((e) => e.name !== "USD 현금" && e.name !== "KRW 현금")
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

/** 현금 통합 조각 툴팁: 이름이 「USD 현금」「KRW 현금」인 줄은 표시명 기준 한 줄로 합침 (% 가산) */
function rollupCashTooltipEntries(
  entries: AllocationSlice["allEntries"],
): AllocationSlice["allEntries"] {
  const map = new Map<string, { name: string; symbol: string; weight: number }>();
  for (const e of entries) {
    const nm = typeof e.name === "string" ? e.name.trim() : "";
    const symRaw = typeof e.symbol === "string" ? e.symbol.trim() : "";
    const w = typeof e.weight === "number" && Number.isFinite(e.weight) ? e.weight : 0;
    const key =
      nm === "USD 현금" || nm === "KRW 현금"
        ? `__byName__:${nm}`
        : `${symRaw.toUpperCase()}\n${nm}`;
    const cur = map.get(key);
    if (cur) cur.weight += w;
    else
      map.set(key, {
        name: nm,
        symbol: nm === "USD 현금" || nm === "KRW 현금" ? "" : symRaw,
        weight: w,
      });
  }
  return Array.from(map.values()).map((v) => ({
    name: v.name,
    symbol: v.symbol,
    weight: v.weight,
  }));
}

/** 툴팁 등: 현금 통합 조각에서는 USD/KRW·종목 줄 모두 노출 */
function entriesForAllocationTooltip(slice: Pick<AllocationSlice, "ticker" | "allEntries">) {
  if (slice.ticker === "현금") {
    return rollupCashTooltipEntries(slice.allEntries).sort(
      (a, b) => (b.weight ?? 0) - (a.weight ?? 0),
    );
  }
  return nonCashEntriesSortedByWeight(slice.allEntries);
}

function mapNumGetInsensitive(m: Record<string, number>, key: string): number | undefined {
  const t = key.trim();
  if (t === "") return undefined;
  const v0 = m[t];
  if (Number.isFinite(v0)) return v0;
  const u = t.toUpperCase();
  for (const [rk, v] of Object.entries(m)) {
    if (rk.trim().toUpperCase() === u && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** 저장소에 심볼 키로 직접 있는 목표 %(포트 전체) — 계산기 분배보다 우선 */
function directSavedPortfolioTargetPct(symbol: string, saved: Record<string, number>): number | null {
  const v = mapNumGetInsensitive(saved, symbol);
  return v !== undefined ? v : null;
}

function fmtCurrentVersusPortfolioTargetTooltip(
  currentSlicePct: number,
  portfolioTargetPct: number | null,
): string {
  const c = `${currentSlicePct.toFixed(1)}%`;
  if (portfolioTargetPct === null || !Number.isFinite(portfolioTargetPct)) return `현재 ${c}`;
  return `현재 ${c} · 목표 ${portfolioTargetPct.toFixed(1)}%`;
}

/** 복수 종목 그룹: 계산기 분배·모드와 동일 규칙으로 종목별 포트 전체 목표 % */
function computeGroupedMemberPortfolioTargets(
  ownerName: string,
  slice: Pick<AllocationSlice, "ticker" | "allEntries">,
  groupTargetPct: number,
): Record<string, number> {
  if (typeof window === "undefined") return {};
  const inner = entriesForAllocationTooltip(slice);
  if (inner.length < 2) return {};
  const splitsRoot = loadAllCalculatorMemberSplits();
  const modesRoot = loadAllCalculatorMemberSplitModes();
  const splitNumeric = splitsRoot[ownerName]?.[slice.ticker] ?? {};
  const mode = modesRoot[ownerName]?.[slice.ticker] ?? "targetPct";
  const syms = inner.map((e) => e.symbol.trim()).filter((s) => s.length > 0);
  const ws = inner.map((e) => e.weight ?? 0);
  return memberPortfolioTargetPctMap({
    groupTargetPct,
    memberSymbolsOrdered: syms,
    withinSliceWeights: ws,
    splitNumeric,
    mode,
  });
}

function resolvePortfolioTargetPctForTooltip(
  slice: Pick<AllocationSlice, "ticker" | "allEntries">,
  saved: Record<string, number>,
  entrySymbol: string,
  groupedMemberMap: Record<string, number>,
  isGrouped: boolean,
): number | null {
  const dir = directSavedPortfolioTargetPct(entrySymbol, saved);
  if (dir !== null) return dir;
  const hasGroupRow = Object.prototype.hasOwnProperty.call(saved, slice.ticker);
  if (!hasGroupRow) return null;
  const gTar = saved[slice.ticker] ?? 0;
  if (!Number.isFinite(gTar)) return null;
  if (!isGrouped) return gTar;
  const mapped = mapNumGetInsensitive(groupedMemberMap, entrySymbol);
  return mapped !== undefined ? mapped : null;
}

function formatKrw(n: number) {
  return `₩${fmtInt(n)}`;
}

function shadeHexToWhite(hex: string, f: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgb(${Math.round(r + (255 - r) * f)},${Math.round(g + (255 - g) * f)},${Math.round(b + (255 - b) * f)})`;
}

function shadeHexToBlack(hex: string, f: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgb(${Math.round(r * (1 - f))},${Math.round(g * (1 - f))},${Math.round(b * (1 - f))})`;
}

function NeonTooltip({
  active,
  payload,
  ownerName,
}: {
  active?: boolean;
  payload?: Array<{
    payload: AllocationSlice;
  }>;
  ownerName: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const entries = entriesForAllocationTooltip(p);
  const isGroup = entries.length > 1;
  const saved =
    typeof window !== "undefined" ? (loadAllTargetStockWeights()[ownerName] ?? {}) : {};
  const hasGroupRow = Object.prototype.hasOwnProperty.call(saved, p.ticker);
  const groupTarNum = saved[p.ticker] ?? 0;
  const groupedMemberMap =
    typeof window !== "undefined" && hasGroupRow && isGroup ?
      computeGroupedMemberPortfolioTargets(ownerName, p, groupTarNum)
    : {};
  return (
    <div className="rounded-lg border border-white/15 bg-zinc-950/95 px-3 py-2 text-xs shadow-[0_0_20px_rgba(0,229,255,0.15)] backdrop-blur-md">
      {isGroup ? (
        <div className="mb-1.5 space-y-1">
          <div className="mb-0.5">
            <p className="font-bold text-cyan-400">{p.ticker}</p>
            {hasGroupRow ?
              <p className="text-[10px] tabular-nums text-zinc-500">
                그룹 목표 {groupTarNum.toFixed(1)}% · 포트 전체
              </p>
            : null}
          </div>
          {entries.map((e, ei) => (
            <div
              key={`${p.ticker}-tt-${ei}-${e.symbol}-${e.name}`}
              className="flex items-baseline justify-between gap-3"
            >
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 font-semibold text-zinc-300">{e.symbol}</span>
                <span className="truncate text-zinc-500">{e.name}</span>
              </div>
              <span className="shrink-0 whitespace-nowrap tabular-nums text-zinc-300">
                {fmtCurrentVersusPortfolioTargetTooltip(
                  e.weight ?? 0,
                  resolvePortfolioTargetPctForTooltip(p, saved, e.symbol, groupedMemberMap, true),
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-1">
          {entries[0]?.symbol && entries[0].symbol !== entries[0].name && (
            <p className="font-bold text-cyan-400">{entries[0].symbol}</p>
          )}
          <p className="font-semibold text-foreground">{p.displayName}</p>
          <p className="mt-0.5 tabular-nums text-zinc-400">
            {fmtCurrentVersusPortfolioTargetTooltip(
              entries[0]?.weight ?? 0,
              resolvePortfolioTargetPctForTooltip(
                p,
                saved,
                entries[0]?.symbol ?? "",
                groupedMemberMap,
                false,
              ),
            )}
          </p>
        </div>
      )}
      <p className="text-muted-foreground">
        {formatKrw(p.value)} · 현재 포트 {p.weight.toFixed(1)}%
        {hasGroupRow ?
          <>
            {" "}
            · 그룹 목표 {groupTarNum.toFixed(1)}%
          </>
        : null}
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
  payload?: { ticker?: string; weight?: number; value?: number; changePct?: number | null };
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
  const changePct = props.payload?.changePct ?? null;
  const c = NEON_PALETTE[idx % NEON_PALETTE.length];
  const changeColor =
    changePct === null ? "rgba(255,255,255,0.72)" : changePct > 0 ? "#ef4444" : changePct < 0 ? "#3b82f6" : "rgba(255,255,255,0.85)";

  if (width < 22 || height < 16) return null;

  const gradId = `tm3d-${idx}-${String(ticker).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}-${Math.round(x)}-${Math.round(y)}`;
  const cHi = shadeHexToWhite(c, 0.32);
  const cLo = shadeHexToBlack(c, 0.38);
  const cMid = c;

  return (
    <g>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={cHi} stopOpacity={1} />
          <stop offset="48%" stopColor={cMid} stopOpacity={1} />
          <stop offset="100%" stopColor={cLo} stopOpacity={1} />
        </linearGradient>
        <filter id={`${gradId}-sh`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="rgba(0,0,0,0.45)" />
          <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor={c} floodOpacity="0.32" />
        </filter>
      </defs>
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={width - 1}
        height={height - 1}
        rx={5}
        ry={5}
        fill={`url(#${gradId})`}
        filter={`url(#${gradId}-sh)`}
        stroke="rgba(0,0,0,0.28)"
        strokeWidth={0.75}
        style={{ paintOrder: "stroke fill" }}
      />
      <line
        x1={x + 1.5}
        y1={y + 1.5}
        x2={x + width - 1.5}
        y2={y + 1.5}
        stroke="rgba(255,255,255,0.2)"
        strokeWidth={0.6}
        strokeLinecap="round"
        opacity={0.85}
      />
      <line
        x1={x + 1.5}
        y1={y + 1.5}
        x2={x + 1.5}
        y2={y + height - 1.5}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={0.5}
        opacity={0.75}
      />
      {width > 40 && height > 22 && (
        <text x={x + 5} y={y + 13} fill="white" fontSize={11} fontWeight={700}>
          {ticker}
        </text>
      )}
      {width > 42 && height > 22 && (
        <text x={x + 5} y={y + 26} fill="rgba(255,255,255,0.9)" fontSize={10} fontWeight={700}>
          {weight.toFixed(1)}%
        </text>
      )}
      {width > 78 && height > 36 && (
        <text x={x + 5} y={y + 39} fill={changeColor} fontSize={10} fontWeight={700}>
          {changePct === null ? "--" : `${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%`}
        </text>
      )}
    </g>
  );
}

function formatKrwCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 1_0000_0000) {
    return `${sign}${(abs / 1_0000_0000).toFixed(1)}억`;
  }
  if (abs >= 10_000) {
    return `${sign}${fmtInt(Math.round(abs / 10_000))}만`;
  }
  return `${sign}${fmtInt(Math.round(abs))}원`;
}

/** 목표 % 표시용 — 정수면 소수 생략 */
function fmtTargetPctLabel(targetPct: number): string {
  if (!Number.isFinite(targetPct)) return "—";
  const rounded = Math.round(targetPct * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
  return rounded.toFixed(1);
}

/** 목표 바 한 줄 — 비현금만 드래그 정렬 가능 */
function TargetWeightSortableBarRow({
  slice,
  targetsByTicker,
  setTarget,
  TARGET_AT,
  MAX_RATIO,
  ownerName,
  calcSplitBump,
}: {
  slice: AllocationSlice;
  targetsByTicker: Record<string, number>;
  setTarget: (ticker: string, raw: string) => void;
  TARGET_AT: number;
  MAX_RATIO: number;
  ownerName: string;
  calcSplitBump: number;
}) {
  const isCashRow = isCashRebalanceTicker(slice.ticker);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slice.ticker,
    disabled: isCashRow,
  });
  const hasInputTarget = Object.prototype.hasOwnProperty.call(targetsByTicker, slice.ticker);
  const target = targetsByTicker[slice.ticker] ?? 0;
  const actual = slice.weight;
  const hasPositiveTarget = target > 0;
  const isOverTargetWhenZero = hasInputTarget && !hasPositiveTarget && actual > 0;

  const NO_TARGET_REF = 10;
  const ratio = hasPositiveTarget
    ? actual / target
    : isOverTargetWhenZero
      ? MAX_RATIO
      : !hasInputTarget && actual > 0
        ? actual / NO_TARGET_REF
        : 0;
  const barWidthPct = (Math.min(ratio, MAX_RATIO) / MAX_RATIO) * 100;
  const isClipped = ratio > MAX_RATIO;

  const relDev = hasPositiveTarget ? (actual - target) / target : 0;
  const withinBand = hasPositiveTarget && Math.abs(relDev) <= PORTFOLIO_TARGET_REL_DEV_BAND;
  const belowBand = hasPositiveTarget && relDev < -PORTFOLIO_TARGET_REL_DEV_BAND;
  const diffPp = actual - target;

  const barBg = !hasInputTarget
    ? "rgba(255,255,255,0.07)"
    : withinBand
      ? "linear-gradient(to right, rgb(29,78,216), rgb(14,165,233))"
      : belowBand
        ? "linear-gradient(to right, rgb(153,27,27), rgb(220,38,38), rgb(248,113,113))"
        : "linear-gradient(to right, rgb(20,83,45), rgb(22,163,74), rgb(52,211,153))";
  const barGlow = !hasInputTarget
    ? undefined
    : withinBand
      ? "0 0 8px rgba(56,189,248,0.35)"
      : belowBand
        ? "0 0 8px rgba(248,113,113,0.45)"
        : "0 0 8px rgba(52,211,153,0.4)";

  const tooltipEntries = entriesForAllocationTooltip(slice);
  const isGrouped = tooltipEntries.length > 1;

  const groupedMemberMap = useMemo(() => {
    void calcSplitBump;
    const gTar = targetsByTicker[slice.ticker] ?? 0;
    if (!hasInputTarget || !isGrouped) return {} as Record<string, number>;
    return computeGroupedMemberPortfolioTargets(ownerName, slice, gTar);
  }, [
    calcSplitBump,
    ownerName,
    slice,
    slice.ticker,
    slice.allEntries,
    targetsByTicker,
    hasInputTarget,
    isGrouped,
  ]);

  const outerStyle =
    !isCashRow ?
      ({
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.92, zIndex: 4, position: "relative" as const } : {}),
      })
    : undefined;

  return (
    <div ref={setNodeRef} style={outerStyle} className="group relative flex min-h-0 items-center gap-1 py-0 leading-none">
      {!isCashRow ?
        <button
          type="button"
          className="touch-none shrink-0 cursor-grab rounded p-0.5 text-zinc-500 hover:text-zinc-300 active:cursor-grabbing"
          title="순서 이동 (드래그)"
          {...attributes}
          {...listeners}
          aria-label={`${slice.ticker} 순서 변경`}
        >
          <GripVertical className="h-3 w-3" />
        </button>
      : <span className="w-[22px] shrink-0" aria-hidden />}

      {tooltipEntries.length > 0 && (
        <div className="pointer-events-none absolute bottom-[calc(100%+4px)] left-0 z-30 hidden w-max min-w-[160px] rounded-lg border border-white/15 bg-zinc-950/95 px-2 py-1.5 text-[9px] shadow-[0_0_20px_rgba(0,229,255,0.15)] backdrop-blur-md group-hover:block">
          {isGrouped ?
            <div className="space-y-1">
              <div>
                <p className="font-bold text-cyan-400">{slice.ticker}</p>
                {hasInputTarget ?
                  <p className="text-[9px] tabular-nums text-zinc-500">그룹 목표 {target.toFixed(1)}%</p>
                : null}
              </div>
              {tooltipEntries.map((e, ei) => (
                <div
                  key={`${slice.ticker}-bar-${ei}-${e.symbol}-${e.name}`}
                  className="flex items-baseline justify-between gap-3"
                >
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 font-semibold text-zinc-300">{e.symbol}</span>
                    <span className="truncate text-zinc-500">{e.name}</span>
                  </div>
                  <span className="shrink-0 whitespace-nowrap tabular-nums text-zinc-300">
                    {fmtCurrentVersusPortfolioTargetTooltip(
                      e.weight ?? 0,
                      resolvePortfolioTargetPctForTooltip(slice, targetsByTicker, e.symbol, groupedMemberMap, true),
                    )}
                  </span>
                </div>
              ))}
            </div>
          : <div className="space-y-0.5">
              <p className="font-bold text-cyan-400">{tooltipEntries[0].symbol || slice.ticker}</p>
              <p className="font-semibold text-zinc-200">{tooltipEntries[0].name || slice.displayName}</p>
              <p className="tabular-nums text-zinc-400">
                {fmtCurrentVersusPortfolioTargetTooltip(
                  tooltipEntries[0].weight ?? 0,
                  resolvePortfolioTargetPctForTooltip(
                    slice,
                    targetsByTicker,
                    tooltipEntries[0].symbol ?? "",
                    groupedMemberMap,
                    false,
                  ),
                )}
              </p>
            </div>
          }
        </div>
      )}

      <div className="flex w-[118px] shrink-0 items-center gap-1 sm:w-[124px]">
        <span
          className="min-w-0 flex-1 truncate text-[9px] font-normal leading-tight text-zinc-300 tabular-nums"
          title={slice.displayName || slice.ticker}
        >
          {slice.displayName && slice.displayName !== slice.ticker
            ? `${slice.ticker} (${slice.displayName})`
            : slice.ticker}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            placeholder="—"
            aria-label={`${slice.ticker} 목표 비중 %`}
            className="w-7 rounded border border-white/10 bg-zinc-900/80 px-0.5 py-px text-right text-[9px] tabular-nums text-zinc-100 outline-none ring-sky-500/40 [appearance:textfield] placeholder:text-zinc-600 focus:ring-1 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            style={{ boxShadow: "inset 2px 2px 4px rgba(0,0,0,0.5)" }}
            value={hasInputTarget ? String(targetsByTicker[slice.ticker]) : ""}
            onChange={(e) => setTarget(slice.ticker, e.target.value)}
          />
          <span className="text-[8px] text-zinc-600">%</span>
        </div>
      </div>

      <div className="w-8 shrink-0 text-right text-[8px] font-normal tabular-nums leading-none text-zinc-500">
        {slice.weight.toFixed(2)}%
      </div>
      <div
        className="hidden w-[4.25rem] shrink-0 truncate text-right text-[8px] tabular-nums leading-none text-zinc-500 md:block"
        title={formatKrw(Math.round(slice.value))}
      >
        {formatKrw(Math.round(slice.value))}
      </div>

      <div
        className="relative h-[13px] flex-1 overflow-hidden rounded-sm"
        style={{ background: "rgba(255,255,255,0.04)" }}
      >
        {/* 0~100% 달성도 축 기준 33%·66% (상단 눈금 25·50·75와 같은 좌표계; 목표선=100%와 겹치지 않음) */}
        {[33, 66].map((pct) => (
          <div
            key={pct}
            className="pointer-events-none absolute top-0 z-[5] h-full w-px"
            style={{
              left: `${(pct / 100) * TARGET_AT * 100}%`,
              borderRight: "1px dashed rgba(161,161,170,0.32)",
            }}
          />
        ))}
        <div
          className="pointer-events-none absolute top-0 z-10 h-full w-px"
          style={{
            left: `${TARGET_AT * 100}%`,
            borderRight: "1px dashed rgba(161,161,170,0.55)",
          }}
        />
        {barWidthPct > 0 ?
          <div
            className="absolute left-0 top-px bottom-px rounded-sm transition-all duration-300"
            style={{ width: `${barWidthPct}%`, background: barBg, boxShadow: barGlow }}
          />
        : hasInputTarget && !hasPositiveTarget ?
          <div
            className="absolute left-0 top-px bottom-px w-[3px] rounded-sm opacity-70"
            style={{ background: "rgba(161,161,170,0.5)" }}
          />
        : null}
        {isClipped ?
          <span className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[7px] text-emerald-300/70">›</span>
        : null}
      </div>

      <div className="w-[4.5rem] shrink-0 text-right text-[8px] tabular-nums leading-snug sm:w-[4.75rem]">
        {!hasInputTarget ?
          <span className="text-zinc-600">—</span>
        : !hasPositiveTarget && actual > 0 ?
          <span className="text-emerald-400">목표 0% ▼ +{actual.toFixed(1)}%p</span>
        : !hasPositiveTarget ?
          <span className="text-zinc-400">목표 0%</span>
        : withinBand ?
          <span className="text-sky-400">≈ 목표</span>
        : belowBand ?
          <span className="text-red-400">▲ {Math.abs(diffPp).toFixed(1)}%p 부족</span>
        : <span className="text-emerald-400">▼ +{diffPp.toFixed(1)}%p 초과</span>}
      </div>
    </div>
  );
}

/** 포트폴리오 비중 그리드 첫 칸용 — 모든 보유자 오늘 수익 요약 */
export type OwnerDailyPortfolioSummary = {
  ownerName: string;
  totalDailyKrw: number;
  /** 보유 평가(전일 종가 기준 주식·현금 포함) 대비 오늘 등락 % */
  totalDailyPct: number | null;
  groups: {
    label: string;
    dailyChangeKrw: number;
    dailyChangePct: number | null;
    /** 그룹명 hover 툴팁용 종목 목록 (ticker · name · 개별 등락%) */
    holdingsItems: { ticker: string; name: string; pct: number | null }[];
  }[];
};

/** 그룹명 위에 hover 시 나타나는 종목별 팝업 — [티커] [종목명] [등락%] 3열 */
function GroupLabelWithTooltip({
  label,
  holdingsItems,
}: {
  label: string;
  holdingsItems: { ticker: string; name: string; pct: number | null }[];
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const pctColor = (pct: number | null) =>
    pct === null ? "text-zinc-500" : pct > 0 ? "text-red-400" : pct < 0 ? "text-blue-400" : "text-zinc-500";

  return (
    <>
      <span
        className="min-w-0 cursor-help truncate border-b border-dotted border-zinc-600/60 text-zinc-400 hover:text-zinc-200"
        onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setPos(null)}
      >
        {label}
      </span>
      {pos !== null &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] rounded-lg border border-white/[0.12] bg-[#1a1f2e] shadow-2xl"
            style={{ left: pos.x + 14, top: pos.y - 6 }}
          >
            {/* 그룹명 헤더 — 이미지의 "S&P500" 스타일 */}
            <div className="border-b border-white/[0.1] px-3 py-2">
              <span className="text-[13px] font-bold text-zinc-100">{label}</span>
            </div>
            {/* 종목 행: [티커] [종목명] [등락%] */}
            <div className="px-3 py-1.5">
              {holdingsItems.map((item) => (
                <div
                  key={item.ticker}
                  className="flex items-center gap-3 py-[3px] text-[12px]"
                >
                  <span className="w-[4.5rem] shrink-0 tabular-nums font-medium text-zinc-300">
                    {item.ticker}
                  </span>
                  <span className="min-w-[8rem] flex-1 text-zinc-200">
                    {item.name !== item.ticker ? item.name : ""}
                  </span>
                  <span className={`w-[3.5rem] shrink-0 text-right tabular-nums ${pctColor(item.pct)}`}>
                    {item.pct !== null
                      ? `${item.pct > 0 ? "+" : ""}${item.pct.toFixed(1)}%`
                      : "0.0%"}
                  </span>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function PortfolioAllOwnersTodayProfitCard({
  owners,
}: {
  owners: OwnerDailyPortfolioSummary[];
}) {
  const krwTone = (n: number) =>
    n > 0 ? "text-red-400" : n < 0 ? "text-blue-400" : "text-zinc-500";

  return (
    <div
      className="relative rounded-2xl border border-white/[0.08] p-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]"
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
      <div className="mb-2 border-b border-white/10 pb-2">
        <h3 className="text-xs font-bold leading-tight text-zinc-100 sm:text-[13px]">오늘 수익 요약</h3>
        <p className="mt-0.5 text-[9px] text-zinc-500">보유자별 · 그룹명에 마우스를 올리면 종목별 등락</p>
      </div>

      {owners.length === 0 ? (
        <p className="py-4 text-center text-[11px] text-zinc-500">요약 데이터가 없습니다.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {owners.map((owner) => (
            <div
              key={owner.ownerName}
              className="rounded-lg border border-white/[0.07] bg-zinc-950/35 px-2 py-1.5"
            >
              {/* 보유자 합계 헤더 */}
              <div className="mb-1 border-b border-white/[0.06] pb-1">
                <span className="block text-[11px] font-semibold text-zinc-200">{owner.ownerName}</span>
                <div className={`flex flex-wrap items-baseline gap-x-1 text-[11px] tabular-nums ${krwTone(owner.totalDailyKrw)}`}>
                  <span className="font-bold">
                    {owner.totalDailyKrw > 0 ? "+" : ""}₩{fmtInt(owner.totalDailyKrw)}
                  </span>
                  {owner.totalDailyPct !== null && owner.totalDailyKrw !== 0 && (
                    <span className="font-semibold">
                      ({owner.totalDailyPct > 0 ? "+" : ""}
                      {owner.totalDailyPct.toFixed(1)}%)
                    </span>
                  )}
                </div>
              </div>

              {/* 그룹별 행 */}
              <div className="space-y-0">
                {owner.groups.map((g) => (
                  <div
                    key={`${owner.ownerName}-${g.label}`}
                    className="flex items-baseline gap-1 border-t border-white/[0.05] py-[2px] text-[10px] first:border-0"
                  >
                    <GroupLabelWithTooltip label={g.label} holdingsItems={g.holdingsItems} />
                    <span className="flex-1" />
                    <span className={`shrink-0 tabular-nums font-semibold whitespace-nowrap ${krwTone(g.dailyChangeKrw)}`}>
                      {g.dailyChangeKrw !== 0
                        ? `${g.dailyChangeKrw > 0 ? "+" : ""}${fmtInt(g.dailyChangeKrw)}`
                        : "—"}
                    </span>
                    <span
                      className={`w-[3rem] shrink-0 text-right tabular-nums whitespace-nowrap ${
                        g.dailyChangePct !== null && g.dailyChangeKrw !== 0
                          ? krwTone(g.dailyChangeKrw)
                          : "text-zinc-600/50"
                      }`}
                    >
                      {g.dailyChangePct !== null && g.dailyChangeKrw !== 0
                        ? `${g.dailyChangePct > 0 ? "+" : ""}${g.dailyChangePct.toFixed(1)}%`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetStockWeightNeu({
  ownerName,
  slices,
  cloudSyncKey,
  total,
}: {
  ownerName: string;
  slices: AllocationSlice[];
  /** 8자 이상이면 «저장» 시 Supabase에도 반영 */
  cloudSyncKey: string;
  /** 보유자 총 평가금액 (KRW) — 리밸런싱 금액 계산에 사용 */
  total: number;
}) {
  const skipSaveRef = useRef(true);
  const saveDebounceRef = useRef<number | null>(null);
  const [targetsByTicker, setTargetsByTicker] = useState<Record<string, number>>(() => {
    const all = loadAllTargetStockWeights();
    return { ...(all[ownerName] ?? {}) };
  });
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [savedAtText, setSavedAtText] = useState<string | null>(null);
  const [saveFailedBrief, setSaveFailedBrief] = useState(false);
  const [splitCount, setSplitCount] = useState<string>("1");
  const [splitAmountMode, setSplitAmountMode] = useState<SplitAmountMode>("remainder");
  const [milestoneStepInput, setMilestoneStepInput] = useState("1");
  const [barTickerOrder, setBarTickerOrder] = useState<string[] | null>(null);
  /** 계산기 종목별 분배 LS 변경 시 종목별 목표 표시 즉시 재계산 */
  const [calcSplitBump, setCalcSplitBump] = useState(0);

  useEffect(() => {
    setBarTickerOrder(loadVisualOrderKeysForOwner(ownerName));
  }, [ownerName]);

  useEffect(() => {
    const h = () => setBarTickerOrder(loadVisualOrderKeysForOwner(ownerName));
    window.addEventListener(REBALANCE_VISUAL_ORDER_REFRESH_EVENT, h);
    return () => window.removeEventListener(REBALANCE_VISUAL_ORDER_REFRESH_EVENT, h);
  }, [ownerName]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bump = () => setCalcSplitBump((n) => n + 1);
    window.addEventListener(REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT, bump);
    return () => window.removeEventListener(REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT, bump);
  }, []);

  const sortNonCashByTarget = useCallback(
    (a: AllocationSlice, b: AllocationSlice) => {
      const ta = targetsByTicker[a.ticker] ?? 0;
      const tb = targetsByTicker[b.ticker] ?? 0;
      if (Math.abs(tb - ta) > 1e-9) return tb - ta;
      return b.weight - a.weight;
    },
    [targetsByTicker],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  /** 목표 비중 바: 비현금은 저장된 순서(또는 목표%)·현금은 항상 하단 */
  const { orderedNonCashSlices, cashSlices, sortableBarIds, sortableContextIds } = useMemo(() => {
    const nc = slices.filter((s) => !isCashRebalanceTicker(s.ticker));
    const cash = slices.filter((s) => isCashRebalanceTicker(s.ticker)).sort(sortNonCashByTarget);

    let orderedNc: AllocationSlice[];
    const keysFromStorage = barTickerOrder?.filter((t) => nc.some((s) => s.ticker === t)) ?? null;
    if (keysFromStorage && keysFromStorage.length > 0) {
      const map = new Map(nc.map((s) => [s.ticker, s]));
      const out: AllocationSlice[] = [];
      for (const t of keysFromStorage) {
        const sl = map.get(t);
        if (sl) {
          out.push(sl);
          map.delete(t);
        }
      }
      const rest = [...map.values()].sort(sortNonCashByTarget);
      orderedNc = [...out, ...rest];
    } else {
      orderedNc = [...nc].sort(sortNonCashByTarget);
    }
    const sortableIds = orderedNc.map((s) => s.ticker);
    const cashIds = cash.map((s) => s.ticker);
    return {
      orderedNonCashSlices: orderedNc,
      cashSlices: cash,
      sortableBarIds: sortableIds,
      sortableContextIds: [...sortableIds, ...cashIds],
    };
  }, [slices, targetsByTicker, barTickerOrder, sortNonCashByTarget]);

  const handleBarDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const a = String(active.id);
      const o = String(over.id);
      const oldIdx = sortableBarIds.indexOf(a);
      const newIdx = sortableBarIds.indexOf(o);
      if (oldIdx < 0 || newIdx < 0) return;
      const nextOrder = arrayMove(sortableBarIds, oldIdx, newIdx);
      setBarTickerOrder(nextOrder);
      persistVisualOrderForOwner(ownerName, nextOrder);
    },
    [sortableBarIds, ownerName],
  );



  useEffect(() => {
    const onRefresh = () => {
      const all = loadAllTargetStockWeights();
      const saved = all[ownerName] ?? {};
      setTargetsByTicker((prev) => {
        // 실제로 값이 달라진 경우에만 state 업데이트 → 불필요한 리렌더 + save effect 연쇄 차단
        const prevKeys = Object.keys(prev);
        const savedKeys = Object.keys(saved);
        if (
          prevKeys.length === savedKeys.length &&
          prevKeys.every((k) => prev[k] === (saved as Record<string, number>)[k])
        ) {
          return prev;
        }
        skipSaveRef.current = true;
        return { ...saved };
      });
    };
    window.addEventListener(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT, onRefresh);
  }, [ownerName]);

  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = window.setTimeout(() => {
      const all = loadAllTargetStockWeights();
      all[ownerName] = targetsByTicker;
      try {
        window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(all));
        window.localStorage.setItem(HAS_LOCAL_CHANGES_KEY, "1");
        window.dispatchEvent(new Event(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT));
      } catch {
        setSaveStatus("err");
        setSaveFailedBrief(true);
        setSavedAtText(null);
        return;
      }
    }, 350);
    return () => {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    };
  }, [ownerName, targetsByTicker]);

  const saveTargetsToDiskNow = useCallback(() => {
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    const all = loadAllTargetStockWeights();
    all[ownerName] = targetsByTicker;
    try {
      window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(all));
      window.localStorage.setItem(HAS_LOCAL_CHANGES_KEY, "1");
      window.dispatchEvent(new Event(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT));
    } catch {
      setSaveStatus("err");
      setSaveFailedBrief(true);
      setSavedAtText(null);
      return false;
    }
    return true;
  }, [ownerName, targetsByTicker]);

  const handleClickSave = useCallback(async () => {
    if (!saveTargetsToDiskNow()) return;
    setSaveStatus("saving");
    setSaveFailedBrief(false);
    setSavedAtText(null);
    if (cloudSyncKey.trim().length < 8) {
      setSaveStatus("ok");
      setSavedAtText(formatSavedTime());
      return;
    }
    try {
      const ok = await pushTargetWeightsAndScratchpadsToServer(cloudSyncKey.trim());
      if (!ok) {
        setSaveStatus("err");
        setSaveFailedBrief(true);
        setSavedAtText(null);
        return;
      }
      setSaveStatus("ok");
      setSavedAtText(formatSavedTime());
    } catch {
      setSaveStatus("err");
      setSaveFailedBrief(true);
      setSavedAtText(null);
    }
  }, [cloudSyncKey, saveTargetsToDiskNow]);

  const setTarget = useCallback((ticker: string, raw: string) => {
    const n = parseFloat(raw.replace(",", "."));
    setTargetsByTicker((prev) => {
      const next = { ...prev };
      if (raw === "" || !Number.isFinite(n) || n < 0) {
        delete next[ticker];
      } else {
        next[ticker] = Math.min(100, Math.max(0, n));
      }
      return next;
    });
  }, []);

  const targetSum = useMemo(
    () => slices.reduce((sum, sl) => sum + (targetsByTicker[sl.ticker] ?? 0), 0),
    [slices, targetsByTicker],
  );

  const hasAnyTarget = useMemo(
    () => slices.some((sl) => (targetsByTicker[sl.ticker] ?? 0) > 0),
    [slices, targetsByTicker],
  );

  const targetSumOk = Math.abs(targetSum - 100) <= TARGET_SUM_TOLERANCE;
  const showTargetSumError = hasAnyTarget && !targetSumOk;

  const splitCountN = useMemo(() => Math.max(1, Math.floor(Number(splitCount) || 1)), [splitCount]);

  const milestoneStepK = useMemo(() => {
    const raw = Math.floor(Number(String(milestoneStepInput).trim()));
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(splitCountN, raw);
  }, [splitCountN, milestoneStepInput]);

  useEffect(() => {
    setMilestoneStepInput((prev) => {
      const raw = Math.floor(Number(String(prev).trim())) || 1;
      if (raw <= splitCountN) return prev;
      return String(splitCountN);
    });
  }, [splitCountN]);

  /** 리밸런싱 필요 금액 (목표비중이 100%에 맞을 때만 계산) */
  const rebalanceItems = useMemo(() => {
    if (!targetSumOk || !hasAnyTarget || !(total > 0)) return [];
    return slices
      .map((sl) => {
        const target = targetsByTicker[sl.ticker] ?? 0;
        if (target <= 0 && sl.value <= 0) return null;
        const targetKrw = total * target / 100;
        const diffKrw = targetKrw - sl.value;
        if (Math.abs(diffKrw) < 1000) return null; // 1천 원 이하 차이는 표시 생략
        return { ticker: sl.ticker, diffKrw, targetKrw, currentKrw: sl.value, targetPct: target };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => {
        const ra = isCashRebalanceTicker(a.ticker) ? 1 : 0;
        const rb = isCashRebalanceTicker(b.ticker) ? 1 : 0;
        if (ra !== rb) return ra - rb;
        return Math.abs(b.diffKrw) - Math.abs(a.diffKrw);
      });
  }, [targetSumOk, hasAnyTarget, total, slices, targetsByTicker]);

  if (slices.length === 0) {
    return (
      <div
        className="flex min-h-[120px] flex-col items-center justify-center rounded-2xl px-3 py-4 text-center text-xs text-zinc-500"
        style={{ background: "#151a24" }}
      >
        목표 비중을 설정할 슬라이스가 없습니다.
      </div>
    );
  }

  // bar x-axis: 0% = nothing held, 100% = exactly at target, max display = MAX_RATIO × target
  const MAX_RATIO = 1.5;
  const TARGET_AT = 1 / MAX_RATIO; // target marker at 66.7% of bar width

  return (
    <div
      className="flex flex-col rounded-2xl p-2"
      style={{
        background: "#151a24",
        boxShadow:
          "6px 6px 14px rgba(0,0,0,0.45), -4px -4px 12px rgba(255,255,255,0.03), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {/* ── Header ── */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px]">
          <span className="font-semibold tracking-wide text-zinc-100">포트폴리오 비중 리밸런싱</span>
          <span className="flex items-center gap-1 text-zinc-500">
            <span className="inline-block h-[5px] w-[9px] rounded-sm bg-red-500/80" />
            부족
          </span>
          <span className="flex items-center gap-1 text-zinc-500">
            <span className="inline-block h-[5px] w-[9px] rounded-sm bg-emerald-500/80" />
            초과
          </span>
          <span className="text-zinc-600">· Marker=목표</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`text-[9px] tabular-nums font-semibold ${
              showTargetSumError
                ? "text-rose-400"
                : hasAnyTarget && targetSumOk
                ? "text-emerald-400"
                : "text-zinc-500"
            }`}
          >
            {targetSum.toFixed(1)}%
            {showTargetSumError
              ? targetSum < 100
                ? ` ▲${(100 - targetSum).toFixed(1)} 미달`
                : ` ▼${(targetSum - 100).toFixed(1)} 초과`
              : hasAnyTarget && targetSumOk
              ? " ✓"
              : ""}
          </span>
          <button
            type="button"
            onClick={() => void handleClickSave()}
            disabled={saveStatus === "saving" || slices.length === 0}
            className="rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0 text-[9px] font-semibold text-sky-200 transition hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveStatus === "saving" ? "…" : "저장"}
          </button>
          {savedAtText && <span className="text-[9px] tabular-nums text-zinc-600">{savedAtText}</span>}
          {saveStatus === "err" && saveFailedBrief && !savedAtText && (
            <span className="text-[9px] text-rose-400">실패</span>
          )}
        </div>
      </div>

      {/* ── Shared scale labels (비현금 행 왼쪽 드래그 핸들 폭 반영) ── */}
      <div className="mb-0.5 flex items-end gap-1 pl-[180px] pr-20 md:pl-[252px]">
        <div className="relative flex-1">
          {[0, 25, 50, 75, 100].map((pct) => (
            <span
              key={pct}
              className="absolute -translate-x-1/2 text-[7px] tabular-nums text-zinc-600"
              style={{ left: `${(pct / 100) * TARGET_AT * 100}%` }}
            >
              {pct}%
            </span>
          ))}
          <div className="h-2.5" />
        </div>
      </div>

      {/* ── Bar rows (비현금 드래그 가능, 현금 고정 하단) ── */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleBarDragEnd}>
        <SortableContext items={sortableContextIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-px">
            {orderedNonCashSlices.map((slice) => (
              <TargetWeightSortableBarRow
                key={slice.ticker}
                slice={slice}
                targetsByTicker={targetsByTicker}
                setTarget={setTarget}
                TARGET_AT={TARGET_AT}
                MAX_RATIO={MAX_RATIO}
                ownerName={ownerName}
                calcSplitBump={calcSplitBump}
              />
            ))}
            {cashSlices.map((slice) => (
              <TargetWeightSortableBarRow
                key={slice.ticker}
                slice={slice}
                targetsByTicker={targetsByTicker}
                setTarget={setTarget}
                TARGET_AT={TARGET_AT}
                MAX_RATIO={MAX_RATIO}
                ownerName={ownerName}
                calcSplitBump={calcSplitBump}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* ── Rebalancing amounts (collapsible) ── */}
      {rebalanceItems.length > 0 && (
        <details className="mt-2 group/reb">
          <summary className="cursor-pointer select-none list-none text-[9px] text-zinc-500 hover:text-zinc-300 transition">
            <span className="group-open/reb:hidden">▶ 리밸런싱 금액 보기</span>
            <span className="hidden group-open/reb:inline">▼ 리밸런싱 금액 접기</span>
          </summary>
          <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[9px] tabular-nums text-zinc-500">총액 {formatKrw(Math.round(total))} 기준</span>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <label className="flex items-center gap-1 text-[9px] text-zinc-500">
                  기준
                  <select
                    value={splitAmountMode}
                    onChange={(e) => setSplitAmountMode(e.target.value as SplitAmountMode)}
                    className="max-w-[9.5rem] rounded border border-white/10 bg-zinc-900/80 px-1 py-0.5 text-[8px] text-zinc-200 outline-none ring-sky-500/40 focus:ring-1"
                    aria-label="분할 금액 계산"
                    title="목표 단계별은 매수만 목표평가의 k/n까지 이번 회에 맞춤. 매도는 ÷n. 분할 1회면 동일."
                  >
                    <option value="remainder">남은 금액 ÷ n</option>
                    <option value="milestone">목표÷n 단계별</option>
                  </select>
                </label>
                <label className="flex items-center gap-1 text-[9px] text-zinc-500">
                  분할
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={splitCount}
                    onChange={(e) => setSplitCount(e.target.value)}
                    className="w-8 rounded border border-white/10 bg-zinc-900/80 px-1 py-0 text-center text-[9px] tabular-nums text-zinc-100 outline-none ring-sky-500/40 focus:ring-1"
                    style={{ boxShadow: "inset 2px 2px 4px rgba(0,0,0,0.5)" }}
                    aria-label="분할 수"
                  />
                  회
                </label>
                {splitAmountMode === "milestone" && splitCountN > 1 ?
                  <label className="flex items-center gap-1 text-[9px] text-zinc-500">
                    목표까지
                    <select
                      value={String(milestoneStepK)}
                      onChange={(e) => setMilestoneStepInput(e.target.value)}
                      className="rounded border border-white/10 bg-zinc-900/80 px-1 py-0.5 text-[8px] text-zinc-200 outline-none ring-sky-500/40 focus:ring-1"
                      aria-label="목표 진행 단계 k/n"
                    >
                      {Array.from({ length: splitCountN }, (_, i) => i + 1).map((kk) => (
                        <option key={kk} value={String(kk)}>
                          {kk}/{splitCountN}
                        </option>
                      ))}
                    </select>
                  </label>
                : null}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {rebalanceItems.map((item) => {
                const perSigned = perSplitKrwCore(
                  splitAmountMode,
                  splitCountN,
                  { diffKrw: item.diffKrw, targetPct: item.targetPct, valueKrw: item.currentKrw },
                  total,
                  { milestoneStep: milestoneStepK },
                );
                const perAbs = Math.abs(perSigned);
                const pctAfter = approxPortfolioPctAfterDelta(item.currentKrw, perSigned, total);
                return (
                  <div key={item.ticker} className="flex items-center justify-between gap-1 text-[10px]">
                    <span className="truncate font-semibold text-zinc-300">{item.ticker}</span>
                    <span className={`tabular-nums font-bold shrink-0 text-right ${item.diffKrw > 0 ? "text-red-400" : "text-blue-400"}`}>
                      <span className="whitespace-nowrap">
                        {item.diffKrw > 0 ? "▲" : "▼"} {formatKrwCompact(perAbs)}
                        {splitCountN > 1 && splitAmountMode === "remainder" && (
                          <span className="ml-0.5 font-normal text-zinc-600">×{splitCountN}</span>
                        )}
                        {splitCountN > 1 && splitAmountMode === "milestone" && (
                          <span className="ml-0.5 font-normal text-zinc-600">{`·${milestoneStepK}/${splitCountN}`}</span>
                        )}
                        {pctAfter != null ?
                          <span className="ml-0.5 font-normal text-zinc-500">{` (→ ${pctAfter.toFixed(2)}%)`}</span>
                        : null}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

export function FamilyAllocationDonut({
  ownerName,
  data,
  total,
  watchlistEntries,
  cloudSyncKey = "",
}: {
  ownerName: string;
  data: AllocationSlice[];
  total: number;
  watchlistEntries?: Array<{ symbol: string; name: string; group?: string }>;
  /** 동기화 키(8자 이상) — 목표 비중을 서버에도 남길 때 사용 */
  cloudSyncKey?: string;
}) {
  const chartData = useMemo(
    () => [...data].sort((a, b) => b.weight - a.weight || b.value - a.value),
    [data],
  );

  const stockSlicesForTargets = useMemo(
    () => {
      const normalize = (value: unknown) =>
        typeof value === "string" ? value.trim() : "";
      const normalizeUpper = (value: unknown) => normalize(value).toUpperCase();
      /** allocation은 페이지에서 예수금+차트「현금」그룹이 이미 하나의 ticker「현금」으로 합쳐져 옴 */
      const base = chartData
        .filter((d) => d.value > 0)
        .map((d) => ({
          ...d,
          allEntries: d.allEntries.map((entry) => ({
            name: normalize(entry.name) || normalize(entry.symbol),
            symbol: normalize(entry.symbol),
            weight: entry.weight,
          })),
        }));
      const baseByTicker = new Map(base.map((d) => [normalizeUpper(d.ticker), d]));
      const groupedWatch = new Map<
        string,
        {
          ticker: string;
          displayName: string;
          allEntries: { name: string; symbol: string; weight: number }[];
        }
      >();
      for (const row of watchlistEntries ?? []) {
        const rawSymbol = normalize(row?.symbol);
        const symbol = rawSymbol.toUpperCase();
        if (!symbol) continue;
        const group = normalize(row?.group);
        const ticker = group || symbol;
        const key = normalizeUpper(ticker);
        const entry = {
          name: normalize(row?.name) || rawSymbol || symbol,
          symbol,
          weight: 0,
        };
        const existingBase = baseByTicker.get(key);
        if (existingBase) {
          const duplicated = existingBase.allEntries.some(
            (e) => normalizeUpper(e.symbol) === symbol,
          );
          if (!duplicated) existingBase.allEntries.push(entry);
          continue;
        }
        const prev = groupedWatch.get(key);
        if (prev) {
          const duplicated = prev.allEntries.some(
            (e) => normalizeUpper(e.symbol) === symbol,
          );
          if (!duplicated) prev.allEntries.push(entry);
        } else {
          groupedWatch.set(key, {
            ticker,
            displayName: group || normalize(row?.name) || symbol,
            allEntries: [entry],
          });
        }
      }
      const extra = Array.from(groupedWatch.entries()).map(
        ([key, v]): AllocationSlice => ({
          name: `watch|${key}`,
          displayName: v.displayName,
          ticker: v.ticker,
          allEntries: v.allEntries,
          value: 0,
          weight: 0,
          changePct: null,
        }),
      );
      return [...base, ...extra].sort((a, b) => b.weight - a.weight || b.value - a.value);
    },
    [chartData, watchlistEntries],
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
      {/* ── 소유자 헤더 + 현재 비중 범례 ── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-bold text-zinc-100">{ownerName}</p>
          <p className="text-[11px] tabular-nums text-zinc-400">{formatKrw(total)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {chartData.map((d, i) => {
            const c = NEON_PALETTE[i % NEON_PALETTE.length];
            return (
              <div key={d.name} className="flex items-center gap-1 text-[10px] text-zinc-300">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: c, boxShadow: `0 0 6px ${c}` }} />
                <span title={d.displayName}>
                  {d.ticker} <span className="text-zinc-500">{d.weight.toFixed(1)}%</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 리밸런싱 바 차트 ── */}
      <TargetStockWeightNeu
        key={ownerName}
        ownerName={ownerName}
        slices={stockSlicesForTargets}
        cloudSyncKey={cloudSyncKey}
        total={total}
      />

      {/* ── 트리맵 (아코디언) ── */}
      <details className="mt-3 group/treemap">
        <summary className="cursor-pointer select-none list-none text-[10px] text-zinc-500 hover:text-zinc-300 transition">
          <span className="group-open/treemap:hidden">▶ 트리맵 보기</span>
          <span className="hidden group-open/treemap:inline">▼ 트리맵 접기</span>
        </summary>
        <div className="mt-2">
          <div className="h-[180px] w-full rounded-xl border border-white/10 bg-zinc-950/40 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <Treemap
                data={chartData}
                dataKey="value"
                stroke="rgba(255,255,255,0.12)"
                content={<NeonTreemapNode />}
                aspectRatio={1.6}
              >
                <Tooltip
                  content={<NeonTooltip ownerName={ownerName} />}
                  allowEscapeViewBox={{ x: true, y: true }}
                  wrapperStyle={{ zIndex: 50 }}
                />
              </Treemap>
            </ResponsiveContainer>
          </div>
          <OwnerScratchPad ownerName={ownerName} cloudSyncKey={cloudSyncKey} />
        </div>
      </details>
    </div>
  );
}
