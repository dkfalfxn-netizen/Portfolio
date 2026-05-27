/**
 * 백업·복원용 스냅샷 wire 형식 (portfolio_snapshot_backups.snapshot jsonb)
 */

export type PortfolioBackupSnapshot = {
  positions: unknown;
  cash_by_owner: unknown;
  holdings_sort_by_owner: unknown;
  owner_names: unknown;
  sell_log_by_owner: unknown;
  target_stock_weight_by_owner: unknown;
  owner_scratchpad_by_owner: unknown;
  rebalance_calculator_by_owner: unknown;
  alert_thresholds_by_position: unknown;
  /** 매수 일지(차트 마커용) — 로컬 전용이므로 백업에만 포함, 메인 sync에는 없음 */
  buy_journal_entries?: unknown;
  source_updated_at: string | null;
};

export function emptyPortfolioBackupSnapshot(): PortfolioBackupSnapshot {
  return {
    positions: [],
    cash_by_owner: {},
    holdings_sort_by_owner: {},
    owner_names: [],
    sell_log_by_owner: {},
    target_stock_weight_by_owner: {},
    owner_scratchpad_by_owner: {},
    rebalance_calculator_by_owner: {},
    alert_thresholds_by_position: {},
    source_updated_at: null,
  };
}

/** 클라이언트·서버 row → 백업용 스냅샷 정규화 */
export function normalizePortfolioBackupSnapshot(raw: unknown): PortfolioBackupSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const positions = s.positions;
  if (positions !== undefined && !Array.isArray(positions)) return null;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const source =
    typeof s.source_updated_at === "string"
      ? s.source_updated_at
      : typeof s.updated_at === "string"
        ? s.updated_at
        : null;
  return {
    positions: positions ?? [],
    cash_by_owner: obj(s.cash_by_owner),
    holdings_sort_by_owner: obj(s.holdings_sort_by_owner),
    owner_names: arr(s.owner_names),
    sell_log_by_owner: obj(s.sell_log_by_owner),
    target_stock_weight_by_owner: obj(s.target_stock_weight_by_owner),
    owner_scratchpad_by_owner: obj(s.owner_scratchpad_by_owner),
    rebalance_calculator_by_owner: obj(s.rebalance_calculator_by_owner),
    alert_thresholds_by_position: obj(s.alert_thresholds_by_position),
    // buy_journal_entries는 없어도 괜찮음(구버전 백업 호환)
    ...(Array.isArray(s.buy_journal_entries) ? { buy_journal_entries: s.buy_journal_entries } : {}),
    source_updated_at: source,
  };
}
