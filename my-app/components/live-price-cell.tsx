"use client";

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
  currency: "USD" | "KRW";
  price: number;
  previousClose: number | null;
  /** USD 종목일 때 원화 환산 한 줄 (선택) */
  krwLine?: string;
}) {
  const hasDay = previousClose != null && previousClose > 0;
  const change = hasDay ? price - previousClose! : null;
  const changePct = hasDay && change != null ? (change / previousClose!) * 100 : null;
  const up = change != null && change >= 0;

  const fmt = (n: number) =>
    currency === "USD"
      ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
      : Math.round(n).toLocaleString();

  const pillClass = !hasDay
    ? "bg-muted text-foreground"
    : up
      ? `${UP_BG} text-white shadow-[0_1px_3px_rgba(239,83,80,0.45)]`
      : `${DOWN_BG} text-white shadow-[0_1px_3px_rgba(0,191,165,0.4)]`;

  const subClass = !hasDay ? "text-muted-foreground" : up ? UP_TEXT : DOWN_TEXT;

  return (
    <div className="flex w-full min-w-[6.5rem] flex-col items-end gap-0.5">
      <div
        className={`w-full max-w-[9rem] rounded-xl px-3 py-2 text-center text-[15px] font-semibold leading-none tracking-tight text-white tabular-nums ${pillClass}`}
      >
        {fmt(price)}
      </div>
      {change != null && changePct != null ? (
        <p className={`text-[11px] font-semibold tabular-nums ${subClass}`}>
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
