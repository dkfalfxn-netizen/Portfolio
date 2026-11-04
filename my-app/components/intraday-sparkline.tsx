"use client";

/** 당일 가격 시계열(분봉 종가 등)을 미니 라인 차트로 표시합니다. 한국 시세 관례: 상승 빨강, 하락 파랑 */
export function IntradaySparkline({
  points,
  progress = 1,
  baseline,
}: {
  points: number[];
  /** 세션 진행률(0~1). 1 미만이면 선을 왼쪽 일부 폭에만 그림(장 초에는 짧게) */
  progress?: number;
  /** 전일 종가 — 있으면 전폭 점선 기준선을 그리고 선 색도 이 기준으로 결정 */
  baseline?: number;
}) {
  if (points.length < 2) {
    return (
      <span className="inline-block w-[72px] text-center text-[10px] text-muted-foreground">—</span>
    );
  }
  const hasBase = typeof baseline === "number" && baseline > 0;
  const min = Math.min(...points, ...(hasBase ? [baseline] : []));
  const max = Math.max(...points, ...(hasBase ? [baseline] : []));
  const frac = Math.min(1, Math.max(0.04, progress));
  const span = max - min || Math.abs(max) * 0.001 || 1;
  const pad = span * 0.05;
  const lo = min - pad;
  const hi = max + pad;
  const range = hi - lo;
  const w = 100;
  const h = 36;
  const pathD = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w * frac;
      const y = h - ((p - lo) / range) * h;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= (hasBase ? baseline : points[0]);
  const stroke = up ? "rgb(239 68 68)" : "rgb(59 130 246)";

  return (
    <svg
      width={72}
      height={28}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0 overflow-visible text-[0]"
      role="img"
      aria-label="당일 가격 흐름"
    >
      {hasBase ? (
        <line
          x1={0}
          x2={w}
          y1={h - ((baseline - lo) / range) * h}
          y2={h - ((baseline - lo) / range) * h}
          stroke="currentColor"
          className="text-muted-foreground/50"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        d={pathD}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
