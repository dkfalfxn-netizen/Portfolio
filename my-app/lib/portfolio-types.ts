import { type DailyPrice as SignalDailyPrice } from "@/lib/signals";

export type OwnerName = string;
export type Position = {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  currency: "USD" | "EUR" | "KRW";
  /** 해외(USD) 매수 시점 USD/KRW — 원화 매입원가·원화 수익률에 사용 */
  purchaseUsdKrw?: number;
  /** 해외(EUR) 매수 시점 EUR/KRW */
  purchaseEurKrw?: number;
  /** 매수일(YYYY-MM-DD, KST) — 정산환율(T+2 09:00) 자동 보정용. 날짜 미입력 시 추가한 날로 설정 */
  purchaseDate?: string;
  /** 정산환율(T+2 09:00 KST) 미확정 상태 — 현재환율 임시값. 정산 시점 경과 후 자동 보정되면 해제 */
  purchaseFxPending?: boolean;
  /** 추가 당시 임시로 박은 환율(현재환율). 정산 후 매입환율은 정산값으로 바뀌므로 내역 표시용으로 보존 */
  purchaseFxAtAdd?: number;
  accountType: "해외주식" | "국내주식";
  accountName: string;
  owner: OwnerName;
  /** 원형 차트에서 같은 값끼리 합산할 그룹명 (미입력 시 티커 기준) */
  chartGroup?: string;
};

export type MarketState = "REGULAR" | "PRE" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED" | null;

export type MarketResponse = {
  quotes: Record<
    string,
    { price: number | null; currency: string | null; previousClose: number | null; marketState?: MarketState }
  >;
  /** 티커별 당일 분봉 종가 시계열 */
  intraday?: Record<string, number[]>;
  usdKrw: number | null;
  eurKrw: number | null;
  /** Yahoo ^VIX */
  vix: number | null;
  /** Fear & Greed — CNN Dataviz (edition.cnn.com 과 동일 소스) */
  fearGreed: { score: number; label: string } | null;
  fetchedAt: number;
};

export const FEAR_GREED_LABEL_KO: Record<string, string> = {
  "Extreme Fear": "극공포",
  Fear: "공포",
  Neutral: "중립",
  Greed: "탐욕",
  "Extreme Greed": "극탐욕",
};

export type HistoryResponse = {
  history: Record<string, SignalDailyPrice[]>;
  fetchedAt?: number;
};

/** 로컬 저장 키 — v1에서 한 번만 마이그레이션 후 v2만 사용 */
export const STORAGE_KEY = "portfolio_positions_v2";
export const LEGACY_POSITIONS_STORAGE_KEY = "portfolio_positions_v1";
export const CASH_STORAGE_KEY = "portfolio_cash_v1";
export const OWNER_NAMES_STORAGE_KEY = "portfolio_owner_names_v1";
export const SYNC_KEY_STORAGE = "portfolio_sync_key_v1";
export const AUTO_SYNC_STORAGE = "portfolio_auto_sync_v1";
export const HOLDINGS_SORT_STORAGE_KEY = "portfolio_holdings_sort_v1";
/** 보유 표 「기준선」열 표시 여부 (기본 숨김) */
export const HOLDINGS_ALERT_COLUMN_VISIBLE_KEY = "portfolio_holdings_alert_col_visible_v1";
/** 종목별 합산 표 「기준선」(% )열 표시 여부 (기본 표시) */
export const AGG_ALERT_COLUMN_VISIBLE_KEY = "portfolio_agg_alert_col_visible_v1";
export const DAILY_SNAPSHOTS_KEY = "portfolio_daily_snapshots_v1";
/**
 * 마지막으로 서버와 성공적으로 동기화했을 때의 서버 updated_at 값.
 * 로컬 시계가 아닌 서버 시각 기준이라 기기 간 시계 차이 문제가 없다.
 */
export const LAST_SYNC_TS_KEY = "portfolio_last_sync_ts_v1";
/**
 * 오늘 서버에 push한 날짜 ("YYYY-MM-DD") 와 그때의 totalValue.
 * 날짜가 같아도 totalValue가 1% 이상 달라지면 재push해 현금 변경을 반영한다.
 */
export const SNAPSHOT_PUSHED_DATE_KEY = "portfolio_snapshot_pushed_date_v1";
export const SNAPSHOT_PUSHED_TOTAL_KEY = "portfolio_snapshot_pushed_total_v1";
export const SELL_LOG_KEY = "portfolio_sell_log_v1";
/** 「종목 추가」체결을 일별 차트 마커용으로만 로컬 저장(서버 동기화 없음) */
export const BUY_JOURNAL_KEY = "portfolio_buy_journal_v1";
export const BUY_JOURNAL_MAX = 500;
export const LAST_SELL_LOG_SYNC_TS_KEY = "portfolio_last_sell_log_sync_ts_v1";
export const SELL_LOG_DIRTY_KEY = "portfolio_sell_log_dirty_v1";
export const TRADING_FEE_RATE = 0.001; // 0.1%
/** 매입 시 현금 잔고 비교용(부동소수 오차) */
export const CASH_CHECK_EPS = 1e-6;
/** 보유 종목 차트 그룹 추천(datalist). 「현금」은 현금·현금성 자산을 한 그룹으로 묶을 때 사용 */
export const HOLDINGS_CHART_GROUP_PRESETS = [
  "현금",
  "GOLD",
  "ATTACK",
  "XLE",
  "AI",
  "S&P500",
  "방산",
] as const;
/** 일별 스냅샷 최대 보관 일수 */
export const SNAPSHOT_MAX_DAYS = 180;
/** 실현손익 '종목별 손익' 접기 키(전 보유자 합산 표이므로 단일 토글) */
export const REALIZED_SYMBOL_PNL_TOGGLE_KEY = "__realizedSymbolPnlAll__";

export type DailySnapshot = {
  date: string; // YYYY-MM-DD
  ownerValues: Record<string, number>; // ownerName → 총 평가액(KRW)
  breakdownValues?: Record<string, number>; // "owner · group" 또는 "owner · 현금" → 평가액(KRW)
  totalValue: number;
  /** 서버 DB의 updated_at (ISO 8601). LWW 병합에 사용 */
  updatedAt?: string;
  /** 로컬 저장 시각 (Date.now() ms). LWW 병합에 사용 */
  savedAt?: number;
};

export type DailyLiveChange = {
  date: string;
  changeKrw: number;
  changePct: number | null;
  ownerChanges: Array<{ name: string; changeKrw: number; changePct: number | null }>;
  compareNote?: string;
};

export type SellLogEntry = {
  id: string;
  date: string;          // YYYY-MM-DD
  symbol: string;
  name: string;
  qty: number;
  sellPrice: number;
  avgPrice: number;
  currency: "USD" | "EUR" | "KRW";
  /** 매도 시 적용 환율 (USD/EUR용) */
  fxRate: number;
  /** 실현손익 원화 */
  realizedKrw: number;
  note?: string;
};

/** 종목 추가 시 로컬에만 남기는 매수 저널(차트 마커용) */
export type BuyJournalEntry = {
  id: string;
  date: string;
  owner: OwnerName;
  symbol: string;
  name: string;
  qty: number;
  buyPrice: number;
  currency: "USD" | "EUR" | "KRW";
  fxRate: number;
  totalKrw: number;
  /** USD 매수 정산환율(T+2 09:00) 미확정 — 현재환율 임시. 정산 후 fxRate·totalKrw 자동 보정되면 해제 */
  fxPending?: boolean;
};

/** 텔레그램 테스트 발송 API 응답 */
export type TelegramTestResult = {
  ok: boolean;
  env?: Record<string, string>;
  symbols?: Array<{ symbol: string; changePct: number | null; willAlert: boolean }>;
  alertCount?: number;
  alreadySentToday?: string[];
  message?: string;
  error?: string;
  detail?: Record<string, string>;
  watchlistCount?: number;
  watchlistSignals?: unknown[];
  sentHoldings?: number;
  sentWatchlist?: number;
};

/** 관심종목 owners에서 "모든 보유자"를 뜻하는 토큰 */
export const WATCHLIST_OWNER_ALL = "__ALL__";

export type WatchlistRow = { symbol: string; name: string; group?: string; owners?: string[] };
