"use client";

import { TelegramTestResult } from "@/lib/portfolio-types";

export type TelegramAlertSectionProps = {
  handleTelegramTest: (dryRun: boolean) => Promise<void>;
  telegramTestBusy: boolean;
  telegramTestResult: TelegramTestResult | null;
};

export function TelegramAlertSection({
  handleTelegramTest,
  telegramTestBusy,
  telegramTestResult,
}: TelegramAlertSectionProps) {
  return (
    <section id="section-telegram" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">📲 텔레그램 가격 변동 알림</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              크론 자동 발송은 <b>본인 동기화 키</b> 한 계정만 대상으로 하려면 Vercel에{" "}
              <code className="rounded bg-muted px-1">TELEGRAM_ALERT_SYNC_KEY</code>를 동기화 키와 동일하게 설정하세요.
              Supabase 포트폴리오·시세 기준 <b>총 평가·전일 대비 수익률·종목 등락</b> HTML 브리핑이{" "}
              <b>KST 09:30, 14:00, 24:00</b> (평일만, 주말 미발송) (<code className="rounded bg-muted px-1">vercel.json</code>{" "}
              <code className="rounded bg-muted px-1">slot</code>)에 발송됩니다. 관심종목 MA·RSI·BB·VOL 요약은 위에서 저장한
              목록을 이어서 보냅니다. 환경변수:{" "}
              <code className="rounded bg-muted px-1">TELEGRAM_BOT_TOKEN</code>,{" "}
              <code className="rounded bg-muted px-1">TELEGRAM_CHAT_ID</code>,{" "}
              <code className="rounded bg-muted px-1">CRON_SECRET</code>. 브리핑 슬롯 로그는{" "}
              <code className="rounded bg-muted px-1">price_move_alert_logs_briefing_slot.sql</code> 마이그레이션을
              적용했는지 확인하세요.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-md border px-4 py-2 text-sm transition-all duration-100 hover:bg-muted active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                disabled={telegramTestBusy}
                onClick={() => handleTelegramTest(true)}
              >
                {telegramTestBusy ? "점검 중…" : "🔍 진단 (전송 없음)"}
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-md border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm text-blue-600 transition-all duration-100 hover:bg-blue-500/20 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
                disabled={telegramTestBusy}
                onClick={() => handleTelegramTest(false)}
              >
                {telegramTestBusy ? "전송 중…" : "📨 테스트 전송 (실제 발송)"}
              </button>
            </div>
            {telegramTestResult && (
              <div className={`mt-3 rounded-lg border p-3 text-xs ${telegramTestResult.ok ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
                {!telegramTestResult.ok ? (
                  <div className="space-y-1">
                    <p className="font-semibold text-red-500">❌ {telegramTestResult.error}</p>
                    {telegramTestResult.detail && Object.entries(telegramTestResult.detail).map(([k, v]) => (
                      <p key={k}><span className="text-muted-foreground">{k}:</span> {v}</p>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="font-semibold text-green-600">✅ {telegramTestResult.message}</p>
                    {telegramTestResult.env && (
                      <div className="flex gap-4">
                        {Object.entries(telegramTestResult.env).map(([k, v]) => (
                          <p key={k}><span className="text-muted-foreground">{k}:</span> {v}</p>
                        ))}
                      </div>
                    )}
                    {telegramTestResult.alreadySentToday && telegramTestResult.alreadySentToday.length > 0 && (
                      <p className="text-muted-foreground">오늘 이미 발송됨: {telegramTestResult.alreadySentToday.join(", ")}</p>
                    )}
                    {telegramTestResult.symbols && telegramTestResult.symbols.length > 0 && (
                      <div>
                        <p className="mb-1 font-medium text-muted-foreground">종목별 현재 변동률:</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
                          {telegramTestResult.symbols.map((s) => (
                            <p key={s.symbol} className={s.willAlert ? "font-semibold text-red-500" : ""}>
                              {s.symbol}: {s.changePct != null ? `${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(2)}%` : "시세 없음"}
                              {s.willAlert ? " ⚠️" : ""}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                    {telegramTestResult.watchlistSignals && telegramTestResult.watchlistSignals.length > 0 && (
                      <div className="mt-2 border-t pt-2">
                        <p className="mb-1 font-medium text-muted-foreground">관심종목 시그널 (진단):</p>
                        <ul className="space-y-1 text-[11px]">
                          {(telegramTestResult.watchlistSignals as Array<{
                            symbol: string;
                            name: string;
                            ma: string;
                            rsi: string;
                            bb: string;
                            vol: string;
                            overall: string;
                            summaryKo: string;
                          }>).map((w) => (
                            <li key={w.symbol}>
                              <span className="font-medium">{w.name}</span> ({w.symbol}) — {w.overall} · MA:{w.ma} RSI:{w.rsi} BB:{w.bb} VOL:{w.vol} — {w.summaryKo}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
  );
}
