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
  PORTFOLIO_TARGET_REL_DEV_BAND,
  PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT,
  type CalculatorMemberSplitMode,
  loadAllCalculatorMemberSplitModes,
  loadAllCalculatorMemberSplits,
  loadAllTargetStockWeights,
  persistCalculatorMemberSplitModesForOwner,
  persistCalculatorMemberSplitsForOwner,
  persistOwnerTargetWeightsFromInputStrings,
  REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT,
} from "@/lib/portfolio-target-weights";
import {
  loadVisualOrderKeysForOwner,
  persistVisualOrderForOwner,
  REBALANCE_VISUAL_ORDER_REFRESH_EVENT,
} from "@/lib/rebalance-visual-order";
import { type SplitAmountMode, approxPortfolioPctAfterDelta, perSplitKrwCore, proportionalAllocateWithCaps } from "@/lib/rebalance-split-amount";
import {
  allocationTickerMatches,
  allowedCalculatorStubTickerKeysUpper,
  mergeWatchlistSymbolsIntoCalculatorGroups,
  type WatchlistRowForRebalance,
} from "@/lib/rebalance-watchlist-groups";
import { pushTargetWeightsAndScratchpadsToServer } from "@/lib/portfolio-owner-scratchpad";

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
  const saved = loadAllTargetStockWeights()[ownerName] ?? {};
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
  /** 8자 이상이면 목표·메모·계산기 LS 변경을 서버에도 디바운스 반영 */
  cloudSyncKey?: string;
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

/** 전체 평가금 대비 해당 종목(슬라이스) 현재 비중 % */
function currentPortfolioPctOfMember(memberValueKrw: number, portfolioTotalKrw: number): number {
  return portfolioTotalKrw > 0 ? (memberValueKrw / portfolioTotalKrw) * 100 : 0;
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
  const und = (m: (typeof g.members)[number]) => isUndecidedSlotMemberSymbol(m.symbol);
  if (g.valueKrw > 0) {
    return g.members.map((m) => (und(m) ? 0 : m.valueKrw / g.valueKrw));
  }
  const eligible = g.members.filter((m) => !und(m));
  const n = eligible.length;
  if (n === 0) return g.members.map(() => 0);
  const share = 1 / n;
  return g.members.map((m) => (und(m) ? 0 : share));
}

/** 입력된 양수 가중치로 정규화; 미정 슬롯은 항상 비중 0. 모두 비었거나 일부만 채우면 평가금 비율 */
function memberRatiosForGroup(g: GroupAllocation, splitInputs?: Record<string, string>): number[] {
  if (g.members.length === 0) return [];
  const weights = g.members.map((m) => {
    if (isUndecidedSlotMemberSymbol(m.symbol)) return 0;
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

/** 종목 줄에 포트 전체 기준 목표 % 입력(0~100). 합을 그룹 목표%에 맞게 스케일해 목표액·차액 산출.
 * 비워 둔 칸은 목표 0%로 간주(일부만 입력해도 적용). 입력 합이 0 이하면 평가금 비율 분배로 폴백. */
function tryMemberAdjustmentsTargetPortfolioPct(
  g: GroupAllocation,
  splitInputs: Record<string, string> | undefined,
  totalKrwEffective: number,
  groupTargetPct: number,
): MemberAdj[] | null {
  if (!splitInputs || g.members.length === 0) return null;
  const pcts: number[] = [];
  for (const m of g.members) {
    if (isUndecidedSlotMemberSymbol(m.symbol)) {
      pcts.push(0);
      continue;
    }
    const raw = (splitInputs[m.symbol] ?? "").trim().replace(",", ".");
    if (raw === "") {
      pcts.push(0);
      continue;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    pcts.push(n);
  }
  const sumPct = pcts.reduce((a, b) => a + b, 0);
  if (sumPct <= 0) return null;
  const scale = groupTargetPct / sumPct;
  return g.members.map((m, i) => {
    const pct = pcts[i]! * scale;
    const targetKrw = (pct / 100) * totalKrwEffective;
    const diffKrw = targetKrw - m.valueKrw;
    return {
      ...m,
      diffKrw,
      shares: m.priceKrw > 0 ? diffKrw / m.priceKrw : null,
    };
  });
}

function memberPolicyWeights(
  g: GroupAllocation,
  splitInputs: Record<string, string> | undefined,
  splitMode: CalculatorMemberSplitMode,
): number[] {
  if (g.members.length === 0) return [];
  if (splitMode === "targetPct" && splitInputs) {
    const pcts = g.members.map((m) => {
      if (isUndecidedSlotMemberSymbol(m.symbol)) return 0;
      const raw = (splitInputs[m.symbol] ?? "").trim().replace(",", ".");
      if (raw === "") return 0;
      const n = parseFloat(raw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
    const sumPct = pcts.reduce((a, b) => a + b, 0);
    if (sumPct > 0) return pcts.map((p) => p / sumPct);
  }
  const rawRatios = memberRatiosForGroup(g, splitInputs);
  const masked = g.members.map((m, i) =>
    isUndecidedSlotMemberSymbol(m.symbol) ? 0 : Math.max(0, rawRatios[i] ?? 0),
  );
  let sumR = masked.reduce((a, b) => a + b, 0);
  if (sumR <= 0) {
    const vb = valueBasedMemberRatios(g);
    const m2 = g.members.map((m, i) =>
      isUndecidedSlotMemberSymbol(m.symbol) ? 0 : Math.max(0, vb[i] ?? 0),
    );
    sumR = m2.reduce((a, b) => a + b, 0);
    return sumR > 0 ? m2.map((r) => r / sumR) : masked;
  }
  return masked.map((r) => r / sumR);
}

/** 회당 그룹 금액을 종목별로 배분 — 설정 비율을 따르되, 남은 목표 매매액을 넘지 않게 하고 포화 시 나머지 종목에 비율대로 재분배 */
function memberTrancheKrwBySymbol(
  row: ComputedRow,
  perSplitRowKrwSigned: number,
  splitInputs: Record<string, string> | undefined,
  splitMode: CalculatorMemberSplitMode,
): Map<string, number> {
  const out = new Map<string, number>();
  const absTranche = Math.abs(perSplitRowKrwSigned);
  if (absTranche < 1e-9 || row.memberAdjustments.length === 0) return out;

  const weights = memberPolicyWeights(row, splitInputs, splitMode);
  const caps = row.memberAdjustments.map((adj) => {
    if (isUndecidedSlotMemberSymbol(adj.symbol)) return 0;
    if (row.diffKrw > 0) return Math.max(0, adj.diffKrw);
    return Math.max(0, -adj.diffKrw);
  });

  const alloc = proportionalAllocateWithCaps(absTranche, weights, caps);
  const sign = perSplitRowKrwSigned >= 0 ? 1 : -1;
  for (let i = 0; i < row.memberAdjustments.length; i++) {
    const sym = row.memberAdjustments[i]!.symbol;
    out.set(sym, sign * (alloc[i] ?? 0));
  }
  return out;
}

function calcMemberAdjustments(
  g: GroupAllocation,
  diffKrw: number,
  splitInputs: Record<string, string> | undefined,
  ctx: {
    splitMode: CalculatorMemberSplitMode;
    allowTargetPct: boolean;
    totalKrwEffective: number;
    groupTargetPct: number;
  },
): MemberAdj[] {
  if (g.members.length === 0) return [];
  if (ctx.allowTargetPct && ctx.splitMode === "targetPct") {
    const direct = tryMemberAdjustmentsTargetPortfolioPct(
      g,
      splitInputs,
      ctx.totalKrwEffective,
      ctx.groupTargetPct,
    );
    if (direct) {
      return direct.map((adj) =>
        isUndecidedSlotMemberSymbol(adj.symbol)
          ? { ...adj, diffKrw: 0, shares: adj.priceKrw > 0 ? 0 : null }
          : adj,
      );
    }
  }
  const rawRatios = memberRatiosForGroup(g, splitInputs);
  const masked = g.members.map((m, i) =>
    isUndecidedSlotMemberSymbol(m.symbol) ? 0 : Math.max(0, rawRatios[i] ?? 0),
  );
  let sumR = masked.reduce((a, b) => a + b, 0);
  let ratios = masked;
  if (sumR <= 0) {
    const vb = valueBasedMemberRatios(g);
    const m2 = g.members.map((m, i) =>
      isUndecidedSlotMemberSymbol(m.symbol) ? 0 : Math.max(0, vb[i] ?? 0),
    );
    sumR = m2.reduce((a, b) => a + b, 0);
    ratios = sumR > 0 ? m2.map((r) => r / sumR) : m2;
  } else {
    ratios = masked.map((r) => r / sumR);
  }
  return g.members.map((m, i) => {
    if (isUndecidedSlotMemberSymbol(m.symbol)) {
      return {
        ...m,
        diffKrw: 0,
        shares: m.priceKrw > 0 ? 0 : null,
      };
    }
    const ratio = ratios[i] ?? 0;
    const memberDiffKrw = diffKrw * ratio;
    return {
      ...m,
      diffKrw: memberDiffKrw,
      shares: m.priceKrw > 0 ? memberDiffKrw / m.priceKrw : null,
    };
  });
}

/** 차트 리밸런싱 위젯과 동일: 현금 행 목표·현재 비중 상대 편차 */
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
  const withinBand = hasPositiveTarget && Math.abs(relDev) <= PORTFOLIO_TARGET_REL_DEV_BAND;
  const belowBand = hasPositiveTarget && relDev < -PORTFOLIO_TARGET_REL_DEV_BAND;

  if (!hasPositiveTarget && actualPct > 0) {
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-500/60 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-300">
        목표 0% · +{actualPct.toFixed(1)}%p
      </span>
    );
  }
  if (!hasPositiveTarget) {
    return (
      <span className="inline-flex items-center rounded-full border border-slate-600/60 bg-slate-800/60 px-2 py-0.5 text-[11px] font-medium text-slate-400">
        목표 0%
      </span>
    );
  }
  if (withinBand) {
    return (
      <span className="inline-flex items-center rounded-full border border-sky-500/50 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
        ≈ 목표
      </span>
    );
  }
  if (belowBand) {
    return (
      <span className="inline-flex items-center rounded-full border border-rose-500/65 bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold tabular-nums text-rose-300">
        ▲ {Math.abs(diffPp).toFixed(1)}%p 부족
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-500/65 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-300">
      ▼ +{diffPp.toFixed(1)}%p 초과
    </span>
  );
}

/** 대시보드·리밸 바와 동일하게 현금 줄은 드래그 비활성·하단 고정 */
function isPinnedCashPortfolioGroup(groupKey: string): boolean {
  const t = groupKey.trim();
  if (t === "현금" || t === "USD 현금" || t === "KRW 현금") return true;
  return t.toLowerCase().includes("cash");
}

/** 티커를 아직 고르지 않았을 때 그룹 안 비중만 잡아 두는 계산기 전용 줄 */
const GROUP_UNDECIDED_MEMBER_SYMBOL = "__CALC_UNDECIDED__";
const GROUP_UNDECIDED_MEMBER_DISPLAY = "미정 슬롯 (종목 미선정)";

function isUndecidedSlotMemberSymbol(symbol: string): boolean {
  return normalizeTickerKey(symbol) === normalizeTickerKey(GROUP_UNDECIDED_MEMBER_SYMBOL);
}

function appendUndecidedSlotMember(g: GroupAllocation): GroupAllocation {
  if (isPinnedCashPortfolioGroup(g.groupKey)) return g;
  if (g.members.some((m) => isUndecidedSlotMemberSymbol(m.symbol))) return g;
  return {
    ...g,
    members: [
      ...g.members,
      {
        symbol: GROUP_UNDECIDED_MEMBER_SYMBOL,
        name: GROUP_UNDECIDED_MEMBER_DISPLAY,
        valueKrw: 0,
        priceKrw: 0,
      },
    ],
  };
}

function expandGroupsWithUndecidedSlot(groupsIn: GroupAllocation[]): GroupAllocation[] {
  return groupsIn.map(appendUndecidedSlotMember);
}

/** 종목 줄 표시 — 미정 슬롯은 티커 코드 숨김 */
function allocationMemberDisplayLabel(
  symbol: string,
  name: string,
  resolvedNameBySymbol?: Record<string, string>,
): string {
  if (isUndecidedSlotMemberSymbol(symbol)) return GROUP_UNDECIDED_MEMBER_DISPLAY;
  return formatTickerLabel(symbol, name, resolvedNameBySymbol);
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
  rebalanceMode,
  resolvedNameBySymbol,
}: {
  row: ComputedRow;
  targets: Record<string, string>;
  setTargets: Dispatch<SetStateAction<Record<string, string>>>;
  maxScale: number;
  totalKrw: number;
  memberSplitsForGroup: Record<string, string>;
  onMemberSplitChange: (groupKey: string, symbol: string, raw: string) => void;
  rebalanceMode: Mode;
  resolvedNameBySymbol: Record<string, string>;
}) {
  const pinned = isPinnedCashPortfolioGroup(row.groupKey);
  const [membersCollapsed, setMembersCollapsed] = useState(true);
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
  const groupTargetPct = parseFloat(targets[row.groupKey] ?? "0") || 0;
  const TGT_PCT_MATCH_EPS = 0.051;
  let tgtPctPartialSum = 0;
  let tgtPctFilledValidCount = 0;
  let tgtPctEmptyCount = 0;
  let tgtPctInvalid = false;
  for (const m of row.members) {
    const raw = (memberSplitsForGroup[m.symbol] ?? "").trim().replace(",", ".");
    if (raw === "") {
      tgtPctEmptyCount++;
      continue;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      tgtPctInvalid = true;
      continue;
    }
    tgtPctPartialSum += n;
    tgtPctFilledValidCount++;
  }
  const tgtPctAllFilled =
    row.members.length > 0 &&
    !tgtPctInvalid &&
    tgtPctEmptyCount === 0 &&
    tgtPctFilledValidCount === row.members.length;
  const tgtPctDiffVsGroup =
    tgtPctAllFilled && Number.isFinite(groupTargetPct) ? tgtPctPartialSum - groupTargetPct : null;
  const tgtPctMatchesGroup =
    tgtPctDiffVsGroup !== null && Math.abs(tgtPctDiffVsGroup) <= TGT_PCT_MATCH_EPS;

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
          <div className="flex min-w-0 flex-1 items-center gap-1 truncate">
            <span
              className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100 sm:text-sm"
              title={row.displayName || row.groupKey}
            >
              {row.displayName || row.groupKey}
            </span>
            {!pinned && row.members.length > 0 && (
              <button
                type="button"
                onClick={() => setMembersCollapsed((v) => !v)}
                className="shrink-0 rounded px-1 py-0.5 text-[10px] transition-colors hover:bg-slate-700/60"
                title={membersCollapsed ? "종목 펼치기" : "종목 접기"}
              >
                {membersCollapsed
                  ? tgtPctMatchesGroup
                    ? <span className="font-bold text-emerald-400">✓</span>
                    : tgtPctAllFilled
                      ? <span className="font-bold text-amber-400">✗</span>
                      : <span className="text-slate-500">▶</span>
                  : <span className="text-slate-400">▼</span>
                }
              </button>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0">
            <div className="flex items-center gap-0.5">
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                className="w-12 rounded-md border-2 border-slate-500/80 bg-slate-950/80 px-1 py-0.5 text-right text-xs font-bold tabular-nums text-slate-100 shadow-inner outline-none focus:border-primary focus:ring-1 focus:ring-primary/35"
                value={targets[row.groupKey] ?? ""}
                onChange={(e) => setTargets((prev) => ({ ...prev, [row.groupKey]: e.target.value }))}
                title="목표 비중 입력 — 계산기 전용 저장소에 자동 저장됩니다."
                aria-label={`${row.displayName || row.groupKey} 목표 비중 퍼센트`}
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
            <span className="text-[10px] tabular-nums text-slate-500 leading-tight">
              ({row.currentPct.toFixed(1)}/{targets[row.groupKey] ? parseFloat(targets[row.groupKey]).toFixed(1) : "0"}%)
            </span>
          </div>
        </div>

        <div className="relative mx-1.5 h-5 flex-1 min-w-0">
          <div className="absolute inset-y-1 inset-x-0 rounded-sm bg-slate-800/60" />
          {[10, 20, 30, 40, 50, 60, 70, 80, 90].map((v) => (
            <div
              key={v}
              className={`pointer-events-none absolute inset-y-1 w-px ${v % 50 === 0 ? "bg-slate-600/60" : "bg-slate-700/35"}`}
              style={{ left: `${v}%` }}
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

        <div className="w-[7.25rem] shrink-0 text-right sm:w-[8.25rem]">
          {isCash ?
            <CashAllocationDeviationLabel targetPct={row.targetPct} actualPct={row.currentPct} />
          : rowIsOver ?
            <span className="inline-flex items-center justify-end rounded-full border border-emerald-500/70 bg-emerald-500/18 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-300 shadow-sm">
              ▼+{absDiff.toFixed(1)}%p 초과
            </span>
          : rowIsUnder ?
            <span className="inline-flex items-center justify-end rounded-full border border-rose-500/70 bg-rose-500/18 px-2 py-0.5 text-[11px] font-bold tabular-nums text-rose-300 shadow-sm">
              ▲{absDiff.toFixed(1)}%p 부족
            </span>
          : (
            <span className="inline-flex items-center justify-end rounded-full border border-slate-600/70 bg-slate-800/55 px-2 py-0.5 text-[11px] font-semibold text-slate-400">
              적정 ✓
            </span>
          )}
        </div>
      </div>

      {!pinned && row.members.length > 0 ?
        <div className="border-t border-dashed border-slate-600/50 pb-2 pt-2" style={membersCollapsed ? { display: "none" } : undefined}>
          {rebalanceMode !== "buy-only" ?
            <div
              className="mt-2 ml-7 sm:ml-8 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-600/55 bg-slate-900/70 px-2.5 py-2"
              role="status"
              aria-label="종목 목표 퍼센트 검증"
            >
              <span className="text-xs font-bold uppercase tracking-wide text-slate-400 shrink-0">
                검증
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs leading-snug tabular-nums text-slate-300 sm:text-sm">
                <span>
                  그룹 목표{" "}
                  <span className="font-semibold text-slate-100">{groupTargetPct.toFixed(1)}%</span>
                </span>
                {tgtPctInvalid ?
                  <span className="font-medium text-amber-400">목표% 칸에 0~100 숫자만 입력해 주세요.</span>
                : tgtPctFilledValidCount === 0 && tgtPctEmptyCount === row.members.length ?
                  <span className="text-slate-400">종목 목표% 입력 시 여기에 합계가 표시됩니다.</span>
                : !tgtPctAllFilled ?
                  <>
                    <span>
                      입력된 줄만 합{" "}
                      <span className="font-semibold text-slate-100">{tgtPctPartialSum.toFixed(2)}%</span>
                    </span>
                    <span className="text-slate-400">
                      (<span className="text-slate-200">{tgtPctFilledValidCount}</span>/
                      <span className="text-slate-200">{row.members.length}</span>줄)
                    </span>
                    <span className="text-slate-400">
                      비운 칸은 계산 시 목표 0%로 봅니다. 합·그룹 목표 비교는 줄을 모두 채우면 표시됩니다.
                    </span>
                  </>
                : groupTargetPct <= 0 ?
                  <span className="text-slate-400">
                    종목 입력 합 <span className="font-semibold text-slate-100">{tgtPctPartialSum.toFixed(2)}%</span>
                    {" · "}
                    그룹 목표가 0%라 스케일은 적용되지 않습니다.
                  </span>
                : (
                  <>
                    <span>
                      종목 입력 합{" "}
                      <span className="font-semibold text-slate-100">{tgtPctPartialSum.toFixed(2)}%</span>
                    </span>
                    {tgtPctMatchesGroup ?
                      <span className="font-semibold text-emerald-400">그룹 목표와 일치 ✓</span>
                    : (
                      <span className="text-slate-400">
                        차이{" "}
                        <span
                          className={
                            (tgtPctDiffVsGroup ?? 0) > 0 ? "font-semibold text-amber-400" : "font-semibold text-sky-400"
                          }
                        >
                          {(tgtPctDiffVsGroup ?? 0) > 0 ? "+" : ""}
                          {(tgtPctDiffVsGroup ?? 0).toFixed(2)}%p
                        </span>
                        {" · 비율 유지 후 그룹 목표에 맞게 스케일되어 계산됩니다."}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          : null}
          <div className="-mx-0.5 mt-2 overflow-x-auto pl-7 sm:pl-8">
            <div className="min-w-0 sm:min-w-[36rem]">
              <div
                className="mb-0.5 hidden border-b border-slate-700/50 px-2 pb-1 text-[9px] font-bold uppercase tracking-wide text-slate-500 sm:grid sm:grid-cols-[13rem_4.75rem_9.5rem_6.25rem] sm:gap-x-2 sm:px-2.5"
                aria-hidden
              >
                <span>종목</span>
                <span className="text-right">현재%</span>
                <span className="text-right">평가액</span>
                <span className="text-right">목표</span>
              </div>
              <div className="divide-y divide-slate-700/55 rounded-md border border-slate-700/35 bg-slate-900/20 px-2 sm:px-2.5">
              {row.members.map((m) => {
                const portPct = currentPortfolioPctOfMember(m.valueKrw, totalKrw);
                return (
                  <div
                    key={`${row.groupKey}:${m.symbol}`}
                    className="grid grid-cols-1 gap-y-1 py-2 pr-1 first:pt-1.5 last:pb-1.5 sm:grid-cols-[13rem_4.75rem_9.5rem_6.25rem] sm:items-center sm:gap-x-2 sm:gap-y-0 sm:py-1.5"
                  >
                    <span
                      className={`min-w-0 truncate text-[10px] font-medium leading-tight text-slate-100 sm:text-[11px] ${
                        isUndecidedSlotMemberSymbol(m.symbol) ? "italic text-slate-400" : ""
                      }`}
                      title={allocationMemberDisplayLabel(m.symbol, m.name, resolvedNameBySymbol)}
                    >
                      {allocationMemberDisplayLabel(m.symbol, m.name, resolvedNameBySymbol)}
                    </span>
                    <div className="flex items-baseline justify-start gap-0.5 sm:justify-end">
                      <span className="text-[9px] font-medium uppercase tracking-wide text-slate-500 sm:hidden">
                        현재{" "}
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums leading-none text-slate-200 sm:text-xs">
                        {portPct.toFixed(2)}
                      </span>
                      <span className="text-[9px] font-medium text-slate-400">%</span>
                    </div>
                    <div className="text-left sm:text-right">
                      <span className="text-[9px] font-medium uppercase tracking-wide text-slate-500 sm:hidden">
                        평가{" "}
                      </span>
                      <span className="text-[9px] tabular-nums text-slate-400/85 sm:text-[10px]">
                        {fmtKrw(m.valueKrw)}
                      </span>
                    </div>
                    <label className="flex w-full max-w-[8rem] items-center gap-1.5 sm:w-[6.25rem] sm:max-w-none sm:justify-self-end">
                      <span className="hidden w-9 shrink-0 text-right text-[9px] font-semibold uppercase tracking-wide text-slate-500 sm:inline sm:w-10">
                        목표
                      </span>
                      <span className="shrink-0 text-[9px] font-semibold text-slate-500 sm:hidden">목표%</span>
                      <span className="sr-only">
                        {m.symbol} 포트폴리오 목표 비중 퍼센트
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        placeholder="—"
                        className="h-7 w-full min-w-[2.5rem] max-w-[4rem] rounded border border-slate-500/80 bg-slate-950/90 px-1 py-0.5 text-center text-[11px] font-semibold tabular-nums text-slate-50 shadow-inner outline-none ring-slate-600/25 transition-[border-color,box-shadow] focus:border-primary focus:ring-1 focus:ring-primary/35 sm:max-w-[3.25rem] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        value={memberSplitsForGroup[m.symbol] ?? ""}
                        onChange={(e) => onMemberSplitChange(row.groupKey, m.symbol, e.target.value)}
                        aria-label={`${row.displayName || row.groupKey} · ${m.symbol} 포트폴리오 목표 %`}
                        title="포트폴리오 목표 %. 비운 칸은 0%. 입력 합이 그룹 목표에 맞게 스케일되어 상세 매매액에 반영됩니다."
                      />
                    </label>
                  </div>
                );
              })}
              </div>
            </div>
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

/** ±N주 · ±원화 액수. 시세 없으면 ±액만 (미보유·워치 등 priceKrw=0) */
function formatMemberSharesOrAmount(diffKrw: number, priceKrw: number): string {
  const sign = diffKrw >= 0 ? "+" : "-";
  const amtPart = `${sign}${fmtKrw(diffKrw)}`;
  if (priceKrw > 0) return `${sign}${floorShares(diffKrw, priceKrw)}주 · ${amtPart}`;
  return amtPart;
}

function RebalancingOwner({
  ownerName,
  groups,
  totalKrw,
  cloudSyncKey,
}: Props) {
  const [resolvedNameBySymbol, setResolvedNameBySymbol] = useState<Record<string, string>>({});
  /** 이미 fetch 요청을 보낸 심볼 집합 — resolvedNameBySymbol을 deps에 넣으면 fetch 완료 후
   *  state가 바뀌어 effect가 재실행되는 루프를 유발하므로 ref로 별도 관리한다. */
  const requestedSymbolsRef = useRef<Set<string>>(new Set());

  // ── 목표 비중: 대시보드와 통합 저장소(loadAllTargetStockWeights) ──
  const [targets, setTargets] = useState<Record<string, string>>(() => {
    const saved =
      typeof window !== "undefined" ? (loadAllTargetStockWeights()[ownerName] ?? {}) : {};
    const init: Record<string, string> = {};
    for (const g of groups) {
      init[g.groupKey] = dashboardTargetInputString(saved, g.groupKey);
    }
    return init;
  });

  // 새 그룹이 추가·삭제될 때 targets를 그룹 키에 맞춤 (빠진 행 키는 제거 → LS 자동저장으로 stale 복구 차단)
  useEffect(() => {
    setTargets((prev) => {
      const saved = loadAllTargetStockWeights()[ownerName] ?? {};
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

  /** 대시보드 바·서버 pull 등 외부에서 통합 LS가 바뀐 경우 입력칸 동기화 */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncFromDisk = () => {
      const saved = loadAllTargetStockWeights()[ownerName] ?? {};
      setTargets((prev) => {
        const next: Record<string, string> = {};
        for (const g of groups) {
          const k = g.groupKey;
          const v = saved[k];
          next[k] = v != null && Number.isFinite(v) ? String(v) : "0";
        }
        if (
          Object.keys(prev).length === Object.keys(next).length &&
          Object.keys(next).every((ky) => prev[ky] === next[ky])
        ) {
          return prev;
        }
        return next;
      });
    };
    window.addEventListener(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT, syncFromDisk);
    return () => window.removeEventListener(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT, syncFromDisk);
  }, [ownerName, groups]);

  /** 그룹 내 종목별 매매액 분배 가중치 (계산기 전용 LS) */
  const [memberSplits, setMemberSplits] = useState<Record<string, Record<string, string>>>(() =>
    typeof window !== "undefined"
      ? (() => {
          const raw = loadAllCalculatorMemberSplits()[ownerName] ?? {};
          const out: Record<string, Record<string, string>> = {};
          for (const g of groups) {
            const row: Record<string, string> = {};
            for (const m of appendUndecidedSlotMember(g).members) {
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
        for (const m of appendUndecidedSlotMember(g).members) {
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

  const [memberSplitModes, setMemberSplitModes] = useState<Record<string, CalculatorMemberSplitMode>>(() => {
    if (typeof window === "undefined") return {};
    const saved = loadAllCalculatorMemberSplitModes()[ownerName] ?? {};
    const out: Record<string, CalculatorMemberSplitMode> = {};
    for (const g of groups) {
      const m = saved[g.groupKey];
      out[g.groupKey] = m === "targetPct" ? m : "targetPct";
    }
    return out;
  });

  useEffect(() => {
    setMemberSplitModes((prev) => {
      const keys = new Set(groups.map((g) => g.groupKey));
      const next: Record<string, CalculatorMemberSplitMode> = {};
      for (const g of groups) {
        const gk = g.groupKey;
        next[gk] = prev[gk] ?? "targetPct";
      }
      for (const k of Object.keys(next)) {
        if (!keys.has(k)) delete next[k];
      }
      return next;
    });
  }, [groups, ownerName]);

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

  const groupsWithUndecidedSlot = useMemo(
    () => expandGroupsWithUndecidedSlot(groups),
    [groups],
  );

  const orderedGroups = useMemo(
    () => orderPortfolioGroupsVisual(groupsWithUndecidedSlot, visualOrderKeys, sortGroupsByTarget),
    [groupsWithUndecidedSlot, visualOrderKeys, sortGroupsByTarget],
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
  const [splitAmountMode, setSplitAmountMode] = useState<SplitAmountMode>("remainder");
  const [milestoneStepInput, setMilestoneStepInput] = useState("1");
  const [hideSmall, setHideSmall] = useState(false);
  const [saveToast, setSaveToast] = useState(false);
  /** 상세 표 하단: 개별 종목 포트폴리오 목표 % → 필요 주수 참고 계산 */
  const [stockTargetQuickKey, setStockTargetQuickKey] = useState("");
  const [stockTargetPctQuickInput, setStockTargetPctQuickInput] = useState("");

  const newMoneyKrw = useMemo(() => parseKoreanIntDigits(newMoneyInput), [newMoneyInput]);
  const splitCount = useMemo(() => {
    const n = Math.floor(Number(splitCountInput));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(20, n);
  }, [splitCountInput]);

  const milestoneStepK = useMemo(() => {
    const raw = Math.floor(Number(String(milestoneStepInput).trim()));
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(splitCount, raw);
  }, [splitCount, milestoneStepInput]);

  useEffect(() => {
    setMilestoneStepInput((prev) => {
      const raw = Math.floor(Number(String(prev).trim())) || 1;
      if (raw <= splitCount) return prev;
      return String(splitCount);
    });
  }, [splitCount]);

  // ── 목표 합계 ────────────────────────────────────────────────────────────
  const targetSum = useMemo(
    () => Object.values(targets).reduce((s, v) => s + (parseFloat(v) || 0), 0),
    [targets],
  );
  const sumIsOver = targetSum > 100.05;
  const sumIsUnder = targetSum < 99.95;

  // ── 바 스케일: 0~100% 고정 ──────────────────────────────────────────────
  const maxScale = 100;

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
      const totalEff = totalKrw;
      return orderedGroups.map((g) => {
        const targetPct = parseFloat(targets[g.groupKey] ?? "0") || 0;
        const diffKrw = (targetPct / 100) * totalKrw - g.valueKrw;
        return {
          ...g,
          targetPct,
          diffKrw,
          memberAdjustments: calcMemberAdjustments(g, diffKrw, memberSplits[g.groupKey], {
            splitMode: memberSplitModes[g.groupKey] ?? "targetPct",
            allowTargetPct: true,
            totalKrwEffective: totalEff,
            groupTargetPct: targetPct,
          }),
        };
      }).filter((r) => !isGhostRow(r));
    }

    // buy-only
    const newTotal = totalKrw + Math.max(newMoneyKrw, 0);
    const totalEff = newTotal;
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
        memberAdjustments: calcMemberAdjustments(g, diffKrw, memberSplits[g.groupKey], {
          splitMode: memberSplitModes[g.groupKey] ?? "targetPct",
          allowTargetPct: false,
          totalKrwEffective: totalEff,
          groupTargetPct: targetPct,
        }),
      };
    }).filter((r) => !isGhostRow(r));
  }, [orderedGroups, targets, totalKrw, mode, newMoneyKrw, memberSplits, memberSplitModes]);

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

  // ── 표시 행 (임계값 필터 적용) ───────────────────────────────────────────
  const visibleRows = useMemo(
    () =>
      hideSmall
        ? rows.filter((r) => Math.abs(r.targetPct - r.currentPct) >= 1)
        : rows,
    [rows, hideSmall],
  );

  const effectivePortfolioKrw = useMemo(
    () => (mode === "buy-only" ? totalKrw + Math.max(newMoneyKrw, 0) : totalKrw),
    [mode, totalKrw, newMoneyKrw],
  );

  const stockQuickOptions = useMemo(() => {
    const out: Array<{
      key: string;
      groupLabel: string;
      symbol: string;
      name: string;
      valueKrw: number;
      priceKrw: number;
    }> = [];
    for (const g of groups) {
      if (isPinnedCashPortfolioGroup(g.groupKey)) continue;
      for (const m of g.members) {
        if (isUndecidedSlotMemberSymbol(m.symbol)) continue;
        out.push({
          key: `${g.groupKey}\u001f${m.symbol}`,
          groupLabel: g.displayName || g.groupKey,
          symbol: m.symbol,
          name: m.name,
          valueKrw: m.valueKrw,
          priceKrw: m.priceKrw,
        });
      }
    }
    out.sort((a, b) =>
      formatTickerLabel(a.symbol, a.name, resolvedNameBySymbol).localeCompare(
        formatTickerLabel(b.symbol, b.name, resolvedNameBySymbol),
        "ko",
      ),
    );
    return out;
  }, [groups, resolvedNameBySymbol]);

  useEffect(() => {
    if (stockQuickOptions.length === 0) {
      setStockTargetQuickKey("");
      return;
    }
    setStockTargetQuickKey((prev) =>
      stockQuickOptions.some((o) => o.key === prev) ? prev : stockQuickOptions[0]!.key,
    );
  }, [stockQuickOptions]);

  const stockQuickCalc = useMemo(() => {
    if (stockQuickOptions.length === 0) return { kind: "empty" as const };
    const sel =
      stockQuickOptions.find((o) => o.key === stockTargetQuickKey) ?? stockQuickOptions[0]!;
    const raw = stockTargetPctQuickInput.trim().replace(",", ".");
    if (raw === "") return { kind: "need_input" as const, sel };
    const pct = parseFloat(raw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { kind: "invalid_pct" as const, sel };
    }
    const tot = effectivePortfolioKrw;
    if (!(tot > 0)) return { kind: "no_total" as const, sel };
    const targetKrw = (pct / 100) * tot;
    const diffKrw = targetKrw - sel.valueKrw;
    const currentPct = (sel.valueKrw / tot) * 100;
    return {
      kind: "ok" as const,
      sel,
      pct,
      targetKrw,
      diffKrw,
      currentPct,
      priceKrw: sel.priceKrw,
    };
  }, [
    stockQuickOptions,
    stockTargetQuickKey,
    stockTargetPctQuickInput,
    effectivePortfolioKrw,
  ]);

  // ── 자동저장: 통합 목표 LS(대시보드·계산기 동일 키), `PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT` 발행 ──

  useEffect(() => {
    const unresolved = new Set<string>();
    for (const g of groups) {
      const repKey = normalizeTickerKey(g.repSymbol);
      if (
        isLikelyKoreanTicker(g.repSymbol) &&
        (!g.repName || g.repName.trim() === "" || g.repName.trim().toUpperCase() === g.repSymbol.trim().toUpperCase()) &&
        !requestedSymbolsRef.current.has(repKey)
      ) {
        unresolved.add(g.repSymbol);
      }
      for (const m of g.members) {
        if (isUndecidedSlotMemberSymbol(m.symbol)) continue;
        const mKey = normalizeTickerKey(m.symbol);
        if (
          isLikelyKoreanTicker(m.symbol) &&
          (!m.name || m.name.trim() === "" || m.name.trim().toUpperCase() === m.symbol.trim().toUpperCase()) &&
          !requestedSymbolsRef.current.has(mKey)
        ) {
          unresolved.add(m.symbol);
        }
      }
    }
    if (unresolved.size === 0) return;
    // fetch 전에 먼저 요청 집합에 등록 → 중복 요청 방지
    for (const sym of unresolved) {
      requestedSymbolsRef.current.add(normalizeTickerKey(sym));
    }
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
  }, [groups]);

  /** handleLoad가 localStorage를 덮어쓰기 전에 취소할 수 있도록 ref로 타이머 ID 관리 */
  const autosaveTimerRef = useRef<number | null>(null);
  const memberSplitAutosaveTimerRef = useRef<number | null>(null);
  const serverCalculatorSyncTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (autosaveTimerRef.current != null) window.clearTimeout(autosaveTimerRef.current);
    const id = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      persistOwnerTargetWeightsFromInputStrings(ownerName, targets);
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
      persistCalculatorMemberSplitModesForOwner(ownerName, memberSplitModes);
    }, 420) as unknown as number;
    memberSplitAutosaveTimerRef.current = id;
    return () => {
      if (memberSplitAutosaveTimerRef.current != null) {
        window.clearTimeout(memberSplitAutosaveTimerRef.current);
        memberSplitAutosaveTimerRef.current = null;
      }
    };
  }, [memberSplits, memberSplitModes, ownerName]);

  /** 동기화 키가 있으면 LS 자동 저장 직후 서버에도 목표·메모·계산기 번들 반영(pushTargetWeights) */
  useEffect(() => {
    const k = cloudSyncKey?.trim() ?? "";
    if (typeof window === "undefined" || k.length < 8) return;
    if (serverCalculatorSyncTimerRef.current != null) {
      window.clearTimeout(serverCalculatorSyncTimerRef.current);
    }
    serverCalculatorSyncTimerRef.current = window.setTimeout(() => {
      serverCalculatorSyncTimerRef.current = null;
      void pushTargetWeightsAndScratchpadsToServer(k);
    }, 900) as unknown as number;
    return () => {
      if (serverCalculatorSyncTimerRef.current != null) {
        window.clearTimeout(serverCalculatorSyncTimerRef.current);
        serverCalculatorSyncTimerRef.current = null;
      }
    };
  }, [targets, memberSplits, memberSplitModes, ownerName, cloudSyncKey]);

  const handleSave = useCallback(() => {
    persistOwnerTargetWeightsFromInputStrings(ownerName, targets);
    persistCalculatorMemberSplitsForOwner(ownerName, memberSplits);
    persistCalculatorMemberSplitModesForOwner(ownerName, memberSplitModes);
    setSaveToast(true);
    setTimeout(() => setSaveToast(false), 2000);
  }, [targets, ownerName, memberSplits, memberSplitModes]);

  /** 초기화: 계산기 저장값으로 복원 (없으면 0%) */
  const handleReset = useCallback(() => {
    const saved = loadAllTargetStockWeights()[ownerName] ?? {};
    const init: Record<string, string> = {};
    for (const g of groups) {
      init[g.groupKey] = dashboardTargetInputString(saved, g.groupKey);
    }
    setTargets(init);
    const msaved = loadAllCalculatorMemberSplits()[ownerName] ?? {};
    const msNext: Record<string, Record<string, string>> = {};
    for (const g of groups) {
      const row: Record<string, string> = {};
      for (const m of appendUndecidedSlotMember(g).members) {
        const n = msaved[g.groupKey]?.[m.symbol];
        row[m.symbol] = n != null && Number.isFinite(n) ? String(n) : "";
      }
      if (Object.keys(row).length > 0) msNext[g.groupKey] = row;
    }
    setMemberSplits(msNext);
    const modesSaved = loadAllCalculatorMemberSplitModes()[ownerName] ?? {};
    const modesNext: Record<string, CalculatorMemberSplitMode> = {};
    for (const g of groups) {
      const m = modesSaved[g.groupKey];
      modesNext[g.groupKey] = m === "targetPct" ? m : "targetPct";
    }
    setMemberSplitModes(modesNext);
  }, [groups, ownerName]);

  return (
    <div className="space-y-5">
      {/* ── 컨트롤 헤더 ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 모드 토글 */}
        <div className="flex overflow-hidden rounded-md border text-xs sm:text-sm">
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
              <span className="text-xs text-muted-foreground shrink-0">
                잔여{" "}
                <span className="font-medium text-foreground">
                  {fmtKrw(Math.max(0, newMoneyKrw - allocatedKrw))}
                </span>
              </span>
            )}
          </div>
        )}
        {/* 우측 컨트롤 */}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <label className="flex cursor-pointer select-none items-center gap-1 text-xs text-muted-foreground">
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
          <button
            type="button"
            onClick={handleReset}
            className="rounded border px-2 py-1 text-xs transition-colors hover:bg-muted active:scale-95"
          >
            초기화
          </button>
          <button
            type="button"
            onClick={handleSave}
            className={`relative rounded border px-2 py-1 text-xs transition-all active:scale-95 ${
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
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-300 sm:text-sm">
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

        {/* 스케일 헤더 — 바 행과 동일한 레이아웃으로 정렬 */}
        <div className="mb-0.5 flex items-center">
          <div className="flex shrink-0">
            <span className="w-5 shrink-0 sm:w-5" aria-hidden />
            <div className="w-36 shrink-0 sm:w-44" />
          </div>
          <div className="mx-1.5 flex-1">
            <div className="flex justify-between text-[10px] tabular-nums text-slate-400 sm:text-xs">
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((v) => (
                <span key={v}>{v}%</span>
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
                  rebalanceMode={mode}
                  resolvedNameBySymbol={resolvedNameBySymbol}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {mode === "buy-only" && newMoneyKrw === 0 && (
        <p className="rounded-lg border border-slate-700/40 bg-slate-900/20 px-3 py-2 text-xs text-muted-foreground">
          투자할 금액을 입력하면 목표 비중에 맞게 매수 배분을 계산합니다.
        </p>
      )}

      {/* ── 상세 수치 (항상 표시) ─────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 pb-2">
          <h3 className="text-xs font-semibold text-foreground sm:text-sm">상세 수치</h3>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            기준
            <select
              value={splitAmountMode}
              onChange={(e) => setSplitAmountMode(e.target.value as SplitAmountMode)}
              className="max-w-[10rem] rounded border border-border bg-background px-1.5 py-1 text-[11px] text-foreground outline-none ring-primary/35 focus:ring-1"
              aria-label="회당 분할 금액 계산 방식"
              title="남은액÷n·매도는 균등 분할. 목표 단계별은 매수만 목표평가의 k/n까지 이번 회에 맞춤(k 선택). 분할 1회면 동일."
            >
              <option value="remainder">남은 금액 ÷ n</option>
              <option value="milestone">목표÷n 단계별</option>
            </select>
          </label>
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
              aria-label="분할 횟수"
            />
            <span className="text-muted-foreground shrink-0">회</span>
          </div>
          {splitAmountMode === "milestone" && splitCount > 1 ?
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              목표까지
              <select
                value={String(milestoneStepK)}
                onChange={(e) => setMilestoneStepInput(e.target.value)}
                className="rounded border border-border bg-background px-1.5 py-1 text-[11px] text-foreground outline-none ring-primary/35 focus:ring-1"
                aria-label="목표 진행 단계 k/n"
              >
                {Array.from({ length: splitCount }, (_, i) => i + 1).map((kk) => (
                  <option key={kk} value={String(kk)}>
                    {kk}/{splitCount}
                  </option>
                ))}
              </select>
            </label>
          : null}
        </div>
        <p className="-mt-1 text-[10px] leading-snug text-muted-foreground">
          같은 값이 계속 나올 때: <strong className="text-foreground/80">분할이 2회 미만이면 두 기준이 항상 같습니다.</strong>{" "}
          그 밖에는 <strong className="text-foreground/80">매도 줄(▼)</strong>은 스펙상 둘 다 “남은액÷n”.
          그리고 <strong className="text-foreground/80">평가 0원(미보유·워치 같은 슬라이스)</strong>에서는 매수(▲)라도 두 기준이 수식상 동일하게 나옵니다.
          회당 차이가 보이려면 <strong className="text-foreground/80">매수 + 분할 n≥2 + 해당 줄 평가 있음</strong>.
          차액이 1만원 미만이면 회당은 “—”로 비교가 안 됩니다.
          <strong className="text-foreground/80"> 목표÷n 단계별</strong>은 이번 회에 목표평가의{" "}
          <span className="tabular-nums">k/n</span>까지 맞추는 금액으로, 아래에서{" "}
          <span className="tabular-nums">k</span>를 고릅니다.
          {" "}
          <strong className="text-foreground/80">회당 종목(주수·금액)</strong> 열은 그룹 안에서 정한 비율(가중·목표%)대로 나누되,
          한 종목이 이번 회 금액만으로 목표치에 먼저 도달하면 남은 금액은 아직 부족한 종목들만 대상으로 같은 비율로 다시 배분합니다.
        </p>

        {/* ── 계산 방식 요약 메모 ───────────────────────────────────────────────── */}
        <details className="rounded-lg border border-slate-700/40 bg-slate-900/20 text-[11px] leading-relaxed text-muted-foreground">
          <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-slate-300 hover:text-slate-100">
            계산 방식 요약 ▸
          </summary>
          <div className="grid gap-3 px-3 pb-3 pt-1 sm:grid-cols-3">
            <div>
              <p className="mb-1 font-semibold text-slate-200">① 회당 금액</p>
              <p><span className="text-slate-300">남은 금액÷n:</span> 총 남은 금액을 n등분</p>
              <p className="mt-1"><span className="text-slate-300">목표÷n 단계별 (k/n):</span> 그룹 목표%의 k/n 비중까지 올리는 금액</p>
              <p className="mt-1 text-slate-500">└ 현재 비중이 0%가 아니면 1회차가 나머지 회차보다 적음</p>
              <p className="text-slate-500">└ 예) 현재 9.6%, 목표 55%, 1/2 → 9.6%→27.5%만 올리면 되므로 ≠ 총액÷2</p>
            </div>
            <div>
              <p className="mb-1 font-semibold text-slate-200">② 종목별 배분</p>
              <p>회당 그룹 금액을 <span className="text-slate-300">각 종목의 목표액 비율</span>로 배분</p>
              <p className="text-slate-500">└ 목표액 = 현재 보유액 + 추가 필요액</p>
              <p className="mt-1">배분액 &lt; 1주 가격이면 → <span className="text-slate-300">0주 매수</span></p>
              <p className="text-slate-500">└ 금액은 표시되지만 실제 매수 없음</p>
            </div>
            <div>
              <p className="mb-1 font-semibold text-slate-200">③ → X% 의미</p>
              <p><span className="text-slate-300">(현재 보유액 + 회당 배분) ÷ 전체 포트폴리오 목표액</span></p>
              <p className="text-slate-500">└ 분모는 목표액으로 고정 (투자 후 현재액 기준 아님)</p>
              <p className="mt-1">목표 포트폴리오 전체 대비 해당 종목의 <span className="text-slate-300">달성률</span></p>
            </div>
          </div>
        </details>

        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-2 pr-2 text-left font-medium">그룹</th>
                <th className="py-2 px-2 text-right font-medium">현재%</th>
                <th className="py-2 px-2 text-right font-medium">현재액</th>
                <th className="py-2 px-2 text-right font-medium">목표%</th>
                <th className="py-2 px-2 text-right font-medium">목표액</th>
                <th className="py-2 px-2 text-right font-medium">매수/매도</th>
                <th className="py-2 px-2 text-right font-medium">회당</th>
                <th className="py-2 px-2 text-right font-medium" title="시세 없으면 원화 차액만 표시">
                  종목(주수·금액)
                </th>
                <th className="py-2 px-2 text-right font-medium" title="시세 없으면 원화 차액만 표시">
                  회당 주수·금액
                </th>
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

                const perSplitRowKrw =
                  significant && splitCount > 1 ?
                    perSplitKrwCore(
                      splitAmountMode,
                      splitCount,
                      {
                        diffKrw: r.diffKrw,
                        targetPct: r.targetPct,
                        valueKrw: r.valueKrw,
                      },
                      effectiveTotalKrw,
                      { milestoneStep: milestoneStepK },
                    )
                  : 0;

                const rowPctAfterSplit =
                  significant && splitCount > 1 && effectiveTotalKrw > 0 ?
                    approxPortfolioPctAfterDelta(r.valueKrw, perSplitRowKrw, effectiveTotalKrw)
                  : null;

                const trancheBySymbol =
                  significant && splitCount > 1 && !isCash ?
                    memberTrancheKrwBySymbol(
                      r,
                      perSplitRowKrw,
                      memberSplits[r.groupKey],
                      memberSplitModes[r.groupKey] ?? "targetPct",
                    )
                  : null;

                return (
                  <tr
                    key={r.groupKey}
                    className="border-b last:border-0 hover:bg-muted/20"
                  >
                    <td className="py-2 pr-2 font-medium">
                      {r.displayName || r.groupKey}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                      {r.currentPct.toFixed(1)}%
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                      {fmtKrw(r.valueKrw)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      {r.targetPct.toFixed(1)}%
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      {fmtKrw(targetKrw)}
                    </td>
                    <td
                      className={`py-2 px-2 text-right tabular-nums font-semibold ${
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
                      className={`py-2 px-2 text-right tabular-nums ${
                        !significant
                          ? "text-muted-foreground"
                          : r.diffKrw > 0
                            ? "text-rose-400"
                            : "text-blue-400"
                      }`}
                    >
                      {!significant
                        ? "—"
                      : splitCount > 1 ?
                        <span className="inline-flex flex-wrap items-baseline justify-end gap-x-0.5 tabular-nums">
                          <span>
                            {r.diffKrw > 0 ? "▲" : "▼"} {fmtKrw(perSplitRowKrw)}
                          </span>
                          {splitAmountMode === "remainder" && (
                            <span className="font-normal text-muted-foreground">×{splitCount}</span>
                          )}
                          {splitAmountMode === "milestone" && (
                            <span className="font-normal text-muted-foreground">{`·${milestoneStepK}/${splitCount}`}</span>
                          )}
                          {rowPctAfterSplit != null ?
                            <span className="font-normal text-muted-foreground">{` (→ ${rowPctAfterSplit.toFixed(2)}%)`}</span>
                          : null}
                        </span>
                      : "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {isCash ? (
                        <span className="text-muted-foreground">현금</span>
                      ) : !significant ? (
                        (() => {
                          const holdings = r.members.filter(
                            (m) => !isUndecidedSlotMemberSymbol(m.symbol),
                          );
                          if (!holdings.length) {
                            return <span className="text-muted-foreground">—</span>;
                          }
                          return (
                            <div className="space-y-0.5">
                              {holdings.map((m) => (
                                <p key={m.symbol} className="tabular-nums">
                                  <span className="text-muted-foreground">
                                    {allocationMemberDisplayLabel(m.symbol, m.name, resolvedNameBySymbol)}{" "}
                                    <span className="tabular-nums">{`현재 ${currentPortfolioPctOfMember(m.valueKrw, totalKrw).toFixed(2)}%`}</span>
                                  </span>
                                </p>
                              ))}
                            </div>
                          );
                        })()
                      ) : r.members.length <= 1 && r.repPrice > 0 ? (
                        <span
                          className={r.diffKrw > 0 ? "tabular-nums text-rose-400" : "tabular-nums text-blue-400"}
                        >
                          <span className="text-muted-foreground">
                            {formatTickerLabel(r.repSymbol, r.repName, resolvedNameBySymbol)}{" "}
                            <span className="tabular-nums">{`현재 ${currentPortfolioPctOfMember(r.valueKrw, totalKrw).toFixed(2)}%`}</span>
                          </span>{" "}
                          {formatMemberSharesOrAmount(r.diffKrw, r.repPrice)}
                        </span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.memberAdjustments
                            .filter((m) => Math.abs(m.diffKrw) >= 10000)
                            .map((m) => (
                              <p key={m.symbol} className="tabular-nums">
                                <span className="text-muted-foreground">
                                  {allocationMemberDisplayLabel(m.symbol, m.name, resolvedNameBySymbol)}{" "}
                                  <span className="tabular-nums">{`현재 ${currentPortfolioPctOfMember(m.valueKrw, totalKrw).toFixed(2)}%`}</span>
                                </span>{" "}
                                <span
                                  title={m.priceKrw <= 0 ? "종목 시세 없음 · 매매 차액만 표시" : undefined}
                                  className={
                                    m.diffKrw >= 0 ? "text-rose-400" : "text-blue-400"
                                  }
                                >
                                  {formatMemberSharesOrAmount(m.diffKrw, m.priceKrw)}
                                </span>
                              </p>
                            ))}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {isCash || !significant || splitCount <= 1 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : r.members.length <= 1 && r.repPrice > 0 ? (
                        <span
                          className={r.diffKrw > 0 ? "tabular-nums text-rose-400" : "tabular-nums text-blue-400"}
                        >
                          <span className="text-muted-foreground">
                            {formatTickerLabel(r.repSymbol, r.repName, resolvedNameBySymbol)}{" "}
                            <span className="tabular-nums">{`현재 ${currentPortfolioPctOfMember(r.valueKrw, totalKrw).toFixed(2)}%`}</span>
                          </span>{" "}
                          {formatMemberSharesOrAmount(perSplitRowKrw, r.repPrice)}
                          {rowPctAfterSplit != null ?
                            <span className="text-muted-foreground">{` (→ ${rowPctAfterSplit.toFixed(2)}%)`}</span>
                          : null}
                        </span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.memberAdjustments
                            .filter((m) => Math.abs(m.diffKrw) >= 10000)
                            .map((m) => {
                              const mPer = trancheBySymbol?.get(m.symbol) ?? 0;
                              const mPctAfter =
                                approxPortfolioPctAfterDelta(m.valueKrw, mPer, effectiveTotalKrw);
                              return (
                                <p key={`${m.symbol}-per-split`} className="tabular-nums">
                                  <span className="text-muted-foreground">
                                    {allocationMemberDisplayLabel(m.symbol, m.name, resolvedNameBySymbol)}{" "}
                                    <span className="tabular-nums">{`현재 ${currentPortfolioPctOfMember(m.valueKrw, totalKrw).toFixed(2)}%`}</span>
                                  </span>{" "}
                                  <span
                                    title={
                                      m.priceKrw <= 0 ? "종목 시세 없음 · 매매 차액만 표시" : undefined
                                    }
                                    className={m.diffKrw >= 0 ? "text-rose-400" : "text-blue-400"}
                                  >
                                    {formatMemberSharesOrAmount(mPer, m.priceKrw)}
                                    {mPctAfter != null ?
                                      <span className="text-muted-foreground">{` (→ ${mPctAfter.toFixed(2)}%)`}</span>
                                    : null}
                                  </span>
                                </p>
                              );
                            })}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t font-semibold">
                <td className="py-2 pr-2">합계</td>
                <td className="py-2 px-2 text-right tabular-nums">
                  {groups.reduce((s, g) => s + g.currentPct, 0).toFixed(1)}%
                </td>
                <td className="py-2 px-2 text-right tabular-nums">{fmtKrw(totalKrw)}</td>
                <td
                  className={`py-2 px-2 text-right tabular-nums ${
                    sumIsOver || sumIsUnder ? "text-amber-400" : "text-emerald-400"
                  }`}
                >
                  {targetSum.toFixed(1)}%
                </td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          </table>

          <div className="mt-4 rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-3 sm:px-4">
            <p className="text-xs font-semibold text-slate-200 sm:text-sm">
              개별 종목: 원하는 포트폴리오 비중 → 필요 주수
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              전체 평가금 기준으로 이 종목이 포트폴리오의 몇 %가 되려면 주 몇 주를 사거나 팔아야 하는지 참고합니다.
              {mode === "buy-only" ?
                " 신규 투자금 모드에서는 (기존 평가금 + 입력한 투자금)을 전체로 사용합니다."
              : null}
            </p>
            {stockQuickCalc.kind === "empty" ?
              <p className="mt-3 text-xs text-slate-500">보유 종목이 없어 계산할 수 없습니다.</p>
            : (
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
                  <span className="text-xs font-medium text-slate-400">종목</span>
                  <select
                    className="rounded-md border border-slate-600/80 bg-background px-2 py-2 text-xs sm:text-sm"
                    value={stockTargetQuickKey}
                    onChange={(e) => setStockTargetQuickKey(e.target.value)}
                    aria-label="주수 계산 대상 종목"
                  >
                    {stockQuickOptions.map((o) => (
                      <option key={o.key} value={o.key}>
                        {formatTickerLabel(o.symbol, o.name, resolvedNameBySymbol)} · {o.groupLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex w-full flex-col gap-1 sm:w-36">
                  <span className="text-xs font-medium text-slate-400">목표 비중 (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    placeholder="예: 5"
                    className="rounded-md border border-slate-600/80 bg-background px-2 py-2 text-right text-xs tabular-nums sm:text-sm"
                    value={stockTargetPctQuickInput}
                    onChange={(e) => setStockTargetPctQuickInput(e.target.value)}
                    aria-label="포트폴리오에서 차지할 목표 퍼센트"
                  />
                </label>
              </div>
            )}
            {stockQuickCalc.kind === "need_input" ?
              <p className="mt-3 text-xs text-slate-500">목표 %를 입력하면 결과가 표시됩니다.</p>
            : stockQuickCalc.kind === "invalid_pct" ?
              <p className="mt-3 text-xs text-amber-400">목표 %는 0~100 사이 숫자로 입력해 주세요.</p>
            : stockQuickCalc.kind === "no_total" ?
              <p className="mt-3 text-xs text-slate-500">평가금 합계가 없어 계산할 수 없습니다.</p>
            : stockQuickCalc.kind === "ok" ?
              <div className="mt-3 space-y-1.5 text-xs tabular-nums text-slate-200 sm:text-sm">
                <p>
                  <span className="text-slate-400">현재</span>{" "}
                  <span className="font-medium text-slate-100">{stockQuickCalc.currentPct.toFixed(2)}%</span>
                  {" · "}
                  <span className="text-slate-400">평가액</span> {fmtKrw(stockQuickCalc.sel.valueKrw)}
                </p>
                <p>
                  <span className="text-slate-400">목표</span>{" "}
                  <span className="font-medium text-slate-100">{stockQuickCalc.pct.toFixed(2)}%</span>
                  {" → "}
                  <span className="text-slate-400">목표 평가액</span> {fmtKrw(stockQuickCalc.targetKrw)}
                </p>
                <p className="font-semibold text-slate-50">
                  참고 주수:{" "}
                  <span
                    className={
                      stockQuickCalc.diffKrw >= 0 ? "text-rose-400" : "text-blue-400"
                    }
                  >
                    {formatMemberSharesOrAmount(stockQuickCalc.diffKrw, stockQuickCalc.priceKrw)}
                  </span>
                </p>
              </div>
            : null}
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
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
  eurKrw = 1450,
  marketQuotes,
  watchlistRows = [],
  watchlistOwnerAllToken = "__ALL__",
  cloudSyncKey = "",
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
  /** EUR 종목 시세 환산 (관심종목·미보유 종목 주수 계산) */
  eurKrw?: number;
  /** 보유 외 심볼도 시세 맵(`/api/market` quotes) — 관심종목과 결합 시 미보유 종목 주수 표시 */
  marketQuotes?: Record<string, { price: number | null; currency: string | null }>;
  /** 대시보드 도넛과 동일하게 그룹 후보에 워치 종목을 붙입니다 */
  watchlistRows?: WatchlistRowForRebalance[];
  watchlistOwnerAllToken?: string;
  /** 설정 시 계산기 편집을 서버 스냅샷(pushTargetWeights)에 함께 반영합니다. */
  cloudSyncKey?: string;
}) {
  const [selectedOwner, setSelectedOwner] = useState(allocationByOwner[0]?.ownerName ?? "");
  const mergeTargetsReady = useClientReady();
  /** 서버 pull 등으로 분배 LS가 바뀌면 미보유 stub ownerData 재구성 트리거 */
  const [calcStorageBump, setCalcStorageBump] = useState(0);
  /** 통합 목표 LS 변경 시 mergeSavedWithoutHoldings가 다시 LS를 읽도록(리마운트 없이) */
  const [targetDiskRev, setTargetDiskRev] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bumpCalc = () => setCalcStorageBump((n) => n + 1);
    window.addEventListener(REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT, bumpCalc);
    const bumpTargets = () => setTargetDiskRev((n) => n + 1);
    window.addEventListener(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT, bumpTargets);
    return () => {
      window.removeEventListener(REBALANCE_CALCULATOR_STORAGE_REFRESH_EVENT, bumpCalc);
      window.removeEventListener(PORTFOLIO_TARGET_WEIGHTS_REFRESH_EVENT, bumpTargets);
    };
  }, []);

  const displayOwner = useMemo(() => {
    if (allocationByOwner.some((o) => o.ownerName === selectedOwner)) return selectedOwner;
    return allocationByOwner[0]?.ownerName ?? "";
  }, [allocationByOwner, selectedOwner]);

  const ownerData = useMemo(() => {
    void calcStorageBump;
    void targetDiskRev;
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
        { quotes: marketQuotes, eurKrw },
      );

      return { ownerName, groups, totalKrw: total };
    });
  }, [
    allocationByOwner,
    enrichedPositions,
    usdKrw,
    eurKrw,
    marketQuotes,
    mergeTargetsReady,
    calcStorageBump,
    targetDiskRev,
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
          key={`${current.ownerName}-${calcStorageBump}`}
          ownerName={current.ownerName}
          groups={current.groups}
          totalKrw={current.totalKrw}
          cloudSyncKey={cloudSyncKey}
        />
      ) : (
        <p className="text-sm text-muted-foreground">보유 종목이 없습니다.</p>
      )}
    </div>
  );
}
