"use client";

/** 당일 가격 시계열(분봉 종가 등)을 미니 라인 차트로 표시합니다. 한국 시세 관례: 상승 빨강, 하락 파랑 */
export function IntradaySparkline({ points }: { points: number[] }) {
  if (points.length < 2) {
    return (
      <span className="inline-block w-[72px] text-center text-[10px] text-muted-foreground">—</span>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || Math.abs(max) * 0.001 || 1;
  const pad = span * 0.05;
  const lo = min - pad;
  const hi = max + pad;
  const range = hi - lo;
  const w = 100;
  const h = 36;
  const pathD = points
    .map((p, i) => {
      const x = points.length === 1 ? w / 2 : (i / (points.length - 1)) * w;
      const y = h - ((p - lo) / range) * h;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
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
