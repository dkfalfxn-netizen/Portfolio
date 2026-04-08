"use client";

import { useMemo, useState } from "react";
import type { DailySnapshot } from "@/app/page";

type Props = {
  snapshots: DailySnapshot[];
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

  const byDate = useMemo(() => {
    const map = new Map<string, DailySnapshot>();
    for (const s of snapshots) map.set(s.date, s);
    return map;
  }, [snapshots]);

  const items = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const startWeekday = first.getDay(); // 0: 일
    const daysInMonth = last.getDate();
    const cells: Array<{
      date: Date;
      inMonth: boolean;
      key: string;
      changeKrw: number | null;
      changePct: number | null;
    }> = [];

    // 달력 시작(일요일 기준)으로 맞춤
    const begin = new Date(first);
    begin.setDate(first.getDate() - startWeekday);

    for (let i = 0; i < 42; i++) {
      const d = new Date(begin);
      d.setDate(begin.getDate() + i);
      const key = ymd(d);
      const cur = byDate.get(key);
      const prev = (() => {
        const p = new Date(d);
        p.setDate(d.getDate() - 1);
        return byDate.get(ymd(p));
      })();
      let changeKrw: number | null = null;
      let changePct: number | null = null;
      if (cur && prev && prev.totalValue > 0) {
        changeKrw = cur.totalValue - prev.totalValue;
        changePct = (changeKrw / prev.totalValue) * 100;
      }
      cells.push({
        date: d,
        inMonth: d.getMonth() === cursor.getMonth() && d.getFullYear() === cursor.getFullYear(),
        key,
        changeKrw,
        changePct,
      });
    }

    return { first, daysInMonth, cells };
  }, [cursor, byDate]);

  const hasAny = snapshots.length > 0;

  return (
    <div className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">일일 변동 달력</h3>
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
              return (
                <div
                  key={c.key}
                  className={`min-h-[72px] rounded border p-1.5 ${tone} ${c.inMonth ? "" : "opacity-40"}`}
                  title={
                    c.changeKrw == null
                      ? `${c.key} (기록 없음 또는 전일 비교 불가)`
                      : `${c.key} ${toKrw(c.changeKrw)} (${c.changePct?.toFixed(2)}%)`
                  }
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
                  ) : (
                    <p className="mt-2 text-[10px] text-muted-foreground/70">—</p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

