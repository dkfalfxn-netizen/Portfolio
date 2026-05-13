"use client";

import {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { GripVertical } from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { fmtInt, parseKoreanIntDigits } from "@/lib/format-money";
import {
  CALCULATOR_TARGET_STORAGE_KEY,
  loadAllCalculatorMemberSplits,
  loadAllCalculatorTargetWeights,
  loadAllTargetStockWeights,
  persistCalculatorMemberSplitsForOwner,
} from "@/lib/portfolio-target-weights";
import {
  loadVisualOrderKeysForOwner,
  persistVisualOrderForOwner,
  REBALANCE_VISUAL_ORDER_REFRESH_EVENT,
} from "@/lib/rebalance-visual-order";
import {
  allocationTickerMatches,
  allowedCalculatorStubTickerKeysUpper,
  mergeWatchlistSymbolsIntoCalculatorGroups,
  type WatchlistRowForRebalance,
} from "@/lib/rebalance-watchlist-groups";

/** 미보유 스텁 행 복원 시 허용 티커만 사용 — 보유 슬라이스·워치 슬라이스 외 LS 잔재(AI 등)로 목표 합이 100% 넘는 현상 차단 */
function mergeSavedTargetGroupsWithoutHoldings(
  ownerName: string,
  baseGroups: GroupAllocation[],
  ctx: {
    allocationTickers: string[];
    watchlistRows: WatchlistRowForRebalance[];
    watchlistOwnerAllToken: string;
  },
): GroupAllocation[] {
  const fromCalc = loadAllCalculatorTargetWeights()[ownerName] ?? {};
  const fromDash = loadAllTargetStockWeights()[ownerName] ?? {};
  const saved = { ...fromCalc, ...fromDash };
  const allowedStub = allowedCalculatorStubTickerKeysUpper({
    ownerName,
    allocationTickers: ctx.allocationTickers,
    watchlistRows: ctx.watchlistRows,
    watchlistOwnerAllToken: ctx.watchlistOwnerAllToken,
  });
  const seenUpper = new Set(baseGroups.map((g) => g.groupKey.trim().toUpperCase()));
  const extra: GroupAllocation[] = [];
  for (const [key, target] of Object.entries(saved)) {
    const k = key.trim();
    const ku = k.toUpperCase();
    // stale key 정리: 목표가 0% 이하인 미보유 그룹은 계산기 목록에 복원하지 않음
    if (!(Number(target) > 0)) continue;
    if (!k || !allowedStub.has(ku)) continue;
    if (seenUpper.has(ku)) continue;
    seenUpper.add(ku);
    extra.push({
      groupKey: k,
      displayName: k,
      valueKrw: 0,
      currentPct: 0,
      repSymbol: k,
      repName: k,
      repPrice: 0,
      members: [],
    });
  }
  return extra.length ? [...baseGroups, ...extra] : baseGroups;
}

/** 대시보드에 목표가 없을 때 목표 입력란 초깃값은 0 (현재 비중으로 대체하지 않음) */
function dashboardTargetInputString(saved: Record<string, number>, groupKey: string): string {
  const v = saved[groupKey];
  return v != null && Number.isFinite(v) ? String(v) : "0";
}


/** 계산기 목표 문자열을 계산기 전용 LS 키에 저장 (대시보드와 독립) */
function persistCalculatorTargets(
  ownerName: string,
  targetsStrings: Record<string, string>,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const all = loadAllCalculatorTargetWeights();
    const before = JSON.stringify(all);
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(targetsStrings)) {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) continue;
      next[k] = Math.min(100, Math.max(0, n));
    }
    all[ownerName] = next;
    if (JSON.stringify(all) === before) return false;
    window.localStorage.setItem(CALCULATOR_TARGET_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

// ─── 타입 ──────────────────────────────────────────────────────────────────────

export type GroupAllocation = {
  groupKey: string;
  displayName: string;
  valueKrw: number;
  currentPct: number;
  repSymbol: string;
  repName: string;
  repPrice: number;
  members: { symbol: string; name: string; valueKrw: number; priceKrw: number }[];
};

type MemberAdj = {
  symbol: string;
  name: string;
  valueKrw: number;
  priceKrw: number;
  diffKrw: number;
  shares: number | null;
};

type ComputedRow = GroupAllocation & {
  targetPct: number;
  diffKrw: number;
  memberAdjustments: MemberAdj[];
};

type Props = {
  ownerName: string;
  groups: GroupAllocation[];
  totalKrw: number;
  /** 대시보드 불러오기 후 외부 래퍼가 ownerData를 재계산하도록 알림 */
  onDashboardLoaded?: () => void;
  /** 대시보드 현재 목표 비중 (저장 이벤트로 항상 최신값 전달, 보유+워치리스트 허용 티커 위주) */
  dashboardTargets?: Record<string, number> | null;
  /** 대시보드 바에서 디바운스된 편집 중 목표(localStorage 플러시보다 신선함) */
  draftTargets?: Record<string, number> | null;
};

type Mode = "buy-sell" | "buy-only";

/** SSR에서는 false, 클라이언트에서는 true — localStorage 병합은 클라이언트에서만 */
function useClientReady(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

// ─── 헬퍼 ──────────────────────────────────────────────────────────────────────

function fmtKrw(n: number) {
  return `₩${fmtInt(Math.abs(n))}`;
}

function normalizeTickerKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isLikelyKoreanTicker(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (!s) return false;
  if (s.startsWith("KRX:")) return /^[0-9][0-9A-Z]{5}$/.test(s.slice(4));
  if (s.startsWith("KQ:")) return /^[0-9][0-9A-Z]{5}$/.test(s.slice(3));
  return /^[0-9][0-9A-Z]{5}$/.test(s);
}

function formatTickerLabel(
  symbol: string,
  name: string,
  resolvedNameBySymbol?: Record<string, string>,
): string {
  const s = symbol.trim();
  const fallback = resolvedNameBySymbol?.[normalizeTickerKey(symbol)]?.trim() ?? "";
  const n = (name.trim() || fallback).trim();
  if (!s) return n;
  if (!n) return s;
  if (s.toLowerCase() === n.toLowerCase()) return s;
  return `${s} (${n})`;
}

function valueBasedMemberRatios(g: GroupAllocation): number[] {
  if (g.members.length === 0) return [];
  if (g.valueKrw > 0) return g.members.map((m) => m.valueKrw / g.valueKrw);
  return g.members.map(() => 1 / g.members.length);
}

/** 입력된 양수 가중치로 정규화; 모두 비었거나 일부만 채우면 평가금 비율 */
function memberRatiosForGroup(g: GroupAllocation, splitInputs?: Record<string, string>): number[] {
  if (g.members.length === 0) return [];
  const weights = g.members.map((m) => {
    const raw = (splitInputs?.[m.symbol] ?? "").trim().replace(",", ".");
    if (raw === "") return NaN;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  });
  const anyFilled = weights.some((w) => Number.isFinite(w));
  const allFilled = weights.every((w) => Number.isFinite(w));
  if (!anyFilled || !allFilled) return valueBasedMemberRatios(g);
  const sum = weights.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (sum <= 0) return valueBasedMemberRatios(g);
  return weights.map((w) => (Number.isFinite(w) ? w / sum : 0));
}

function calcMemberAdjustments(
  g: GroupAllocation,
  diffKrw: number,
  splitInputs?: Record<string, string>,
): MemberAdj[] {
  if (g.members.length === 0) return [];
  const ratios = memberRatiosForGroup(g, splitInputs);
  return g.members.map((m, i) => {
    const ratio = ratios[i] ?? 0;
    const memberDiffKrw = diffKrw * ratio;
    return {
      ...m,
      diffKrw: memberDiffKrw,
      shares: m.priceKrw > 0 ? memberDiffKrw / m.priceKrw : null,
    };
  });
}

/** 차트 리밸런싱 위젯과 동일: 현금 행 목표·현재 비중(%p) 편차 */
function CashAllocationDeviationLabel({
  targetPct,
  actualPct,
}: {
  targetPct: number;
  actualPct: number;
}) {
  const hasPositiveTarget = targetPct > 0;
  const diffPp = actualPct - targetPct;
  const relDev = hasPositiveTarget ? (actualPct - targetPct) / targetPct : 0;
  const withinBand = hasPositiveTarget && Math.abs(relDev) <= 0.05;
  const belowBand = hasPositiveTarget && relDev < -0.05;

  if (!hasPositiveTarget && actualPct > 0) {
    return <span className="text-emerald-400">목표 0% ▼ +{actualPct.toFixed(1)}%p</span>;
  }
  if (!hasPositiveTarget) {
    return <span className="text-zinc-400">목표 0%</span>;
  }
  if (withinBand) {
    return <span className="text-sky-400">≈ 목표</span>;
  }
  if (belowBand) {
    return (
      <span className="text-rose-400">▲ {Math.abs(diffPp).toFixed(1)}%p 부족</span>
    );
  }
  return <span className="text-emerald-400">▼ +{diffPp.toFixed(1)}%p 초과</span>;
}

/** 대시보드·리밸 바와 동일하게 현금 줄은 드래그 비활성·하단 고정 */
function isPinnedCashPortfolioGroup(groupKey: string): boolean {
  const t = groupKey.trim();
  if (t === "현금" || t === "USD 현금" || t === "KRW 현금") return true;
  return t.toLowerCase().includes("cash");
}

function orderPortfolioGroupsVisual(
  groupsIn: GroupAllocation[],
  visualKeys: string[] | null,
  sortFallback: (a: GroupAllocation, b: GroupAllocation) => number,
): GroupAllocation[] {
  const pinned = groupsIn.filter((g) => isPinnedCashPortfolioGroup(g.groupKey));
  const movable = groupsIn.filter((g) => !isPinnedCashPortfolioGroup(g.groupKey));
  const keysFiltered = visualKeys?.filter((k) => movable.some((g) => g.groupKey === k)) ?? null;
  let orderedNc: GroupAllocation[];
  if (keysFiltered && keysFiltered.length > 0) {
    const map = new Map(movable.map((g) => [g.groupKey, g]));
    orderedNc = [];
    for (const k of keysFiltered) {
      const g = map.get(k);
      if (g) {
        orderedNc.push(g);
        map.delete(k);
      }
    }
    orderedNc.push(...[...map.values()].sort(sortFallback));
  } else {
    orderedNc = [...movable].sort(sortFallback);
  }
  return [...orderedNc, ...pinned.sort(sortFallback)];
}

function RebalancingBarSortableRow({
  row,
  targets,
  setTargets,
  maxScale,
  totalKrw,
  memberSplitsForGroup,
  onMemberSplitChange,
  resolvedNameBySymbol,
}: {
  row: ComputedRow;
  targets: Record<string, string>;
  setTargets: Dispatch<SetStateAction<Record<string, string>>>;
  maxScale: number;
  totalKrw: number;
  memberSplitsForGroup: Record<string, string>;
  onMemberSplitChange: (groupKey: string, symbol: string, raw: string) => void;
  resolvedNameBySymbol: Record<string, string>;
}) {
  const pinned = isPinnedCashPortfolioGroup(row.groupKey);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.groupKey,
    disabled: pinned,
  });
  const diff = row.targetPct - row.currentPct;
  const absDiff = Math.abs(diff);
  const rowIsOver = diff < -0.049;
  const rowIsUnder = diff > 0.049;
  const currentBarPct = Math.min((row.currentPct / maxScale) * 100, 100);
  const targetLinePct = Math.min((row.targetPct / maxScale) * 100, 100);
  const isCash = pinned;

  const outerStyle =
    !pinned ?
      {
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.9, zIndex: 3, position: "relative" as const } : {}),
      }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={outerStyle}
      className="border-b border-slate-800/40 last:border-0"
    >
      <div className="flex items-center py-1.5">
        {!pinned ?
          <button
            type="button"
            className="touch-none mr-0.5 shrink-0 cursor-grab rounded p-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
            title="순서 이동 (드래그)"
            {...attributes}
            {...listeners}
            aria-label={`${row.groupKey} 순서 변경`}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        : <span className="mr-0.5 w-5 shrink-0" aria-hidden />}

        <div className="flex w-36 shrink-0 items-center gap-0.5 sm:w-44">
          <span
            className="min-w-0 flex-1 truncate text-[11px] font-medium sm:text-xs"
            title={row.displayName || row.groupKey}
          >
            {row.displayName || row.groupKey}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              className="w-12 rounded border bg-background px-1 py-0.5 text-right text-[11px] tabular-nums"
              value={targets[row.groupKey] ?? ""}
              onChange={(e) => setTargets((prev) => ({ ...prev, [row.groupKey]: e.target.value }))}
              title="목표 비중 입력 — 계산기 전용 저장소에 자동 저장됩니다."
              aria-label={`${row.displayName || row.groupKey} 목표 비중 퍼센트`}
            />
            <span className="text-[10px] text-muted-foreground">%</span>
          </div>
        </div>

        <div className="relative mx-1.5 h-5 flex-1 min-w-0">
          <div className="absolute inset-y-1 inset-x-0 rounded-sm bg-slate-800/60" />
          {[0.25, 0.5, 0.75].map((f) => (
            <div
              key={f}
              className="pointer-events-none absolute inset-y-1 w-px bg-slate-700/40"
              style={{ left: `${f * 100}%` }}
            />
          ))}
          <div
            className={`absolute inset-y-1 left-0 rounded-sm transition-all duration-300 ${
              rowIsOver ? "bg-emerald-500/75" : rowIsUnder ? "bg-rose-500/75" : "bg-slate-500/60"
            }`}
            style={{ width: `${currentBarPct}%` }}
          />
          {row.targetPct > 0 ?
            <div
              className="absolute inset-y-0 w-0 border-l-2 border-dashed border-white/55 transition-all duration-300"
              style={{ left: `${targetLinePct}%` }}
            />
          : null}
        </div>

        <div className="w-24 shrink-0 text-right text-[11px] sm:w-28">
          {isCash ?
            <CashAllocationDeviationLabel targetPct={row.targetPct} actualPct={row.currentPct} />
          : rowIsOver ?
            <span className="font-medium tabular-nums text-emerald-400">▼+{absDiff.toFixed(1)}%p 초과</span>
          : rowIsUnder ?
            <span className="font-medium tabular-nums text-rose-400">▲{absDiff.toFixed(1)}%p 부족</span>
          : (
            <span className="text-muted-foreground">✓</span>
          )}
        </div>
      </div>

      {!pinned && row.members.length > 0 ?
        <div className="border-t border-dashed border-slate-800/55 pb-1.5 pt-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-7 sm:pl-8">
            <span className="w-full text-[9px] font-medium leading-snug text-muted-foreground/95">
              그룹 매매 차액을 종목끼리 나눌 비율(가중치)입니다. 포트폴리오 %나 목표 %가 아닙니다.
              예: 반반 → 각각 <span className="tabular-nums">1</span>과{" "}
              <span className="tabular-nums">1</span>(또는 <span className="tabular-nums">50</span>과{" "}
              <span className="tabular-nums">50</span> — 숫자 크기는 비율만 의미합니다).
              같은 그룹 종목 줄을 <span className="font-medium text-foreground/90">모두</span> 양수로 채워야 적용되고,
              하나라도 비우면 평가금 비율로 자동 분배합니다.
            </span>
          </div>
          <div className="mt-1 space-y-1 pl-7 sm:pl-8">
            {row.members.map((m) => {
              const portPct = totalKrw > 0 ? (m.valueKrw / totalKrw) * 100 : 0;
              return (
                <div key={`${row.groupKey}:${m.symbol}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                  <span className="min-w-[8rem] max-w-[14rem] truncate font-medium text-muted-foreground">
                    {formatTickerLabel(m.symbol, m.name, resolvedNameBySymbol)}
                  </span>
                  <span className="tabular-nums text-muted-foreground/90">
                    현재 {portPct.toFixed(2)}% · {fmtKrw(m.valueKrw)}
                  </span>
                  <label className="ml-auto flex items-center gap-1 sm:ml-0">
                    <span className="shrink-0 text-[9px] text-muted-foreground">가중치</span>
                    <span className="sr-only">{m.symbol} 매매 차액 분배 가중치</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      placeholder="비움"
                      className="w-16 rounded border bg-background px-1 py-0.5 text-right tabular-nums"
                      value={memberSplitsForGroup[m.symbol] ?? ""}
                      onChange={(e) => onMemberSplitChange(row.groupKey, m.symbol, e.target.value)}
                      aria-label={`${row.displayName || row.groupKey} · ${m.symbol} 매매 차액 분배 가중치`}
                      title="이 종목이 그룹 전체 매매 차액 중 차지할 비중의 비율. 모든 종목 줄에 양수를 넣어야 적용됩니다. 비우면 평가금 비율."
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      : null}
    </div>
  );
}

// ─── RebalancingOwner ──────────────────────────────────────────────────────────

/** 정수 주수 (floor 절대값, 부호는 호출자가 처리) */
function floorShares(diffKrw: number, priceKrw: number): number {
  if (priceKrw <= 0) return 0;
  return Math.floor(Math.abs(diffKrw) / priceKrw);
}

function RebalancingOwner({ ownerName, groups, totalKrw, onDashboardLoaded, dashboardTargets, draftTargets }: Props) {
  const [resolvedNameBySymbol, setResolvedNameBySymbol] = useState<Record<string, string>>({});

  // ── 목표 비중 state: 계산기 전용 키에서 초깃값 읽기 (대시보드와 독립) ──
  const [targets, setTargets] = useState<Record<string, string>>(() => {
    const saved =
      typeof window !== "undefined" ? (loadAllCalculatorTargetWeights()[ownerName] ?? {}) : {};
    const init: Record<string, string> = {};
    for (const g of groups) {
      init[g.groupKey] = dashboardTargetInputString(saved, g.groupKey);
    }
    return init;
  });

  // 새 그룹이 추가·삭제될 때 targets를 그룹 키에 맞춤 (빠진 행 키는 제거 → LS 자동저장으로 stale 복구 차단)
  useEffect(() => {
    setTargets((prev) => {
      const saved = loadAllCalculatorTargetWeights()[ownerName] ?? {};
      const next: Record<string, string> = {};
      for (const g of groups) {
        const k = g.groupKey;
        next[k] = k in prev ? prev[k]! : dashboardTargetInputString(saved, k);
      }
      if (Object.keys(next).length === Object.keys(prev).length) {
        let same = true;
        for (const k of Object.keys(next)) {
          if (next[k] !== prev[k]) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, [groups, ownerName]);

  /** 그룹 내 종목별 매매액 분배 가중치 (계산기 전용 LS) */
  const [memberSplits, setMemberSplits] = useState<Record<string, Record<string, string>>>(() =>
    typeof window !== "undefined"
      ? (() => {
          const raw = loadAllCalculatorMemberSplits()[ownerName] ?? {};
          const out: Record<string, Record<string, string>> = {};
          for (const g of groups) {
            const row: Record<string, string> = {};
            for (const m of g.members) {
              const n = raw[g.groupKey]?.[m.symbol];
              row[m.symbol] = n != null && Number.isFinite(n) ? String(n) : "";
            }
            if (Object.keys(row).length > 0) out[g.groupKey] = row;
          }
          return out;
        })()
      : {},
  );

  useEffect(() => {
    setMemberSplits((prev) => {
      const saved = loadAllCalculatorMemberSplits()[ownerName] ?? {};
      const next: Record<string, Record<string, string>> = {};
      for (const g of groups) {
        const gk = g.groupKey;
        const row: Record<string, string> = {};
        for (const m of g.members) {
          const prevV = prev[gk]?.[m.symbol];
          const n = saved[gk]?.[m.symbol];
          row[m.symbol] =
            prevV !== undefined && prevV !== ""
              ? prevV
              : n != null && Number.isFinite(n)
                ? String(n)
                : "";
        }
        if (Object.keys(row).length > 0) next[gk] = row;
      }
      return next;
    });
  }, [groups, ownerName]);

  const handleMemberSplitChange = useCallback((groupKey: string, symbol: string, raw: string) => {
    setMemberSplits((prev) => ({
      ...prev,
      [groupKey]: { ...(prev[groupKey] ?? {}), [symbol]: raw },
    }));
  }, []);

  const [visualOrderKeys, setVisualOrderKeys] = useState<string[] | null>(null);

  useEffect(() => {
    setVisualOrderKeys(loadVisualOrderKeysForOwner(ownerName));
  }, [ownerName]);

  useEffect(() => {
    const h = () => setVisualOrderKeys(loadVisualOrderKeysForOwner(ownerName));
    window.addEventListener(REBALANCE_VISUAL_ORDER_REFRESH_EVENT, h);
    return () => window.removeEventListener(REBALANCE_VISUAL_ORDER_REFRESH_EVENT, h);
  }, [ownerName]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const sortGroupsByTarget = useCallback(
    (a: GroupAllocation, b: GroupAllocation) => {
      const ta = parseFloat(targets[a.groupKey] ?? "0") || 0;
      const tb = parseFloat(targets[b.groupKey] ?? "0") || 0;
      return tb - ta;
    },
    [targets],
  );

  const orderedGroups = useMemo(
    () => orderPortfolioGroupsVisual(groups, visualOrderKeys, sortGroupsByTarget),
    [groups, visualOrderKeys, sortGroupsByTarget],
  );

  const handleCalculatorBarDragEnd = useCallback(
    (sortableIds: string[], e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const a = String(active.id);
      const o = String(over.id);
      const oldIdx = sortableIds.indexOf(a);
      const newIdx = sortableIds.indexOf(o);
      if (oldIdx < 0 || newIdx < 0) return;
      const nextOrder = arrayMove(sortableIds, oldIdx, newIdx);
      setVisualOrderKeys(nextOrder);
      persistVisualOrderForOwner(ownerName, nextOrder);
    },
    [ownerName],
  );

  // ── 모드 & 신규 투자금 ─────────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>("buy-sell");
  const [newMoneyInput, setNewMoneyInput] = useState("");
  const [splitCountInput, setSplitCountInput] = useState("1");
  const [hideSmall, setHideSmall] = useState(false);
  const [saveToast, setSaveToast] = useState(false);

  const newMoneyKrw = useMemo(() => parseKoreanIntDigits(newMoneyInput), [newMoneyInput]);
  const splitCount = useMemo(() => {
    const n = Math.floor(Number(splitCountInput));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(20, n);
  }, [splitCountInput]);

  // ── 목표 합계 ────────────────────────────────────────────────────────────
  const targetSum = useMemo(
    () => Object.values(targets).reduce((s, v) => s + (parseFloat(v) || 0), 0),
    [targets],
  );
  const sumIsOver = targetSum > 100.05;
  const sumIsUnder = targetSum < 99.95;

  // ── 바 스케일: 현재 & 목표 중 최대값의 125% (5% 단위로 올림) ──────────────
  const maxScale = useMemo(() => {
    const vals = groups.flatMap((g) => [
      g.currentPct,
      parseFloat(targets[g.groupKey] ?? "0") || 0,
    ]);
    const raw = Math.max(...vals, 5);
    return Math.ceil((raw * 1.25) / 5) * 5;
  }, [groups, targets]);

  // ── 행 계산 (표시 순서 = orderedGroups, 대시보드와 같은 visual order 키) ───
  const rows = useMemo((): ComputedRow[] => {
    const isGhostRow = (row: { valueKrw: number; currentPct: number; targetPct: number; members: { valueKrw: number }[] }) => {
      const hasMemberValue = row.members.some((m) => Math.abs(m.valueKrw) > 0);
      return (
        Math.abs(row.valueKrw) < 1 &&
        Math.abs(row.currentPct) < 0.0001 &&
        Math.abs(row.targetPct) < 0.0001 &&
        !hasMemberValue
      );
    };

    if (mode === "buy-sell") {
      return orderedGroups.map((g) => {
        const targetPct = parseFloat(targets[g.groupKey] ?? "0") || 0;
        const diffKrw = (targetPct / 100) * totalKrw - g.valueKrw;
        return {
          ...g,
          targetPct,
          diffKrw,
          memberAdjustments: calcMemberAdjustments(g, diffKrw, memberSplits[g.groupKey]),
        };
      }).filter((r) => !isGhostRow(r));
    }

    // buy-only
    const newTotal = totalKrw + Math.max(newMoneyKrw, 0);
    const rawRows = orderedGroups.map((g) => {
      const targetPct = parseFloat(targets[g.groupKey] ?? "0") || 0;
      const rawDiff = (targetPct / 100) * newTotal - g.valueKrw;
      return { g, targetPct, rawDiff };
    });
    const totalBuyNeeded = rawRows.reduce((s, r) => s + Math.max(0, r.rawDiff), 0);
    // newMoneyKrw = 0 이면 scale = 0 → 아무 배분 없음
    const scale =
      newMoneyKrw > 0 ? Math.min(1, newMoneyKrw / Math.max(totalBuyNeeded, 1)) : 0;

    return rawRows.map(({ g, targetPct, rawDiff }) => {
      const diffKrw = rawDiff > 0 ? rawDiff * scale : 0;
      return {
        ...g,
        targetPct,
        diffKrw,
        memberAdjustments: calcMemberAdjustments(g, diffKrw, memberSplits[g.groupKey]),
      };
    }).filter((r) => !isGhostRow(r));
  }, [orderedGroups, targets, totalKrw, mode, newMoneyKrw, memberSplits]);

  const { sortableBarGroupKeys, sortableContextIds } = useMemo(() => {
    const nk = rows.filter((r) => !isPinnedCashPortfolioGroup(r.groupKey)).map((r) => r.groupKey);
    const pin = rows.filter((r) => isPinnedCashPortfolioGroup(r.groupKey)).map((r) => r.groupKey);
    return {
      sortableBarGroupKeys: nk,
      sortableContextIds: [...nk, ...pin],
    };
  }, [rows]);

  // ── 배분된 투자금 합계 (buy-only) ─────────────────────────────────────────
  const allocatedKrw = useMemo(
    () => (mode === "buy-only" ? rows.reduce((s, r) => s + r.diffKrw, 0) : 0),
    [rows, mode],
  );

  // ── 매매 실행 순서 ────────────────────────────────────────────────────────
  const actionItems = useMemo(() => {
    const significant = rows.filter((r) => Math.abs(r.diffKrw) >= 10000);
    if (mode === "buy-only") {
      return significant.filter((r) => r.diffKrw > 0).sort((a, b) => b.diffKrw - a.diffKrw);
    }
    const sells = significant.filter((r) => r.diffKrw < 0).sort((a, b) => a.diffKrw - b.diffKrw);
    const buys = significant.filter((r) => r.diffKrw > 0).sort((a, b) => b.diffKrw - a.diffKrw);
    return [...sells, ...buys];
  }, [rows, mode]);

  // ── 표시 행 (임계값 필터 적용) ───────────────────────────────────────────
  const visibleRows = useMemo(
    () =>
      hideSmall
        ? rows.filter((r) => Math.abs(r.targetPct - r.currentPct) >= 1)
        : rows,
    [rows, hideSmall],
  );

  // ── 자동저장: 계산기 전용 키에만 저장, 대시보드 이벤트 미발행 ─────────────
  const [loadToast, setLoadToast] = useState(false);

  useEffect(() => {
    const unresolved = new Set<string>();
    for (const g of groups) {
      if (
        isLikelyKoreanTicker(g.repSymbol) &&
        (!g.repName || g.repName.trim() === "" || g.repName.trim().toUpperCase() === g.repSymbol.trim().toUpperCase()) &&
        !resolvedNameBySymbol[normalizeTickerKey(g.repSymbol)]
      ) {
        unresolved.add(g.repSymbol);
      }
      for (const m of g.members) {
        if (
          isLikelyKoreanTicker(m.symbol) &&
          (!m.name || m.name.trim() === "" || m.name.trim().toUpperCase() === m.symbol.trim().toUpperCase()) &&
          !resolvedNameBySymbol[normalizeTickerKey(m.symbol)]
        ) {
          unresolved.add(m.symbol);
        }
      }
    }
    if (unresolved.size === 0) return;
    const ac = new AbortController();
    const list = [...unresolved];
    void fetch(`/api/symbol-name?symbols=${encodeURIComponent(list.join(","))}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { names?: Record<string, string> } | null) => {
        const names = j?.names;
        if (!names) return;
        setResolvedNameBySymbol((prev) => {
          const next = { ...prev };
          for (const [symbol, nm] of Object.entries(names)) {
            if (typeof nm !== "string" || !nm.trim()) continue;
            next[normalizeTickerKey(symbol)] = nm.trim();
          }
          return next;
        });
      })
      .catch(() => {});
    return () => ac.abort();
  }, [groups, resolvedNameBySymbol]);

  /** handleLoad가 localStorage를 덮어쓰기 전에 취소할 수 있도록 ref로 타이머 ID 관리 */
  const autosaveTimerRef = useRef<number | null>(null);
  const memberSplitAutosaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (autosaveTimerRef.current != null) window.clearTimeout(autosaveTimerRef.current);
    const id = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      persistCalculatorTargets(ownerName, targets);
    }, 420) as unknown as number;
    autosaveTimerRef.current = id;
    return () => {
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [targets, ownerName]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (memberSplitAutosaveTimerRef.current != null) {
      window.clearTimeout(memberSplitAutosaveTimerRef.current);
    }
    const id = window.setTimeout(() => {
      memberSplitAutosaveTimerRef.current = null;
      persistCalculatorMemberSplitsForOwner(ownerName, memberSplits);
    }, 420) as unknown as number;
    memberSplitAutosaveTimerRef.current = id;
    return () => {
      if (memberSplitAutosaveTimerRef.current != null) {
        window.clearTimeout(memberSplitAutosaveTimerRef.current);
        memberSplitAutosaveTimerRef.current = null;
      }
    };
  }, [memberSplits, ownerName]);

  /** 대시보드 목표 비중 불러오기 — localStorage 목표와 페이지 요약본을 합산해 현재 행(groups)에 맞춘다 */
  const handleLoad = useCallback(() => {
    if (typeof window === "undefined") return;
    // 로컬스토리지(전체 목표) + 페이지가 내려준 집약본을 합산.
    // `dashboardTargets ?? LS`처럼 prop만 쓰면 LS에 있는 미보유(워치리스트) 줄이 무시된다.
    const fromLsDash = loadAllTargetStockWeights()[ownerName] ?? {};
    const fromProp = dashboardTargets ?? {};
    const fromDraft = draftTargets ?? {};
    // 요약본 → 저장된 전체 목표 순으로 덮고, 마지막에 화면에만 있는 초안까지 합함(워치 목표 초기 입력 포함)
    const saved = { ...fromProp, ...fromLsDash, ...fromDraft };

    // autosave 타이머를 먼저 취소해 구 targets 가 localStorage를 덮어쓰는 race 방지
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (memberSplitAutosaveTimerRef.current != null) {
      window.clearTimeout(memberSplitAutosaveTimerRef.current);
      memberSplitAutosaveTimerRef.current = null;
    }

    // 계산기 localStorage를 병합된 대시보드 목표로 교체
    const allCalc = loadAllCalculatorTargetWeights();
    allCalc[ownerName] = { ...saved };
    try { window.localStorage.setItem(CALCULATOR_TARGET_STORAGE_KEY, JSON.stringify(allCalc)); } catch { /* ignore */ }

    // targets를 현재 groups 기준으로 재구성(행은 미보유 stub 병합으로 곧 증가)
    const next: Record<string, string> = {};
    for (const g of groups) {
      const v = saved[g.groupKey];
      next[g.groupKey] = v != null && Number.isFinite(v) ? String(v) : "0";
    }
    setTargets(next);
    // 외부 래퍼에 ownerData 재계산 요청 (미보유 ghost 행 갱신)
    onDashboardLoaded?.();
    setLoadToast(true);
    setTimeout(() => setLoadToast(false), 2000);
  }, [ownerName, groups, onDashboardLoaded, dashboardTargets, draftTargets]);

  const handleSave = useCallback(() => {
    persistCalculatorTargets(ownerName, targets);
    persistCalculatorMemberSplitsForOwner(ownerName, memberSplits);
    setSaveToast(true);
    setTimeout(() => setSaveToast(false), 2000);
  }, [targets, ownerName, memberSplits]);

  /** 초기화: 계산기 저장값으로 복원 (없으면 0%) */
  const handleReset = useCallback(() => {
    const saved = loadAllCalculatorTargetWeights()[ownerName] ?? {};
    const init: Record<string, string> = {};
    for (const g of groups) {
      init[g.groupKey] = dashboardTargetInputString(saved, g.groupKey);
    }
    setTargets(init);
    const msaved = loadAllCalculatorMemberSplits()[ownerName] ?? {};
    const msNext: Record<string, Record<string, string>> = {};
    for (const g of groups) {
      const row: Record<string, string> = {};
      for (const m of g.members) {
        const n = msaved[g.groupKey]?.[m.symbol];
        row[m.symbol] = n != null && Number.isFinite(n) ? String(n) : "";
      }
      if (Object.keys(row).length > 0) msNext[g.groupKey] = row;
    }
    setMemberSplits(msNext);
  }, [groups, ownerName]);

  return (
    <div className="space-y-5">
      {/* ── 컨트롤 헤더 ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 모드 토글 */}
        <div className="flex overflow-hidden rounded-md border text-[11px] sm:text-xs">
          {(["buy-sell", "buy-only"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-2.5 py-1.5 transition-colors ${
                mode === m
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-muted-foreground"
              }`}
            >
              {m === "buy-sell" ? "매수+매도" : "신규 투자금만"}
            </button>
          ))}
        </div>

        {/* 신규 투자금 입력 (buy-only 모드에서만 표시) */}
        {mode === "buy-only" && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground shrink-0">투자금</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="0"
              className="w-28 rounded border bg-background px-2 py-1 text-right tabular-nums text-xs"
              value={newMoneyInput}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d]/g, "");
                setNewMoneyInput(raw ? Number(raw).toLocaleString("ko-KR") : "");
              }}
            />
            <span className="text-muted-foreground shrink-0">₩</span>
            {newMoneyKrw > 0 && allocatedKrw > 0 && (
              <span className="text-[11px] text-muted-foreground shrink-0">
                잔여{" "}
                <span className="font-medium text-foreground">
                  {fmtKrw(Math.max(0, newMoneyKrw - allocatedKrw))}
                </span>
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground shrink-0">분할</span>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            className="w-14 rounded border bg-background px-2 py-1 text-right tabular-nums text-xs"
            value={splitCountInput}
            onChange={(e) => setSplitCountInput(e.target.value)}
          />
          <span className="text-muted-foreground shrink-0">회</span>
        </div>

        {/* 우측 컨트롤 */}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <label className="flex cursor-pointer select-none items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={hideSmall}
              onChange={(e) => setHideSmall(e.target.checked)}
              className="rounded"
            />
            1%p 미만 숨기기
          </label>
          <span
            className={`text-xs font-semibold tabular-nums ${
              sumIsOver
                ? "text-red-400"
                : sumIsUnder
                  ? "text-amber-400"
                  : "text-emerald-400"
            }`}
          >
            {targetSum.toFixed(1)}%{!sumIsOver && !sumIsUnder ? " ✓" : sumIsOver ? " ▲" : " ▼"}
          </span>
          {/* 대시보드 저장값 불러오기 */}
          <button
            type="button"
            onClick={handleLoad}
            title="대시보드에 설정된 목표 비중을 계산기로 불러옵니다 (대시보드는 변경되지 않습니다)"
            className={`rounded border px-2 py-1 text-[11px] transition-all active:scale-95 ${
              loadToast
                ? "border-sky-500/60 bg-sky-500/10 text-sky-400"
                : "hover:bg-muted text-muted-foreground"
            }`}
          >
            {loadToast ? "불러옴 ✓" : "대시보드 불러오기"}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="rounded border px-2 py-1 text-[11px] transition-colors hover:bg-muted active:scale-95"
          >
            초기화
          </button>
          <button
            type="button"
            onClick={handleSave}
            className={`relative rounded border px-2 py-1 text-[11px] transition-all active:scale-95 ${
              saveToast
                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-400"
                : "border-primary/50 bg-primary/10 text-primary hover:bg-primary/20"
            }`}
          >
            {saveToast ? "저장됨 ✓" : "저장"}
          </button>
        </div>
      </div>

      {/* ── 바 차트 ─────────────────────────────────────────────────────────── */}
      <div>
        {/* 범례 */}
        <div className="mb-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-rose-500/80" />
            부족
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-emerald-500/80" />
            초과
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 border-l-2 border-dashed border-white/50" />
            목표
          </span>
        </div>
        <p className="mb-3 max-w-2xl text-[10px] leading-snug text-muted-foreground">
          왼쪽 %는 목표 비중입니다. 계산기 목표는 대시보드와 독립적으로 저장되며, 변경 후 약 0.4초 뒤 자동 저장됩니다.
          대시보드 목표를 가져오려면「대시보드 불러오기」를 누르세요. 미설정 그룹은 0%로 표시됩니다.
          보유·평가가 없는 줄(S&P500 등)은 현재 비중이 0%이고 바가 비어 있는 것이 정상입니다(데이터 누락이 아닙니다).
          목표 합은 보통 100%입니다. 우측 숫자가 빨간 ▲면 합이 100%를 넘어 한 번에 만족할 수 없는 조합입니다 — 일부 목표를 줄이거나 초과 분야에서 줄여 주세요.
          목표 줄은 보유 그룹·관심종목에 해당하는 티커만 나타나며, 예전에 저장만 되어 있던 다른 이름(AI·원자력 등)은 더 이상 자동으로 붙지 않습니다.
          같은 그룹에 종목이 여러 개면, 그룹 옆의 %는 전체 포트에서의 목표 비중이고, 펼친 줄 오른쪽 「가중치」는 그 그룹의 매수·매도 차액을 종목끼리 나눌 비율(임의 숫자, 합으로 정규화)입니다. 포트 %를 넣는 칸이 아닙니다. 모든 종목 줄을 양수로 채워야 적용되고 하나라도 비우면 평가금 비율로 나눕니다.
          관심종목에 넣어 둔 티커·그룹명은 대시보드 바와 같이 해당 그룹 아래 종목 줄로 붙습니다.
        </p>

        {/* 스케일 헤더 — 바 행과 동일한 레이아웃으로 정렬 */}
        <div className="mb-0.5 flex items-center">
          <div className="flex shrink-0">
            <span className="w-5 shrink-0 sm:w-5" aria-hidden />
            <div className="w-36 shrink-0 sm:w-44" />
          </div>
          <div className="mx-1.5 flex-1">
            <div className="flex justify-between text-[9px] text-muted-foreground/50">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <span key={f}>{(maxScale * f).toFixed(0)}%</span>
              ))}
            </div>
          </div>
          <div className="w-24 shrink-0 sm:w-28" />
        </div>

        {/* 바 행 — ⋮ 드래그로 순서 (현금 줄 고정, 대시보드와 동일 localStorage 키) */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => handleCalculatorBarDragEnd(sortableBarGroupKeys, e)}
        >
          <SortableContext items={sortableContextIds} strategy={verticalListSortingStrategy}>
            <div>
              {visibleRows.map((r) => (
                <RebalancingBarSortableRow
                  key={r.groupKey}
                  row={r}
                  targets={targets}
                  setTargets={setTargets}
                  maxScale={maxScale}
                  totalKrw={totalKrw}
                  memberSplitsForGroup={memberSplits[r.groupKey] ?? {}}
                  onMemberSplitChange={handleMemberSplitChange}
                  resolvedNameBySymbol={resolvedNameBySymbol}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* ── 매매 실행 순서 ──────────────────────────────────────────────────── */}
      {actionItems.length > 0 && (
        <div className="rounded-lg border border-slate-700/50 bg-slate-900/30 p-3 space-y-2">
          <p className="text-[11px] font-semibold text-muted-foreground">
            {mode === "buy-only" ? "매수 실행 순서" : "매매 실행 순서"}
            <span className="ml-1 font-normal text-[10px]">
              {mode === "buy-only" ? "(투자금 배분 · 크기순)" : "(매도 먼저 · 이탈 크기순)"}
            </span>
            <span className="ml-1 font-normal text-[10px] text-muted-foreground/80">
              · {splitCount}분할
            </span>
          </p>
          <div className="space-y-1.5 text-xs">
            {actionItems.map((r) => {
              const isBuy = r.diffKrw > 0;
              const actionColor = isBuy ? "text-rose-400" : "text-blue-400";
              const actionBg = isBuy
                ? "border-rose-500/25 bg-rose-500/5"
                : "border-blue-500/25 bg-blue-500/5";
              const isCash =
                r.groupKey === "현금" || r.groupKey.toLowerCase().includes("cash");

              // 주수 표시 계산
              let sharesDisplay = "";
              let perSplitSharesDisplay = "";
              if (!isCash) {
                if (r.members.length <= 1 && r.repPrice > 0) {
                  const sh = floorShares(r.diffKrw, r.repPrice);
                  sharesDisplay = `${formatTickerLabel(r.repSymbol, r.repName, resolvedNameBySymbol)} ${isBuy ? "+" : "-"}${sh}주`;
                  if (splitCount > 1) {
                    const perSh = floorShares(r.diffKrw / splitCount, r.repPrice);
                    perSplitSharesDisplay = `회당 ${formatTickerLabel(r.repSymbol, r.repName, resolvedNameBySymbol)} ${isBuy ? "+" : "-"}${perSh}주`;
                  }
                } else if (r.memberAdjustments.length > 0) {
                  const parts = r.memberAdjustments
                    .filter((m) => Math.abs(m.diffKrw) >= 10000 && m.priceKrw > 0)
                    .map((m) => {
                      const sh = floorShares(m.diffKrw, m.priceKrw);
                      return `${formatTickerLabel(m.symbol, m.name, resolvedNameBySymbol)} ${m.diffKrw >= 0 ? "+" : "-"}${sh}주`;
                    });
                  sharesDisplay = parts.join(" / ");
                  if (splitCount > 1) {
                    const perParts = r.memberAdjustments
                      .filter((m) => Math.abs(m.diffKrw) >= 10000 && m.priceKrw > 0)
                      .map((m) => {
                        const perSh = floorShares(m.diffKrw / splitCount, m.priceKrw);
                        return `${formatTickerLabel(m.symbol, m.name, resolvedNameBySymbol)} ${m.diffKrw >= 0 ? "+" : "-"}${perSh}주`;
                      });
                    perSplitSharesDisplay = `회당 ${perParts.join(" / ")}`;
                  }
                }
              }

              return (
                <div
                  key={r.groupKey}
                  className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2.5 py-1.5 ${actionBg}`}
                >
                  <span className={`shrink-0 font-bold ${actionColor}`}>
                    [{isBuy ? "매수" : "매도"}]
                  </span>
                  <span className="shrink-0 font-medium">{r.displayName || r.groupKey}</span>
                  <span className={`shrink-0 tabular-nums ${actionColor}`}>
                    {fmtKrw(r.diffKrw)}
                  </span>
                  {splitCount > 1 && (
                    <span className="text-muted-foreground tabular-nums">
                      (회당 {fmtKrw(r.diffKrw / splitCount)} ×{splitCount})
                    </span>
                  )}
                  {sharesDisplay && (
                    <span className="text-muted-foreground tabular-nums">{sharesDisplay}</span>
                  )}
                  {perSplitSharesDisplay && (
                    <span className="text-muted-foreground/80 tabular-nums">[{perSplitSharesDisplay}]</span>
                  )}
                </div>
              );
            })}
          </div>
          {mode === "buy-only" && newMoneyKrw > 0 && (
            <p className="text-[10px] text-muted-foreground pt-1 border-t border-slate-700/40">
              배분 합계{" "}
              <span className="tabular-nums font-medium text-foreground">{fmtKrw(allocatedKrw)}</span>
              {" · "}잔여{" "}
              <span className="tabular-nums font-medium text-foreground">
                {fmtKrw(Math.max(0, newMoneyKrw - allocatedKrw))}
              </span>
            </p>
          )}
        </div>
      )}

      {mode === "buy-only" && newMoneyKrw === 0 && (
        <p className="rounded-lg border border-slate-700/40 bg-slate-900/20 px-3 py-2 text-[11px] text-muted-foreground">
          투자할 금액을 입력하면 목표 비중에 맞게 매수 배분을 계산합니다.
        </p>
      )}

      {/* ── 상세 수치 테이블 (접기) ──────────────────────────────────────────── */}
      <details>
        <summary className="cursor-pointer select-none py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          ▶ 상세 수치 보기
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">그룹</th>
                <th className="py-1.5 px-2 text-right font-medium">현재%</th>
                <th className="py-1.5 px-2 text-right font-medium">현재액</th>
                <th className="py-1.5 px-2 text-right font-medium">목표%</th>
                <th className="py-1.5 px-2 text-right font-medium">목표액</th>
                <th className="py-1.5 px-2 text-right font-medium">매수/매도</th>
                <th className="py-1.5 px-2 text-right font-medium">회당</th>
                <th className="py-1.5 px-2 text-right font-medium">종목(주수)</th>
                <th className="py-1.5 px-2 text-right font-medium">회당 주수</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const effectiveTotalKrw =
                  mode === "buy-only" ? totalKrw + newMoneyKrw : totalKrw;
                const targetKrw = (r.targetPct / 100) * effectiveTotalKrw;
                const significant = Math.abs(r.diffKrw) >= 10000;
                const isCash =
                  r.groupKey === "현금" || r.groupKey.toLowerCase().includes("cash");

                return (
                  <tr
                    key={r.groupKey}
                    className="border-b last:border-0 hover:bg-muted/20"
                  >
                    <td className="py-1.5 pr-2 font-medium">
                      {r.displayName || r.groupKey}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                      {r.currentPct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                      {fmtKrw(r.valueKrw)}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {r.targetPct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {fmtKrw(targetKrw)}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right tabular-nums font-semibold ${
                        !significant
                          ? "text-muted-foreground"
                          : r.diffKrw > 0
                            ? "text-rose-400"
                            : "text-blue-400"
                      }`}
                    >
                      {!significant
                        ? "—"
                        : `${r.diffKrw > 0 ? "▲" : "▼"} ${fmtKrw(r.diffKrw)}`}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right tabular-nums ${
                        !significant
                          ? "text-muted-foreground"
                          : r.diffKrw > 0
                            ? "text-rose-400"
                            : "text-blue-400"
                      }`}
                    >
                      {!significant
                        ? "—"
                        : splitCount > 1
                          ? `${r.diffKrw > 0 ? "▲" : "▼"} ${fmtKrw(r.diffKrw / splitCount)}`
                          : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      {isCash ? (
                        <span className="text-muted-foreground">현금</span>
                      ) : !significant ? (
                        <span className="text-muted-foreground">—</span>
                      ) : r.members.length <= 1 && r.repPrice > 0 ? (
                        <span
                          className={r.diffKrw > 0 ? "tabular-nums text-rose-400" : "tabular-nums text-blue-400"}
                        >
                          {formatTickerLabel(r.repSymbol, r.repName, resolvedNameBySymbol)}{" "}
                          {r.diffKrw > 0 ? "+" : "-"}
                          {floorShares(r.diffKrw, r.repPrice)}주
                        </span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.memberAdjustments
                            .filter((m) => Math.abs(m.diffKrw) >= 10000)
                            .map((m) => (
                              <p key={m.symbol} className="tabular-nums">
                                <span className="text-muted-foreground">{formatTickerLabel(m.symbol, m.name, resolvedNameBySymbol)}</span>{" "}
                                <span
                                  className={
                                    m.diffKrw >= 0 ? "text-rose-400" : "text-blue-400"
                                  }
                                >
                                  {m.priceKrw > 0
                                    ? `${m.diffKrw >= 0 ? "+" : "-"}${floorShares(m.diffKrw, m.priceKrw)}주`
                                    : "—"}
                                </span>
                              </p>
                            ))}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      {isCash || !significant || splitCount <= 1 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : r.members.length <= 1 && r.repPrice > 0 ? (
                        <span
                          className={r.diffKrw > 0 ? "tabular-nums text-rose-400" : "tabular-nums text-blue-400"}
                        >
                          {formatTickerLabel(r.repSymbol, r.repName, resolvedNameBySymbol)}{" "}
                          {r.diffKrw > 0 ? "+" : "-"}
                          {floorShares(r.diffKrw / splitCount, r.repPrice)}주
                        </span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.memberAdjustments
                            .filter((m) => Math.abs(m.diffKrw) >= 10000)
                            .map((m) => (
                              <p key={`${m.symbol}-per-split`} className="tabular-nums">
                                <span className="text-muted-foreground">{formatTickerLabel(m.symbol, m.name, resolvedNameBySymbol)}</span>{" "}
                                <span
                                  className={
                                    m.diffKrw >= 0 ? "text-rose-400" : "text-blue-400"
                                  }
                                >
                                  {m.priceKrw > 0
                                    ? `${m.diffKrw >= 0 ? "+" : "-"}${floorShares(m.diffKrw / splitCount, m.priceKrw)}주`
                                    : "—"}
                                </span>
                              </p>
                            ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t font-semibold">
                <td className="py-1.5 pr-2">합계</td>
                <td className="py-1.5 px-2 text-right tabular-nums">
                  {groups.reduce((s, g) => s + g.currentPct, 0).toFixed(1)}%
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">{fmtKrw(totalKrw)}</td>
                <td
                  className={`py-1.5 px-2 text-right tabular-nums ${
                    sumIsOver || sumIsUnder ? "text-amber-400" : "text-emerald-400"
                  }`}
                >
                  {targetSum.toFixed(1)}%
                </td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          </table>
        </div>
      </details>

      <p className="text-[10px] text-muted-foreground">
        * 주수는 현재가 기준 정수(floor) 참고용입니다. 실제 매매 시 수수료·가격 변동을 감안하세요.
        {mode === "buy-only" && " · 신규 투자금 모드에서는 매도 없이 배분됩니다."}
      </p>
    </div>
  );
}

// ─── RebalancingCalculator (외부 보유자 선택 래퍼) ────────────────────────────

export function RebalancingCalculator({
  allocationByOwner,
  enrichedPositions,
  usdKrw,
  dashboardTargetsByOwner = {},
  dashboardTargetsDraftByOwner = {},
  watchlistRows = [],
  watchlistOwnerAllToken = "__ALL__",
}: {
  allocationByOwner: {
    ownerName: string;
    data: { ticker: string; displayName: string; value: number; weight: number }[];
    total: number;
  }[];
  enrichedPositions: {
    owner: string;
    symbol: string;
    name: string;
    chartGroup?: string;
    valueKrw: number;
    currentPrice: number;
    currency: string;
  }[];
  usdKrw: number;
  dashboardTargetsByOwner?: Record<string, Record<string, number>>;
  dashboardTargetsDraftByOwner?: Record<string, Record<string, number>>;
  /** 대시보드 도넛과 동일하게 그룹 후보에 워치 종목을 붙입니다 */
  watchlistRows?: WatchlistRowForRebalance[];
  watchlistOwnerAllToken?: string;
}) {
  const [selectedOwner, setSelectedOwner] = useState(allocationByOwner[0]?.ownerName ?? "");
  const mergeTargetsReady = useClientReady();
  /** 대시보드 불러오기 후 계산기 키 변경을 감지해 ownerData 재계산 트리거 */
  const [calcStorageBump, setCalcStorageBump] = useState(0);

  const handleDashboardLoaded = useCallback(() => {
    setCalcStorageBump((n) => n + 1);
  }, []);

  const displayOwner = useMemo(() => {
    if (allocationByOwner.some((o) => o.ownerName === selectedOwner)) return selectedOwner;
    return allocationByOwner[0]?.ownerName ?? "";
  }, [allocationByOwner, selectedOwner]);

  const ownerData = useMemo(() => {
    return allocationByOwner.map(({ ownerName, data, total }) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);

      const repMap = new Map<string, { symbol: string; name: string; priceKrw: number }>();
      for (const p of items) {
        const gkRaw = p.chartGroup?.trim() || p.symbol;
        const gk = gkRaw.trim().toUpperCase();
        if (!repMap.has(gk) && p.currentPrice > 0) {
          const priceKrw =
            p.currency === "USD" ? p.currentPrice * usdKrw : p.currentPrice;
          repMap.set(gk, { symbol: p.symbol, name: p.name, priceKrw });
        }
      }

      let groups: GroupAllocation[] = data.map((d) => {
        const dk = d.ticker.trim().toUpperCase();
        const rep = repMap.get(dk);
        const members = items
          .filter((p) =>
            allocationTickerMatches(p.chartGroup?.trim() || p.symbol, d.ticker),
          )
          .map((p) => ({
            symbol: p.symbol,
            name: p.name,
            valueKrw: p.valueKrw,
            priceKrw: p.currency === "USD" ? p.currentPrice * usdKrw : p.currentPrice,
          }));
        return {
          groupKey: d.ticker,
          displayName: d.displayName,
          valueKrw: d.value,
          currentPct: d.weight,
          repSymbol: rep?.symbol ?? d.ticker,
          repName: rep?.name ?? d.displayName,
          repPrice: rep?.priceKrw ?? 0,
          members,
        };
      });

      if (mergeTargetsReady) {
        groups = mergeSavedTargetGroupsWithoutHoldings(ownerName, groups, {
          allocationTickers: data.map((d) => d.ticker),
          watchlistRows,
          watchlistOwnerAllToken,
        });
      }

      groups = mergeWatchlistSymbolsIntoCalculatorGroups(
        ownerName,
        groups,
        watchlistRows,
        watchlistOwnerAllToken,
        enrichedPositions,
        usdKrw,
      );

      return { ownerName, groups, totalKrw: total };
    });
  }, [
    allocationByOwner,
    enrichedPositions,
    usdKrw,
    mergeTargetsReady,
    calcStorageBump,
    watchlistRows,
    watchlistOwnerAllToken,
  ]);

  const current = ownerData.find((o) => o.ownerName === displayOwner);

  return (
    <div className="space-y-3">
      {/* 보유자 탭 */}
      <div className="flex flex-wrap gap-1">
        {ownerData.map(({ ownerName }) => (
          <button
            key={ownerName}
            type="button"
            onClick={() => setSelectedOwner(ownerName)}
            className={`cursor-pointer rounded px-3 py-1 text-xs transition-all ${
              displayOwner === ownerName
                ? "bg-primary text-primary-foreground"
                : "border hover:bg-muted"
            }`}
          >
            {ownerName}
          </button>
        ))}
      </div>

      {current && current.groups.length > 0 ? (
        <RebalancingOwner
          key={current.ownerName}
          ownerName={current.ownerName}
          groups={current.groups}
          totalKrw={current.totalKrw}
          onDashboardLoaded={handleDashboardLoaded}
          dashboardTargets={dashboardTargetsByOwner[current.ownerName] ?? null}
          draftTargets={dashboardTargetsDraftByOwner[current.ownerName] ?? null}
        />
      ) : (
        <p className="text-sm text-muted-foreground">보유 종목이 없습니다.</p>
      )}
    </div>
  );
}
