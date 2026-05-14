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

/**
 * 양수 예산 `total`을 가중치 `weights` 비율로 나누되, 각 i는 `caps[i]`를 넘지 않음.
 * 한 종목이 캡에 도달하면 남은 예산을 **아직 여유가 있는 종목들**에게 동일 비율(재정규화)로 돌려줌.
 */
export function proportionalAllocateWithCaps(
  total: number,
  weights: number[],
  caps: number[],
): number[] {
  const EPS = 1e-6;
  const n = weights.length;
  if (n === 0 || !(total > EPS) || caps.length !== n) return new Array(Math.max(n, 0)).fill(0);
  const out = new Array(n).fill(0);
  let remCap = caps.map((c) => Math.max(0, c));
  let budget = total;

  while (budget > EPS) {
    const activeIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (remCap[i] > EPS && weights[i] > EPS) activeIdx.push(i);
    }
    if (activeIdx.length === 0) break;
    const wsum = activeIdx.reduce((s, i) => s + weights[i], 0);
    if (wsum < EPS) break;

    let distributed = 0;
    let hitCap = false;
    for (const i of activeIdx) {
      const ideal = budget * (weights[i] / wsum);
      const take = Math.min(remCap[i], ideal);
      if (take + EPS < ideal) hitCap = true;
      out[i] += take;
      remCap[i] -= take;
      distributed += take;
    }
    budget -= distributed;
    if (!hitCap) break;
    if (distributed < EPS) break;
  }
  return out;
}
