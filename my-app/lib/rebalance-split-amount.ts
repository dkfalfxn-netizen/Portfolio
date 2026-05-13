export type SplitAmountMode = "remainder" | "milestone";

/**
 * 분할·리밸 시 1회분 금액.
 * - remainder: 남은 매수액 diffKrw ÷ n.
 * - milestone: 매수(diff>0)일 때 목표%·n 비중까지 채우는 1차 금액(이후 회차는 별개).
 */
export function perSplitKrwCore(
  mode: SplitAmountMode,
  splitCount: number,
  row: { diffKrw: number; targetPct: number; valueKrw: number },
  effectiveTotalKrw: number,
): number {
  const n = Math.max(1, Math.floor(splitCount) || 1);
  if (n <= 1) return row.diffKrw;
  if (mode === "remainder") {
    return row.diffKrw / n;
  }
  if (row.diffKrw > 0 && effectiveTotalKrw > 0) {
    const milestoneKrw = ((row.targetPct / 100) * effectiveTotalKrw) / n;
    const raw = milestoneKrw - row.valueKrw;
    return Math.min(Math.max(0, raw), row.diffKrw);
  }
  return row.diffKrw / n;
}
