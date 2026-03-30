"use client";

/** 한국 시세 UI 관례: 상승 빨강, 하락 초록 */
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

  const pillBg = !hasDay
    ? "bg-muted text-foreground"
    : up
      ? "bg-red-600 text-white dark:bg-red-600"
      : "bg-emerald-600 text-white dark:bg-emerald-600";
  const subText = !hasDay
    ? "text-muted-foreground"
    : up
      ? "text-red-600 dark:text-red-500"
      : "text-emerald-600 dark:text-emerald-600";

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={`min-w-[5.5rem] rounded-full px-3 py-1.5 text-right font-bold tabular-nums shadow-sm ${pillBg}`}
      >
        {fmt(price)}
      </div>
      {change != null && changePct != null ? (
        <p className={`text-xs font-medium tabular-nums ${subText}`}>
          {up ? "+" : ""}
          {fmt(change)} · {up ? "+" : ""}
          {changePct.toFixed(2)}%
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">전일 종가 없음</p>
      )}
      {krwLine ? <p className="text-[10px] text-muted-foreground">원화 {krwLine}</p> : null}
    </div>
  );
}
