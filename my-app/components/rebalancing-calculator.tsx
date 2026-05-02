"use client";

import { useState, useMemo, useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { GripVertical } from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { fmtInt, parseKoreanIntDigits } from "@/lib/format-money";
import {
  loadAllTargetStockWeights,
  TARGET_WEIGHT_STORAGE_KEY,
  HAS_LOCAL_CHANGES_KEY,
} from "@/lib/portfolio-target-weights";
import {
  loadVisualOrderKeysForOwner,
  persistVisualOrderForOwner,
  REBALANCE_VISUAL_ORDER_REFRESH_EVENT,
} from "@/lib/rebalance-visual-order";

/** 대시보드에 목표만 있고 현재 평가 0원인 그룹을 계산기 행에 포함 */
function mergeSavedTargetGroupsWithoutHoldings(ownerName: string, baseGroups: GroupAllocation[]): GroupAllocation[] {
  const saved = loadAllTargetStockWeights()[ownerName] ?? {};
  const seen = new Set(baseGroups.map((g) => g.groupKey.trim()));
  const extra: GroupAllocation[] = [];
  for (const key of Object.keys(saved)) {
    const k = key.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
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
};

type Mode = "buy-sell" | "buy-only";

// ─── 헬퍼 ──────────────────────────────────────────────────────────────────────

function fmtKrw(n: number) {
  return `₩${fmtInt(Math.abs(n))}`;
}

function calcMemberAdjustments(g: GroupAllocation, diffKrw: number): MemberAdj[] {
  if (g.members.length === 0) return [];
  return g.members.map((m) => {
    const ratio = g.valueKrw > 0 ? m.valueKrw / g.valueKrw : 1 / g.members.length;
    const memberDiffKrw = diffKrw * ratio;
    return {
      ...m,
      diffKrw: memberDiffKrw,
      shares: m.priceKrw > 0 ? memberDiffKrw / m.priceKrw : null,
    };
  });
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
  dashboardHasStoredTarget,
}: {
  row: ComputedRow;
  targets: Record<string, string>;
  setTargets: Dispatch<SetStateAction<Record<string, string>>>;
  maxScale: number;
  /** 대시보드 저장소에 이 그룹 키의 목표가 있는지 (0% 저장도 true) */
  dashboardHasStoredTarget: boolean;
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
    <div ref={setNodeRef} style={outerStyle} className="flex items-center border-b border-slate-800/40 py-1.5 last:border-0">
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
            title={
              dashboardHasStoredTarget ?
                "대시보드(원형 차트)와 같은 저장소에 있는 목표 비중입니다. 수정 후 「저장」하면 대시보드에도 반영됩니다."
              : "이 그룹은 대시보드에 목표가 아직 저장되지 않았습니다. 목표 입력은 0%로 두었습니다. 대시보드에서 목표를 저장하거나 여기서 입력한 뒤 「저장」하세요."
            }
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
          <span className="text-muted-foreground text-[10px]">현금</span>
        : rowIsOver ?
          <span className="font-medium tabular-nums text-emerald-400">▼+{absDiff.toFixed(1)}%p 초과</span>
        : rowIsUnder ?
          <span className="font-medium tabular-nums text-rose-400">▲{absDiff.toFixed(1)}%p 부족</span>
        : (
          <span className="text-muted-foreground">✓</span>
        )}
      </div>
    </div>
  );
}

// ─── RebalancingOwner ──────────────────────────────────────────────────────────

/** 정수 주수 (floor 절대값, 부호는 호출자가 처리) */
function floorShares(diffKrw: number, priceKrw: number): number {
  if (priceKrw <= 0) return 0;
  return Math.floor(Math.abs(diffKrw) / priceKrw);
}

function RebalancingOwner({ ownerName, groups, totalKrw }: Props) {
  /** localStorage 재읽기(저장/불러오기 후 대시보드 스냅샷·툴팁 반영) */
  const [targetStorageRevision, setTargetStorageRevision] = useState(0);

  const dashboardSavedTargets = useMemo(
    () => loadAllTargetStockWeights()[ownerName] ?? {},
    [ownerName, targetStorageRevision],
  );

  // ── 목표 비중 state: 대시보드 저장값만 초깃값(미저장 그룹은 0%), 현재 비중으로 채우지 않음 ──
  const [targets, setTargets] = useState<Record<string, string>>(() => {
    const saved =
      typeof window !== "undefined" ? (loadAllTargetStockWeights()[ownerName] ?? {}) : {};
    const init: Record<string, string> = {};
    for (const g of groups) {
      init[g.groupKey] = dashboardTargetInputString(saved, g.groupKey);
    }
    return init;
  });

  // 새 그룹이 추가됐을 때 targets 보강 — 대시보드 저장값 또는 0%
  useEffect(() => {
    setTargets((prev) => {
      const saved = loadAllTargetStockWeights()[ownerName] ?? {};
      const next = { ...prev };
      let changed = false;
      for (const g of groups) {
        if (!(g.groupKey in next)) {
          next[g.groupKey] = dashboardTargetInputString(saved, g.groupKey);
          changed = true;
        }
      }
      return changed ? next : prev;
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
  const [hideSmall, setHideSmall] = useState(false);
  const [saveToast, setSaveToast] = useState(false);

  const newMoneyKrw = useMemo(() => parseKoreanIntDigits(newMoneyInput), [newMoneyInput]);

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
    if (mode === "buy-sell") {
      return orderedGroups.map((g) => {
        const targetPct = parseFloat(targets[g.groupKey] ?? "0") || 0;
        const diffKrw = (targetPct / 100) * totalKrw - g.valueKrw;
        return { ...g, targetPct, diffKrw, memberAdjustments: calcMemberAdjustments(g, diffKrw) };
      });
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
      return { ...g, targetPct, diffKrw, memberAdjustments: calcMemberAdjustments(g, diffKrw) };
    });
  }, [orderedGroups, targets, totalKrw, mode, newMoneyKrw]);

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

  // ── 대시보드 목표 비중 불러오기 ──────────────────────────────────────────
  const [loadToast, setLoadToast] = useState(false);

  const handleLoad = useCallback(() => {
    const saved =
      typeof window !== "undefined" ? (loadAllTargetStockWeights()[ownerName] ?? {}) : {};
    const hasSaved = Object.keys(saved).length > 0;
    if (!hasSaved) return;
    setTargets((prev) => {
      const next = { ...prev };
      for (const g of groups) {
        if (saved[g.groupKey] != null) {
          next[g.groupKey] = String(saved[g.groupKey]);
        }
      }
      return next;
    });
    setTargetStorageRevision((n) => n + 1);
    setLoadToast(true);
    setTimeout(() => setLoadToast(false), 2000);
  }, [groups, ownerName]);

  // 대시보드에서 저장 이벤트가 발생하면 자동으로 반영
  useEffect(() => {
    const handler = () => handleLoad();
    window.addEventListener("portfolio-target-weights-refresh", handler);
    return () => window.removeEventListener("portfolio-target-weights-refresh", handler);
  }, [handleLoad]);

  // ── 저장 / 초기화 ─────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    try {
      const all = loadAllTargetStockWeights();
      const entry: Record<string, number> = {};
      for (const [k, v] of Object.entries(targets)) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) entry[k] = n;
      }
      all[ownerName] = entry;
      window.localStorage.setItem(TARGET_WEIGHT_STORAGE_KEY, JSON.stringify(all));
      window.localStorage.setItem(HAS_LOCAL_CHANGES_KEY, "1");
      window.dispatchEvent(new Event("portfolio-target-weights-refresh"));
      setTargetStorageRevision((n) => n + 1);
      setSaveToast(true);
      setTimeout(() => setSaveToast(false), 2000);
    } catch {
      /* localStorage 접근 불가 시 무시 */
    }
  }, [targets, ownerName]);

  const handleReset = useCallback(() => {
    const saved = loadAllTargetStockWeights()[ownerName] ?? {};
    const init: Record<string, string> = {};
    for (const g of groups) {
      init[g.groupKey] = dashboardTargetInputString(saved, g.groupKey);
    }
    setTargets(init);
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
            title="대시보드(원형 차트) 목표 비중 설정값을 불러옵니다"
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
          왼쪽 % 입력 칸은 목표 비중이며, 대시보드 원형 차트와 같은 localStorage 저장값을 기본으로 씁니다. 해당 그룹
          목표가 저장소에 없으면 0%로 둡니다. 여기에서 바꾼 뒤 우측「저장」을 누르면 대시보드와 숫자가 맞춰
          유지됩니다.
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
                  dashboardHasStoredTarget={dashboardSavedTargets[r.groupKey] != null}
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
              if (!isCash) {
                if (r.members.length <= 1 && r.repPrice > 0) {
                  const sh = floorShares(r.diffKrw, r.repPrice);
                  sharesDisplay = `${r.repName} ${isBuy ? "+" : "-"}${sh}주`;
                } else if (r.memberAdjustments.length > 0) {
                  const parts = r.memberAdjustments
                    .filter((m) => Math.abs(m.diffKrw) >= 10000 && m.priceKrw > 0)
                    .map((m) => {
                      const sh = floorShares(m.diffKrw, m.priceKrw);
                      return `${m.name} ${m.diffKrw >= 0 ? "+" : "-"}${sh}주`;
                    });
                  sharesDisplay = parts.join(" / ");
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
                  {sharesDisplay && (
                    <span className="text-muted-foreground tabular-nums">{sharesDisplay}</span>
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
                <th className="py-1.5 px-2 text-right font-medium">종목(주수)</th>
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
                    <td className="py-1.5 px-2 text-right">
                      {isCash ? (
                        <span className="text-muted-foreground">현금</span>
                      ) : !significant ? (
                        <span className="text-muted-foreground">—</span>
                      ) : r.members.length <= 1 && r.repPrice > 0 ? (
                        <span
                          className={r.diffKrw > 0 ? "tabular-nums text-rose-400" : "tabular-nums text-blue-400"}
                        >
                          {r.repName}{" "}
                          {r.diffKrw > 0 ? "+" : "-"}
                          {floorShares(r.diffKrw, r.repPrice)}주
                        </span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.memberAdjustments
                            .filter((m) => Math.abs(m.diffKrw) >= 10000)
                            .map((m) => (
                              <p key={m.symbol} className="tabular-nums">
                                <span className="text-muted-foreground">{m.name}</span>{" "}
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
                <td colSpan={3} />
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
}) {
  const [selectedOwner, setSelectedOwner] = useState(allocationByOwner[0]?.ownerName ?? "");
  const [mergeTargetsReady, setMergeTargetsReady] = useState(false);
  /** 대시보드 저장/불러오기 후 localStorage 변경을 반영 */
  const [savedTargetsBump, setSavedTargetsBump] = useState(0);

  useEffect(() => {
    setMergeTargetsReady(true);
  }, []);

  useEffect(() => {
    const onRefresh = () => setSavedTargetsBump((n) => n + 1);
    window.addEventListener("portfolio-target-weights-refresh", onRefresh);
    return () => window.removeEventListener("portfolio-target-weights-refresh", onRefresh);
  }, []);

  useEffect(() => {
    if (!allocationByOwner.find((o) => o.ownerName === selectedOwner)) {
      setSelectedOwner(allocationByOwner[0]?.ownerName ?? "");
    }
  }, [allocationByOwner, selectedOwner]);

  const ownerData = useMemo(() => {
    return allocationByOwner.map(({ ownerName, data, total }) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);

      const repMap = new Map<string, { symbol: string; name: string; priceKrw: number }>();
      for (const p of items) {
        const gk = p.chartGroup?.trim() || p.symbol;
        if (!repMap.has(gk) && p.currentPrice > 0) {
          const priceKrw =
            p.currency === "USD" ? p.currentPrice * usdKrw : p.currentPrice;
          repMap.set(gk, { symbol: p.symbol, name: p.name, priceKrw });
        }
      }

      let groups: GroupAllocation[] = data.map((d) => {
        const rep = repMap.get(d.ticker);
        const members = items
          .filter((p) => (p.chartGroup?.trim() || p.symbol) === d.ticker)
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
        groups = mergeSavedTargetGroupsWithoutHoldings(ownerName, groups);
      }

      return { ownerName, groups, totalKrw: total };
    });
  }, [allocationByOwner, enrichedPositions, usdKrw, mergeTargetsReady, savedTargetsBump]);

  const current = ownerData.find((o) => o.ownerName === selectedOwner);

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
              selectedOwner === ownerName
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
        />
      ) : (
        <p className="text-sm text-muted-foreground">보유 종목이 없습니다.</p>
      )}
    </div>
  );
}
