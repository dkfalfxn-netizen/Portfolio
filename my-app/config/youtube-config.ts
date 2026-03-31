/**
 * AI 데일리 마켓 인사이트 - 유튜브 채널 & 섹터 설정
 *
 * 채널 ID 찾는 법:
 *   유튜브 채널 페이지 → 우클릭 → "페이지 소스 보기" → "channel_id" 검색
 *   또는 https://www.youtube.com/@채널핸들 접속 후 소스에서 "UCxxxx" 검색
 */

export type YoutubeChannel = {
  /** 유튜브 Channel ID (UC로 시작하는 24자리) */
  id: string;
  name: string;
  category: "kr-economy" | "us-economy" | "tech" | "market-analysis";
  /** 자막 언어 우선순위 (첫 번째 실패 시 두 번째로 fallback) */
  langs: string[];
  /** 분석할 최신 영상 개수 (토큰 비용 vs 정보량 tradeoff: 1~2 권장) */
  maxVideos: number;
  /** false 이면 해당 채널 분석 건너뜀 */
  enabled: boolean;
};

export const YOUTUBE_CHANNELS: YoutubeChannel[] = [
  // ─────────────── 국내 경제·시황 ───────────────
  {
    id: "UCdxSMU1HEqMx0_-JYlAJThA",
    name: "삼프로TV",
    category: "kr-economy",
    langs: ["ko"],
    maxVideos: 1,
    enabled: true,
  },
  {
    id: "UCuCDNIJFZRCbKCdn3oUFmfA",
    name: "슈카월드",
    category: "kr-economy",
    langs: ["ko"],
    maxVideos: 1,
    enabled: true,
  },
  {
    id: "UCup9Hf5CZMLNAJRXiHbSqtg",
    name: "신사임당",
    category: "kr-economy",
    langs: ["ko"],
    maxVideos: 1,
    enabled: false,
  },

  // ─────────────── 미국 경제·투자 ───────────────
  {
    id: "UCa-ckhlsFzc55eNt-Xd7rjg",
    name: "Graham Stephan",
    category: "us-economy",
    langs: ["en"],
    maxVideos: 1,
    enabled: true,
  },
  {
    id: "UCvJJ_dzjViJCoLf5uKUTwoA",
    name: "CNBC",
    category: "us-economy",
    langs: ["en"],
    maxVideos: 1,
    enabled: false,   // 영상이 많아 토큰 낭비 가능 — 필요 시 true로 전환
  },

  // ─────────────── 기술·테크 ───────────────
  {
    id: "UCnUYZLuoy1rq1aVMwx4aTzw",
    name: "MKBHD",
    category: "tech",
    langs: ["en"],
    maxVideos: 1,
    enabled: false,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 관심 섹터 정의
// AI 리포트에서 "미래 유망 섹터" 선택 시 아래 목록을 참고 컨텍스트로 제공합니다.
// ─────────────────────────────────────────────────────────────────────────────
export const INTEREST_SECTORS = [
  { key: "ai-semiconductor",  label: "AI 반도체",          description: "엔비디아, AMD, TSMC 등 AI 가속기·HBM" },
  { key: "us-big-tech",       label: "미국 빅테크",         description: "매그니피센트7 (애플, 마소, 구글, 아마존, 메타, 엔비디아, 테슬라)" },
  { key: "ev-battery",        label: "전기차·배터리",       description: "테슬라, 현대차, 삼성SDI, LG에너지솔루션 등" },
  { key: "kr-bio",            label: "국내 바이오·제약",     description: "삼성바이오로직스, 셀트리온, 리가켐바이오 등" },
  { key: "kr-defense",        label: "국내 방산",           description: "한화에어로스페이스, 현대로템, LIG넥스원 등" },
  { key: "gold-commodity",    label: "금·원자재",           description: "KRX 금현물, 구리, 원유 ETF 등" },
  { key: "us-etf",            label: "미국 ETF·지수",       description: "QQQ, SPY, SCHD 등 인덱스 투자" },
  { key: "retirement-safe",   label: "안전자산·퇴직연금",    description: "채권 ETF, 배당주, TDF 등" },
] as const;

export type SectorKey = (typeof INTEREST_SECTORS)[number]["key"];

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI 모델 설정
// ─────────────────────────────────────────────────────────────────────────────
export const AI_CONFIG = {
  /** gpt-4o-mini: 비용 최소화. 더 깊은 분석이 필요하면 gpt-4o로 변경 */
  model: "gpt-4o-mini" as const,
  /** 채널당 자막 최대 글자 수 (한국어 기준 약 1500~2000 토큰) */
  transcriptMaxChars: 4000,
  /** 전체 프롬프트 자막 파트 최대 글자 수 */
  totalTranscriptMaxChars: 16000,
};
