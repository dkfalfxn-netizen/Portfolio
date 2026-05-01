"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import {
  HAS_LOCAL_CHANGES_KEY,
  loadAllTargetStockWeights,
  TARGET_WEIGHT_STORAGE_KEY,
} from "@/lib/portfolio-target-weights";
import {
  loadAllOwnerScratchpads,
  persistOneOwnerScratchpad,
  pushTargetWeightsAndScratchpadsToServer,
} from "@/lib/portfolio-owner-scratchpad";

/** 네온 글로우용 팔레트 (한 단계 어둡게 — 채도는 유지) */
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
    refreshFromStorage();
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

/** 현물 비중(%) 내림차순 — USD/KRW 현금 행은 제외 */
function nonCashEntriesSortedByWeight(
  allEntries: AllocationSlice["allEntries"],
): AllocationSlice["allEntries"] {
  return allEntries
    .filter((e) => e.name !== "USD 현금" && e.name !== "KRW 현금")
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function formatKrw(n: number) {
  return `₩${Math.round(n).toLocaleString()}`;
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
}: {
  active?: boolean;
  payload?: Array<{
    payload: AllocationSlice;
  }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const entries = nonCashEntriesSortedByWeight(p.allEntries);
  const isGroup = entries.length > 1;
  const entryPctText = (w?: number) => `${(w ?? p.weight).toFixed(1)}%`;
  return (
    <div className="rounded-lg border border-white/15 bg-zinc-950/95 px-3 py-2 text-xs shadow-[0_0_20px_rgba(0,229,255,0.15)] backdrop-blur-md">
      {isGroup ? (
        <div className="mb-1.5 space-y-1">
          <p className="mb-1 font-bold text-cyan-400">{p.ticker}</p>
          {entries.map((e) => (
            <div key={`${e.symbol}-${e.name}`} className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-1.5">
                <span className="font-semibold text-zinc-300">{e.symbol}</span>
                <span className="text-zinc-500">{e.name}</span>
              </div>
              <span className="tabular-nums text-zinc-400">{entryPctText(e.weight)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-1">
          {entries[0]?.symbol && entries[0].symbol !== entries[0].name && (
            <p className="font-bold text-cyan-400">{entries[0].symbol}</p>
          )}
          <p className="font-semibold text-foreground">
            {p.displayName} <span className="tabular-nums text-zinc-400">({entryPctText(entries[0]?.weight)})</span>
          </p>
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
    return `${sign}${Math.round(abs / 10_000).toLocaleString()}만`;
  }
  return `${sign}${Math.round(abs).toLocaleString()}원`;
}

/** 목표 % 표시용 — 정수면 소수 생략 */
function fmtTargetPctLabel(targetPct: number): string {
  if (!Number.isFinite(targetPct)) return "—";
  const rounded = Math.round(targetPct * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
  return rounded.toFixed(1);
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

  useEffect(() => {
    const onRefresh = () => {
      const all = loadAllTargetStockWeights();
      skipSaveRef.current = true;
      setTargetsByTicker({ ...(all[ownerName] ?? {}) });
    };
    window.addEventListener("portfolio-target-weights-refresh", onRefresh);
    return () => window.removeEventListener("portfolio-target-weights-refresh", onRefresh);
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

  /** 목표 % 큰 그룹/종목이 먼저, 동률·미설정(0)은 현재 비중으로 보조 정렬 */
  const orderedSlices = useMemo(
    () =>
      [...slices].sort((a, b) => {
        const ta = targetsByTicker[a.ticker] ?? 0;
        const tb = targetsByTicker[b.ticker] ?? 0;
        if (Math.abs(tb - ta) > 1e-9) return tb - ta;
        return b.weight - a.weight;
      }),
    [slices, targetsByTicker],
  );

  const targetSumOk = Math.abs(targetSum - 100) <= TARGET_SUM_TOLERANCE;
  const showTargetSumError = hasAnyTarget && !targetSumOk;

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
        return { ticker: sl.ticker, diffKrw, targetKrw, currentKrw: sl.value };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => Math.abs(b.diffKrw) - Math.abs(a.diffKrw));
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
      className="flex flex-col rounded-2xl p-3"
      style={{
        background: "#151a24",
        boxShadow:
          "6px 6px 14px rgba(0,0,0,0.45), -4px -4px 12px rgba(255,255,255,0.03), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {/* ── Header ── */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px]">
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
            className={`text-[10px] tabular-nums font-semibold ${
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
            className="rounded border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-200 transition hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveStatus === "saving" ? "…" : "저장"}
          </button>
          {savedAtText && <span className="text-[9px] tabular-nums text-zinc-600">{savedAtText}</span>}
          {saveStatus === "err" && saveFailedBrief && !savedAtText && (
            <span className="text-[9px] text-rose-400">실패</span>
          )}
        </div>
      </div>

      {/* ── Shared scale labels (relative to target: 0%=nothing, 100%=target) ── */}
      <div className="mb-1 flex items-end gap-1.5 pl-[108px] pr-[96px]">
        <div className="relative flex-1">
          {[0, 25, 50, 75, 100].map((pct) => (
            <span
              key={pct}
              className="absolute -translate-x-1/2 text-[8px] tabular-nums text-zinc-600"
              style={{ left: `${(pct / 100) * TARGET_AT * 100}%` }}
            >
              {pct}%
            </span>
          ))}
          <div className="h-3" />
        </div>
      </div>

      {/* ── Bar rows ── */}
      <div className="space-y-[3px]">
        {orderedSlices.map((slice) => {
          const hasInputTarget = Object.prototype.hasOwnProperty.call(targetsByTicker, slice.ticker);
          const target = targetsByTicker[slice.ticker] ?? 0;
          const actual = slice.weight;
          const hasPositiveTarget = target > 0;
          const isOverTargetWhenZero = hasInputTarget && !hasPositiveTarget && actual > 0;

          const ratio = hasPositiveTarget
            ? actual / target
            : isOverTargetWhenZero
            ? MAX_RATIO
            : 0;
          const barWidthPct = (Math.min(ratio, MAX_RATIO) / MAX_RATIO) * 100;
          const isClipped = ratio > MAX_RATIO;

          const relDev = hasPositiveTarget ? (actual - target) / target : 0;
          const withinBand = hasPositiveTarget && Math.abs(relDev) <= 0.05;
          const belowBand = hasPositiveTarget && relDev < -0.05;
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

          const tooltipEntries = nonCashEntriesSortedByWeight(slice.allEntries);
          const isGrouped = tooltipEntries.length > 1;
          const tooltipPctText = (w?: number) => `${(w ?? slice.weight).toFixed(1)}%`;

          return (
            <div key={slice.name} className="group relative flex items-center gap-1.5">
              {/* Hover tooltip */}
              {tooltipEntries.length > 0 && (
                <div className="pointer-events-none absolute bottom-[calc(100%+4px)] left-0 z-30 hidden w-max min-w-[140px] rounded-lg border border-white/15 bg-zinc-950/95 px-2.5 py-2 text-[10px] shadow-[0_0_20px_rgba(0,229,255,0.15)] backdrop-blur-md group-hover:block">
                  {isGrouped ? (
                    <div className="space-y-1">
                      <p className="font-bold text-cyan-400">{slice.ticker}</p>
                      {tooltipEntries.map((e) => (
                        <div key={`${slice.ticker}-${e.symbol}`} className="flex items-baseline justify-between gap-2">
                          <div className="flex items-baseline gap-1.5">
                            <span className="font-semibold text-zinc-300">{e.symbol}</span>
                            <span className="text-zinc-500">{e.name}</span>
                          </div>
                          <span className="tabular-nums text-zinc-400">{tooltipPctText(e.weight)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      <p className="font-bold text-cyan-400">{tooltipEntries[0].symbol || slice.ticker}</p>
                      <p className="font-semibold text-zinc-200">
                        {tooltipEntries[0].name || slice.displayName}{" "}
                        <span className="tabular-nums text-zinc-400">({tooltipPctText(tooltipEntries[0].weight)})</span>
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Name + target input (inline) */}
              <div className="flex w-[108px] shrink-0 items-center justify-between gap-1">
                <span className="truncate text-[11px] font-semibold text-zinc-200" title={slice.displayName}>
                  {slice.ticker}
                </span>
                <div className="flex shrink-0 items-center">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    placeholder="—"
                    aria-label={`${slice.ticker} 목표 비중 %`}
                    className="w-9 rounded border border-white/10 bg-zinc-900/80 px-0.5 py-0 text-right text-[10px] tabular-nums text-zinc-100 outline-none ring-sky-500/40 [appearance:textfield] placeholder:text-zinc-600 focus:ring-1 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    style={{ boxShadow: "inset 2px 2px 4px rgba(0,0,0,0.5)" }}
                    value={hasInputTarget ? String(targetsByTicker[slice.ticker]) : ""}
                    onChange={(e) => setTarget(slice.ticker, e.target.value)}
                  />
                  <span className="ml-0.5 text-[9px] text-zinc-600">%</span>
                </div>
              </div>

              {/* Horizontal bar (scale: 0→MAX_RATIO×target, marker at 100% of target) */}
              <div
                className="relative h-[18px] flex-1 overflow-hidden rounded-sm"
                style={{ background: "rgba(255,255,255,0.04)" }}
              >
                <div
                  className="pointer-events-none absolute top-0 z-10 h-full w-px"
                  style={{
                    left: `${TARGET_AT * 100}%`,
                    borderRight: "1px dashed rgba(161,161,170,0.55)",
                  }}
                />
                {barWidthPct > 0 ? (
                  <div
                    className="absolute left-0 top-[2px] bottom-[2px] rounded-sm transition-all duration-300"
                    style={{ width: `${barWidthPct}%`, background: barBg, boxShadow: barGlow }}
                  />
                ) : hasInputTarget && !hasPositiveTarget ? (
                  <div
                    className="absolute left-0 top-[2px] bottom-[2px] w-[3px] rounded-sm opacity-70"
                    style={{ background: "rgba(161,161,170,0.5)" }}
                  />
                ) : null}
                {isClipped && (
                  <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[8px] text-emerald-300/70">›</span>
                )}
              </div>

              {/* Deviation label */}
              <div className="w-[96px] shrink-0 text-right text-[10px] tabular-nums leading-none">
                {!hasInputTarget ? (
                  <span className="text-zinc-600">—</span>
                ) : !hasPositiveTarget && actual > 0 ? (
                  <span className="text-emerald-400">목표 0% ▼ +{actual.toFixed(1)}%p</span>
                ) : !hasPositiveTarget ? (
                  <span className="text-zinc-400">목표 0%</span>
                ) : withinBand ? (
                  <span className="text-sky-400">≈ 목표</span>
                ) : belowBand ? (
                  <span className="text-red-400">▲ {Math.abs(diffPp).toFixed(1)}%p 부족</span>
                ) : (
                  <span className="text-emerald-400">▼ +{diffPp.toFixed(1)}%p 초과</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Rebalancing amounts (collapsible) ── */}
      {rebalanceItems.length > 0 && (
        <details className="mt-3 group/reb">
          <summary className="cursor-pointer select-none list-none text-[10px] text-zinc-500 hover:text-zinc-300 transition">
            <span className="group-open/reb:hidden">▶ 리밸런싱 금액 보기</span>
            <span className="hidden group-open/reb:inline">▼ 리밸런싱 금액 접기</span>
          </summary>
          <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[9px] text-zinc-500">총액 {formatKrw(Math.round(total))} 기준</span>
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
            </div>
            {(() => {
              const n = Math.max(1, Math.floor(Number(splitCount) || 1));
              return (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {rebalanceItems.map((item) => {
                    const perSplit = item.diffKrw / n;
                    return (
                      <div key={item.ticker} className="flex items-center justify-between gap-1 text-[10px]">
                        <span className="truncate font-semibold text-zinc-300">{item.ticker}</span>
                        <span className={`tabular-nums font-bold shrink-0 ${item.diffKrw > 0 ? "text-red-400" : "text-blue-400"}`}>
                          {item.diffKrw > 0 ? "▲" : "▼"} {formatKrwCompact(Math.abs(perSplit))}
                          {n > 1 && <span className="ml-0.5 font-normal text-zinc-600">×{n}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
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
      const usdCash = chartData.find((d) => d.ticker === "USD 현금");
      const krwCash = chartData.find((d) => d.ticker === "KRW 현금");
      const mergedCashValue = (usdCash?.value ?? 0) + (krwCash?.value ?? 0);
      const mergedCashWeight = (usdCash?.weight ?? 0) + (krwCash?.weight ?? 0);
      const base = chartData
        .filter((d) => d.value > 0 && d.ticker !== "USD 현금" && d.ticker !== "KRW 현금")
        .map((d) => ({
          ...d,
          allEntries: d.allEntries.map((entry) => ({
            name: normalize(entry.name) || normalize(entry.symbol),
            symbol: normalize(entry.symbol),
            weight: entry.weight,
          })),
        }));
      const baseByTicker = new Map(base.map((d) => [normalizeUpper(d.ticker), d]));
      if (mergedCashValue > 0) {
        base.push({
          name: "cash-merged",
          displayName: "현금(USD+KRW)",
          ticker: "현금",
          allEntries: [
            ...(usdCash?.allEntries ?? []).map((entry) => ({
              name: normalize(entry.name) || normalize(entry.symbol),
              symbol: normalize(entry.symbol),
              weight: entry.weight,
            })),
            ...(krwCash?.allEntries ?? []).map((entry) => ({
              name: normalize(entry.name) || normalize(entry.symbol),
              symbol: normalize(entry.symbol),
              weight: entry.weight,
            })),
          ],
          value: mergedCashValue,
          weight: mergedCashWeight,
          changePct: null,
        });
      }
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
      <TargetStockWeightNeu ownerName={ownerName} slices={stockSlicesForTargets} cloudSyncKey={cloudSyncKey} total={total} />

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
                  content={<NeonTooltip />}
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
