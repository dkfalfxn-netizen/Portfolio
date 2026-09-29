"use client";

import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { HoldingsAggTipRow, fmtHoldingsAggSharePct, fmtHoldingsAggTipPct } from "@/lib/portfolio-holdings-helpers";

/** 종목별 합산 표 — 네이티브 title 대신 DOM 오버레이(한글·₩ 깨짐 방지), 표 형식 툴팁 */
export function HoldingsAggRichTooltip({
  header,
  rows,
  pctHeader = "등락",
  showPctColumn = true,
  /** 보유자별 평가/손익: 금액 뒤에 행 합계 대비 지분(%)을 같은 칸에 표시 — 3열 대신 2열 */
  mergePctIntoName = false,
  codeMono = true,
  className,
  children,
}: {
  header: string;
  rows: HoldingsAggTipRow[];
  /** 보유자별 수익률 열일 때 열 제목 */
  pctHeader?: string;
  /** 보유자 목록 등 % 열이 의미 없을 때 숨김 */
  showPctColumn?: boolean;
  mergePctIntoName?: boolean;
  /** 첫 열을 티커용 고정폭(모노)으로 — 보유자 이름은 false */
  codeMono?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  if (rows.length === 0) {
    return <span className={className}>{children}</span>;
  }
  const hdr = header.trim();
  const twoColAmountPct = !showPctColumn && mergePctIntoName;
  return (
    <>
      <span
        className={className}
        onMouseEnter={(e) => {
          setOpen(true);
          setCoords({ x: e.clientX, y: e.clientY });
        }}
        onMouseMove={(e) => {
          if (open) setCoords({ x: e.clientX, y: e.clientY });
        }}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[300] w-[min(92vw,22rem)] rounded-lg border border-slate-600/90 bg-slate-950 px-3 py-2.5 text-left shadow-xl ring-1 ring-white/5"
            style={{ left: coords.x + 12, top: coords.y + 12 }}
          >
            {hdr.length > 0 ? (
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-100">
                {hdr}
              </p>
            ) : null}
            <table className="w-full border-separate border-spacing-y-1 text-[11px]">
              <thead>
                {twoColAmountPct ? (
                  <tr className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    <th className="pb-1 pr-2 text-left font-medium">보유자</th>
                    <th className="pb-1 px-1 text-right font-medium">금액</th>
                    <th className="w-[4.5rem] min-w-[4.5rem] pb-1 pl-1 text-right font-medium tabular-nums">
                      비중
                    </th>
                  </tr>
                ) : (
                  <tr className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    <th className="pb-1 pr-2 text-left font-medium">
                      {showPctColumn ? "코드" : "보유자"}
                    </th>
                    <th
                      className={cn(
                        "pb-1 text-left font-medium",
                        showPctColumn ? "px-1" : "pl-1",
                      )}
                    >
                      {showPctColumn ? "이름" : ""}
                    </th>
                    {showPctColumn ? (
                      <th className="pb-1 pl-2 text-right font-medium">{pctHeader}</th>
                    ) : null}
                  </tr>
                )}
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.code}-${i}`}>
                    <td
                      className={cn(
                        "max-w-[5.5rem] truncate pr-2 align-top text-slate-200",
                        codeMono && "font-mono",
                        !showPctColumn && "max-w-none",
                        !codeMono && "font-sans",
                      )}
                      title={!showPctColumn ? r.code : undefined}
                    >
                      {r.code}
                    </td>
                    {twoColAmountPct ? (
                      <>
                        <td className="max-w-[10rem] truncate px-1 text-right align-top tabular-nums text-slate-200">
                          {r.name}
                        </td>
                        <td className="w-[4.5rem] min-w-[4.5rem] truncate pl-1 text-right align-top tabular-nums font-medium text-slate-400">
                          {fmtHoldingsAggSharePct(r.pct)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td
                          className={cn(
                            "truncate align-top text-slate-300",
                            showPctColumn ? "max-w-[9rem] px-1" : "pl-1 text-slate-500",
                          )}
                          title={showPctColumn ? r.name : undefined}
                        >
                          {showPctColumn ? r.name || "—" : ""}
                        </td>
                        {showPctColumn ? (
                          <td
                            className={cn(
                              "pl-2 text-right tabular-nums align-top font-medium",
                              r.pct === null || !Number.isFinite(r.pct)
                                ? "text-slate-500"
                                : r.pct >= 0
                                  ? "text-rose-400"
                                  : "text-sky-400",
                            )}
                          >
                            {fmtHoldingsAggTipPct(r.pct)}
                          </td>
                        ) : null}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
          document.body,
        )}
    </>
  );
}
