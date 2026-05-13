export type SplitAmountMode = "remainder" | "milestone";

/** {@link perSplitKrwCore} 선택 인자 */
export type PerSplitKrwOptions = {
  /**
   * `milestone`·매수일 때 목표 평가액의 몇 번째 구간까지 맞출지 (1…n, 기본 1).
   * 목표평가 × (k/n) 까지 이번 회 금액으로 맞추며, 전체 차액으로 클램프.
   */
  milestoneStep?: number;
};

/**
 * 총 평가액(denominator)을 그대로 둘 때, 이번 분할 금액만 반영한 뒤의 **해당 줄 비중**(≈).
 * (평가 + 분할금) / 포트폴리오 총액. 현금 매도·증자 등은 포함하지 않는 단순 근사값.
 */
export function approxPortfolioPctAfterDelta(
  holdingValueKrw: number,
  deltaKrwSigned: number,
  portfolioTotalDenominatorKrw: number,
): number | null {
  if (!(portfolioTotalDenominatorKrw > 0)) return null;
  const v = (holdingValueKrw + deltaKrwSigned) / portfolioTotalDenominatorKrw;
  if (!Number.isFinite(v)) return null;
  return v * 100;
}

/**
 * 분할·리밸 시 1회분 금액.
 * - remainder: 남은 매수액 diffKrw ÷ n.
 * - milestone (매수, diffKrw 양수, n≥2): 목표 평가의 **k/n** 지점까지 이번 회에 맞춤
 *   (= 목표평가×k/n − 현재평가, 0~(전체 차액)으로 클램프). k 기본 1.
 * - 매도(diffKrw≤0)·n===1 일 때 milestone도 remainder와 동일하게 diff/n(또는 전액).
 */
export function perSplitKrwCore(
  mode: SplitAmountMode,
  splitCount: number,
  row: { diffKrw: number; targetPct: number; valueKrw: number },
  effectiveTotalKrw: number,
  options?: PerSplitKrwOptions,
): number {
  const n = Math.max(1, Math.floor(splitCount) || 1);
  const kRaw = Math.floor(Number(options?.milestoneStep));
  const k = Number.isFinite(kRaw) && kRaw >= 1 ? Math.min(n, kRaw) : 1;

  if (n <= 1) return row.diffKrw;
  if (mode === "remainder") {
    return row.diffKrw / n;
  }
  if (row.diffKrw > 0 && effectiveTotalKrw > 0) {
    const fullTargetKrw = (row.targetPct / 100) * effectiveTotalKrw;
    const milestoneKrw = fullTargetKrw * (k / n);
    const raw = milestoneKrw - row.valueKrw;
    return Math.min(Math.max(0, raw), row.diffKrw);
  }
  return row.diffKrw / n;
}
