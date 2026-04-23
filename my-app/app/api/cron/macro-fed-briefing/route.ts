import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { todayKST } from "@/lib/date-utils";

export const maxDuration = 60;

const RSS_QUERIES = [
  "Federal+Reserve+interest+rate",
  "Kevin+Warsh+Federal+Reserve",
  "FOMC+policy",
] as const;

function googleNewsRssUrl(q: string): string {
  return `https://news.google.com/rss/search?q=${q}&hl=en&gl=US&ceid=US:en`;
}

function parseRssTitles(xml: string, limit = 28): string[] {
  const out: string[] = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
  for (const item of itemBlocks) {
    if (out.length >= limit) break;
    const m = item.match(
      /<title(?:\s[^>]*)?>(?:\s*<!\[CDATA\[)?([\s\S]*?)(?:\]\]>\s*)?<\/title>/i,
    );
    if (!m) continue;
    let t = m[1]
      .replace(/^\s*<!\[CDATA\[/, "")
      .replace(/\]\]>\s*$/, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    t = t.replace(/<[^>]+>/g, "");
    if (t.length < 6) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

function fallbackSummary(titles: string[]): string {
  if (titles.length === 0) {
    return "오늘은 RSS에서 가져온 제목이 없어 요약을 만들 수 없습니다. 뉴스 소스·네트워크 응답을 확인하세요. 연준·금리 관련 쟁점은 수동 점검이 필요할 수 있습니다. Vercel Cron 로그를 함께 확인해 주세요.";
  }
  return `최신 헤드라인 ${Math.min(5, titles.length)}개를 기준으로, 연준·금리 정책 논의가 뉴스 흐름에 포함돼 있는지 확인할 수 있습니다. OpenAI API 키가 없을 때는 상세 AI 요약 대신 이 안내가 표시됩니다. (예시 제목) ${titles.slice(0, 2).join(" / ")}`;
}

async function fetchAllTitles(): Promise<string[]> {
  const all: string[] = [];
  for (const q of RSS_QUERIES) {
    try {
      const res = await fetch(googleNewsRssUrl(q), {
        cache: "no-store",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MacroBrief/1.0)" },
      });
      if (!res.ok) continue;
      const text = await res.text();
      all.push(...parseRssTitles(text, 20));
    } catch {
      /* next query */
    }
  }
  return [...new Set(all)].slice(0, 36);
}

async function generateSummary(titles: string[], date: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (titles.length === 0) return fallbackSummary(titles);
  if (!apiKey) return fallbackSummary(titles);

  const client = new OpenAI({ apiKey });
  const lines = titles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.25,
    max_tokens: 600,
    messages: [
      {
        role: "system",
        content:
          "너는 국제 금융 뉴스 데스크다. 아래는 최근(당일) 연준·금리·FOMC·후보(케빈 워시 등) 관련으로 수집된 **영어 뉴스 제목**이다. 투자 권유·단정적 예측은 금지. 한국어로 **정확히 3~4문장**만 쓰고, (1) 시장/정책 쪽에서 공통으로 보이는 관심사 (2) 연준·금리·후보자 관련 언급이 있으면 요지만 (3) 뉴스끼리 상충되면 '제목 상으로는 상충이 보인다' 수준의 온건한 표현 (4) 마지막에 한 문장: 자료는 헤드라인만이므로 **원문 기사 확인이 필요**하다는 점을 밝힌다. 제목에 없는 사실(구체 수치, 인용)은 쓰지 말라.",
      },
      {
        role: "user",
        content: `기준일(한국): ${date}\n\n다음 뉴스 제목:\n${lines.slice(0, 4000)}`,
      },
    ],
  });
  const text = completion.choices[0]?.message?.content?.trim();
  return text && text.length > 0 ? text.slice(0, 2000) : fallbackSummary(titles);
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const date = todayKST();
  const titles = await fetchAllTitles();
  const summary = await generateSummary(titles, date);

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Supabase admin 없음", titlesCount: titles.length, summary },
      { status: 503 },
    );
  }

  const { error } = await admin.from("macro_fed_briefings").upsert(
    { report_date: date, summary, source_titles: titles },
    { onConflict: "report_date" },
  );

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message, hint: "Supabase에 macro_fed_briefings 테이블이 있는지 확인하세요 (supabase/macro_fed_briefings.sql)." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, date, titlesCount: titles.length, summaryLen: summary.length });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
