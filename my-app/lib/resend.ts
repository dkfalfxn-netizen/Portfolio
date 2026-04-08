import { Resend } from "resend";

const resendClient = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

export type AlertViolation = {
  owner: string;
  symbol: string;
  currentPct: number;
  minPct?: number;
  maxPct?: number;
};

export type DailyOwnerSummary = {
  owner: string;
  totalKrw: number;
  stockKrw: number;
  cashKrw: number;
};

export type DailyRatioRow = {
  owner: string;
  symbol: string;
  ratioPct: number;
  valueKrw: number;
};

export async function sendAlertEmail(
  to: string,
  violations: AlertViolation[],
): Promise<{ ok: boolean; error?: string }> {
  if (!resendClient) {
    return { ok: false, error: "RESEND_API_KEY가 설정되지 않았습니다." };
  }

  const rows = violations
    .map((v) => {
      const direction =
        v.maxPct !== undefined && v.currentPct > v.maxPct
          ? `상한(${v.maxPct}%) 초과 → 현재 ${v.currentPct.toFixed(1)}%`
          : `하한(${v.minPct}%) 미달 → 현재 ${v.currentPct.toFixed(1)}%`;
      return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${v.owner}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${v.symbol}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee">${direction}</td>
      </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#111">포트폴리오 비중 이탈 알림</h2>
      <p style="color:#555">설정한 비중 기준을 벗어난 종목이 있습니다.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:8px 12px;text-align:left">담당자</th>
            <th style="padding:8px 12px;text-align:left">종목</th>
            <th style="padding:8px 12px;text-align:left">상태</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:24px;color:#888;font-size:12px">
        이 메일은 가족 포트폴리오 대시보드에서 자동 발송됩니다.
      </p>
    </div>
  `;

  try {
    const { error } = await resendClient.emails.send({
      from: "Portfolio Alert <onboarding@resend.dev>",
      to,
      subject: `[포트폴리오] 비중 이탈 알림 — ${violations.length}건`,
      html,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function sendDailySummaryEmail(
  to: string,
  payload: {
    dateKst: string;
    totalKrw: number;
    ownerSummaries: DailyOwnerSummary[];
    topRatios: DailyRatioRow[];
    violationsCount: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  if (!resendClient) {
    return { ok: false, error: "RESEND_API_KEY가 설정되지 않았습니다." };
  }

  const ownerRows = payload.ownerSummaries
    .map(
      (o) => `<tr>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${o.owner}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">₩${Math.round(o.totalKrw).toLocaleString()}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">₩${Math.round(o.stockKrw).toLocaleString()}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">₩${Math.round(o.cashKrw).toLocaleString()}</td>
</tr>`,
    )
    .join("");

  const ratioRows = payload.topRatios
    .map(
      (r) => `<tr>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.owner}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.symbol}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${r.ratioPct.toFixed(2)}%</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">₩${Math.round(r.valueKrw).toLocaleString()}</td>
</tr>`,
    )
    .join("");

  const html = `
<div style="font-family:sans-serif;max-width:760px;margin:0 auto">
  <h2 style="color:#111">포트폴리오 데일리 요약 리포트</h2>
  <p style="color:#555">${payload.dateKst} 기준 자동 리포트입니다.</p>
  <p style="color:#222"><b>총 자산:</b> ₩${Math.round(payload.totalKrw).toLocaleString()}</p>
  <p style="color:#222"><b>비중 이탈 건수:</b> ${payload.violationsCount}건</p>

  <h3 style="margin-top:18px">보유자별 현황</h3>
  <table style="width:100%;border-collapse:collapse;margin-top:8px">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:8px 10px;text-align:left">보유자</th>
        <th style="padding:8px 10px;text-align:right">총 평가</th>
        <th style="padding:8px 10px;text-align:right">주식</th>
        <th style="padding:8px 10px;text-align:right">현금</th>
      </tr>
    </thead>
    <tbody>${ownerRows || '<tr><td colspan="4" style="padding:8px 10px;color:#666">데이터 없음</td></tr>'}</tbody>
  </table>

  <h3 style="margin-top:18px">비중 상위 종목 (보유자별)</h3>
  <table style="width:100%;border-collapse:collapse;margin-top:8px">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:8px 10px;text-align:left">보유자</th>
        <th style="padding:8px 10px;text-align:left">종목</th>
        <th style="padding:8px 10px;text-align:right">비중</th>
        <th style="padding:8px 10px;text-align:right">평가금액</th>
      </tr>
    </thead>
    <tbody>${ratioRows || '<tr><td colspan="4" style="padding:8px 10px;color:#666">데이터 없음</td></tr>'}</tbody>
  </table>

  <p style="margin-top:20px;color:#888;font-size:12px">
    이 메일은 가족 포트폴리오 대시보드의 매일 오전 9시 자동 작업으로 발송됩니다.
  </p>
</div>`;

  try {
    const { error } = await resendClient.emails.send({
      from: "Portfolio Daily <onboarding@resend.dev>",
      to,
      subject: `[포트폴리오] 데일리 요약 ${payload.dateKst}`,
      html,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
