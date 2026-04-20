/**
 * POST /api/cron/analyze-market
 *
 * Vercel Cron Job으로 매일 오전 6시(UTC 21:00 → KST 06:00)에 호출됩니다.
 * 수동 테스트: curl -X POST https://<your-domain>/api/cron/analyze-market \
 *               -H "Authorization: Bearer <CRON_SECRET>"
 *
 * 처리 흐름:
 *  1. CRON_SECRET 인증
 *  2. 활성화된 유튜브 채널에서 최신 영상 ID 수집 (YouTube RSS, API 키 불필요)
 *  3. youtube-transcript 로 자막 추출
 *  4. Supabase portfolio_snapshots 에서 현재 보유 종목 로드
 *  5. OpenAI gpt-4o-mini 로 마켓 인사이트 생성
 *  6. 결과를 market_reports 테이블에 upsert (날짜 기준)
 */

// Vercel 함수 최대 실행 시간 (초) — Pro 플랜: 최대 300s, Hobby: 최대 60s
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { YoutubeTranscript } from "youtube-transcript";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import {
  YOUTUBE_CHANNELS,
  INTEREST_SECTORS,
  AI_CONFIG,
  type YoutubeChannel,
} from "@/config/youtube-config";

// ─────────────────────────────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────────────────────────────

type VideoMeta = {
  channel: string;
  channelId: string;
  videoId: string;
  title: string;
  publishedAt: string;
  description: string;
};

type TranscriptResult = VideoMeta & {
  transcript: string;   // RSS description 또는 실제 자막
  transcriptChars: number;
};

type PortfolioItem = {
  symbol: string;
  name: string;
  owner: string;
  quantity: number;
  currency: string;
};

type MacroIssue = {
  title: string;
  summary: string;
  impact: "high" | "medium" | "low";
  sourceChannel: string;
};

type PortfolioAnalysis = {
  symbol: string;
  name: string;
  owner: string;
  mentioned: boolean;
  sentiment: "bullish" | "bearish" | "neutral";
  keyPoints: string[];
  strategy: "매수" | "매도" | "보유" | "관망";
};

type BuySellOpinion = {
  overall: "bullish" | "bearish" | "neutral";
  comment: string;
  buyCandidates: string[];
  sellCandidates: string[];
  watchList: string[];
};

type FutureSector = {
  sector: string;
  sectorKey: string;
  reason: string;
  timeframe: string;
  confidence: "high" | "medium" | "low";
};

type MarketReport = {
  reportDate: string;
  videosAnalyzed: (VideoMeta & { transcriptChars: number })[];
  macroIssues: MacroIssue[];
  portfolioAnalysis: PortfolioAnalysis[];
  buySellOpinion: BuySellOpinion;
  futureSectors: FutureSector[];
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  analysisDurationMs: number;
  errorChannels: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 유틸: 오늘 날짜 (KST, YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────────────────────
function todayKST(): string {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }),
  )
    .toISOString()
    .slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: YouTube RSS로 채널 최신 영상 메타 가져오기 (API 키 불필요)
//         title + media:description 을 분석 소스로 활용
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLatestVideos(
  channel: YoutubeChannel,
): Promise<VideoMeta[]> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
  const res = await fetch(rssUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed for ${channel.name}: ${res.status}`);
  }
  const xml = await res.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const videos: VideoMeta[] = [];

  for (const entry of entries.slice(0, channel.maxVideos)) {
    const block = entry[1];
    const videoIdMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch = block.match(/<title>([^<]+)<\/title>/);
    const publishedMatch = block.match(/<published>([^<]+)<\/published>/);
    // RSS에 포함된 영상 설명 (media:description)
    const descMatch = block.match(/<media:description>([\s\S]*?)<\/media:description>/);

    if (videoIdMatch && titleMatch) {
      const rawDesc = descMatch?.[1] ?? "";
      // HTML 엔티티 디코딩 + 최대 길이 제한
      const description = rawDesc
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .slice(0, AI_CONFIG.transcriptMaxChars);

      videos.push({
        channel: channel.name,
        channelId: channel.id,
        videoId: videoIdMatch[1],
        title: titleMatch[1],
        publishedAt: publishedMatch?.[1] ?? "",
        description,
      });
    }
  }
  return videos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: 자막 수집 시도 (실패 시 RSS description으로 fallback)
// youtube-transcript는 Vercel 서버 IP에서 차단되는 경우가 있으므로
// 실패 시 이미 수집된 RSS description을 그대로 사용
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTranscriptWithFallback(
  videoId: string,
  langs: string[],
  maxChars: number,
  fallbackDescription: string,
): Promise<{ text: string; source: "transcript" | "description" }> {
  for (const lang of langs) {
    try {
      const items = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      const text = items
        .map((t) => t.text.replace(/\n/g, " "))
        .join(" ")
        .slice(0, maxChars);
      if (text.length > 100) return { text, source: "transcript" };
    } catch {
      // 다음 언어로 fallback
    }
  }
  // RSS description으로 fallback
  return {
    text: fallbackDescription,
    source: "description",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Supabase에서 현재 보유 종목 로드
// portfolio_snapshots 테이블의 가장 최신 레코드 사용
// ─────────────────────────────────────────────────────────────────────────────
async function loadPortfolioHoldings(): Promise<PortfolioItem[]> {
  const supabase = createSupabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("sync_key, positions, updated_at")
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error || !data?.length) return [];

  // 가장 최신 sync_key 기준으로 포지션 집계
  const latestKey = data[0].sync_key;
  const latestRow = data.find((r) => r.sync_key === latestKey);
  if (!latestRow?.positions) return [];

  type RawPosition = {
    symbol?: unknown;
    name?: unknown;
    owner?: unknown;
    quantity?: unknown;
    currency?: unknown;
  };

  const positions = Array.isArray(latestRow.positions)
    ? (latestRow.positions as RawPosition[])
    : [];

  return positions
    .filter(
      (p): p is Required<RawPosition> =>
        typeof p?.symbol === "string" &&
        typeof p?.name === "string" &&
        typeof p?.owner === "string",
    )
    .map((p) => ({
      symbol: String(p.symbol),
      name: String(p.name),
      owner: String(p.owner),
      quantity: Number(p.quantity ?? 0),
      currency: String(p.currency ?? "USD"),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: OpenAI로 마켓 인사이트 생성
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 전문 투자 분석가입니다. 제공된 유튜브 영상 자막들을 분석하여 
가족 포트폴리오 투자자를 위한 실용적인 마켓 인사이트를 JSON 형식으로 생성합니다.

반드시 아래 JSON 구조만 출력하세요 (마크다운 코드블록 없이 순수 JSON):
{
  "macroIssues": [
    {
      "title": "이슈 제목 (20자 이내)",
      "summary": "요약 (100자 이내)",
      "impact": "high|medium|low",
      "sourceChannel": "출처 채널명"
    }
  ],
  "portfolioAnalysis": [
    {
      "symbol": "종목 티커",
      "name": "종목명",
      "owner": "보유자명",
      "mentioned": true,
      "sentiment": "bullish|bearish|neutral",
      "keyPoints": ["포인트1", "포인트2"],
      "strategy": "매수|매도|보유|관망"
    }
  ],
  "buySellOpinion": {
    "overall": "bullish|bearish|neutral",
    "comment": "전체 시장 코멘트 (150자 이내)",
    "buyCandidates": ["매수 고려 종목 또는 ETF"],
    "sellCandidates": ["매도/비중축소 고려 종목"],
    "watchList": ["주시 종목"]
  },
  "futureSectors": [
    {
      "sector": "섹터명",
      "sectorKey": "섹터 키",
      "reason": "선정 이유 (80자 이내)",
      "timeframe": "1~3개월",
      "confidence": "high|medium|low"
    }
  ]
}

중요 지침:
- portfolioAnalysis는 제공된 보유 종목 중 영상에서 직접/간접 언급된 것만 포함
- 언급되지 않은 종목도 시장 흐름상 영향받을 경우 포함 가능 (mentioned: false)
- 투자 조언이 아닌 정보 제공 목적임을 고려해 균형잡힌 시각 유지
- 한국어로 작성`;

async function generateAIReport(
  transcripts: TranscriptResult[],
  holdings: PortfolioItem[],
  openai: OpenAI,
): Promise<{
  result: Omit<MarketReport, "reportDate" | "videosAnalyzed" | "errorChannels" | "analysisDurationMs">;
  promptTokens: number;
  completionTokens: number;
}> {
  const holdingsList = holdings
    .map((h) => `  - ${h.symbol} (${h.name}) · 보유자: ${h.owner} · ${h.currency}`)
    .join("\n");

  const sectorList = INTEREST_SECTORS.map(
    (s) => `  - ${s.key}: ${s.label} — ${s.description}`,
  ).join("\n");

  const transcriptParts = transcripts
    .map(
      (t) =>
        `[채널: ${t.channel} | 영상: ${t.title}]\n${t.transcript || "(자막 없음)"}`,
    )
    .join("\n\n---\n\n");

  const userPrompt = `# 오늘의 유튜브 영상 자막

${transcriptParts}

---
# 현재 가족 보유 종목

${holdingsList || "  (보유 종목 없음)"}

---
# 관심 섹터 목록 (futureSectors 선택 시 참고)

${sectorList}

---
위 자막을 분석하여 JSON 리포트를 생성해주세요.`;

  const response = await openai.chat.completions.create({
    model: AI_CONFIG.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 2000,
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as {
    macroIssues?: MacroIssue[];
    portfolioAnalysis?: PortfolioAnalysis[];
    buySellOpinion?: BuySellOpinion;
    futureSectors?: FutureSector[];
  };

  return {
    result: {
      macroIssues: parsed.macroIssues ?? [],
      portfolioAnalysis: parsed.portfolioAnalysis ?? [],
      buySellOpinion: parsed.buySellOpinion ?? {
        overall: "neutral",
        comment: "",
        buyCandidates: [],
        sellCandidates: [],
        watchList: [],
      },
      futureSectors: parsed.futureSectors ?? [],
      modelUsed: AI_CONFIG.model,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    },
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Supabase market_reports 테이블에 upsert
// ─────────────────────────────────────────────────────────────────────────────
async function saveReport(report: MarketReport): Promise<void> {
  const supabase = createSupabaseAdmin();
  if (!supabase) throw new Error("Supabase 연결 불가");

  const { error } = await supabase.from("market_reports").upsert(
    {
      report_date: report.reportDate,
      videos_analyzed: report.videosAnalyzed,
      macro_issues: report.macroIssues,
      portfolio_analysis: report.portfolioAnalysis,
      buy_sell_opinion: report.buySellOpinion,
      future_sectors: report.futureSectors,
      model_used: report.modelUsed,
      prompt_tokens: report.promptTokens,
      completion_tokens: report.completionTokens,
      analysis_duration_ms: report.analysisDurationMs,
      error_channels: report.errorChannels,
    },
    { onConflict: "report_date" },
  );
  if (error) throw new Error(`Supabase upsert 실패: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handler
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 1. 인증
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY 환경 변수가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  const startTime = Date.now();
  const errorChannels: string[] = [];
  const transcriptResults: TranscriptResult[] = [];

  try {

  // 2. 활성화된 채널 목록
  const activeChannels = YOUTUBE_CHANNELS.filter((c) => c.enabled);
  if (activeChannels.length === 0) {
    return NextResponse.json(
      { error: "활성화된 유튜브 채널이 없습니다. config/youtube-config.ts를 확인하세요." },
      { status: 400 },
    );
  }

  // 3. 채널별 영상 수집 + 자막/설명 추출 (병렬 처리)
  const channelResults = await Promise.allSettled(
    activeChannels.map(async (channel) => {
      const videos = await fetchLatestVideos(channel);
      if (videos.length === 0) throw new Error("영상 없음");

      const results: TranscriptResult[] = [];
      for (const video of videos) {
        const { text, source } = await fetchTranscriptWithFallback(
          video.videoId,
          channel.langs,
          AI_CONFIG.transcriptMaxChars,
          video.description,
        );
        // description도 없으면 제목만이라도 포함
        const finalText = text.length > 0 ? text : `[제목만 수집됨] ${video.title}`;
        results.push({
          ...video,
          transcript: source === "transcript"
            ? finalText
            : `[영상 설명]\n${finalText}`,
          transcriptChars: finalText.length,
        });
      }
      return results;
    }),
  );

  for (let i = 0; i < channelResults.length; i++) {
    const r = channelResults[i];
    if (r.status === "fulfilled") {
      transcriptResults.push(...r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      errorChannels.push(`${activeChannels[i].name}(${msg.slice(0, 50)})`);
    }
  }

  // 영상 자체가 하나도 수집 안 됐으면 중단
  if (transcriptResults.length === 0) {
    return NextResponse.json(
      { error: "수집된 영상이 없어 분석을 중단했습니다.", errorChannels },
      { status: 422 },
    );
  }

  // 총 자막 길이 제한 (토큰 비용 관리)
  let totalChars = 0;
  const trimmedTranscripts = transcriptResults.map((t) => {
    const remaining = Math.max(
      0,
      AI_CONFIG.totalTranscriptMaxChars - totalChars,
    );
    const sliced = t.transcript.slice(0, remaining);
    totalChars += sliced.length;
    return { ...t, transcript: sliced };
  });

  // 4. 보유 종목 로드
  const holdings = await loadPortfolioHoldings();

  // 5. AI 분석
  const openai = new OpenAI({ apiKey: openaiKey });
  const { result } = await generateAIReport(trimmedTranscripts, holdings, openai);

  // 6. 저장
  const report: MarketReport = {
    reportDate: todayKST(),
    videosAnalyzed: trimmedTranscripts.map(({ transcript: _t, ...rest }) => rest),
    macroIssues: result.macroIssues,
    portfolioAnalysis: result.portfolioAnalysis,
    buySellOpinion: result.buySellOpinion,
    futureSectors: result.futureSectors,
    modelUsed: result.modelUsed,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    analysisDurationMs: Date.now() - startTime,
    errorChannels,
  };

  await saveReport(report);

  return NextResponse.json({
    ok: true,
    reportDate: report.reportDate,
    videosAnalyzed: report.videosAnalyzed.length,
    errorChannels,
    tokens: {
      prompt: report.promptTokens,
      completion: report.completionTokens,
    },
    durationMs: report.analysisDurationMs,
  });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[analyze-market] 오류:", message, err instanceof Error ? err.stack?.slice(0, 500) : undefined);
    return NextResponse.json(
      { error: message, durationMs: Date.now() - startTime },
      { status: 500 },
    );
  }
}

// Vercel Cron은 GET 방식도 지원 — POST와 동일 로직 위임
export async function GET(req: NextRequest) {
  return POST(req);
}
