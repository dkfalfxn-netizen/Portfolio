import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { todayKST } from "@/lib/date-utils";

export const maxDuration = 60;

const DEFAULT_KCIF_REPORT_LIST_URL = "https://www.kcif.or.kr/annual/reportList";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

type KcifReport = {
  title: string;
  date: string;
  author: string;
  reportUrl: string;
  pdfUrl: string | null;
  previewText: string;
};

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toAbsolute(baseUrl: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative;
  }
}


function extractMeta(html: string, reportUrl: string): KcifReport {
  const titleMatch = html.match(/<h\d[^>]*>\s*([^<]*?)\s*<\/h\d>/i);
  const strongTitleMatch = html.match(/<strong[^>]*>\s*([^<]+?)\s*<\/strong>/i);
  const title = normalizeWs(
    titleMatch?.[1] ?? strongTitleMatch?.[1] ?? "KCIF 보고서",
  );

  const dateMatch = html.match(/(\d{4}\.\d{2}\.\d{2}|\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1].replace(/\./g, "-") : "";

  const authorCandidate = html.match(/작성자[^<]*<\/[^>]+>\s*([^<\n]+)/i);
  const author = normalizeWs(authorCandidate?.[1] ?? "");

  const pdfHrefMatch = html.match(/href="([^"]+\.pdf[^"]*)"/i);
  const pdfUrl = pdfHrefMatch ? toAbsolute(reportUrl, pdfHrefMatch[1]) : null;

  const bullets = [...html.matchAll(/<b[^>]*>\s*[ㅁ■●▪-]?\s*([^<]{15,500})\s*<\/b>/gi)]
    .map((m) => normalizeWs(m[1]))
    .filter(Boolean)
    .slice(0, 5);

  const fallbackText = normalizeWs(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );

  return {
    title,
    date,
    author,
    reportUrl,
    pdfUrl,
    previewText: bullets.length > 0 ? bullets.join("\n") : fallbackText.slice(0, 2500),
  };
}

function extractLatestFromList(html: string, baseUrl: string): {
  reportUrl: string | null;
  listTitle: string;
  listDate: string;
  listPdfUrl: string | null;
} {
  const match = [...html.matchAll(/<a[^>]*href="([^"]*\/annual\/reportView\?[^"]*rpt_no=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)][0];
  if (!match) {
    return { reportUrl: null, listTitle: "", listDate: "", listPdfUrl: null };
  }

  const reportUrl = toAbsolute(baseUrl, match[1]);
  const listTitle = normalizeWs(match[2].replace(/<[^>]+>/g, " "));
  const idx = match.index ?? 0;
  const window = html.slice(Math.max(0, idx - 300), Math.min(html.length, idx + 2400));

  const dateMatch = window.match(/(\d{4}\.\d{2}\.\d{2}|\d{4}-\d{2}-\d{2})/);
  const listDate = dateMatch ? dateMatch[1].replace(/\./g, "-") : "";

  const pdfMatch = window.match(/href="([^"]+\.pdf[^"]*)"/i);
  const listPdfUrl = pdfMatch ? toAbsolute(baseUrl, pdfMatch[1]) : null;

  return { reportUrl, listTitle, listDate, listPdfUrl };
}

async function fetchKcifReport(): Promise<KcifReport> {
  const listUrl = process.env.KCIF_REPORT_URL?.trim() || DEFAULT_KCIF_REPORT_LIST_URL;
  const listRes = await fetch(listUrl, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    cache: "no-store",
  });
  if (!listRes.ok) {
    throw new Error(`KCIF 목록 조회 실패: ${listRes.status}`);
  }
  const listHtml = await listRes.text();
  const latest = extractLatestFromList(listHtml, listUrl);
  if (!latest.reportUrl) {
    throw new Error("KCIF 목록에서 reportView 링크를 찾지 못했습니다.");
  }

  const detailRes = await fetch(latest.reportUrl, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    cache: "no-store",
  });
  if (!detailRes.ok) {
    // 상세 페이지 실패 시 목록 파싱 정보로 fallback
    return {
      title: latest.listTitle || "KCIF 보고서",
      date: latest.listDate,
      author: "",
      reportUrl: latest.reportUrl,
      pdfUrl: latest.listPdfUrl,
      previewText: normalizeWs(listHtml.replace(/<[^>]+>/g, " ")).slice(0, 2500),
    };
  }
  const detailHtml = await detailRes.text();
  const detail = extractMeta(detailHtml, latest.reportUrl);

  return {
    ...detail,
    title: detail.title || latest.listTitle || "KCIF 보고서",
    date: detail.date || latest.listDate,
    pdfUrl: detail.pdfUrl ?? latest.listPdfUrl,
  };
}

async function extractPdfText(pdfUrl: string): Promise<string> {
  const res = await fetch(pdfUrl, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`KCIF PDF 조회 실패: ${res.status}`);
  }
  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    const parsed = await parser.getText();
    return normalizeWs(parsed.text ?? "").slice(0, 12000);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function summarizeWithOpenAI(input: {
  report: KcifReport;
  pdfText: string;
  holdingsText: string;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.");
  }

  const client = new OpenAI({ apiKey });
  const prompt = [
    `제목: ${input.report.title}`,
    `날짜: ${input.report.date || "미상"}`,
    `작성자: ${input.report.author || "미상"}`,
    `원문 URL: ${input.report.reportUrl}`,
    `PDF URL: ${input.report.pdfUrl ?? "없음"}`,
    "",
    "[내 보유종목]",
    input.holdingsText || "(보유종목 정보 없음)",
    "",
    "[페이지 미리보기 텍스트]",
    input.report.previewText,
    "",
    "[PDF 본문 텍스트]",
    input.pdfText || "(없음)",
    "",
    "요청: 한국어로 아래 형식으로 작성",
    "1) 핵심 요약 5줄 이내",
    "2) 시장영향 포인트 3개",
    "3) 내 보유종목 연관 분석(관련 종목만, 없으면 없음이라고 명시) 3개",
    "4) 오늘 체크포인트 2개",
  ].join("\n");

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content:
          "당신은 국제금융 보고서를 요약하는 애널리스트입니다. 사실 기반으로 간결하게 작성하고 과장하지 마세요.",
      },
      { role: "user", content: prompt },
    ],
  });

  return normalizeWs(completion.choices[0]?.message?.content ?? "요약 생성 실패").slice(0, 3000);
}

async function loadPortfolioHoldingsText(): Promise<string> {
  const syncKey = process.env.TELEGRAM_ALERT_SYNC_KEY?.trim();
  if (!syncKey) return "";

  const supabase = createSupabaseAdmin();
  if (!supabase) return "";

  const { data } = await supabase
    .from("portfolio_snapshots")
    .select("positions")
    .eq("sync_key", syncKey)
    .maybeSingle();

  const rows = Array.isArray(data?.positions) ? (data.positions as Array<Record<string, unknown>>) : [];
  if (rows.length === 0) return "";

  const lines = rows
    .map((p) => {
      const symbol = typeof p.symbol === "string" ? p.symbol : "";
      const name = typeof p.name === "string" ? p.name : "";
      const owner = typeof p.owner === "string" ? p.owner : "";
      if (!symbol) return "";
      return `- ${symbol}${name ? ` (${name})` : ""}${owner ? ` · 보유자: ${owner}` : ""}`;
    })
    .filter(Boolean);

  return lines.join("\n");
}

async function sendTelegramMessage(text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수 미설정");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`텔레그램 전송 실패: ${body.slice(0, 240)}`);
  }
}

function buildTelegramText(report: KcifReport, summary: string): string {
  const lines = [
    "📰 <b>KCIF PDF 일일 요약</b>",
    `<b>${escapeHtml(report.title)}</b>`,
    report.date ? `일자: ${escapeHtml(report.date)}` : "",
    report.author ? `작성: ${escapeHtml(report.author)}` : "",
    "",
    escapeHtml(summary),
    "",
    `원문: ${report.reportUrl}`,
    report.pdfUrl ? `PDF: ${report.pdfUrl}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

async function run() {
  const report = await fetchKcifReport();
  const today = todayKST();
  if (!report.date || report.date !== today) {
    return {
      ok: true,
      skipped: true,
      reason: `오늘 게시물 없음 (latest=${report.date || "unknown"}, today=${today})`,
      reportUrl: report.reportUrl,
      title: report.title,
    };
  }
  if (!report.pdfUrl) {
    throw new Error("PDF 링크를 찾지 못했습니다. KCIF 페이지 구조를 확인하세요.");
  }
  const pdfText = await extractPdfText(report.pdfUrl);
  if (!pdfText || pdfText.length < 80) {
    throw new Error("PDF 본문을 충분히 추출하지 못했습니다.");
  }
  const holdingsText = await loadPortfolioHoldingsText();
  const summary = await summarizeWithOpenAI({ report, pdfText, holdingsText });
  const message = buildTelegramText(report, summary);
  await sendTelegramMessage(message);

  return {
    ok: true,
    title: report.title,
    date: report.date,
    reportUrl: report.reportUrl,
    pdfUrl: report.pdfUrl,
  };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await run();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
