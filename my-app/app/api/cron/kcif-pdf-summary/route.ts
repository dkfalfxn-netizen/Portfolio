import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const maxDuration = 60;

const DEFAULT_KCIF_REPORT_URL =
  "https://www.kcif.or.kr/annual/reportView?rpt_no=36942&mn=001005&pe=002014&skey=&sval=&pg=1&pp=10";

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

function extractLatestReportUrl(html: string, baseUrl: string): string | null {
  const links = [...html.matchAll(/href="([^"]*\/annual\/reportView\?[^"]+)"/gi)]
    .map((m) => toAbsolute(baseUrl, m[1]))
    .filter((u) => /rpt_no=\d+/.test(u));
  if (links.length === 0) return null;
  return links[0];
}

async function fetchKcifReport(): Promise<KcifReport> {
  const seedUrl = process.env.KCIF_REPORT_URL?.trim() || DEFAULT_KCIF_REPORT_URL;
  const seedRes = await fetch(seedUrl, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    cache: "no-store",
  });
  if (!seedRes.ok) {
    throw new Error(`KCIF 페이지 조회 실패: ${seedRes.status}`);
  }
  const seedHtml = await seedRes.text();

  const latestUrl = extractLatestReportUrl(seedHtml, seedUrl);
  if (!latestUrl || latestUrl === seedUrl) {
    return extractMeta(seedHtml, seedUrl);
  }

  const latestRes = await fetch(latestUrl, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    cache: "no-store",
  });
  if (!latestRes.ok) {
    return extractMeta(seedHtml, seedUrl);
  }
  const latestHtml = await latestRes.text();
  return extractMeta(latestHtml, latestUrl);
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
    "[페이지 미리보기 텍스트]",
    input.report.previewText,
    "",
    "[PDF 본문 텍스트]",
    input.pdfText || "(없음)",
    "",
    "요청: 한국어로 5줄 이내 핵심 요약 + 시장영향 포인트 3개 + 체크포인트 2개를 간결하게 작성",
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

  return normalizeWs(completion.choices[0]?.message?.content ?? "요약 생성 실패");
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
  if (!report.pdfUrl) {
    throw new Error("PDF 링크를 찾지 못했습니다. KCIF 페이지 구조를 확인하세요.");
  }
  const pdfText = await extractPdfText(report.pdfUrl);
  if (!pdfText || pdfText.length < 80) {
    throw new Error("PDF 본문을 충분히 추출하지 못했습니다.");
  }
  const summary = await summarizeWithOpenAI({ report, pdfText });
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
