"use client";

import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { krSettlementTargetUnixSec } from "@/lib/trading-calendar";
import { BuyJournalEntry, Position } from "@/lib/portfolio-types";

export type FxTooltipRow = { label: string; value: string; tag?: string };
export type FxTooltipData = { ticker: string; name?: string; rows: FxTooltipRow[]; note?: string };

/** 매입환율 셀 hover 툴팁 데이터: 매수일·정산일·정산환율 내역 (USD만). 매수일은 포지션 또는 매수저널에서 찾음 */
export function purchaseFxTooltipData(
  p: Position,
  currentUsdKrw: number,
  journal: BuyJournalEntry[] = [],
): FxTooltipData | undefined {
  if (p.currency !== "USD") return undefined;
  const pdate = typeof p.purchaseDate === "string" ? p.purchaseDate.trim() : "";
  const jEntry = journal.find(
    (b) => b.owner === p.owner && b.symbol === p.symbol && b.currency === "USD",
  );
  const jdate = jEntry?.date ?? "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(pdate)
    ? pdate
    : /^\d{4}-\d{2}-\d{2}$/.test(jdate)
      ? jdate
      : "";
  if (!d) return undefined;
  const mdd = (ymd: string) => {
    const parts = ymd.split("-");
    return `${Number(parts[1])}/${Number(parts[2])}`;
  };
  const r = (n: number | undefined | null) =>
    typeof n === "number" && Number.isFinite(n) ? `${Math.round(n).toLocaleString("ko-KR")} ₩/$` : null;
  const name = (jEntry?.name || p.name || "").trim() || undefined;
  const applied = r(p.purchaseUsdKrw);

  if (p.purchaseFxPending) {
    const est = applied ?? r(currentUsdKrw) ?? "—";
    return {
      ticker: p.symbol,
      name,
      rows: [{ label: `매수 ${mdd(d)}`, value: est }],
      note: "정산 전 · 현재환율 추정",
    };
  }
  const targetSec = krSettlementTargetUnixSec(d, 2, 9);
  const settleYmd =
    targetSec !== null
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(targetSec * 1000))
      : null;
  const addRate = r(p.purchaseFxAtAdd);
  const rows: FxTooltipRow[] = [];
  if (addRate) rows.push({ label: `추가 ${mdd(d)}`, value: addRate });
  if (applied) {
    rows.push(
      addRate && settleYmd
        ? { label: `정산 ${mdd(settleYmd)}`, value: applied, tag: "적용" }
        : { label: `매수 ${mdd(d)}`, value: applied },
    );
  }
  if (rows.length === 0) return undefined;
  return { ticker: p.symbol, name, rows };
}

/** 매입환율 셀: hover 시 「오늘 수익 요약」과 같은 양식의 팝업(헤더+행) 표시 */
export function PurchaseFxCell({
  position,
  currentUsdKrw,
  journal,
  children,
}: {
  position: Position;
  currentUsdKrw: number;
  journal: BuyJournalEntry[];
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const data = purchaseFxTooltipData(position, currentUsdKrw, journal);
  if (!data) return <>{children}</>;
  return (
    <>
      <span
        className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2"
        onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setPos(null)}
      >
        {children}
      </span>
      {pos !== null &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] rounded-lg border border-white/[0.12] bg-[#1a1f2e] shadow-2xl"
            style={{ left: pos.x + 14, top: pos.y - 6 }}
          >
            <div className="flex items-baseline gap-2 border-b border-white/[0.1] px-3 py-2">
              <span className="text-[13px] font-bold text-zinc-100">{data.ticker}</span>
              {data.name ? <span className="text-[12px] text-zinc-400">{data.name}</span> : null}
            </div>
            <div className="space-y-1 px-3 py-2">
              {data.rows.map((row, i) => (
                <div key={i} className="flex items-center gap-4 text-[12px]">
                  <span className="shrink-0 text-zinc-400">{row.label}</span>
                  <span className="flex-1 text-right tabular-nums font-medium text-zinc-100">
                    {row.value}
                  </span>
                  {row.tag ? <span className="shrink-0 text-[11px] text-emerald-400">{row.tag}</span> : null}
                </div>
              ))}
              {data.note ? <div className="pt-0.5 text-[11px] text-amber-400">{data.note}</div> : null}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
