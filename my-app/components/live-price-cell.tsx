"use client";

import { fmtInt, fmtUsdNumber } from "@/lib/format-money";

/** 한국 시세 앱 스타일: 상승 빨강(#ef5350 계열), 하락 청록(#00bfa5 계열) */
const UP_BG = "bg-[#ef5350]";
const DOWN_BG = "bg-[#00bfa5]";
const UP_TEXT = "text-[#ef5350]";
const DOWN_TEXT = "text-[#00bfa5]";

export function LivePriceCell({
  currency,
  price,
  previousClose,
  krwLine,
}: {
  currency: "USD" | "EUR" | "KRW";
  price: number;
  previousClose: number | null;
  /** USD/EUR 종목일 때 원화 환산 한 줄 (선택) */
  krwLine?: string;
}) {
  const hasDay = previousClose != null && previousClose > 0;
  const change = hasDay ? price - previousClose! : null;
  const changePct = hasDay && change != null ? (change / previousClose!) * 100 : null;
  const up = change != null && change >= 0;

  const fmt = (n: number) =>
    currency === "USD" || currency === "EUR"
      ? fmtUsdNumber(n, 2, 4)
      : fmtInt(Math.round(n));

  const pillClass = !hasDay
    ? "bg-muted text-foreground"
    : up
      ? `${UP_BG} text-white shadow-[0_1px_3px_rgba(239,83,80,0.45)]`
      : `${DOWN_BG} text-white shadow-[0_1px_3px_rgba(0,191,165,0.4)]`;

  const subClass = !hasDay ? "text-muted-foreground" : up ? UP_TEXT : DOWN_TEXT;

  return (
    <div className="ml-auto flex w-fit min-w-0 flex-col items-end gap-1">
      <div
        className={`w-fit min-w-0 rounded-xl px-2 py-1.5 text-center text-[16px] font-semibold leading-none tracking-tight text-white tabular-nums ${pillClass}`}
      >
        {fmt(price)}
      </div>
      {change != null && changePct != null ? (
        <p className={`text-[15px] font-bold leading-tight tabular-nums ${subClass}`}>
          {up ? "+" : ""}
          {fmt(change)} · {up ? "+" : ""}
          {changePct.toFixed(2)}%
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">전일 종가 없음</p>
      )}
      {krwLine ? (
        <p className="text-[10px] leading-tight text-muted-foreground">원화 {krwLine}</p>
      ) : null}
    </div>
  );
}
