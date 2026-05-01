"use client";

import { useMemo, useRef, useState } from "react";
import type { DailySnapshot } from "@/app/page";
import { ymdKST } from "@/lib/date-utils";
import { fmtInt } from "@/lib/format-money";

type LiveChange = {
  date: string;
  changeKrw: number;
  changePct: number | null;
  ownerChanges: OwnerChange[];
  compareNote?: string;
};

type Props = {
  snapshots: DailySnapshot[];
  liveChangeByDate?: Record<string, LiveChange>;
};

type OwnerChange = {
  name: string;
  changeKrw: number;
  changePct: number | null;
};

type CellData = {
  date: Date;
  inMonth: boolean;
  key: string;
  changeKrw: number | null;
  changePct: number | null;
  ownerChanges: OwnerChange[];
  totalValue: number | null;
  compareNote: string | null;
};

/** YYYY-MM-DD 두 달력값의 일수 차 (타임존·서머타임과 무관하게 날짜만 비교, 스냅샷 문자열용) */
function diffCalendarDays(a: string, b: string): number | null {
  const pa = a.split("-");
  const pb = b.split("-");
  if (pa.length !== 3 || pb.length !== 3) return null;
  const ya = Number(pa[0]);
  const ma = Number(pa[1]);
  const da = Number(pa[2]);
  const yb = Number(pb[0]);
  const mb = Number(pb[1]);
  const db = Number(pb[2]);
  if (![ya, ma, da, yb, mb, db].every(Number.isFinite)) return null;
  const tA = Date.UTC(ya, ma - 1, da);
  const tB = Date.UTC(yb, mb - 1, db);
  return Math.round((tA - tB) / 86_400_000);
}

/** 스냅샷 총변동과 자산단위 합계를 맞추기 위한 허용 오차(원) — 반올림·부동소수 누적 */
const DELTA_MATCH_EPS = 2;

function sumChangeKrw(rows: OwnerChange[]): number {
  return rows.reduce((s, r) => s + r.changeKrw, 0);
}

/** ownerValues만으로 보유자 순위 변동 줄 (breakdown 불일치 시 합계 일치용) */
function ownerValuesDeltaRows(cur: DailySnapshot, prev: DailySnapshot): OwnerChange[] {
  const names = new Set([
    ...Object.keys(cur.ownerValues ?? {}),
    ...Object.keys(prev.ownerValues ?? {}),
  ]);
  const rows: OwnerChange[] = [];
  for (const name of names) {
    const c = cur.ownerValues?.[name] ?? 0;
    const p = prev.ownerValues?.[name] ?? 0;
    const changeKrw = c - p;
    if (changeKrw === 0) continue;
    rows.push({
      name,
      changeKrw,
      changePct: p > 0 ? (changeKrw / p) * 100 : null,
    });
  }
  rows.sort((x, y) => Math.abs(y.changeKrw) - Math.abs(x.changeKrw));
  return rows;
}

/**
 * breakdown 행 합이 당일 총 변동액과 맞지 않으면(그룹키 불일치 등) 보유자만 집계로 대체
 */
function reconcileOwnerChangeRows(
  cur: DailySnapshot,
  prev: DailySnapshot,
  expectedTotalDelta: number,
): OwnerChange[] {
  const fromBreakdown = buildChangeRows(cur, prev);
  if (
    fromBreakdown.length > 0 &&
    Math.abs(sumChangeKrw(fromBreakdown) - expectedTotalDelta) <= DELTA_MATCH_EPS
  ) {
    return fromBreakdown;
  }
  const fromOwners = ownerValuesDeltaRows(cur, prev);
  if (fromOwners.length === 0) return fromBreakdown;
  // 보유자 단위 합계가 총액과 더 맞으면 이쪽 사용, 아니면 breakdown 유지(해석은 어긋날 수 있음)
  const ownSum = sumChangeKrw(fromOwners);
  if (
    Math.abs(ownSum - expectedTotalDelta) <= DELTA_MATCH_EPS ||
    Math.abs(ownSum - expectedTotalDelta) < Math.abs(sumChangeKrw(fromBreakdown) - expectedTotalDelta)
  ) {
    return fromOwners;
  }
  return fromBreakdown;
}

function toKrw(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "" : "±";
  return `${sign}${fmtInt(n)}원`;
}

function getOwnerFromBreakdownKey(name: string): string {
  const idx = name.indexOf(" · ");
  return idx > 0 ? name.slice(0, idx) : name;
}

function buildChangeRows(cur: DailySnapshot, prev: DailySnapshot): OwnerChange[] {
  const currentBreakdown = cur.breakdownValues;
  const previousBreakdown = prev.breakdownValues;

  // 신규 상세 필드가 있으면 자산(그룹) 단위로, 없으면 기존 owner 단위로 fallback
  const curMap = currentBreakdown && previousBreakdown ? currentBreakdown : (cur.ownerValues ?? {});
  const prevMap = currentBreakdown && previousBreakdown ? previousBreakdown : (prev.ownerValues ?? {});

  const allKeys = new Set([...Object.keys(curMap), ...Object.keys(prevMap)]);
  const rows: OwnerChange[] = [];

  for (const name of allKeys) {
    const curVal = curMap[name] ?? 0;
    const prevVal = prevMap[name] ?? 0;
    const changeKrw = curVal - prevVal;
    if (changeKrw === 0) continue;
    const ownerName = getOwnerFromBreakdownKey(name);
    const ownerPrevTotal = prev.ownerValues?.[ownerName] ?? 0;

    rows.push({
      name,
      changeKrw,
      // 자산군 자체 비중 변화(리밸런싱)로 퍼센트가 과장되지 않도록
      // 소유자 전일 총액 대비 변화율로 표시합니다.
      changePct: ownerPrevTotal > 0 ? (changeKrw / ownerPrevTotal) * 100 : null,
    });
  }

  rows.sort((a, b) => Math.abs(b.changeKrw) - Math.abs(a.changeKrw));
  return rows;
}

function aggregateOwnerTotals(rows: OwnerChange[]): OwnerChange[] {
  // changePct 는 두 경로 모두 "소유자 전일 총액" 분모 기준이므로 합산이 수학적으로 정확
  // (스냅샷 경로: buildChangeRows에서 ownerPrevTotal을 분모로 통일
  //  라이브 경로: dailyLiveChangeByDate에서 ownerPrevKrw를 분모로 통일)
  const map = new Map<string, { changeKrw: number; changePct: number | null }>();
  for (const row of rows) {
    const owner = getOwnerFromBreakdownKey(row.name);
    const existing = map.get(owner);
    if (!existing) {
      map.set(owner, { changeKrw: row.changeKrw, changePct: row.changePct });
      continue;
    }
    existing.changeKrw += row.changeKrw;
    // 분모가 동일한 값으로 통일되어 있으므로 합산이 올바른 가중 평균과 동일
    if (row.changePct !== null) {
      existing.changePct = (existing.changePct ?? 0) + row.changePct;
    }
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, changeKrw: v.changeKrw, changePct: v.changePct }))
    .filter((x) => x.changeKrw !== 0)
    .sort((a, b) => Math.abs(b.changeKrw) - Math.abs(a.changeKrw));
}

export function DailyChangeCalendar({ snapshots, liveChangeByDate }: Props) {
  const [cursor, setCursor] = useState(() => {
    // KST 기준 연·월로 초기화 (브라우저 TZ와 무관하게 달력이 KST 월을 표시)
    const kst = ymdKST(new Date()); // "YYYY-MM-DD"
    const [y, m] = kst.split("-").map(Number);
    return new Date(y, m - 1, 1);
  });
  const [tooltip, setTooltip] = useState<{ key: string; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const byDate = useMemo(() => {
    const map = new Map<string, DailySnapshot>();
    for (const s of snapshots) map.set(s.date, s);
    return map;
  }, [snapshots]);
  const prevSnapshotByDate = useMemo(() => {
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const map = new Map<string, DailySnapshot | null>();
    let prev: DailySnapshot | null = null;
    for (const s of sorted) {
      map.set(s.date, prev);
      prev = s;
    }
    return map;
  }, [snapshots]);

  const items = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const startWeekday = first.getDay();
    const daysInMonth = last.getDate();
    const cells: CellData[] = [];

    const begin = new Date(first);
    begin.setDate(first.getDate() - startWeekday);

    for (let i = 0; i < 42; i++) {
      const d = new Date(begin);
      d.setDate(begin.getDate() + i);
      const key = ymdKST(d);
      const cur = byDate.get(key);
      /* 직전 스냅샷과 달력 날짜가 정확히 하루 차이일 때만 변동액 표시(그 사이 날짜가 비면 생략). 셀 키는 KST로 스냅샷 date와 동일 체계. */
      const prev = cur ? (prevSnapshotByDate.get(key) ?? null) : null;

      let changeKrw: number | null = null;
      let changePct: number | null = null;
      const ownerChanges: OwnerChange[] = [];
      let compareNote: string | null = null;

      if (cur) {
        if (!prev) {
          compareNote = "전일 비교 불가(이전 기록 없음)";
        } else {
          const dayDiff = diffCalendarDays(cur.date, prev.date);
          if (dayDiff !== 1) {
            compareNote = "전일 비교 불가(기록 간격)";
          } else if (!(prev.totalValue > 0)) {
            compareNote = "전일 비교 불가(기준값 없음)";
          } else {
            changeKrw = cur.totalValue - prev.totalValue;
            changePct = (changeKrw / prev.totalValue) * 100;
            ownerChanges.push(...reconcileOwnerChangeRows(cur, prev, changeKrw));
          }
        }
      }
      const live = liveChangeByDate?.[key];
      if (live) {
        changeKrw = live.changeKrw;
        changePct = live.changePct;
        ownerChanges.splice(0, ownerChanges.length, ...live.ownerChanges);
        compareNote = live.compareNote ?? null;
      }

      cells.push({
        date: d,
        inMonth: d.getMonth() === cursor.getMonth() && d.getFullYear() === cursor.getFullYear(),
        key,
        changeKrw,
        changePct,
        ownerChanges,
        // prev 없이도 스냅샷이 있으면 총액을 노출
        totalValue: cur ? cur.totalValue : null,
        compareNote,
      });
    }

    return { first, daysInMonth, cells };
  }, [cursor, byDate, prevSnapshotByDate, liveChangeByDate]);

  const tooltipCell = tooltip ? items.cells.find((c) => c.key === tooltip.key) : null;
  const tooltipOwnerTotals = useMemo(
    () => (tooltipCell ? aggregateOwnerTotals(tooltipCell.ownerChanges) : []),
    [tooltipCell],
  );

  const tooltipOwnerSumMismatch = useMemo(() => {
    if (!tooltipCell || tooltipCell.changeKrw == null || tooltipOwnerTotals.length === 0) return false;
    const s = tooltipOwnerTotals.reduce((a, o) => a + o.changeKrw, 0);
    return Math.abs(s - tooltipCell.changeKrw) > DELTA_MATCH_EPS;
  }, [tooltipCell, tooltipOwnerTotals]);

  const hasAny = snapshots.length > 0;

  return (
    <div ref={containerRef} className="relative rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">일일 변동 달력</h3>
          {snapshots.length > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {snapshots.length}일치 기록
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            className="rounded border px-2 py-1 hover:bg-muted"
            onClick={() => setCursor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          >
            이전
          </button>
          <span className="px-1 font-medium">
            {cursor.getFullYear()}년 {cursor.getMonth() + 1}월
          </span>
          <button
            type="button"
            className="rounded border px-2 py-1 hover:bg-muted"
            onClick={() => setCursor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          >
            다음
          </button>
        </div>
      </div>

      {!hasAny ? (
        <p className="py-4 text-center text-xs text-muted-foreground">저장된 일별 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="mb-1 grid grid-cols-7 text-center text-[10px] text-muted-foreground">
            {["일", "월", "화", "수", "목", "금", "토"].map((w) => (
              <div key={w} className="py-1">{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {items.cells.map((c) => {
              const tone =
                c.changeKrw == null
                  ? "border-border/50 bg-background"
                  : c.changeKrw > 0
                    ? "border-red-500/30 bg-red-500/10"
                    : c.changeKrw < 0
                      ? "border-blue-500/30 bg-blue-500/10"
                      : "border-border/50 bg-background";
              const hasTooltip = c.totalValue !== null;
              return (
                <div
                  key={c.key}
                  className={`min-h-[72px] rounded border p-1.5 ${tone} ${c.inMonth ? "" : "opacity-40"} ${hasTooltip ? "cursor-pointer" : ""}`}
                  onMouseEnter={(e) => {
                    if (!hasTooltip) return;
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const containerRect = containerRef.current?.getBoundingClientRect();
                    if (!containerRect) return;
                    setTooltip({
                      key: c.key,
                      x: rect.left - containerRect.left + rect.width / 2,
                      y: rect.top - containerRect.top,
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <p className="text-[10px] font-medium">{parseInt(c.key.slice(8, 10), 10)}</p>
                  {c.changeKrw != null ? (
                    <>
                      <p className={`mt-1 text-[10px] font-semibold ${c.changeKrw > 0 ? "text-red-500" : c.changeKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                        {toKrw(c.changeKrw)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {c.changeKrw > 0 ? "+" : ""}{c.changePct?.toFixed(2)}%
                      </p>
                    </>
                  ) : c.totalValue != null && c.totalValue > 0 ? (
                    // 스냅샷은 있으나 비교할 전날 데이터가 없는 경우 → 총액 표시
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      ₩{fmtInt(Math.round(c.totalValue / 10000))}만
                    </p>
                  ) : (
                    <p className="mt-2 text-[10px] text-muted-foreground/70">—</p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* 툴팁 */}
      {tooltip && tooltipCell && (
        <div
          className="pointer-events-none absolute z-50 min-w-[160px] rounded-xl border bg-popover p-3 shadow-lg text-xs"
          style={{
            left: tooltip.x,
            top: tooltip.y - 8,
            transform: "translate(-50%, -100%)",
          }}
        >
          <p className="mb-2 font-semibold text-foreground">{tooltip.key} 변동 상세</p>
          {tooltipOwnerTotals.length > 0 ? (
            <>
              <div className="space-y-1">
                {tooltipOwnerTotals.map((o) => (
                  <div key={o.name} className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{o.name}</span>
                    <span className={`font-medium tabular-nums ${o.changeKrw > 0 ? "text-red-500" : o.changeKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                      {toKrw(o.changeKrw)}
                      <span className="ml-1 text-[10px]">
                        {o.changePct !== null
                          ? `(${o.changeKrw > 0 ? "+" : ""}${o.changePct.toFixed(2)}%)`
                          : "(신규/기준없음)"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 border-t pt-2 flex justify-between font-semibold">
                <span>합계</span>
                <span className={tooltipCell.changeKrw! > 0 ? "text-red-500" : tooltipCell.changeKrw! < 0 ? "text-blue-500" : "text-muted-foreground"}>
                  {toKrw(tooltipCell.changeKrw!)}
                </span>
              </div>
              {tooltipOwnerSumMismatch ? (
                <p className="mt-2 text-[10px] text-amber-600/90 dark:text-amber-500/90">
                  보유자별 합이 셀 총액과 불일치합니다. 스냅샷에 total과 owner 합이 어긋난 저장일 수 있습니다.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">
              {tooltipCell.compareNote ?? "전일 비교 불가"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

