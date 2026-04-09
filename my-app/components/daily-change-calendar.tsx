"use client";

import { useMemo, useRef, useState } from "react";
import type { DailySnapshot } from "@/app/page";

type Props = {
  snapshots: DailySnapshot[];
};

type OwnerChange = {
  name: string;
  changeKrw: number;
  changePct: number;
};

type CellData = {
  date: Date;
  inMonth: boolean;
  key: string;
  changeKrw: number | null;
  changePct: number | null;
  ownerChanges: OwnerChange[];
  totalValue: number | null;
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toKrw(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "" : "±";
  return `${sign}${Math.round(n).toLocaleString()}원`;
}

export function DailyChangeCalendar({ snapshots }: Props) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
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
      const key = ymd(d);
      const cur = byDate.get(key);
      // 기록이 연속되지 않아도 직전 기록일과 비교해 달력에 변화량을 채웁니다.
      const prev = cur ? (prevSnapshotByDate.get(key) ?? null) : null;

      let changeKrw: number | null = null;
      let changePct: number | null = null;
      const ownerChanges: OwnerChange[] = [];

      if (cur && prev && prev.totalValue > 0) {
        changeKrw = cur.totalValue - prev.totalValue;
        changePct = (changeKrw / prev.totalValue) * 100;

        const allOwners = new Set([
          ...Object.keys(cur.ownerValues ?? {}),
          ...Object.keys(prev.ownerValues ?? {}),
        ]);
        for (const name of allOwners) {
          const curVal = cur.ownerValues?.[name] ?? 0;
          const prevVal = prev.ownerValues?.[name] ?? 0;
          if (prevVal > 0) {
            ownerChanges.push({
              name,
              changeKrw: curVal - prevVal,
              changePct: ((curVal - prevVal) / prevVal) * 100,
            });
          }
        }
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
      });
    }

    return { first, daysInMonth, cells };
  }, [cursor, byDate, prevSnapshotByDate]);

  const tooltipCell = tooltip ? items.cells.find((c) => c.key === tooltip.key) : null;

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
              const hasOwners = c.ownerChanges.length > 0;
              return (
                <div
                  key={c.key}
                  className={`min-h-[72px] rounded border p-1.5 ${tone} ${c.inMonth ? "" : "opacity-40"} ${hasOwners ? "cursor-pointer" : ""}`}
                  onMouseEnter={(e) => {
                    if (!hasOwners) return;
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
                  <p className="text-[10px] font-medium">{c.date.getDate()}</p>
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
                      ₩{Math.round(c.totalValue / 10000).toLocaleString()}만
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
      {tooltip && tooltipCell && tooltipCell.ownerChanges.length > 0 && (
        <div
          className="pointer-events-none absolute z-50 min-w-[160px] rounded-xl border bg-popover p-3 shadow-lg text-xs"
          style={{
            left: tooltip.x,
            top: tooltip.y - 8,
            transform: "translate(-50%, -100%)",
          }}
        >
          <p className="mb-2 font-semibold text-foreground">{tooltip.key} 변동 상세</p>
          <div className="space-y-1">
            {tooltipCell.ownerChanges.map((o) => (
              <div key={o.name} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{o.name}</span>
                <span className={`font-medium tabular-nums ${o.changeKrw > 0 ? "text-red-500" : o.changeKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                  {toKrw(o.changeKrw)}
                  <span className="ml-1 text-[10px]">({o.changeKrw > 0 ? "+" : ""}{o.changePct.toFixed(2)}%)</span>
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
        </div>
      )}
    </div>
  );
}

