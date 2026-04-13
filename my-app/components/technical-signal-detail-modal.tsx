"use client";

import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { buildSignalAnalysis } from "@/lib/signals/signal-analysis";
import type { DailyPrice } from "@/lib/signals";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  symbol: string;
  name: string;
  prices: DailyPrice[];
};

function sigColor(s: string): string {
  if (s === "BUY") return "text-red-500";
  if (s === "SELL") return "text-blue-500";
  return "text-muted-foreground";
}

function SignalBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted/80 px-2 py-0.5 text-[11px] font-medium">
      <span className="text-muted-foreground">{label}</span>
      <span className={sigColor(value)}>{value}</span>
    </span>
  );
}

export function TechnicalSignalDetailModal({ open, onClose, symbol, name, prices }: Props) {
  const analysis = useMemo(() => buildSignalAnalysis(prices), [prices]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="signal-detail-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label="닫기"
      />
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div>
            <h2 id="signal-detail-title" className="text-base font-semibold leading-tight">
              기술적 시그널 근거
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {name}{" "}
              <span className="font-mono text-xs text-foreground/90">{symbol}</span>
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              일봉은 Yahoo 6개월 구간 기준이며, 지표는 앱 내부 규칙(이동평균·RSI·볼린저·거래량)과 동일합니다.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            닫기
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {!analysis || prices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              일봉 데이터가 없습니다. 잠시 후 다시 시도하거나 티커를 확인해 주세요.
            </p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">종합</span>
                <span className={`text-lg font-bold ${sigColor(analysis.final)}`}>{analysis.final}</span>
                <span className="text-xs text-muted-foreground">
                  (BUY {analysis.buyVotes} · SELL {analysis.sellVotes})
                </span>
              </div>
              <p className="mb-4 text-sm leading-relaxed text-foreground/90">{analysis.finalSummary}</p>

              <div className="mb-4 flex flex-wrap gap-2">
                <SignalBadge label="MA" value={analysis.ma} />
                <SignalBadge label="RSI" value={analysis.rsi} />
                <SignalBadge label="BB" value={analysis.bb} />
                <SignalBadge label="VOL" value={analysis.vol} />
              </div>

              <section className="mb-6 space-y-4">
                <h3 className="text-sm font-semibold">종가 · 이동평균 · 볼린저</h3>
                <div className="h-64 w-full sm:h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={analysis.chartPoints}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis
                        domain={["auto", "auto"]}
                        tick={{ fontSize: 10 }}
                        width={52}
                        tickFormatter={(v) => (typeof v === "number" ? v.toFixed(0) : String(v))}
                      />
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="close" name="종가" dot={false} strokeWidth={2} stroke="#e2e8f0" />
                      <Line type="monotone" dataKey="sma20" name="20일" dot={false} stroke="#38bdf8" strokeWidth={1.2} connectNulls />
                      <Line type="monotone" dataKey="sma60" name="60일" dot={false} stroke="#a78bfa" strokeWidth={1.2} connectNulls />
                      <Line type="monotone" dataKey="bbUpper" name="BB상단" dot={false} stroke="#64748b" strokeDasharray="4 3" strokeWidth={1} connectNulls />
                      <Line type="monotone" dataKey="bbLower" name="BB하단" dot={false} stroke="#64748b" strokeDasharray="4 3" strokeWidth={1} connectNulls />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="mb-6 space-y-4">
                <h3 className="text-sm font-semibold">RSI(14)</h3>
                <div className="h-40 w-full sm:h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={analysis.chartPoints}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} width={36} />
                      <ReferenceLine y={30} stroke="#64748b" strokeDasharray="3 3" />
                      <ReferenceLine y={70} stroke="#64748b" strokeDasharray="3 3" />
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="rsi" name="RSI" dot={false} stroke="#fbbf24" strokeWidth={1.5} connectNulls />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="mb-6 space-y-4">
                <h3 className="text-sm font-semibold">거래량 vs 20일 평균(전일까지)</h3>
                <div className="h-40 w-full sm:h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={analysis.chartPoints}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} width={48} tickFormatter={(v) => String(v)} />
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="volume" name="거래량" fill="rgba(148,163,184,0.45)" />
                      <Line type="monotone" dataKey="volAvg" name="20일평균" dot={false} stroke="#22c55e" strokeWidth={1.2} connectNulls />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <ExplainBlock title={analysis.maExplain.title} signal={analysis.maExplain.signal} summary={analysis.maExplain.summary} detail={analysis.maExplain.detail} />
              <ExplainBlock title={analysis.rsiExplain.title} signal={analysis.rsiExplain.signal} summary={analysis.rsiExplain.summary} detail={analysis.rsiExplain.detail} />
              <ExplainBlock title={analysis.bbExplain.title} signal={analysis.bbExplain.signal} summary={analysis.bbExplain.summary} detail={analysis.bbExplain.detail} />
              <ExplainBlock title={analysis.volExplain.title} signal={analysis.volExplain.signal} summary={analysis.volExplain.summary} detail={analysis.volExplain.detail} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ExplainBlock({
  title,
  signal,
  summary,
  detail,
}: {
  title: string;
  signal: string;
  summary: string;
  detail: string;
}) {
  return (
    <section className="mb-4 rounded-lg border border-border bg-muted/20 px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        <span className={`text-xs font-bold ${sigColor(signal)}`}>{signal}</span>
      </div>
      <p className="mt-1 text-sm text-foreground/95">{summary}</p>
      <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
        {detail}
      </pre>
    </section>
  );
}
