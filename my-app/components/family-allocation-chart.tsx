"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, Wallet } from "lucide-react";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import {
  HAS_LOCAL_CHANGES_KEY,
  loadAllTargetStockWeights,
  TARGET_WEIGHT_STORAGE_KEY,
} from "@/lib/portfolio-target-weights";
import { cn } from "@/lib/utils";

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
/** 편차(목표·현재 비중 차, %p) — 데드존(±) */
const REBAL_DEADZONE_PCT = 2;
/** 편차 막대 스케일: 이 값(%p)에서 반쪽 너비 꽉 참 */
const DEVIATION_BAR_SCALE_PCT = 20;

export type AllocationSlice = {
  name: string;
  displayName: string;
  ticker: string;
  allEntries: { name: string; symbol: string; weight?: number }[];
  value: number;
  weight: number;
  changePct: number | null;
};

function formatKrw(n: number) {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

function formatCommaInt(n: number) {
  return Math.round(n).toLocaleString("ko-KR");
}

function formatCommaFixed(n: number, digits: number) {
  return n.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatKrwWithUsd(
  krw: number,
  usdKrw: number | null | undefined,
): { krw: string; usd: string | null } {
  const k = `₩${formatCommaInt(krw)}`;
  if (typeof usdKrw === "number" && usdKrw > 0 && Number.isFinite(usdKrw)) {
    return { krw: k, usd: `≈ $${formatCommaFixed(krw / usdKrw, 0)}` };
  }
  return { krw: k, usd: null };
}

function isSafeHavenTicker(ticker: string): boolean {
  const t = ticker.trim();
  if (!t) return false;
  if (/현금|CASH|GOLD|GLD|채권|TIP|BIL|BND/i.test(t)) return true;
  if (["GOLD", "GLD", "현금", "USD", "KRW", "USD 현금", "KRW 현금"].includes(t)) return true;
  return false;
}

type ActionRow = {
  slice: AllocationSlice;
  targetPp: number;
  hasPositiveTarget: boolean;
  isZeroTargetHolding: boolean;
  currentPp: number;
  deltaPp: number;
  rebalKrw: number;
  inDeadzone: boolean;
  barColor: "ok" | "over" | "under" | "na";
};

function buildActionRows(
  slices: AllocationSlice[],
  targetsByTicker: Record<string, number>,
  totalKrw: number,
): ActionRow[] {
  const out: ActionRow[] = [];
  for (const slice of slices) {
    const hasT = Object.prototype.hasOwnProperty.call(targetsByTicker, slice.ticker);
    const targetPp = hasT ? (targetsByTicker[slice.ticker] ?? 0) : 0;
    const hasPositiveTarget = targetPp > 0;
    const isZeroTargetHolding = hasT && !hasPositiveTarget && slice.weight > 0;
    if (!hasT || (!hasPositiveTarget && !isZeroTargetHolding)) continue;

    const currentPp = slice.weight;
    const deltaPp = hasPositiveTarget ? currentPp - targetPp : currentPp - 0;
    const rebalKrw = (hasPositiveTarget || isZeroTargetHolding
      ? (targetPp - currentPp) / 100
      : 0) * totalKrw;
    const inDeadzone = hasPositiveTarget
      ? Math.abs(deltaPp) <= REBAL_DEADZONE_PCT
      : isZeroTargetHolding
        ? false
        : Math.abs(deltaPp) <= REBAL_DEADZONE_PCT;

    let barColor: ActionRow["barColor"] = "na";
    if (hasPositiveTarget) {
      if (Math.abs(deltaPp) <= REBAL_DEADZONE_PCT) barColor = "ok";
      else if (deltaPp > REBAL_DEADZONE_PCT) barColor = "over";
      else barColor = "under";
    } else if (isZeroTargetHolding) {
      barColor = "over";
    }

    out.push({
      slice,
      targetPp,
      hasPositiveTarget,
      isZeroTargetHolding,
      currentPp,
      deltaPp,
      rebalKrw,
      inDeadzone,
      barColor,
    });
  }
  return out.sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp));
}

function splitSafeAggressive(rows: ActionRow[]) {
  const safe = rows.filter((r) => isSafeHavenTicker(r.slice.ticker));
  const agg = rows.filter((r) => !isSafeHavenTicker(r.slice.ticker));
  return { safe, agg };
}

type GuideRow = { ticker: string; displayName: string; allocKrw: number };

function buildAddCashGuide(
  addKrw: number,
  totalKrw: number,
  baseRows: ActionRow[],
): GuideRow[] {
  if (addKrw <= 0 || !Number.isFinite(addKrw) || totalKrw <= 0) return [];
  const newTotal = totalKrw + addKrw;
  const withTarget = baseRows
    .filter((r) => r.hasPositiveTarget)
    .map((r) => ({
      ...r,
      w: r.slice.weight,
      val: r.slice.value,
      tgt: r.targetPp,
    }));
  if (withTarget.length === 0) {
    return [];
  }
  const sorted = [...withTarget].sort((a, b) => a.w - b.w);
  let remaining = addKrw;
  const out: GuideRow[] = [];
  for (const r of sorted) {
    if (remaining < 0.5) break;
    const currentVal = r.val;
    const targetVal = (r.tgt / 100) * newTotal;
    const gap = targetVal - currentVal;
    if (gap <= 0) continue;
    const take = Math.min(remaining, gap);
    if (take < 0.5) continue;
    out.push({
      ticker: r.slice.ticker,
      displayName: r.slice.displayName,
      allocKrw: take,
    });
    remaining -= take;
  }
  if (remaining > 0.5 && sorted[0]) {
    const t = sorted[0].slice.ticker;
    const ex = out.find((o) => o.ticker === t);
    if (ex) {
      ex.allocKrw += remaining;
    } else {
      out.push({
        ticker: t,
        displayName: sorted[0].slice.displayName,
        allocKrw: remaining,
      });
    }
  }
  return out;
}

function DeviationRangeBar({
  deltaPp,
  inDeadzone,
  isZeroTargetHolding,
}: {
  deltaPp: number;
  inDeadzone: boolean;
  isZeroTargetHolding: boolean;
}) {
  const w = Math.min((Math.abs(deltaPp) / DEVIATION_BAR_SCALE_PCT) * 50, 50);
  const showDot = Math.abs(deltaPp) < 0.05;
  const okNeg =
    "bg-gradient-to-l from-lime-500/85 to-emerald-600/90 shadow-[0_0_8px_rgba(34,197,94,0.2)]";
  const okPos =
    "bg-gradient-to-r from-emerald-600/90 to-lime-500/85 shadow-[0_0_8px_rgba(34,197,94,0.2)]";
  return (
    <div className="relative h-7 w-full overflow-hidden rounded-md border border-white/10 bg-zinc-900/50 shadow-inner">
      <div className="absolute top-0 left-1/2 h-full w-px -translate-x-px bg-zinc-400/50" title="0%p (목표)" />
      {showDot ? (
        <div
          className="absolute top-1/2 left-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-400/60 bg-emerald-500/30"
          title="0%p"
        />
      ) : null}
      {!showDot && deltaPp < 0 ? (
        <div
          className={cn(
            "absolute top-1.5 h-4 rounded-l-md",
            inDeadzone && !isZeroTargetHolding
              ? okNeg
              : "bg-gradient-to-l from-blue-600/95 to-sky-500/90 shadow-[0_0_8px_rgba(56,189,248,0.25)]",
          )}
          style={{ right: "50%", width: `${w}%` }}
          title={`편차 ${formatCommaFixed(deltaPp, 1)}%p`}
        />
      ) : null}
      {!showDot && deltaPp > 0 ? (
        <div
          className={cn(
            "absolute top-1.5 h-4 rounded-r-md",
            inDeadzone && !isZeroTargetHolding
              ? okPos
              : "bg-gradient-to-r from-amber-500/95 to-rose-600/90 shadow-[0_0_8px_rgba(244,63,94,0.2)]",
          )}
          style={{ left: "50%", width: `${w}%` }}
          title={`편차 +${formatCommaFixed(deltaPp, 1)}%p`}
        />
      ) : null}
    </div>
  );
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

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={4}
        ry={4}
        fill={c}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth={1}
        style={{ filter: `drop-shadow(0 0 6px ${c}) drop-shadow(0 0 14px ${c}55)` }}
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

function TargetStockWeightNeu({
  ownerName,
  slices,
  cloudSyncKey,
  totalKrw,
  usdKrw = null,
}: {
  ownerName: string;
  slices: AllocationSlice[];
  /** 8자 이상이면 «저장» 시 Supabase에도 반영 */
  cloudSyncKey: string;
  totalKrw: number;
  usdKrw?: number | null;
}) {
  const skipSaveRef = useRef(true);
  const saveDebounceRef = useRef<number | null>(null);
  const [targetsByTicker, setTargetsByTicker] = useState<Record<string, number>>(() => {
    const all = loadAllTargetStockWeights();
    return { ...(all[ownerName] ?? {}) };
  });
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [serverSaveHint, setServerSaveHint] = useState<string | null>(null);

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
        setServerSaveHint("이 브라우저에 저장할 수 없습니다(저장 공간/비공개 모드).");
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
      setServerSaveHint("이 브라우저에 저장할 수 없습니다(저장 공간/비공개 모드).");
      return false;
    }
    return true;
  }, [ownerName, targetsByTicker]);

  const handleClickSave = useCallback(async () => {
    if (!saveTargetsToDiskNow()) return;
    setSaveStatus("saving");
    setServerSaveHint(null);
    if (cloudSyncKey.trim().length < 8) {
      setSaveStatus("ok");
      setServerSaveHint("이 브라우저에는 저장됐습니다. 다른 PC와 맞추려면 동기화 키(8자 이상)를 입력한 뒤 다시 저장하세요.");
      return;
    }
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pushTargetWeights",
          key: cloudSyncKey.trim(),
          targetStockWeightByOwner: loadAllTargetStockWeights(),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; ok?: boolean; updated_at?: string };
      if (!r.ok) {
        setSaveStatus("err");
        setServerSaveHint(
          j.error ??
            (r.status === 404
              ? "서버에 잔고가 아직 없습니다. 먼저 『서버로 올리기』로 잔고를 올린 뒤 저장하세요."
              : "서버에 저장하지 못했습니다."),
        );
        return;
      }
      setSaveStatus("ok");
      setServerSaveHint("이 브라우저와 서버(Supabase)에 저장되었습니다. 다른 기기에서는 『서버에서 불러오기』하세요.");
    } catch {
      setSaveStatus("err");
      setServerSaveHint("네트워크 오류로 서버에 저장하지 못했습니다.");
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

  const actionRows = useMemo(
    () => buildActionRows(slices, targetsByTicker, totalKrw),
    [slices, targetsByTicker, totalKrw],
  );
  const { safe: safeRows, agg: aggRows } = useMemo(
    () => splitSafeAggressive(actionRows),
    [actionRows],
  );
  const summary = useMemo(() => {
    const urgent = actionRows.filter(
      (r) => (r.hasPositiveTarget && !r.inDeadzone) || r.isZeroTargetHolding,
    );
    let buy = 0;
    let sell = 0;
    for (const r of actionRows) {
      if (r.rebalKrw > 0) buy += r.rebalKrw;
      else if (r.rebalKrw < 0) sell += -r.rebalKrw;
    }
    return { urgent: urgent.length, buy, sell };
  }, [actionRows]);
  const [addCashInput, setAddCashInput] = useState("");
  const addCashKrw = useMemo(() => {
    const raw = addCashInput.replace(/,/g, "").replace(/^\s+/, "").trim();
    if (!raw) return 0;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  }, [addCashInput]);
  const addCashGuide = useMemo(
    () => buildAddCashGuide(addCashKrw, totalKrw, actionRows),
    [addCashKrw, totalKrw, actionRows],
  );

  const pendingSlices = useMemo(
    () =>
      slices.filter(
        (sl) => !Object.prototype.hasOwnProperty.call(targetsByTicker, sl.ticker),
      ),
    [slices, targetsByTicker],
  );

  const renderRebalRow = useCallback(
    (r: ActionRow) => {
      const abs = formatKrwWithUsd(Math.abs(r.rebalKrw), usdKrw);
      const side =
        r.rebalKrw > 0 ? "매수" : r.rebalKrw < 0 ? "매도" : "균형";
      const showTrade =
        (r.hasPositiveTarget && !r.inDeadzone) || r.isZeroTargetHolding;
      return (
        <div
          key={r.slice.name}
          className="rounded-xl border border-white/10 bg-white/[0.05] p-2.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] backdrop-blur-md"
        >
          <div className="mb-1.5 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-[11px] font-bold text-zinc-100" title={r.slice.displayName}>
                  {r.slice.ticker}
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  placeholder="%"
                  aria-label={`${r.slice.ticker} 목표 %`}
                  className="ml-0.5 w-11 shrink-0 rounded border border-white/15 bg-zinc-900/90 px-0.5 py-0.5 text-center text-[9px] tabular-nums text-zinc-100"
                  value={
                    Object.prototype.hasOwnProperty.call(targetsByTicker, r.slice.ticker)
                      ? String(targetsByTicker[r.slice.ticker])
                      : ""
                  }
                  onChange={(e) => setTarget(r.slice.ticker, e.target.value)}
                />
                {r.hasPositiveTarget && r.inDeadzone && !r.isZeroTargetHolding ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[8px] font-medium text-emerald-200/95">
                    <CheckCircle2 className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
                    정상
                  </span>
                ) : null}
                {showTrade ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[8px] font-medium text-amber-100/95">
                    <AlertCircle className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
                    매매 필요
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-[8px] text-zinc-500" title={r.slice.displayName}>
                {r.slice.displayName}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[8px] text-zinc-500">편차 (Δ%p)</p>
              <p
                className={cn(
                  "font-mono text-[11px] font-semibold tabular-nums",
                  r.deltaPp > REBAL_DEADZONE_PCT
                    ? "text-amber-200"
                    : r.deltaPp < -REBAL_DEADZONE_PCT
                      ? "text-sky-200"
                      : "text-emerald-200/90",
                )}
              >
                {r.deltaPp > 0 ? "+" : ""}
                {formatCommaFixed(r.deltaPp, 1)}%p
              </p>
            </div>
          </div>
          <DeviationRangeBar
            deltaPp={r.deltaPp}
            inDeadzone={r.inDeadzone}
            isZeroTargetHolding={r.isZeroTargetHolding}
          />
          <div className="mt-2 flex flex-col gap-1 border-t border-white/10 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-[8px] text-zinc-500">
              목표 {formatCommaFixed(r.hasPositiveTarget ? r.targetPp : 0, 1)}% · 현재 {formatCommaFixed(r.currentPp, 1)}%
            </div>
            <div className="text-right">
              <p className="text-[8px] text-zinc-500">
                {side} 필요 <span className="text-zinc-400">(원{usdKrw ? "·달러" : ""})</span>
              </p>
              <p
                className={cn(
                  "text-[11px] font-semibold tabular-nums",
                  r.rebalKrw > 0 ? "text-sky-300" : r.rebalKrw < 0 ? "text-rose-300" : "text-zinc-400",
                )}
              >
                {r.rebalKrw === 0
                  ? "—"
                  : `${r.rebalKrw > 0 ? "" : "−"}${abs.krw}${abs.usd ? ` · ${abs.usd}` : ""}`}
              </p>
            </div>
          </div>
        </div>
      );
    },
    [usdKrw, targetsByTicker, setTarget],
  );

  if (slices.length === 0) {
    return (
      <div
        className="flex min-h-[200px] flex-col items-center justify-center rounded-2xl px-3 py-4 text-center text-xs text-zinc-500"
        style={{
          boxShadow: "inset 4px 4px 10px rgba(0,0,0,0.45), inset -4px -4px 10px rgba(255,255,255,0.04)",
          background: "#151a24",
        }}
      >
        목표 비중을 설정할 주식 슬라이스가 없습니다.
      </div>
    );
  }

  return (
    <div
      className="flex flex-col rounded-2xl p-3 sm:p-4"
      style={{
        background: "#151a24",
        boxShadow:
          "6px 6px 14px rgba(0,0,0,0.45), -4px -4px 12px rgba(255,255,255,0.03), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      <p className="mb-1 text-[11px] font-semibold tracking-wide text-zinc-200">리밸런싱·목표 비중</p>
      <p className="mb-2 text-[10px] leading-snug text-zinc-500">
        중심(0%p)은 목표와 같음, 왼쪽=비중 부족(매수), 오른쪽=과다(매도). 데드존은 ±{REBAL_DEADZONE_PCT}
        %p이며, 그 밖에만 <span className="text-amber-200/90">«매매 필요»</span>로 표시합니다.
      </p>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div
          className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md"
        >
          <p className="text-[8px] font-medium text-zinc-500">총 자산</p>
          <p className="text-sm font-bold tabular-nums text-zinc-100">₩{formatCommaInt(totalKrw)}</p>
        </div>
        <div
          className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md"
        >
          <p className="text-[8px] font-medium text-zinc-500">데드존 밖(조정)</p>
          <p className="text-sm font-bold tabular-nums text-amber-200/95">{formatCommaInt(summary.urgent)}건</p>
        </div>
        <div
          className="rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md"
        >
          <p className="text-[8px] font-medium text-zinc-500">매수 합 / 매도 합</p>
          <p className="text-[10px] font-semibold leading-tight text-zinc-100">
            <span className="text-sky-300">+₩{formatCommaInt(summary.buy)}</span>
            <span className="text-zinc-600"> / </span>
            <span className="text-rose-300">−₩{formatCommaInt(summary.sell)}</span>
          </p>
        </div>
      </div>
      <div
        className="mb-3 rounded-xl border border-cyan-500/15 bg-cyan-500/5 p-2.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] backdrop-blur-md"
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-medium text-cyan-200/90">
          <Wallet className="h-3 w-3 shrink-0" strokeWidth={2.2} />
          추가 입금 시뮬 (원)
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            inputMode="numeric"
            placeholder="예: 1,000,000"
            value={addCashInput}
            onChange={(e) => setAddCashInput(e.target.value)}
            className="w-full min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-900/60 px-2 py-1.5 text-[11px] tabular-nums text-zinc-100 outline-none ring-sky-500/30 focus:ring-1"
          />
          <p className="text-[8px] leading-relaxed text-zinc-500">
            <Info className="mr-0.5 inline h-2.5 w-2.5 text-zinc-500" />
            «저비중·목표 부족» 종목에 잔액 흡수를 우선합니다. 100% 목표·합계 권장.
          </p>
        </div>
        {addCashKrw > 0 && addCashGuide.length > 0 ? (
          <ol className="mt-2 space-y-1 border-t border-white/10 pt-2 text-[9px] text-zinc-300">
            {addCashGuide.map((g, i) => {
              const ab = formatKrwWithUsd(g.allocKrw, usdKrw);
              return (
                <li key={`${g.ticker}-${i}`} className="flex flex-wrap justify-between gap-1">
                  <span>
                    {i + 1}. {g.ticker} <span className="text-zinc-500">({g.displayName})</span>
                  </span>
                  <span className="shrink-0 font-mono text-sky-200/90 tabular-nums">
                    +{ab.krw}
                    {ab.usd ? ` ${ab.usd}` : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : addCashKrw > 0 && hasAnyTarget && targetSumOk ? (
          <p className="mt-2 border-t border-white/10 pt-2 text-[8px] text-zinc-500">
            이미 목표에 도달하거나, 목표가 없는 구간이면 별도 배분이 필요합니다.
          </p>
        ) : null}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleClickSave()}
          disabled={saveStatus === "saving" || slices.length === 0}
          className="rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[10px] font-semibold text-sky-200 shadow-[0_0_12px_rgba(56,189,248,0.15)] transition hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saveStatus === "saving" ? "저장 중…" : "목표 비중 저장"}
        </button>
        {serverSaveHint ? (
          <span
            className={`max-w-[min(100%,20rem)] text-[9px] leading-snug ${
              saveStatus === "err" ? "text-rose-300/95" : "text-emerald-200/90"
            }`}
          >
            {serverSaveHint}
          </span>
        ) : null}
      </div>
      <div className="mb-2 flex flex-wrap gap-3 text-[9px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-gradient-to-r from-emerald-600 to-lime-500" />
          |Δ|≤2%p·정상
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-gradient-to-r from-amber-500 to-rose-600" />
          Δ+2%p 초과·과다
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-gradient-to-l from-sky-500 to-blue-600" />
          Δ-2%p 미만·부족
        </span>
      </div>
      {showTargetSumError ? (
        <div
          className="mb-3 rounded-lg border border-rose-500/45 bg-rose-950/35 px-2.5 py-2 text-[10px] leading-snug text-rose-100/95"
          role="alert"
        >
          <p className="text-rose-200/95">
            목표 합계 <span className="tabular-nums font-semibold text-rose-50">{targetSum.toFixed(1)}%</span>
            — 100%에 맞추세요
            {targetSum < 100 - TARGET_SUM_TOLERANCE ? (
              <span>
                {" "}
                (<span className="tabular-nums">{(100 - targetSum).toFixed(1)}%</span> 부족)
              </span>
            ) : (
              <span>
                {" "}
                (<span className="tabular-nums">{(targetSum - 100).toFixed(1)}%</span> 초과)
              </span>
            )}
            .
          </p>
        </div>
      ) : hasAnyTarget && targetSumOk ? (
        <p className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-950/25 px-2.5 py-1.5 text-[10px] text-emerald-200/95">
          목표 비중 합계 <span className="tabular-nums font-semibold">{targetSum.toFixed(1)}%</span> — 100%에 맞습니다.
        </p>
      ) : null}
      <p className="mb-2 text-[7px] text-zinc-600">※ 각 섹션 안에서는 |Δ%p|가 큰 종목(조정 긴급도)이 위로 옵니다.</p>
      <div className="max-h-[min(70vh,920px)] space-y-4 overflow-y-auto pr-0.5">
        {actionRows.length === 0 && pendingSlices.length === 0 ? (
          <p className="text-center text-[10px] text-zinc-500">아래에 목표를 입력하면 리밸런싱 패널이 열립니다.</p>
        ) : null}
        {actionRows.length > 0 ? (
          <>
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-emerald-200/85">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80 shadow-[0_0_8px_rgba(52,211,153,0.45)]" />
                안전 자산
              </h4>
              <div className="space-y-2">
                {safeRows.length === 0 ? (
                  <p className="text-[8px] text-zinc-600">(해당 없음)</p>
                ) : (
                  safeRows.map((r) => renderRebalRow(r))
                )}
              </div>
            </div>
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-violet-200/85">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400/80 shadow-[0_0_8px_rgba(167,139,250,0.4)]" />
                공격 자산
              </h4>
              <div className="space-y-2">
                {aggRows.length === 0 ? (
                  <p className="text-[8px] text-zinc-600">(해당 없음)</p>
                ) : (
                  aggRows.map((r) => renderRebalRow(r))
                )}
              </div>
            </div>
          </>
        ) : null}
        {pendingSlices.length > 0 ? (
          <div>
            <h4 className="mb-1.5 text-[9px] font-bold text-zinc-500">목표 미입력 (빠른 입력)</h4>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(68px,1fr))] gap-2">
              {pendingSlices.map((slice) => {
                const hasT = Object.prototype.hasOwnProperty.call(targetsByTicker, slice.ticker);
                return (
                  <label key={slice.name} className="flex flex-col gap-0.5 rounded-lg border border-white/10 bg-zinc-900/40 p-1">
                    <span className="line-clamp-1 text-center text-[7px] font-medium text-zinc-400" title={slice.displayName}>
                      {slice.ticker}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      placeholder="—"
                      className="w-full rounded border border-white/10 bg-zinc-900/80 py-0.5 text-center text-[9px] tabular-nums text-zinc-100"
                      value={hasT ? String(targetsByTicker[slice.ticker]) : ""}
                      onChange={(e) => setTarget(slice.ticker, e.target.value)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function FamilyAllocationDonut({
  ownerName,
  data,
  total,
  watchlistEntries,
  cloudSyncKey = "",
  usdKrw = null,
}: {
  ownerName: string;
  data: AllocationSlice[];
  total: number;
  watchlistEntries?: Array<{ symbol: string; name: string; group?: string }>;
  /** 동기화 키(8자 이상) — 목표 비중을 서버에도 남길 때 사용 */
  cloudSyncKey?: string;
  usdKrw?: number | null;
}) {
  const chartData = useMemo(() => [...data].sort((a, b) => b.value - a.value), [data]);

  const stockSlicesForTargets = useMemo(
    () => {
      const usdCash = chartData.find((d) => d.ticker === "USD 현금");
      const krwCash = chartData.find((d) => d.ticker === "KRW 현금");
      const mergedCashValue = (usdCash?.value ?? 0) + (krwCash?.value ?? 0);
      const mergedCashWeight = (usdCash?.weight ?? 0) + (krwCash?.weight ?? 0);
      const base = chartData.filter(
        (d) => d.value > 0 && d.ticker !== "USD 현금" && d.ticker !== "KRW 현금",
      );
      if (mergedCashValue > 0) {
        base.push({
          name: "cash-merged",
          displayName: "현금(USD+KRW)",
          ticker: "현금",
          allEntries: [
            ...(usdCash?.allEntries ?? []),
            ...(krwCash?.allEntries ?? []),
          ],
          value: mergedCashValue,
          weight: mergedCashWeight,
          changePct: null,
        });
      }
      const seen = new Set(base.map((d) => d.ticker.trim().toUpperCase()));
      const groupedWatch = new Map<
        string,
        { ticker: string; displayName: string; allEntries: { name: string; symbol: string }[] }
      >();
      for (const row of watchlistEntries ?? []) {
        const symbol = row.symbol.trim().toUpperCase();
        if (!symbol) continue;
        const group = (row.group ?? "").trim();
        const ticker = group || symbol;
        const key = ticker.toUpperCase();
        if (seen.has(key)) continue;
        const prev = groupedWatch.get(key);
        const entry = { name: row.name.trim() || symbol, symbol };
        if (prev) {
          prev.allEntries.push(entry);
        } else {
          groupedWatch.set(key, {
            ticker,
            displayName: group || row.name.trim() || symbol,
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
      return [...base, ...extra];
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

      <div className="mb-3 border-b border-white/10 pb-3">
        <p className="text-base font-bold text-zinc-100">{ownerName}</p>
        <p className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-300">총 자산 {formatKrw(total)}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.88fr)_minmax(320px,1.2fr)] lg:items-start">
        <div className="flex min-h-0 max-w-full flex-col lg:max-w-[min(100%,520px)]">
          <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400">비중 트리맵</p>
          <div className="h-[200px] w-full rounded-xl border border-white/10 bg-zinc-950/40 p-2 sm:h-[228px]">
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
        </div>

        <TargetStockWeightNeu
          ownerName={ownerName}
          slices={stockSlicesForTargets}
          cloudSyncKey={cloudSyncKey}
          totalKrw={total}
          usdKrw={usdKrw}
        />
      </div>
    </div>
  );
}
