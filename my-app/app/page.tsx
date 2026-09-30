"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChangeEvent,
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FamilyAllocationDonut, PortfolioAllOwnersTodayProfitCard } from "@/components/family-allocation-chart";
import { DailyTrendChart, type DailyTradeMarker } from "@/components/daily-trend-chart";
import { DailyChangeCalendar } from "@/components/daily-change-calendar";
import { RebalancingCalculator } from "@/components/rebalancing-calculator";
import { TechnicalSignalDetailModal } from "@/components/technical-signal-detail-modal";
import TradeImageImport, { type ConfirmedBuyTrade, type ConfirmedSellTrade } from "@/components/trade-image-import";
import { cn } from "@/lib/utils";
import { FALLBACK_USD_KRW, FALLBACK_EUR_KRW } from "@/lib/fx-fallback";
import { holdingSymbolsEquivalent, inferTradingCurrencyFromTicker, isKrxListedEquityCode } from "@/lib/finance-symbols";
import { fmtInt, MONEY_INT_LOCALE, signedPnlTextClass } from "@/lib/format-money";
import {
  HAS_LOCAL_CHANGES_KEY,
  LOCAL_CHANGES_AT_KEY,
  clearLocalChanged,
  markLocalChanged,
  TARGET_WEIGHT_STORAGE_KEY,
  CALCULATOR_TARGET_STORAGE_KEY,
  buildRebalanceCalculatorByOwnerFromLocal,
  loadAllTargetStockWeights,
  mergeAndPersistRebalanceCalculatorFromServer,
  mergeAndPersistTargetStockWeightsFromServer,
} from "@/lib/portfolio-target-weights";
import { OWNER_SCRATCHPAD_STORAGE_KEY, mergeAndPersistOwnerScratchpadsFromServer, loadAllOwnerScratchpads } from "@/lib/portfolio-owner-scratchpad";
import {
  ALERT_THRESHOLDS_STORAGE_KEY,
  evaluateAlertRule,
  getAlertThresholdsPayload,
  getAlertThresholdsForSync,
  loadAlertThresholdsFromStorage,
  mergeAlertThresholdsFromServer,
  mergeAlertThresholdsOnPull,
  positionAlertKey,
  positionReturnPctForAlert,
  resolveAlertRule,
  symbolAlertKey,
  type AlertRule,
  type AlertThresholdsByKey,
} from "@/lib/alert-thresholds";
import { todayKST, yesterdayKST } from "@/lib/date-utils";

import { hasAlertThresholdRule } from "@/lib/portfolio-alert-ui";
import { purchaseCashDeduction, usdPurchaseCashPlan } from "@/lib/portfolio-calc";
import { DEFAULT_OWNER_NAMES, HoldingsAggTipRow, aggregateSymbolKeyForHoldings, chartGroupCompositionLabel, isStockRowForSymbolAggregate, sortPortfolioGridRows } from "@/lib/portfolio-holdings-helpers";
import { CashByOwner, DEFAULT_CASH_BY_OWNER, DEFAULT_POSITIONS, applyPositionUpsert, isValidPosition, loadCashByOwner, loadPositions, makePositionKey, mergeCashBundleDisplayEntries, mergeDuplicatePositions } from "@/lib/portfolio-positions";
import { HoldingsSortMode, buildHoldingsGroupBlocks, defaultHoldingsSort, inferOwnerNamesFromSyncPayload, loadBuyJournal, loadDailySnapshots, loadHoldingsSort, loadOwnerNames, loadSellLog, normalizeOwnerNames, safeSetItem, saveDailySnapshot } from "@/lib/portfolio-storage";
import { CONFLICT_AUTO_PUSH_IF_SYNCED_WITHIN_MS, canMarkAutoMigrationKeep, formatKstForConflict, isLocalPortfolioCacheCleared, isServerSnapshotNewerThanLocal, isUsTradingDayPollWindow, normalizeBuyJournalStrict, normalizeCashStrict, normalizeHoldingsSortStrict, normalizeSellLogStrict, positionsWithLivePrices, recordAutoMigrationKeep } from "@/lib/portfolio-sync-helpers";
import { AGG_ALERT_COLUMN_VISIBLE_KEY, AUTO_SYNC_STORAGE, BUY_JOURNAL_KEY, BUY_JOURNAL_MAX, BuyJournalEntry, CASH_CHECK_EPS, CASH_STORAGE_KEY, DAILY_SNAPSHOTS_KEY, DailyLiveChange, DailySnapshot, HOLDINGS_ALERT_COLUMN_VISIBLE_KEY, HOLDINGS_SORT_STORAGE_KEY, HistoryResponse, LAST_SELL_LOG_SYNC_TS_KEY, LAST_SYNC_TS_KEY, LEGACY_POSITIONS_STORAGE_KEY, MarketResponse, OWNER_NAMES_STORAGE_KEY, OwnerName, Position, SELL_LOG_DIRTY_KEY, SELL_LOG_KEY, SNAPSHOT_PUSHED_DATE_KEY, SNAPSHOT_PUSHED_TOTAL_KEY, STORAGE_KEY, SYNC_KEY_STORAGE, SellLogEntry, TRADING_FEE_RATE, TelegramTestResult, WATCHLIST_OWNER_ALL, WatchlistRow } from "@/lib/portfolio-types";
import {
  calculateBollingerSignal,
  calculateMACrossoverSignal,
  calculateRSISignal,
  calculateVolumeSignal,
  type TradeSignal,
} from "@/lib/signals";
import { shouldShowDailyChangeForCurrency, krSettlementTargetUnixSec } from "@/lib/trading-calendar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { WatchlistSection } from "@/components/watchlist-section";
import { SyncSection } from "@/components/sync-section";
import { TelegramAlertSection } from "@/components/telegram-alert-section";
import { RealizedSection } from "@/components/realized-section";
import { AddPositionSection } from "@/components/add-position-section";
import { TechnicalSignalSection } from "@/components/technical-signal-section";
import { SellLogDetailModal } from "@/components/sell-log-detail-modal";
import { HoldingsBySymbolSection } from "@/components/holdings-by-symbol-section";
import { HoldingsSection } from "@/components/holdings-section";
import { DashboardHeader } from "@/components/dashboard-header";


export default function Home() {
  // SSR과 클라이언트 첫 렌더에서 동일한 초기값을 보장(hydration 불일치 방지).
  // localStorage에서 실제 값을 읽는 것은 아래 init useEffect에서 처리.
  // DEFAULT_OWNER_NAMES는 as const(readonly)이므로 스프레드로 mutable 배열로 변환
  const [ownerNames, setOwnerNames] = useState<OwnerName[]>([...DEFAULT_OWNER_NAMES]);
  const [positions, setPositions] = useState<Position[]>(DEFAULT_POSITIONS);
  const [cashByOwner, setCashByOwner] = useState<CashByOwner>(DEFAULT_CASH_BY_OWNER);
  const [isHydrated, setIsHydrated] = useState(false);
  const [dailySnapshots, setDailySnapshots] = useState<DailySnapshot[]>([]);
  const [buyJournal, setBuyJournal] = useState<BuyJournalEntry[]>([]);
  const [sellLog, setSellLog] = useState<Record<string, SellLogEntry[]>>({});
  const [showTradeImageImport, setShowTradeImageImport] = useState(false);
  const [buyPasteError, setBuyPasteError] = useState("");
  const [buyPasteText, setBuyPasteText] = useState("");
  const [sellPasteText, setSellPasteText] = useState("");
  const [showSymbolPnl, setShowSymbolPnl] = useState<Record<string, boolean>>({});
  const [sellLogErrorByOwner, setSellLogErrorByOwner] = useState<Record<string, string>>({});
  const [sellLogOwnerForSection, setSellLogOwnerForSection] = useState<string>("김승주");
  /** 실현손익 '기록 목록' 열람용 보유자(입력 폼의 보유자와 독립) */
  const [sellLogListViewOwner, setSellLogListViewOwner] = useState<string>("김승주");
  /** 기록 목록 UI 접힘(기본 접힘) */
  const [sellLogListExpanded, setSellLogListExpanded] = useState(false);
  /** 종목별 합산 패널 접힘 */
  const [sellLogSymSummaryExpanded, setSellLogSymSummaryExpanded] = useState(false);
  /** 종목별 합산 보유자 필터: 빈 배열 = 전체 선택 */
  const [sellLogSymOwnerFilter, setSellLogSymOwnerFilter] = useState<string[]>([]);
  /** 실현손익 티커 검색 combobox: owner별 검색어 */
  const [sellTickerSearch, setSellTickerSearch] = useState<Record<string, string>>({});
  /** 실현손익 티커 검색 combobox: owner별 드롭다운 열림 여부 */
  const [sellTickerOpen, setSellTickerOpen] = useState<Record<string, boolean>>({});
  /** 실현손익 티커 검색 combobox: owner별 키보드 하이라이트 인덱스 */
  const [sellTickerHl, setSellTickerHl] = useState<Record<string, number>>({});
  /** 실현손익 티커 입력 ref: 기록 추가 후 포커스 복귀용 */
  const sellTickerInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [sellLogForm, setSellLogForm] = useState<Record<string, {
    date: string; symbol: string; name: string; qty: string;
    sellPrice: string; avgPrice: string; currency: "USD" | "EUR" | "KRW"; fxRate: string; note: string;
    selectedOwners: string[];
    ownerOverrides: Record<string, { qty: string; avgPrice: string; fxRate: string }>;
    editingId: string | null;
  }>>({});
  const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
  const [pendingSaveConfirm, setPendingSaveConfirm] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ type: "edit" | "delete"; rowIndex: number; position: Position } | null>(null);
  const [pendingClearConfirm, setPendingClearConfirm] = useState(false);
  const [editSymbol, setEditSymbol] = useState("");
  const [editName, setEditName] = useState("");
  const [editChartGroup, setEditChartGroup] = useState("");
  const [editQuantity, setEditQuantity] = useState("");
  const [editAvgPrice, setEditAvgPrice] = useState("");
  const [editPurchaseUsdKrw, setEditPurchaseUsdKrw] = useState("");
  const [editPurchaseEurKrw, setEditPurchaseEurKrw] = useState("");
  const [signalDetailTarget, setSignalDetailTarget] = useState<{ symbol: string; name: string } | null>(
    null,
  );
  const [sellLogDetailOpenOwner, setSellLogDetailOpenOwner] = useState<string | null>(null);

  const [cloudSyncKey, setCloudSyncKey] = useState("");
  const [syncKeyDraft, setSyncKeyDraft] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [syncReady, setSyncReady] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const restoreBackupFileInputRef = useRef<HTMLInputElement>(null);
  const [syncMessage, setSyncMessage] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastSellLogSyncedAt, setLastSellLogSyncedAt] = useState<string | null>(null);
  const [sellLogDirty, setSellLogDirty] = useState(false);
  const [latestBackupAt, setLatestBackupAt] = useState<string | null>(null);
  /** 서버 `portfolio_daily_snapshots` 최신 일자 행의 `created_at`(크론·upsert 최초 기록 시각 근사) */
  const [cronDailySnapshotRecordedAt, setCronDailySnapshotRecordedAt] = useState<string | null>(
    null,
  );
  const [hasLoadedLatestBackup, setHasLoadedLatestBackup] = useState(false);
  /** 백업 선택 복원용: 파싱된 백업 파일 데이터 */
  const [pendingBackups, setPendingBackups] = useState<Array<{ id?: string; created_at: string; snapshot: Record<string, unknown> }> | null>(null);
  const [pendingBackupFileKey, setPendingBackupFileKey] = useState<string>("");
  const [serverHealth, setServerHealth] = useState<"loading" | "ok" | "error">("loading");
  const pushDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * positions/cash useEffect에서 HAS_LOCAL_CHANGES_KEY 설정을 건너뛸 횟수.
   * - 최초 하이드레이션(디스크→state 재적용)이나 서버 Pull 반영 시에는
   *   "사용자가 수정"한 것이 아니므로 로컬 변경 플래그를 올리지 않아야 한다.
   * - setPositions + setCashByOwner를 한 번 호출할 때마다 2를 설정.
   */
  const skipMarkLocalChangedRef = useRef(0);
  const skipAlertThresholdsHydrateRef = useRef(0);
  const skipOwnerLocalChangedRef = useRef(0);
  const skipSellLogLocalChangedRef = useRef(0);
  const skipBuyJournalLocalChangedRef = useRef(0);
  const [holdingsSortByOwner, setHoldingsSortByOwner] =
    useState<Record<OwnerName, HoldingsSortMode>>(defaultHoldingsSort);
  /** 보유자별 심플 종목 요약 테이블 접힘 여부 */
  const [holdingsSummaryCollapsed, setHoldingsSummaryCollapsed] = useState<Record<string, boolean>>({});

  const [telegramTestBusy, setTelegramTestBusy] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState<TelegramTestResult | null>(null);
  const [watchlistRows, setWatchlistRows] = useState<WatchlistRow[]>([]);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchlistMessage, setWatchlistMessage] = useState("");

  /** 보유자::티커 → 익절·손절 가격 및 수익률 % 기준 */
  const [alertThresholdsByKey, setAlertThresholdsByKey] = useState<AlertThresholdsByKey>({});
  /** 보유 표 기준선 열 — 평소 숨김, 토글로 표시 */
  const [showHoldingsAlertColumn, setShowHoldingsAlertColumn] = useState(false);
  /** 종목별 합산 표 기준선(익·손 %) 열 */
  const [showAggAlertColumn, setShowAggAlertColumn] = useState(true);

  const patchPositionAlertPrice = useCallback(
    (
      positionKey: string,
      field: "takeProfitPrice" | "stopLossPrice",
      value: number | undefined,
    ) => {
      setAlertThresholdsByKey((prev) => {
        const next = { ...prev };
        const cur: AlertRule = { ...(next[positionKey] ?? {}) };
        if (value === undefined || !Number.isFinite(value)) {
          delete cur[field];
        } else {
          cur[field] = value;
        }
        const empty = cur.takeProfitPrice === undefined && cur.stopLossPrice === undefined;
        if (empty) delete next[positionKey];
        else next[positionKey] = cur;
        return next;
      });
    },
    [],
  );

  /** 티커 공통 % — 종목별 합산 표에서 입력 */
  const patchSymbolAlertPct = useCallback(
    (
      symbolKeys: string[],
      field: "takeProfitReturnPct" | "stopLossReturnPct",
      value: number | undefined,
    ) => {
      if (symbolKeys.length === 0) return;
      setAlertThresholdsByKey((prev) => {
        const next = { ...prev };
        for (const sym of symbolKeys) {
          const storageKey = symbolAlertKey(sym);
          const cur: AlertRule = { ...(next[storageKey] ?? {}) };
          if (value === undefined || !Number.isFinite(value)) {
            delete cur[field];
          } else {
            cur[field] = value;
          }
          const empty =
            cur.takeProfitReturnPct === undefined && cur.stopLossReturnPct === undefined;
          if (empty) delete next[storageKey];
          else next[storageKey] = cur;
          const suffix = `::${sym}`;
          for (const k of Object.keys(next)) {
            if (k.startsWith("*::") || !k.endsWith(suffix)) continue;
            const pos = { ...(next[k] ?? {}) };
            delete pos.takeProfitReturnPct;
            delete pos.stopLossReturnPct;
            if (Object.keys(pos).length === 0) delete next[k];
            else next[k] = pos;
          }
        }
        return next;
      });
    },
    [],
  );

  /**
   * 보유자별 기준선 저장: localStorage(현재 state) + 서버 push.
   */
  const [savingAlertOwner, setSavingAlertOwner] = useState<string | null>(null);
  const [savingAlertAll, setSavingAlertAll] = useState(false);

  const pushAlertThresholdsToServer = useCallback(async () => {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 먼저 설정해야 서버에 저장할 수 있습니다.");
      return false;
    }
    safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(alertThresholdsByKey));
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "push",
        key,
        positions,
        cashByOwner,
        holdingsSortByOwner,
        sellLogByOwner: sellLog,
        ownerNames,
        targetStockWeightByOwner: loadAllTargetStockWeights(),
        ownerScratchpadByOwner: loadAllOwnerScratchpads(),
        rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
        usdKrw: fxRef.current.usd,
        eurKrw: fxRef.current.eur,
        ...getAlertThresholdsPayload(),
      }),
    });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
      const ts = j.updated_at ?? new Date().toISOString();
      safeSetItem(LAST_SYNC_TS_KEY, ts);
      clearLocalChanged();
      setLastSyncedAt(ts);
      return true;
    }
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setSyncMessage(j.error ?? "서버 저장 실패");
    return false;
  }, [
    cloudSyncKey,
    positions,
    cashByOwner,
    holdingsSortByOwner,
    sellLog,
    ownerNames,
    alertThresholdsByKey,
  ]);

  const saveAlertThresholdsForOwner = useCallback(
    async (ownerName: string) => {
      setSavingAlertOwner(ownerName);
      try {
        const ok = await pushAlertThresholdsToServer();
        if (ok) setSyncMessage(`${ownerName} 보유자 기준선(가격)을 서버에 저장했습니다.`);
      } finally {
        setSavingAlertOwner(null);
      }
    },
    [pushAlertThresholdsToServer],
  );

  const saveAllAlertThresholds = useCallback(async () => {
    setSavingAlertAll(true);
    try {
      const ok = await pushAlertThresholdsToServer();
      if (ok) setSyncMessage("기준선(가격·수익률 %)을 서버에 저장했습니다.");
    } finally {
      setSavingAlertAll(false);
    }
  }, [pushAlertThresholdsToServer]);

  const [form, setForm] = useState({
    symbol: "",
    name: "",
    quantity: "",
    avgPrice: "",
    purchaseUsdKrw: "",
    purchaseEurKrw: "",
    /** USD 매입 환율 자동입력용 매입일(한국 달력). 입력 시 매입일+2일 09:00(KST) 근처 Yahoo USD/KRW 반영 */
    purchaseDateForFx: "",
    /** 원형 차트·보유 표 그룹(미입력 시 티커); 현금성 자산은 「현금」 등으로 묶기 */
    chartGroup: "",
    currency: "USD" as "USD" | "EUR" | "KRW",
    accountType: "해외주식" as "해외주식" | "국내주식",
    /** 종목 추가 시 한 번에 넣을 담당자(복수) */
    selectedOwners: ["김승주"] as OwnerName[],
  });
  /** 종목명 수동 입력 시 자동 채움 비활성 (티커·통화·담당자 바꾸면 해제) */
  const skipAddFormAutoNameRef = useRef(false);
  /** 차트 그룹 수동 입력 시 자동 채움 비활성 */
  const skipAddFormAutoChartGroupRef = useRef(false);
  /** 종목 추가 폼: 추가 후 포커스 복귀용 티커 입력 ref */
  const addSymbolInputRef = useRef<HTMLInputElement>(null);
  /** 보유 티커 커스텀 자동완성 패널 */
  const [holdingsTickerSuggestOpen, setHoldingsTickerSuggestOpen] = useState(false);
  const [holdingsTickerSuggestHl, setHoldingsTickerSuggestHl] = useState(0);
  /** 매입 USD/KRW를 직접 수정한 뒤에는 매입일 자동 환율이 덮어쓰지 않음 */
  const addFormFxManualRef = useRef(false);
  const [purchaseFxAutoBusy, setPurchaseFxAutoBusy] = useState(false);
  const [addPositionError, setAddPositionError] = useState("");
  /** 종목 추가 누락 보유자 추적: 입력한 종목 목록과 완료한 보유자 목록 */
  const [addOwnerTracker, setAddOwnerTracker] = useState<
    { symbol: string; name: string; isKorean: boolean; doneOwners: string[] }[]
  >([]);
  /** 실현손익 누락 보유자 추적: 최근 입력한 티커·날짜와 완료한 보유자 목록 */
  const [sellOwnerTracker, setSellOwnerTracker] = useState<{ symbol: string; date: string; doneOwners: string[] } | null>(null);
  const [focusSymbolTrigger, setFocusSymbolTrigger] = useState(0);
  const actionSuccessToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionSuccessToast, setActionSuccessToast] = useState("");
  const showActionSuccessToast = useCallback((message: string) => {
    if (actionSuccessToastTimerRef.current) {
      clearTimeout(actionSuccessToastTimerRef.current);
    }
    setActionSuccessToast(message);
    actionSuccessToastTimerRef.current = setTimeout(() => {
      setActionSuccessToast("");
      actionSuccessToastTimerRef.current = null;
    }, 3200);
  }, []);
  const actionErrorToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionErrorToast, setActionErrorToast] = useState("");
  const showActionErrorToast = useCallback((message: string) => {
    if (actionErrorToastTimerRef.current) {
      clearTimeout(actionErrorToastTimerRef.current);
    }
    setActionErrorToast(message);
    actionErrorToastTimerRef.current = setTimeout(() => {
      setActionErrorToast("");
      actionErrorToastTimerRef.current = null;
    }, 4200);
  }, []);

  useEffect(
    () => () => {
      if (actionSuccessToastTimerRef.current) {
        clearTimeout(actionSuccessToastTimerRef.current);
      }
      if (actionErrorToastTimerRef.current) {
        clearTimeout(actionErrorToastTimerRef.current);
      }
    },
    [],
  );

  // 실현손익 추적: 관련 보유자 전원 완료 시 2.5초 후 자동 닫힘
  useEffect(() => {
    if (!sellOwnerTracker) return;
    const holders = ownerNames.filter((n) =>
      positions.some((p) => p.owner === n && p.symbol === sellOwnerTracker.symbol),
    );
    if (holders.length === 0) return;
    if (holders.some((n) => !sellOwnerTracker.doneOwners.includes(n))) return;
    const t = setTimeout(() => setSellOwnerTracker(null), 2500);
    return () => clearTimeout(t);
  }, [sellOwnerTracker, ownerNames, positions]);

  /** 상단 내비 활성 항목(스크롤 앵커 id 또는 dashboard) */
  const [activeTopNav, setActiveTopNav] = useState<string>("dashboard");
  const holdingsNavRef = useRef<HTMLDivElement>(null);
  const holdingsMenuRef = useRef<HTMLDivElement>(null);
  const [holdingsNavOpen, setHoldingsNavOpen] = useState(false);
  /** 종목별 합산 표 정렬 */
  const [holdingsBySymbolSort, setHoldingsBySymbolSort] = useState<
    "name" | "valueKrw" | "pnlPct" | "pnlKrw" | "owners"
  >("valueKrw");
  /** 종목별 합산: 티커 단위 vs 차트 그룹(같은 그룹명 합산) */
  const [holdingsBySymbolView, setHoldingsBySymbolView] = useState<
    "ticker" | "chartGroup"
  >("ticker");
  const [holdingsMenuPos, setHoldingsMenuPos] = useState<{
    top: number;
    left: number;
    minW: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!holdingsNavOpen) {
      setHoldingsMenuPos(null);
      return;
    }
    const el = holdingsNavRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const minW = Math.max(200, Math.round(rect.width));
    let left = rect.left;
    if (typeof window !== "undefined") {
      const pad = 8;
      left = Math.max(pad, Math.min(left, window.innerWidth - minW - pad));
    }
    setHoldingsMenuPos({ top: Math.round(rect.bottom + 6), left: Math.round(left), minW });
  }, [holdingsNavOpen, ownerNames.length]);

  useEffect(() => {
    if (!holdingsNavOpen) return;
    const onScrollOrResize = () => {
      const el = holdingsNavRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const minW = Math.max(200, Math.round(rect.width));
      let left = rect.left;
      if (typeof window !== "undefined") {
        const pad = 8;
        left = Math.max(pad, Math.min(left, window.innerWidth - minW - pad));
      }
      setHoldingsMenuPos({ top: Math.round(rect.bottom + 6), left: Math.round(left), minW });
    };
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [holdingsNavOpen, ownerNames.length]);

  useEffect(() => {
    if (!holdingsNavOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (holdingsNavRef.current?.contains(t) || holdingsMenuRef.current?.contains(t)) return;
      setHoldingsNavOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [holdingsNavOpen]);

  const goDashboardTop = useCallback(() => {
    setActiveTopNav("dashboard");
  }, []);

  const goDashboardSection = useCallback((elementId: string) => {
    setActiveTopNav(elementId);
    setHoldingsNavOpen(false);
  }, []);

  useEffect(() => {
    setAddPositionError("");
  }, [
    form.symbol,
    form.name,
    form.currency,
    form.selectedOwners,
    form.quantity,
    form.avgPrice,
    form.chartGroup,
    form.purchaseUsdKrw,
    form.purchaseEurKrw,
    form.purchaseDateForFx,
  ]);

  useEffect(() => {
    if (form.currency !== "USD") return;
    if (addFormFxManualRef.current) return;
    const ymd = form.purchaseDateForFx.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;

    const ac = new AbortController();
    let cancelled = false;

    void (async () => {
      setPurchaseFxAutoBusy(true);
      try {
        const r = await fetch(
          `/api/market/fx-settlement?purchaseDate=${encodeURIComponent(ymd)}`,
          { signal: ac.signal },
        );
        const j = (await r.json()) as { rate?: number; error?: string };
        if (!r.ok) throw new Error(j.error ?? "조회 실패");
        if (typeof j.rate !== "number" || !Number.isFinite(j.rate) || j.rate <= 0) {
          throw new Error("환율 데이터 없음");
        }
        if (cancelled) return;
        const rounded = Math.round(j.rate * 1000) / 1000;
        setForm((prev) => ({ ...prev, purchaseUsdKrw: String(rounded) }));
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        if (!cancelled) {
          showActionErrorToast(e instanceof Error ? e.message : "과거 환율 조회 실패");
        }
      } finally {
        if (!cancelled) setPurchaseFxAutoBusy(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [form.currency, form.purchaseDateForFx, showActionErrorToast]);

  // 정산환율 자동 보정: purchaseFxPending(현재환율 임시) USD 포지션·매수저널 중,
  // 매수일 + 2영업일 09:00 KST가 지난 것은 실제 정산환율을 받아 매입환율(·저널 환율/총액)을 교체한다.
  const settlementBackfillBusyRef = useRef(false);
  useEffect(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const isDue = (d: string): boolean => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      const target = krSettlementTargetUnixSec(d, 2, 9);
      return target !== null && target <= nowSec;
    };
    const dueDates = new Set<string>();
    for (const p of positions) {
      if (p.purchaseFxPending && p.currency === "USD" && typeof p.purchaseDate === "string") {
        const d = p.purchaseDate.trim();
        if (isDue(d)) dueDates.add(d);
      }
    }
    for (const b of buyJournal) {
      if (b.fxPending && b.currency === "USD" && typeof b.date === "string") {
        const d = b.date.trim();
        if (isDue(d)) dueDates.add(d);
      }
    }
    if (dueDates.size === 0 || settlementBackfillBusyRef.current) return;

    settlementBackfillBusyRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const rateByDate: Record<string, number> = {};
        for (const d of dueDates) {
          try {
            const r = await fetch(`/api/market/fx-settlement?purchaseDate=${encodeURIComponent(d)}`);
            const j = (await r.json()) as { rate?: number };
            if (r.ok && typeof j.rate === "number" && Number.isFinite(j.rate) && j.rate > 0) {
              rateByDate[d] = Math.round(j.rate * 1000) / 1000;
            }
          } catch {
            // 조회 실패한 날짜는 다음 기회에 다시 시도
          }
        }
        if (cancelled || Object.keys(rateByDate).length === 0) return;
        let anyChange = false;
        setPositions((prev) => {
          let changed = false;
          const next = prev.map((p) => {
            if (
              p.purchaseFxPending &&
              p.currency === "USD" &&
              typeof p.purchaseDate === "string" &&
              rateByDate[p.purchaseDate] != null
            ) {
              changed = true;
              const { purchaseFxPending: _drop, ...rest } = p;
              void _drop;
              return { ...rest, purchaseUsdKrw: rateByDate[p.purchaseDate] };
            }
            return p;
          });
          if (changed) anyChange = true;
          return changed ? next : prev;
        });
        setBuyJournal((prev) => {
          let changed = false;
          const next = prev.map((b) => {
            if (b.fxPending && b.currency === "USD" && rateByDate[b.date] != null) {
              changed = true;
              const fx = rateByDate[b.date];
              const { fxPending: _drop, ...rest } = b;
              void _drop;
              return { ...rest, fxRate: fx, totalKrw: b.qty * b.buyPrice * fx };
            }
            return b;
          });
          if (changed) anyChange = true;
          return changed ? next : prev;
        });
        if (anyChange) markLocalChanged();
      } finally {
        settlementBackfillBusyRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [positions, buyJournal]);

  // 매수저널 환율을 보유표 매입환율에 단방향 동기화한다.
  // (같은 보유자+종목+통화의 포지션 매입환율을 따름. 둘이 다르면 보유표가 기준)
  useEffect(() => {
    if (buyJournal.length === 0 || positions.length === 0) return;
    setBuyJournal((prev) => {
      let changed = false;
      const next = prev.map((b) => {
        if (b.currency === "KRW") return b;
        const pos = positions.find(
          (p) => p.owner === b.owner && p.symbol === b.symbol && p.currency === b.currency,
        );
        if (!pos) return b;
        const rate = b.currency === "USD" ? pos.purchaseUsdKrw : pos.purchaseEurKrw;
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return b;
        if (Math.abs(rate - b.fxRate) < 1e-6) return b;
        changed = true;
        return { ...b, fxRate: rate, totalKrw: b.qty * b.buyPrice * rate };
      });
      if (changed) markLocalChanged();
      return changed ? next : prev;
    });
  }, [positions, buyJournal]);

  const refreshLatestBackupAt = useCallback(async () => {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setLatestBackupAt(null);
      setHasLoadedLatestBackup(false);
      return;
    }
    setHasLoadedLatestBackup(false);
    try {
      const r = await fetch(`/api/backup/latest?sync_key=${encodeURIComponent(key)}`);
      const j = (await r.json()) as { latest_backup_at?: string | null };
      if (!r.ok) {
        setLatestBackupAt(null);
        setHasLoadedLatestBackup(false);
        return;
      }
      setHasLoadedLatestBackup(true);
      setLatestBackupAt(j.latest_backup_at ?? null);
    } catch {
      setLatestBackupAt(null);
      setHasLoadedLatestBackup(false);
    }
  }, [cloudSyncKey]);

  useEffect(() => {
    if (!syncReady || cloudSyncKey.trim().length < 8) {
      setLatestBackupAt(null);
      setHasLoadedLatestBackup(false);
      return;
    }
    void refreshLatestBackupAt();
  }, [syncReady, cloudSyncKey, refreshLatestBackupAt]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(OWNER_NAMES_STORAGE_KEY, JSON.stringify(ownerNames));
    if (skipOwnerLocalChangedRef.current > 0) {
      skipOwnerLocalChangedRef.current -= 1;
    } else {
      markLocalChanged();
    }
  }, [ownerNames, isHydrated]);

  useEffect(() => {
    // positions.owner만 추가 — cash/sort keys는 포함하지 않음
    // (cash/sort keys를 포함하면 삭제된 보유자가 부활하는 원인이 됨)
    const merged = normalizeOwnerNames([
      ...ownerNames,
      ...positions.map((p) => p.owner),
    ]);
    if (merged.length === ownerNames.length && merged.every((name, idx) => ownerNames[idx] === name)) {
      return;
    }
    setOwnerNames(merged);
  }, [ownerNames, positions]);

  const marketSymbols = useMemo(() => {
    const fromPos = positions.map((p) => p.symbol.trim()).filter(Boolean);
    const fromWl = watchlistRows.map((r) => r.symbol.trim()).filter(Boolean);
    return [...new Set([...fromPos, ...fromWl])].join(",");
  }, [positions, watchlistRows]);

  const marketQuery = useQuery<MarketResponse>({
    queryKey: ["market", marketSymbols],
    queryFn: async () => {
      const res = await fetch(`/api/market?symbols=${encodeURIComponent(marketSymbols)}`);
      if (!res.ok) {
        throw new Error("시세 조회 실패");
      }
      return res.json() as Promise<MarketResponse>;
    },
    /** 보유 종목이 없어도 USD/KRW만 받아 현금(USD) 환산·비중에 반영 */
    enabled: true,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  // 요청: 김승주 보유 종목에 대해 기술적 시그널 표시
  const signalSymbols = useMemo(
    () =>
      [
        ...new Set(
          positions
            .filter((p) => p.owner === "김승주")
            .map((p) => p.symbol)
            .filter(Boolean),
        ),
      ].join(","),
    [positions],
  );

  const historyQuery = useQuery<HistoryResponse>({
    queryKey: ["market-history", signalSymbols],
    queryFn: async () => {
      const res = await fetch(`/api/market/history?symbols=${encodeURIComponent(signalSymbols)}`);
      if (!res.ok) throw new Error("일봉 조회 실패");
      return res.json() as Promise<HistoryResponse>;
    },
    enabled: signalSymbols.length > 0,
    // 일봉은 분봉보다 덜 자주 바뀌므로 30분 캐시
    staleTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 30,
  });

  const signalBySymbol = useMemo(() => {
    const out = new Map<
      string,
      { final: TradeSignal; ma: TradeSignal; rsi: TradeSignal; bb: TradeSignal; vol: TradeSignal }
    >();
    const history = historyQuery.data?.history ?? {};
    for (const [symbol, prices] of Object.entries(history)) {
      const ma = calculateMACrossoverSignal(prices);
      const rsi = calculateRSISignal(prices);
      const bb = calculateBollingerSignal(prices);
      const vol = calculateVolumeSignal(prices);
      const buyCount = [ma, rsi, bb, vol].filter((s) => s === "BUY").length;
      const sellCount = [ma, rsi, bb, vol].filter((s) => s === "SELL").length;
      const final: TradeSignal = buyCount > sellCount ? "BUY" : sellCount > buyCount ? "SELL" : "HOLD";
      out.set(symbol, { final, ma, rsi, bb, vol });
    }
    return out;
  }, [historyQuery.data]);
  const sellLogOwnersForModal = useMemo(
    () => [...new Set([...ownerNames, ...Object.keys(sellLog)])],
    [ownerNames, sellLog],
  );
  useEffect(() => {
    if (ownerNames.length === 0) return;
    if (!ownerNames.includes(sellLogOwnerForSection)) {
      setSellLogOwnerForSection(ownerNames[0]);
    }
  }, [ownerNames, sellLogOwnerForSection]);
  useEffect(() => {
    if (ownerNames.length === 0) return;
    if (!ownerNames.includes(sellLogListViewOwner)) {
      setSellLogListViewOwner(ownerNames[0]);
    }
  }, [ownerNames, sellLogListViewOwner]);

  const usdKrw = marketQuery.data?.usdKrw ?? FALLBACK_USD_KRW;
  const eurKrw = marketQuery.data?.eurKrw ?? FALLBACK_EUR_KRW;
  /** 최초 시세·환율 응답 전에는 폴백값으로 계산된 요약 카드를 보여주지 않음(값이 튀는 현상 방지) */
  const isMarketLoading = marketQuery.data == null;
  // 동기화(push) 시점 환율을 항상 최신값으로 보관 — 어떤 push 경로에서도 스테일 클로저 없이 읽음.
  // (텔레그램이 "대시보드가 본 값"을 재현하려면 push마다 이 환율이 스냅샷에 함께 저장돼야 함)
  const fxRef = useRef({ usd: usdKrw, eur: eurKrw });
  fxRef.current = { usd: usdKrw, eur: eurKrw };

  // 미국 주간거래(데이마켓) 실시간 현재가 — 같은 앱의 서버리스 라우트 /api/overseas/daytime-price를 4초 폴링해 덮어씀.
  // 키: 티커(대문자). KIS env 미설정 시 라우트가 503 → 조용히 기존 Yahoo 시세 유지.
  const [daytimeQuotes, setDaytimeQuotes] = useState<
    Record<string, { price: number; prevClose: number | null; asOf: string }>
  >({});

  useEffect(() => {
    // 같은 Vercel 앱의 서버리스 라우트(상대경로) 사용 — 별도 백엔드(Railway) 불필요. CORS 없음.
    const usdSymbols = [
      ...new Set(
        positions
          .filter((p) => p.currency === "USD")
          .map((p) => (p.symbol ?? "").trim().toUpperCase())
          .filter((s) => s.length > 0),
      ),
    ];
    if (usdSymbols.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      if (!isUsTradingDayPollWindow()) return; // 미국 동부 평일만(주말 미국 휴장)
      try {
        // 일괄 조회(한 번의 요청으로 전 종목) — 서버리스 호출 수 절감.
        const r = await fetch(
          `/api/overseas/daytime-price?symbols=${encodeURIComponent(usdSymbols.join(","))}`,
        );
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as {
          quotes?: Record<string, { price?: number; prevClose?: number; asOf?: string }>;
        };
        const quotes = j.quotes ?? {};
        setDaytimeQuotes((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [sym, q] of Object.entries(quotes)) {
            if (typeof q.price !== "number" || !(q.price > 0)) continue;
            // KIS 전일종가(base)도 보관 — 전일대비/등락률을 가격과 같은 출처로 계산.
            const pc = typeof q.prevClose === "number" && q.prevClose > 0 ? q.prevClose : null;
            const cur = prev[sym];
            if (cur && cur.price === q.price && cur.prevClose === pc && cur.asOf === (q.asOf ?? "")) continue;
            next[sym] = { price: q.price, prevClose: pc, asOf: q.asOf ?? "" };
            changed = true;
          }
          return changed ? next : prev; // 변화 없으면 리렌더 방지
        });
      } catch {
        /* 폴링 실패는 무시(다음 주기 재시도) */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [positions]);

  const handleAddSymbolInput = useCallback(
    (value: string) => {
      skipAddFormAutoNameRef.current = false;
      skipAddFormAutoChartGroupRef.current = false;
      setForm((prev) => {
        const next = { ...prev, symbol: value };
        const inferred = inferTradingCurrencyFromTicker(value);
        if (inferred === null) return next;

        const usdFilled = prev.purchaseUsdKrw.trim() !== "";
        const eurFilled = prev.purchaseEurKrw.trim() !== "";
        const purchaseUsdDefault =
          prev.currency === "USD" && usdFilled ? prev.purchaseUsdKrw : String(Math.round(usdKrw));
        const purchaseEurDefault =
          prev.currency === "EUR" && eurFilled ? prev.purchaseEurKrw : String(Math.round(eurKrw));

        return {
          ...next,
          currency: inferred,
          accountType: inferred === "KRW" ? "국내주식" : "해외주식",
          purchaseUsdKrw: inferred === "USD" ? purchaseUsdDefault : "",
          purchaseEurKrw: inferred === "EUR" ? purchaseEurDefault : "",
        };
      });
    },
    [usdKrw, eurKrw],
  );

  /** 기존 보유 티커·종목명 — 커스텀 자동완성( datalist 대신 ) */
  const holdingsTickerOptions = useMemo(() => {
    const map = new Map<string, { symbol: string; name: string }>();
    for (const p of positions) {
      const raw = p.symbol?.trim();
      if (!raw) continue;
      const key = raw.toUpperCase();
      if (!map.has(key)) {
        map.set(key, { symbol: raw, name: (p.name ?? "").trim() });
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "en"))
      .map(([, v]) => v);
  }, [positions]);

  const filteredHoldingsTickers = useMemo(() => {
    const q = form.symbol.trim().toLowerCase();
    if (holdingsTickerOptions.length === 0) return [];
    if (!q) return holdingsTickerOptions.slice(0, 120);
    return holdingsTickerOptions
      .filter((o) => {
        const s = o.symbol.toLowerCase();
        const n = o.name.toLowerCase();
        return s.startsWith(q) || s.includes(q) || n.includes(q);
      })
      .slice(0, 120);
  }, [holdingsTickerOptions, form.symbol]);

  useEffect(() => {
    setHoldingsTickerSuggestHl(0);
  }, [form.symbol]);

  useEffect(() => {
    setHoldingsTickerSuggestHl((h) =>
      filteredHoldingsTickers.length === 0
        ? 0
        : Math.min(h, filteredHoldingsTickers.length - 1),
    );
  }, [filteredHoldingsTickers.length]);

  /** 티커·담당자에 맞춰 종목명·차트 그룹 자동 입력 (보유 줄 우선: 우선 같은 통화 줄, 없으면 동일 티커 다른 통화 줄을 쓰고 폼 통화를 그에 맞춤) */
  useEffect(() => {
    const raw = form.symbol.trim();
    if (!raw) return;

    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const symU = raw.toUpperCase();
        const ownersOrdered = ownerNames.filter((o) => form.selectedOwners.includes(o));

        for (const own of ownersOrdered) {
          const sameSymbol = positions.filter(
            (x) => x.owner === own && holdingSymbolsEquivalent(symU, x.symbol),
          );
          if (sameSymbol.length === 0) continue;

          const withCur = sameSymbol.filter((x) => x.currency === form.currency);
          const pool = withCur.length > 0 ? withCur : sameSymbol;
          const p =
            pool.find((x) => (x.chartGroup ?? "").trim() !== "") ??
            pool[0];

          if (!ac.signal.aborted) {
            setForm((prev) => {
              const next = { ...prev };
              const cur = p.currency;
              if (prev.currency !== cur) {
                addFormFxManualRef.current = false;
                next.currency = cur;
                next.accountType = cur === "KRW" ? "국내주식" : "해외주식";
                next.purchaseUsdKrw = cur === "USD" ? prev.purchaseUsdKrw : "";
                next.purchaseEurKrw = cur === "EUR" ? prev.purchaseEurKrw : "";
                next.purchaseDateForFx = cur === "USD" ? prev.purchaseDateForFx : "";
              }
              if (!skipAddFormAutoNameRef.current && p.name?.trim()) {
                next.name = p.name.trim();
              }
              if (!skipAddFormAutoChartGroupRef.current && p.chartGroup?.trim()) {
                next.chartGroup = p.chartGroup.trim();
              }
              return next;
            });
          }
          return;
        }

        if (skipAddFormAutoNameRef.current) return;

        try {
          const r = await fetch(
            `/api/symbol-name?symbols=${encodeURIComponent(raw)}`,
            { signal: ac.signal },
          );
          if (!r.ok) return;
          const j = (await r.json()) as { names?: Record<string, string> };
          const names = j.names ?? {};
          let resolved: string | undefined;
          for (const [k, v] of Object.entries(names)) {
            if (k.trim().toUpperCase() === symU && typeof v === "string" && v.trim()) {
              resolved = v.trim();
              break;
            }
          }
          if (resolved) {
            if (!ac.signal.aborted) {
              setForm((prev) => ({ ...prev, name: resolved }));
            }
          }
        } catch {
          /* AbortError 등 무시 */
        }
      })();
    }, 400);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [form.symbol, form.currency, form.selectedOwners, positions, ownerNames]);

  const totalCashKrw = useMemo(() => {
    return ownerNames.reduce((sum, owner) => {
      const c = cashByOwner[owner] ?? { usd: 0, krw: 0 };
      return sum + c.krw + c.usd * usdKrw;
    }, 0);
  }, [ownerNames, cashByOwner, usdKrw]);

  const enrichedPositions = useMemo(() => {
    return positions.map((position, sourceIndex) => {
      const q = marketQuery.data?.quotes?.[position.symbol];
      // 주간거래 시간대엔 KIS 실시간 현재가를 우선 적용(없으면 기존 시세). USD 종목만 해당.
      const daytimeQuote =
        position.currency === "USD"
          ? daytimeQuotes[(position.symbol ?? "").trim().toUpperCase()]
          : undefined;
      const daytimePrice = daytimeQuote?.price;
      // KIS 엔드포인트가 세션에 맞는 거래소 코드를 자동 선택(프리·정규·애프터=NAS 라이브, 미국 야간=주간거래).
      // 따라서 KIS 값이 있으면 항상 우선 사용(미국 거래 전 시간대를 4초 폴링으로 커버).
      const usingDaytime = typeof daytimePrice === "number" && daytimePrice > 0;
      const livePrice = usingDaytime ? daytimePrice : q?.price;
      // 주간거래 가격을 쓸 땐 전일대비·등락률도 KIS 전일종가(base) 기준으로 계산해야 가격과 %가 일치.
      const yahooPrevClose =
        typeof q?.previousClose === "number" && q.previousClose > 0 ? q.previousClose : null;
      const daytimePrevClose =
        usingDaytime && typeof daytimeQuote?.prevClose === "number" && daytimeQuote.prevClose > 0
          ? daytimeQuote.prevClose
          : null;
      const rawPreviousClose = usingDaytime ? (daytimePrevClose ?? yahooPrevClose) : yahooPrevClose;
      /** 전일 대비 등락은 "그 종목의 시장" 영업일에만 표시 (국내=한국장, 해외=미국장) */
      const previousClose =
        rawPreviousClose !== null && shouldShowDailyChangeForCurrency(position.currency)
          ? rawPreviousClose
          : null;
      const currentPrice = livePrice ?? position.currentPrice;
      const effectiveAvgPrice = position.avgPrice * (1 + TRADING_FEE_RATE);
      const pnl = ((currentPrice - effectiveAvgPrice) / effectiveAvgPrice) * 100;
      /** 매입 시 환율 없으면 현재 환율로 원가 추정(기존 데이터 호환) */
      const purchaseFx =
        position.currency === "USD"
          ? (position.purchaseUsdKrw ?? usdKrw)
          : position.currency === "EUR"
            ? (position.purchaseEurKrw ?? eurKrw)
            : 1;
      const valueKrw =
        position.currency === "USD"
          ? position.quantity * currentPrice * usdKrw
          : position.currency === "EUR"
            ? position.quantity * currentPrice * eurKrw
            : position.quantity * currentPrice;
      const costKrw = position.quantity * effectiveAvgPrice * purchaseFx;
      /** 해외(USD/EUR): 종목 통화 기준 주가 수익률 */
      const pnlUsdPct = position.currency === "USD" ? pnl : null;
      const pnlEurPct = position.currency === "EUR" ? pnl : null;
      /** 매입 환율 기준 원화 매입액 대비 현재 원화 평가 수익률 */
      const pnlKrwEquityPct =
        (position.currency === "USD" || position.currency === "EUR") && costKrw > 0
          ? ((valueKrw - costKrw) / costKrw) * 100
          : null;
      return {
        ...position,
        sourceIndex,
        currentPrice,
        previousClose,
        pnl,
        valueKrw,
        costKrw,
        purchaseFxUsed: purchaseFx,
        pnlUsdPct,
        pnlEurPct,
        pnlKrwEquityPct,
        marketState: q?.marketState ?? null,
      };
    });
  }, [positions, marketQuery.data, usdKrw, eurKrw, daytimeQuotes]);

  /** 보유자·계좌 무관 동일 티커 합산 — 평가·원가·손익·원화 기준 수익률 (표 정렬은 holdingsAggregatedBySymbolSorted) */
  const holdingsAggregatedBySymbol = useMemo(() => {
    type Acc = {
      key: string;
      displaySymbol: string;
      displayName: string;
      valueKrw: number;
      costKrw: number;
      owners: Set<string>;
      byOwner: Map<string, { valueKrw: number; costKrw: number }>;
    };
    const map = new Map<string, Acc>();
    for (const p of enrichedPositions) {
      if (!isStockRowForSymbolAggregate(p)) continue;
      const key = aggregateSymbolKeyForHoldings(p.symbol);
      const cur = map.get(key);
      if (!cur) {
        map.set(key, {
          key,
          displaySymbol: p.symbol.trim(),
          displayName: (p.name ?? "").trim() || p.symbol.trim(),
          valueKrw: p.valueKrw,
          costKrw: p.costKrw,
          owners: new Set([p.owner]),
          byOwner: new Map([[p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw }]]),
        });
      } else {
        cur.valueKrw += p.valueKrw;
        cur.costKrw += p.costKrw;
        cur.owners.add(p.owner);
        const om = cur.byOwner.get(p.owner);
        if (!om) {
          cur.byOwner.set(p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw });
        } else {
          om.valueKrw += p.valueKrw;
          om.costKrw += p.costKrw;
        }
        const nm = (p.name ?? "").trim();
        if (nm.length > cur.displayName.length) cur.displayName = nm || cur.displayName;
      }
    }
    return [...map.values()]
      .map((r) => {
        const pnlKrw = r.valueKrw - r.costKrw;
        const pnlPct = r.costKrw > 0 ? (pnlKrw / r.costKrw) * 100 : null;
        const ownersSorted = [...r.owners].sort((a, b) => a.localeCompare(b, "ko"));
        const ownerBreakdown = [...r.byOwner.entries()]
          .map(([owner, v]) => ({
            owner,
            valueKrw: v.valueKrw,
            costKrw: v.costKrw,
            pnlKrw: v.valueKrw - v.costKrw,
          }))
          .sort((a, b) => a.owner.localeCompare(b.owner, "ko"));
        const epForDaily = enrichedPositions.find(
          (e) =>
            isStockRowForSymbolAggregate(e) &&
            aggregateSymbolKeyForHoldings(e.symbol) === r.key,
        );
        const dailyPct =
          epForDaily &&
          epForDaily.previousClose !== null &&
          epForDaily.previousClose > 0
            ? ((epForDaily.currentPrice - epForDaily.previousClose) /
                epForDaily.previousClose) *
              100
            : null;
        const tooltipHeader = r.displaySymbol.trim().toUpperCase();
        const tooltipCompositionRows: HoldingsAggTipRow[] = [
          { code: r.displaySymbol.trim(), name: r.displayName, pct: dailyPct },
        ];
        const tooltipOwnerValueRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
          code: o.owner,
          name: `${fmtInt(o.valueKrw)}원`,
          pct: r.valueKrw > 0 ? (o.valueKrw / r.valueKrw) * 100 : null,
        }));
        const tooltipOwnerPnlRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
          code: o.owner,
          name: `${fmtInt(o.pnlKrw)}원`,
          pct:
            Math.abs(pnlKrw) > 1e-9 ? (o.pnlKrw / pnlKrw) * 100 : null,
        }));
        const tooltipOwnersListRows: HoldingsAggTipRow[] =
          ownersSorted.length > 0
            ? ownersSorted.map((o) => ({
                code: o,
                name: "",
                pct: null,
              }))
            : [{ code: "보유자 정보 없음", name: "", pct: null }];
        return {
          key: r.key,
          displaySymbol: r.displaySymbol,
          displayName: r.displayName,
          symbolsForAlert: [r.key],
          valueKrw: r.valueKrw,
          costKrw: r.costKrw,
          pnlKrw,
          pnlPct,
          ownerCount: r.owners.size,
          ownersLabel: ownersSorted.join(", "),
          ownerBreakdown,
          tooltipHeader,
          tooltipCompositionRows,
          tooltipOwnerValueRows,
          tooltipOwnerPnlRows,
          tooltipOwnersListRows,
        };
      })
  }, [enrichedPositions]);

  /** 동일 차트 그룹명끼리 합산(그룹 미입력 종목은 티커별로 동일 키 규칙) */
  const holdingsAggregatedByChartGroup = useMemo(() => {
    type Acc = {
      key: string;
      displaySymbol: string;
      valueKrw: number;
      costKrw: number;
      owners: Set<string>;
      /** 티커 → 구성란 표시(해외=티커, 국내=종목명) */
      symbolLineLabel: Map<string, string>;
      bestName: string;
      byOwner: Map<string, { valueKrw: number; costKrw: number }>;
    };
    const map = new Map<string, Acc>();
    for (const p of enrichedPositions) {
      if (!isStockRowForSymbolAggregate(p)) continue;
      const symKey = aggregateSymbolKeyForHoldings(p.symbol);
      const symDisplay = p.symbol.trim();
      const nm = (p.name ?? "").trim();
      const cg = (p.chartGroup ?? "").trim();
      const bucketKey = cg ? `g:${cg}` : `s:${symKey}`;
      const cur = map.get(bucketKey);
      const line = chartGroupCompositionLabel(p);
      if (!cur) {
        map.set(bucketKey, {
          key: bucketKey,
          displaySymbol: cg || symDisplay,
          valueKrw: p.valueKrw,
          costKrw: p.costKrw,
          owners: new Set([p.owner]),
          symbolLineLabel: new Map([[symDisplay, line]]),
          bestName: nm || symDisplay,
          byOwner: new Map([[p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw }]]),
        });
      } else {
        cur.valueKrw += p.valueKrw;
        cur.costKrw += p.costKrw;
        cur.owners.add(p.owner);
        const prevLine = cur.symbolLineLabel.get(symDisplay);
        if (prevLine === undefined) {
          cur.symbolLineLabel.set(symDisplay, line);
        } else if (p.currency !== "USD" && p.currency !== "EUR" && line.length > prevLine.length) {
          cur.symbolLineLabel.set(symDisplay, line);
        }
        if (nm.length > cur.bestName.length) cur.bestName = nm;
        const om = cur.byOwner.get(p.owner);
        if (!om) {
          cur.byOwner.set(p.owner, { valueKrw: p.valueKrw, costKrw: p.costKrw });
        } else {
          om.valueKrw += p.valueKrw;
          om.costKrw += p.costKrw;
        }
      }
    }
    return [...map.values()].map((r) => {
      const pnlKrw = r.valueKrw - r.costKrw;
      const pnlPct = r.costKrw > 0 ? (pnlKrw / r.costKrw) * 100 : null;
      const ownersSorted = [...r.owners].sort((a, b) => a.localeCompare(b, "ko"));
      const partsOrdered = [...r.symbolLineLabel.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([, lab]) => lab);
      const groupKind = r.key.startsWith("g:");
      const displayName = groupKind
        ? partsOrdered.length <= 1
          ? partsOrdered[0] ?? (r.bestName || r.displaySymbol)
          : `${partsOrdered.length}개 종목 · ${partsOrdered.slice(0, 5).join(", ")}${partsOrdered.length > 5 ? " …" : ""}`
        : r.bestName;
      const ownerBreakdown = [...r.byOwner.entries()]
        .map(([owner, v]) => ({
          owner,
          valueKrw: v.valueKrw,
          costKrw: v.costKrw,
          pnlKrw: v.valueKrw - v.costKrw,
        }))
        .sort((a, b) => a.owner.localeCompare(b.owner, "ko"));
      const dailyPctForSym = (symDisplay: string): number | null => {
        const ep = enrichedPositions.find(
          (e) => isStockRowForSymbolAggregate(e) && e.symbol.trim() === symDisplay,
        );
        if (!ep || ep.previousClose === null || ep.previousClose <= 0) return null;
        return ((ep.currentPrice - ep.previousClose) / ep.previousClose) * 100;
      };
      const tooltipCompositionRows: HoldingsAggTipRow[] = [...r.symbolLineLabel.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([sym, line]) => ({
          code: sym,
          name: line,
          pct: dailyPctForSym(sym),
        }));
      const tooltipHeader = r.displaySymbol.trim().toUpperCase();
      const tooltipOwnerValueRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
        code: o.owner,
        name: `${fmtInt(o.valueKrw)}원`,
        pct: r.valueKrw > 0 ? (o.valueKrw / r.valueKrw) * 100 : null,
      }));
      const tooltipOwnerPnlRows: HoldingsAggTipRow[] = ownerBreakdown.map((o) => ({
        code: o.owner,
        name: `${fmtInt(o.pnlKrw)}원`,
        pct: Math.abs(pnlKrw) > 1e-9 ? (o.pnlKrw / pnlKrw) * 100 : null,
      }));
      const tooltipOwnersListRows: HoldingsAggTipRow[] =
        ownersSorted.length > 0
          ? ownersSorted.map((o) => ({
              code: o,
              name: "",
              pct: null,
            }))
          : [{ code: "보유자 정보 없음", name: "", pct: null }];
      const symbolsForAlert = [...r.symbolLineLabel.keys()].map((s) =>
        aggregateSymbolKeyForHoldings(s),
      );
      return {
        key: r.key,
        displaySymbol: r.displaySymbol,
        displayName,
        symbolsForAlert,
        valueKrw: r.valueKrw,
        costKrw: r.costKrw,
        pnlKrw,
        pnlPct,
        ownerCount: r.owners.size,
        ownersLabel: ownersSorted.join(", "),
        ownerBreakdown,
        tooltipHeader,
        tooltipCompositionRows,
        tooltipOwnerValueRows,
        tooltipOwnerPnlRows,
        tooltipOwnersListRows,
      };
    });
  }, [enrichedPositions]);

  const holdingsAggSource =
    holdingsBySymbolView === "chartGroup"
      ? holdingsAggregatedByChartGroup
      : holdingsAggregatedBySymbol;

  const holdingsAggregatedBySymbolSorted = useMemo(() => {
    const rows = holdingsAggSource.slice();
    const cmpPctDesc = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    };
    switch (holdingsBySymbolSort) {
      case "name":
        rows.sort((a, b) =>
          a.displayName.localeCompare(b.displayName, "ko", { sensitivity: "base" }),
        );
        break;
      case "valueKrw":
        rows.sort(
          (a, b) =>
            b.valueKrw - a.valueKrw || a.displaySymbol.localeCompare(b.displaySymbol, "en"),
        );
        break;
      case "pnlPct":
        rows.sort(
          (a, b) =>
            cmpPctDesc(a.pnlPct, b.pnlPct) || b.valueKrw - a.valueKrw,
        );
        break;
      case "pnlKrw":
        rows.sort((a, b) => b.pnlKrw - a.pnlKrw || b.valueKrw - a.valueKrw);
        break;
      case "owners":
        rows.sort(
          (a, b) =>
            b.ownerCount - a.ownerCount || b.valueKrw - a.valueKrw,
        );
        break;
      default:
        break;
    }
    return rows;
  }, [holdingsAggSource, holdingsBySymbolSort]);

  const holdingsSymbolGrandTotals = useMemo(() => {
    const v = holdingsAggregatedBySymbol.reduce((s, r) => s + r.valueKrw, 0);
    const c = holdingsAggregatedBySymbol.reduce((s, r) => s + r.costKrw, 0);
    const pnl = v - c;
    const pct = c > 0 ? (pnl / c) * 100 : null;
    return { valueKrw: v, costKrw: c, pnlKrw: pnl, pnlPct: pct };
  }, [holdingsAggregatedBySymbol]);

  const alertLineHits = useMemo(() => {
    const out: Array<{
      key: string;
      owner: string;
      symbol: string;
      name: string;
      reasons: string[];
      currentPrice: number;
      returnPct: number | null;
    }> = [];
    for (const p of enrichedPositions) {
      const alertKey = positionAlertKey(p.owner, p.symbol);
      const rule = resolveAlertRule(alertThresholdsByKey, p.owner, p.symbol);
      if (!hasAlertThresholdRule(rule)) continue;
      const returnPct = positionReturnPctForAlert(p);
      const { hit, reasons } = evaluateAlertRule(rule, {
        price: typeof p.currentPrice === "number" && Number.isFinite(p.currentPrice) ? p.currentPrice : null,
        returnPct,
      });
      if (hit) {
        out.push({
          key: alertKey,
          owner: p.owner,
          symbol: p.symbol,
          name: p.name,
          reasons,
          currentPrice: p.currentPrice,
          returnPct,
        });
      }
    }
    return out;
  }, [enrichedPositions, alertThresholdsByKey]);

  const alertLineHitsByOwner = useMemo(() => {
    const map = new Map<string, typeof alertLineHits>();
    for (const h of alertLineHits) {
      const list = map.get(h.owner) ?? [];
      list.push(h);
      map.set(h.owner, list);
    }
    const orderedOwners: string[] = [];
    for (const o of ownerNames) {
      if (map.has(o)) orderedOwners.push(o);
    }
    for (const o of map.keys()) {
      if (!orderedOwners.includes(o)) orderedOwners.push(o);
    }
    return orderedOwners.map((owner) => ({
      owner,
      hits: (map.get(owner) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, "ko", { sensitivity: "base" }),
      ),
    }));
  }, [alertLineHits, ownerNames]);

  const summaryCards = useMemo(() => {
    const stockValue = enrichedPositions.reduce((sum, position) => sum + position.valueKrw, 0);
    const stockCost = enrichedPositions.reduce((sum, position) => sum + position.costKrw, 0);
    const totalValue = stockValue + totalCashKrw;
    const costBasis = stockCost + totalCashKrw;
    const totalProfit = totalValue - costBasis;
    const totalReturnPct = costBasis > 0 ? (totalProfit / costBasis) * 100 : 0;

    return [
      {
        label: "전체 수익률 (원화 기준)",
        value: `${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%`,
        sub: "투입(주식 원가+현금) 대비 평가",
        change: "",
        positive: totalReturnPct >= 0,
      },
      {
        label: "평가손익 (주식·원화)",
        value: `₩${fmtInt(totalProfit)}`,
        sub: "현금은 손익 없이 원금으로 포함",
        change: "",
        positive: totalProfit >= 0,
      },
    ];
  }, [enrichedPositions, totalCashKrw, usdKrw]);

  /** 상단 3칸 요약(미니 KIS 대시보드) */
  const kisMetrics = useMemo(() => {
    const stockValue = enrichedPositions.reduce((s, p) => s + p.valueKrw, 0);
    const stockCost = enrichedPositions.reduce((s, p) => s + p.costKrw, 0);
    const totalAppraisal = stockValue + totalCashKrw;
    return {
      totalAppraisal,
      totalCost: stockCost,
      deposit: totalCashKrw,
    };
  }, [enrichedPositions, totalCashKrw]);

  const allocationByOwner = useMemo(() => {
    return ownerNames.map((ownerName) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);
      // chartGroup이 있으면 그룹명 기준, 없으면 symbol 기준으로 차트 슬라이스 합산
      const groupMap = new Map<string, {
        displayName: string;
        allEntries: { name: string; symbol: string; value: number }[];
        value: number;
        weightedChangeSum: number;
        prevCloseValueSum: number;
      }>();
      for (const position of items) {
        const v = Math.max(0, Number.isFinite(position.valueKrw) ? position.valueKrw : 0);
        const prevClose =
          typeof position.previousClose === "number" && position.previousClose > 0
            ? position.previousClose
            : null;
        const dailyChangePct = prevClose !== null ? ((position.currentPrice - prevClose) / prevClose) * 100 : null;
        const groupKey = position.chartGroup?.trim() || position.symbol;
        const existing = groupMap.get(groupKey);
        if (existing) {
          existing.value += v;
          if (dailyChangePct !== null) {
            existing.weightedChangeSum += dailyChangePct * v;
            existing.prevCloseValueSum += v;
          }
          const entry = existing.allEntries.find(
            (e) => e.symbol === position.symbol && e.name === position.name,
          );
          if (entry) {
            entry.value += v;
          } else {
            existing.allEntries.push({ name: position.name, symbol: position.symbol, value: v });
          }
        } else {
          groupMap.set(groupKey, {
            displayName: position.chartGroup?.trim() || position.name,
            allEntries: [{ name: position.name, symbol: position.symbol, value: v }],
            value: v,
            weightedChangeSum: dailyChangePct !== null ? dailyChangePct * v : 0,
            prevCloseValueSum: dailyChangePct !== null ? v : 0,
          });
        }
      }
      const stockSlices = Array.from(groupMap.entries()).map(
        ([groupKey, { displayName, allEntries, value, weightedChangeSum, prevCloseValueSum }]) => ({
          name: `stk|${groupKey}|${ownerName}`,
          displayName,
          ticker: groupKey,
          allEntries: allEntries.map((entry) => ({
            name: entry.name,
            symbol: entry.symbol,
            value: entry.value,
          })),
          value,
          changePct: prevCloseValueSum > 0 ? weightedChangeSum / prevCloseValueSum : null,
        }),
      );

      const chartCashStockSlice = stockSlices.find((s) => s.ticker === "현금");
      const stockSlicesNoBundledCash = stockSlices.filter((s) => s.ticker !== "현금");

      const c = cashByOwner[ownerName] ?? { usd: 0, krw: 0 };
      const usd = Number.isFinite(c.usd) ? Math.max(0, c.usd) : 0;
      const krw = Number.isFinite(c.krw) ? Math.max(0, c.krw) : 0;
      const usdCashKrw = usd * usdKrw;

      /** 예수금(USD/KRW) + 차트그룹「현금」종목을 하나의 현금 조각으로 */
      type CashAgg = {
        name: string;
        displayName: string;
        ticker: string;
        allEntries: { name: string; symbol: string; value: number }[];
        value: number;
        changePct: number | null;
      };
      const cashBundleParts: CashAgg["allEntries"] = [];
      if (usdCashKrw > 0) {
        cashBundleParts.push({ name: "USD 현금", symbol: "", value: usdCashKrw });
      }
      if (krw > 0) {
        cashBundleParts.push({ name: "KRW 현금", symbol: "", value: krw });
      }
      const hasUsdDeposit = usdCashKrw > 0;
      const hasKrwDeposit = krw > 0;
      if (chartCashStockSlice) {
        for (const ent of chartCashStockSlice.allEntries) {
          const sym = typeof ent.symbol === "string" ? ent.symbol.trim() : "";
          const nm = typeof ent.name === "string" ? ent.name.trim() : "";
          if (sym === "" && nm === "USD 현금" && hasUsdDeposit) continue;
          if (sym === "" && nm === "KRW 현금" && hasKrwDeposit) continue;
          cashBundleParts.push({
            name: ent.name,
            symbol: typeof ent.symbol === "string" ? ent.symbol : "",
            value: ent.value,
          });
        }
      }
      const mergedCashEntries = mergeCashBundleDisplayEntries(cashBundleParts);
      const cashBundleValue = mergedCashEntries.reduce((s, e) => s + e.value, 0);

      const extra: CashAgg[] = [];
      if (cashBundleValue > 0 && mergedCashEntries.length > 0) {
        extra.push({
          name: `cash-bundle|${ownerName}`,
          displayName: "현금",
          ticker: "현금",
          allEntries: mergedCashEntries,
          value: cashBundleValue,
          changePct: chartCashStockSlice?.changePct ?? null,
        });
      }

      const merged = [...stockSlicesNoBundledCash, ...extra];
      const total = merged.reduce((sum, item) => sum + item.value, 0);
      const data = merged.map((item) => ({
        ...item,
        allEntries: item.allEntries.map((entry) => ({
          name: entry.name,
          symbol: entry.symbol,
          weight: total > 0 ? (entry.value / total) * 100 : 0,
        })),
        weight: total > 0 ? (item.value / total) * 100 : 0,
      }));
      return { ownerName, data, total };
    });
  }, [ownerNames, enrichedPositions, cashByOwner, usdKrw]);

  const positionsByOwner = useMemo(() => {
    return ownerNames.map((ownerName) => {
      const items = enrichedPositions.filter((p) => p.owner === ownerName);
      const sectionStockValue = items.reduce((sum, item) => sum + item.valueKrw, 0);
      const sectionStockCost = items.reduce((sum, item) => sum + item.costKrw, 0);
      const c = cashByOwner[ownerName] ?? { usd: 0, krw: 0 };
      const sectionCashKrw = c.krw + c.usd * usdKrw;
      const sectionTotal = sectionStockValue + sectionCashKrw;
      /** 주식 원가 + 현금(원화 환산) — 상단 카드와 동일한 투입 기준 */
      const sectionCostBasis = sectionStockCost + sectionCashKrw;
      const sectionPnL = sectionTotal - sectionCostBasis;
      const sectionPnLPct =
        sectionCostBasis > 0 ? (sectionPnL / sectionCostBasis) * 100 : 0;
      return {
        ownerName,
        items,
        sectionStockValue,
        sectionStockCost,
        sectionCashKrw,
        sectionTotal,
        sectionCostBasis,
        sectionPnL,
        sectionPnLPct,
        cashUsd: c.usd,
        cashKrw: c.krw,
      };
    });
  }, [ownerNames, enrichedPositions, cashByOwner, usdKrw]);

  /** 보유자별 그룹 오늘 등락 요약 (내림차순 정렬) */
  const ownerGroupDailySummary = useMemo(() => {
    return positionsByOwner.map((group) => {
      const blocks = buildHoldingsGroupBlocks(group.items);
      const groups = blocks.map((block) => {
        const dailyChangeKrw = block.items.reduce((sum, p) => {
          if (p.previousClose === null) return sum;
          const diff = p.currentPrice - p.previousClose;
          const krw =
            p.currency === "USD" ? diff * p.quantity * usdKrw
            : p.currency === "EUR" ? diff * p.quantity * eurKrw
            : diff * p.quantity;
          return sum + krw;
        }, 0);
        const prevSumKrw = block.items.reduce((sum, p) => {
          if (p.previousClose === null) return sum;
          const v =
            p.currency === "USD" ? p.previousClose * p.quantity * usdKrw
            : p.currency === "EUR" ? p.previousClose * p.quantity * eurKrw
            : p.previousClose * p.quantity;
          return sum + v;
        }, 0);
        const dailyChangePct = prevSumKrw > 0 ? (dailyChangeKrw / prevSumKrw) * 100 : null;
        const holdingsItems = (() => {
          const seen = new Set<string>();
          return block.items.flatMap((p) => {
            const sym = typeof p.symbol === "string" ? p.symbol.trim() : "";
            const nm = typeof p.name === "string" ? p.name.trim() : "";
            const key = sym || nm;
            if (!key || seen.has(key)) return [];
            seen.add(key);
            const pct =
              typeof p.previousClose === "number" && p.previousClose > 0
                ? ((p.currentPrice - p.previousClose) / p.previousClose) * 100
                : null;
            return [{ ticker: sym || nm, name: nm || sym, pct }];
          });
        })();
        // 그룹이 없는 단일 국내 종목은 라벨이 티커 코드(예: A446770)뿐이므로,
        // 화면에는 종목명을 노출한다(없으면 티커 유지). 해외 티커(SNDK 등)는 그대로.
        const displayLabel = isKrxListedEquityCode(block.label)
          ? block.items.find((p) => typeof p.name === "string" && p.name.trim())?.name?.trim() ||
            block.label
          : block.label;
        return { label: displayLabel, dailyChangeKrw, dailyChangePct, holdingsItems };
      }).sort((a, b) => b.dailyChangeKrw - a.dailyChangeKrw);
      const totalDailyKrw = groups.reduce((s, g) => s + g.dailyChangeKrw, 0);
      const prevStockKrw = group.items.reduce((s, p) => {
        if (p.previousClose === null) return s;
        const v =
          p.currency === "USD" ? p.previousClose * p.quantity * usdKrw
          : p.currency === "EUR" ? p.previousClose * p.quantity * eurKrw
          : p.previousClose * p.quantity;
        return s + v;
      }, 0);
      const prevTotalKrw = prevStockKrw + group.sectionCashKrw;
      const totalDailyPct = prevTotalKrw > 0 ? (totalDailyKrw / prevTotalKrw) * 100 : null;
      return { ownerName: group.ownerName, groups, totalDailyKrw, totalDailyPct };
    });
  }, [positionsByOwner, usdKrw, eurKrw]);

  // 보유자 표시 순서는 ownerNames 배열을 기준으로 한다(드래그 재정렬 시 ownerNames를 바꿔
  // 요약 카드·보유종목 그리드가 함께 같은 순서로 정렬되게 함). ownerNames는 로컬·서버에 동기화됨.
  const allocationByOwnerForGrid = useMemo(
    () => sortPortfolioGridRows(allocationByOwner, ownerNames),
    [allocationByOwner, ownerNames],
  );

  const ownerGroupDailySummaryForGrid = useMemo(
    () => sortPortfolioGridRows(ownerGroupDailySummary, ownerNames),
    [ownerGroupDailySummary, ownerNames],
  );

  const handleReorderOwners = useCallback((orderedOwnerNames: string[]) => {
    setOwnerNames((prev) => {
      const inOrder = orderedOwnerNames.filter((n) => prev.includes(n));
      const rest = prev.filter((n) => !inOrder.includes(n));
      const next = [...inOrder, ...rest];
      // 순서가 동일하면 state 갱신 생략(불필요한 재렌더·동기화 방지)
      if (next.length === prev.length && next.every((n, i) => n === prev[i])) return prev;
      return next;
    });
    markLocalChanged();
  }, []);

  const dailyLiveChangeByDate = useMemo<Record<string, DailyLiveChange>>(() => {
    const date = todayKST();

    // 소유자별 전일 기준 총액 (prevStock + 현금) — aggregateOwnerTotals가 올바른 %를 계산하려면
    // 각 그룹의 changePct 분모를 "그룹 자체 기준"이 아닌 "소유자 전체 기준"으로 통일해야 함
    const ownerPrevKrwMap = new Map<string, number>(
      positionsByOwner.map((g) => {
        const prevStock = g.items.reduce((s, p) => {
          if (p.previousClose === null) return s;
          const v =
            p.currency === "USD" ? p.previousClose * p.quantity * usdKrw
            : p.currency === "EUR" ? p.previousClose * p.quantity * eurKrw
            : p.previousClose * p.quantity;
          return s + v;
        }, 0);
        return [g.ownerName, prevStock + g.sectionCashKrw] as [string, number];
      }),
    );

    const ownerChanges = ownerGroupDailySummary
      .flatMap((owner) => {
        const ownerPrevKrw = ownerPrevKrwMap.get(owner.ownerName) ?? 0;
        return owner.groups.map((g) => ({
          name: `${owner.ownerName} · ${g.label}`,
          changeKrw: g.dailyChangeKrw,
          // 소유자 전체 전일 총액 대비 %로 통일 → aggregateOwnerTotals 합산이 정확해짐
          changePct: ownerPrevKrw > 0 ? (g.dailyChangeKrw / ownerPrevKrw) * 100 : g.dailyChangePct,
        }));
      })
      .sort((a, b) => Math.abs(b.changeKrw) - Math.abs(a.changeKrw));

    const totalChangeKrw = ownerGroupDailySummary.reduce((sum, owner) => sum + owner.totalDailyKrw, 0);
    const prevTotalKrw = [...ownerPrevKrwMap.values()].reduce((s, v) => s + v, 0);

    return {
      [date]: {
        date,
        changeKrw: totalChangeKrw,
        changePct: prevTotalKrw > 0 ? (totalChangeKrw / prevTotalKrw) * 100 : null,
        ownerChanges,
        compareNote: "실시간 전일종가 기준",
      },
    };
  }, [ownerGroupDailySummary, positionsByOwner, usdKrw, eurKrw]);

  const dailyTrendTradeMarkers = useMemo<DailyTradeMarker[]>(() => {
    const acc: DailyTradeMarker[] = [];
    for (const b of buyJournal) {
      acc.push({
        id: b.id,
        isoDate: b.date,
        kind: "buy",
        owner: b.owner,
        stockName: b.name,
        symbol: b.symbol,
        qty: b.qty,
        unitPrice: b.buyPrice,
        totalKrw: b.totalKrw,
        currency: b.currency,
        ...(b.currency === "KRW" ? {} : { fxRate: b.fxRate }),
      });
    }
    for (const [owner, entries] of Object.entries(sellLog)) {
      for (const e of entries) {
        const fx = Number(e.fxRate) > 0 ? Number(e.fxRate) : 1;
        const totalKrw =
          e.currency === "KRW" ? e.qty * e.sellPrice : e.qty * e.sellPrice * fx;
        const costBasisKrw =
          e.currency === "KRW" ? e.avgPrice * e.qty : e.avgPrice * e.qty * fx;
        const realizedPct =
          costBasisKrw > 0 ? (e.realizedKrw / costBasisKrw) * 100 : null;
        acc.push({
          id: e.id,
          isoDate: e.date,
          kind: "sell",
          owner,
          stockName: e.name,
          symbol: e.symbol,
          qty: e.qty,
          unitPrice: e.sellPrice,
          totalKrw,
          currency: e.currency,
          realizedKrw: e.realizedKrw,
          realizedPct,
          costBasisKrw,
          ...(e.currency === "KRW" ? {} : { fxRate: fx }),
        });
      }
    }
    return acc;
  }, [buyJournal, sellLog]);

  // 시세 로드 완료 후 오늘 스냅샷 자동 저장 (하루 1회 로컬 + 서버)
  useEffect(() => {
    if (!isHydrated) return;
    const hasRealPrices = positionsByOwner.some((g) => g.sectionTotal > 0);
    if (!hasRealPrices) return;
    // 환율 미확보(폴백 상수 1350/1450 사용 중) + 해당 통화 보유 시 → 스냅샷 저장 보류.
    // 폴백 환율로 미국·유럽 평가액이 통째로 왜곡돼 가짜 등락이 기록되는 것을 막는다.
    const hasUsdHolding = positions.some((p) => p.currency === "USD");
    const hasEurHolding = positions.some((p) => p.currency === "EUR");
    const fxMissing =
      (hasUsdHolding && marketQuery.data?.usdKrw == null) ||
      (hasEurHolding && marketQuery.data?.eurKrw == null);
    if (fxMissing) return;
    const today = todayKST();
    const ownerValues: Record<string, number> = {};
    const breakdownValues: Record<string, number> = {};
    let totalValue = 0;
    for (const g of positionsByOwner) {
      ownerValues[g.ownerName] = g.sectionTotal;
      totalValue += g.sectionTotal;

      // 달력 툴팁에서 "어떤 자산(그룹)이 변동했는지" 보여주기 위한 상세 스냅샷
      const blocks = buildHoldingsGroupBlocks(g.items);
      for (const block of blocks) {
        breakdownValues[`${g.ownerName} · ${block.label}`] = block.sumKrw;
      }
      if (g.sectionCashKrw > 0) {
        breakdownValues[`${g.ownerName} · 현금`] = g.sectionCashKrw;
      }
    }
    const snap: DailySnapshot = { date: today, ownerValues, breakdownValues, totalValue, savedAt: Date.now() };
    // 로컬 저장 (항상 오늘 최신값으로 갱신)
    saveDailySnapshot(snap);
    setDailySnapshots(loadDailySnapshots());

    // ── 어제 스냅샷 백필(보존 우선) ───────────────────────────────────────────
    //   어제 값을 매번 "현재 포지션 × 전일 종가 + 현재 현금"으로 덮어쓰면,
    //   오늘 입금/출금·매매가 어제 칸으로 새어 들어가 자산 추이가 왜곡된다.
    //   (예: 오늘 현금 1,000만 입금 → 어제 값도 1,000만 부풀려져 입금 점프가 사라짐)
    //   → 어제 기록이 이미 있으면 그날 실제값을 보존하고, 전혀 없을 때만 추정값으로 채운다.
    //   "어제 대비 등락률"은 dailyLiveChangeByDate가 실시간 동일포지션 기준으로 별도 계산하므로
    //   어제 스냅샷을 덮어쓰지 않아도 등락률 표시는 영향받지 않는다.
    const yday = yesterdayKST();
    const ydayAlreadyRecorded = loadDailySnapshots().some((s) => s.date === yday);
    if (!ydayAlreadyRecorded) {
      const prevOwnerValues: Record<string, number> = {};
      const prevBreakdownValues: Record<string, number> = {};
      let prevTotalValue = 0;
      for (const g of positionsByOwner) {
        const prevStock = g.items.reduce((s, p) => {
          const price = (typeof p.previousClose === "number" && p.previousClose > 0)
            ? p.previousClose : p.currentPrice;
          const v =
            p.currency === "USD" ? price * p.quantity * usdKrw
            : p.currency === "EUR" ? price * p.quantity * eurKrw
            : price * p.quantity;
          return s + v;
        }, 0);
        const ownerPrevTotal = prevStock + g.sectionCashKrw;
        prevOwnerValues[g.ownerName] = ownerPrevTotal;
        prevTotalValue += ownerPrevTotal;
        const blocks = buildHoldingsGroupBlocks(g.items);
        for (const block of blocks) {
          const blockPrev = block.items.reduce((s, p) => {
            const price = (typeof p.previousClose === "number" && p.previousClose > 0)
              ? p.previousClose : p.currentPrice;
            const v =
              p.currency === "USD" ? price * p.quantity * usdKrw
              : p.currency === "EUR" ? price * p.quantity * eurKrw
              : price * p.quantity;
            return s + v;
          }, 0);
          prevBreakdownValues[`${g.ownerName} · ${block.label}`] = blockPrev;
        }
        if (g.sectionCashKrw > 0) {
          prevBreakdownValues[`${g.ownerName} · 현금`] = g.sectionCashKrw;
        }
      }
      if (prevTotalValue > 0) {
        saveDailySnapshot({
          date: yday,
          ownerValues: prevOwnerValues,
          breakdownValues: prevBreakdownValues,
          totalValue: prevTotalValue,
          savedAt: Date.now(),
        });
        setDailySnapshots(loadDailySnapshots());
      }
    }

    // 서버 저장: KST 16~18시(장 마감 직후)에만 push
    // → 한국 장 마감(15:30) 후 종가 + 전일 미국 종가 기준으로, 매일 동일 시점(종가)으로 기록.
    // → 18시 이후(미국장 진행 중) push를 막아, 저녁 중간 시세가 그 날 값으로 굳는 것을 방지.
    //   (서버 크론도 KST 16·17시에 같은 종가 기준으로 기록하므로 시점이 일치함)
    try {
      const key = window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "";
      const nowKstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
      const isKoreanCloseWindow = nowKstHour >= 16 && nowKstHour < 18; // KST 16:00~17:59
      if (key.length >= 8 && isKoreanCloseWindow) {
        // 오늘 스냅샷 push
        const pushedDate = window.localStorage.getItem(SNAPSHOT_PUSHED_DATE_KEY) ?? "";
        const pushedTotal = Number(window.localStorage.getItem(SNAPSHOT_PUSHED_TOTAL_KEY) ?? "0");
        const valueDiff = pushedTotal > 0 ? Math.abs(totalValue - pushedTotal) / pushedTotal : 1;
        if (pushedDate !== today || valueDiff >= 0.01) {
          void fetch("/api/snapshot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sync_key: key, date: today, ownerValues, breakdownValues, totalValue }),
          }).then((r) => {
            if (r.ok) {
              safeSetItem(SNAPSHOT_PUSHED_DATE_KEY, today);
              safeSetItem(SNAPSHOT_PUSHED_TOTAL_KEY, String(totalValue));
            }
          }).catch(() => {});
        }
        // ※ 어제(이전 날짜) 스냅샷은 클라이언트가 push하지 않는다.
        //   서버 크론(/api/cron/daily-snapshot, KST 16·17시)이 매일 그날의 실제값을 기록하므로,
        //   클라이언트가 "현재 포지션 × 전일 종가"로 재계산해 덮어쓰면 과거 실제값이 훼손된다.
      }
    } catch {}
  }, [positionsByOwner, isHydrated, usdKrw, eurKrw]);

  /** pull → 있으면 반영, 없으면 이 기기(pos/cash/정렬)를 push (최초 기기·키 저장 직후 공통) */
  const syncWithServerForKey = useCallback(
    async (
      key: string,
      pos: Position[],
      cash: CashByOwner,
      holdingsSort: Record<OwnerName, HoldingsSortMode>,
      sellLogByOwner: Record<string, SellLogEntry[]>,
      buyJournalEntries: BuyJournalEntry[],
      owners: OwnerName[],
      /** true이면 로컬 변경 여부와 무관하게 항상 pull 우선 */
      forcePull = false,
    ) => {
    setSyncBusy(true);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull", key }),
      });
      const j = (await r.json()) as {
        error?: string;
        found?: boolean;
        positions?: unknown;
        cash_by_owner?: unknown;
        holdings_sort_by_owner?: unknown;
        sell_log_by_owner?: unknown;
        buy_journal?: unknown;
        owner_names?: unknown;
        target_stock_weight_by_owner?: unknown;
        owner_scratchpad_by_owner?: unknown;
        rebalance_calculator_by_owner?: unknown;
        alert_thresholds_by_position?: unknown;
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "동기화를 사용할 수 없습니다.");
        return;
      }
      if (j.found) {
        const serverTs = typeof j.updated_at === "string" ? j.updated_at.trim() : "";
        const lastSyncTs = (window.localStorage.getItem(LAST_SYNC_TS_KEY) ?? "").trim();
        const hasLocalChanges = window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) === "1";

        const cacheMissing = isLocalPortfolioCacheCleared();
        const serverNewer = isServerSnapshotNewerThanLocal(serverTs, lastSyncTs);

        // ── 충돌 감지: 이 기기에 미저장 변경이 있고(서버에 안 올라감) 서버가 더 최신 ──
        //   = 다른 기기가 마지막 동기화 이후 서버에 새 데이터를 올렸음.
        //   이 기기 데이터로 그냥 push하면 다른 기기의 변경이 유실되므로
        //   (C) 덮어쓰기 전 서버 상태를 자동 백업하고 (A) 사용자에게 방향을 확인한다.
        let conflictChoice: "push" | "applyServer" | null = null;
        if (hasLocalChanges && serverNewer && !forcePull) {
          const localChangedAtRaw = (window.localStorage.getItem(LOCAL_CHANGES_AT_KEY) ?? "").trim();
          const lastSyncAgeMs = (() => {
            const t = Date.parse(lastSyncTs);
            return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
          })();
          if (localChangedAtRaw.length === 0) {
            // 수정 시각 기록이 없는 플래그 = 매수저널·알림설정 자동 이행(사용자 수정 아님).
            // 묻지 않고 서버 최신을 따른다 — "취소를 눌러도 충돌창이 계속 뜨는" 반복 방지.
            // (적용 후 자동 이행 데이터는 auto-push가 조용히 다시 서버에 올린다)
            conflictChoice = "applyServer";
          } else if (lastSyncAgeMs < CONFLICT_AUTO_PUSH_IF_SYNCED_WITHIN_MS) {
            // 이 기기는 방금 전까지 서버와 같은 상태였음 → 데이터가 낡지 않았으므로
            // 묻지 않고 이 기기 변경을 우선 저장한다(활발히 수정 중 모달 폭탄 방지).
            // 덮어쓰기 전 서버 상태는 자동 백업되어 복원 가능.
            try {
              await fetch("/api/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sync_key: key }),
              });
            } catch {
              // 백업 실패해도 진행 — 이 기기 기준 데이터가 최신 작업본
            }
            conflictChoice = "push";
            setSyncMessage("다른 기기의 저장과 겹쳐 이 기기 변경을 우선 저장했습니다. (직전 서버 상태는 자동 백업됨)");
          } else {
            // 이 기기가 오래(10분+) 동기화되지 않았던 경우(며칠 묵은 탭 등)만 사용자에게 확인.
            // C: 덮어쓰기로 사라질 "현재 서버 상태"를 백업 테이블에 자동 저장 (snapshot 생략 = 서버가 자기 상태를 백업)
            try {
              await fetch("/api/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sync_key: key }),
              });
            } catch {
              // 백업 실패해도 동기화 흐름은 계속 (아래 확인에서 사용자가 판단)
            }
            // A: 어느 쪽을 살릴지 확인 (각 데이터의 시각을 함께 표기)
            const serverTimeLabel = formatKstForConflict(serverTs);
            const localTimeLabel = formatKstForConflict(localChangedAtRaw);
            const overwrite = window.confirm(
              [
                "⚠️ 동기화 충돌",
                "",
                `서버: 다른 기기에서 저장한 더 최신 데이터 (${serverTimeLabel} 저장)`,
                `이 기기: 아직 서버에 올리지 않은 변경 (${localTimeLabel} 마지막 수정)`,
                "",
                `[확인] 이 기기 데이터(${localTimeLabel} 수정)로 서버를 덮어씁니다.`,
                "         (직전 서버 상태는 방금 자동 백업되어 복원 가능)",
                `[취소] 서버 데이터(${serverTimeLabel} 저장)를 이 기기로 불러옵니다.`,
                "         (이 기기의 미저장 변경은 버려집니다)",
              ].join("\n"),
            );
            conflictChoice = overwrite ? "push" : "applyServer";
          }
        }

        const shouldApplyServer =
          forcePull ||
          conflictChoice === "applyServer" ||
          (!hasLocalChanges && (serverNewer || (lastSyncTs.length > 0 && cacheMissing)));

        if (shouldApplyServer) {
          // ─ forcePull(키 변경 시) 또는 서버가 더 최신이고 로컬 미반영 변경 없음 → 서버 데이터를 적용
          //   (동기 시각만 남고 positions/owner_names 키는 지운 경우에도 서버 스냅샷을 다시 적용)
          setSyncMessage("서버에서 최신 잔고를 불러왔습니다.");
          skipMarkLocalChangedRef.current = 2;
          skipOwnerLocalChangedRef.current = 1;
          skipSellLogLocalChangedRef.current = 1;
          const valid = Array.isArray(j.positions)
            ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
            : [];
          const pulledOwners = inferOwnerNamesFromSyncPayload(j);
          const allowedOwners = new Set(pulledOwners);
          const filtered = valid.filter((p) => allowedOwners.has(p.owner));
          setPositions(mergeDuplicatePositions(filtered));
          setCashByOwner(normalizeCashStrict(j.cash_by_owner, pulledOwners));
          setHoldingsSortByOwner(normalizeHoldingsSortStrict(j.holdings_sort_by_owner, pulledOwners));
          setSellLog(normalizeSellLogStrict(j.sell_log_by_owner, pulledOwners));
          setOwnerNames(pulledOwners);
          const clockToStore = serverTs.length > 0 ? serverTs : new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, clockToStore);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, clockToStore);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
          setLastSyncedAt(clockToStore);
          setLastSellLogSyncedAt(clockToStore);
          setSellLogDirty(false);
          mergeAndPersistTargetStockWeightsFromServer(j.target_stock_weight_by_owner);
          mergeAndPersistOwnerScratchpadsFromServer(j.owner_scratchpad_by_owner);
          mergeAndPersistRebalanceCalculatorFromServer(j.rebalance_calculator_by_owner);
          const localAlerts = loadAlertThresholdsFromStorage();
          const fromServerAlerts = mergeAlertThresholdsFromServer(
            j.alert_thresholds_by_position,
            pulledOwners,
          );
          const mergedAlerts = mergeAlertThresholdsOnPull(
            localAlerts,
            j.alert_thresholds_by_position,
            pulledOwners,
          );
          setAlertThresholdsByKey(mergedAlerts);
          safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(mergedAlerts));
          skipAlertThresholdsHydrateRef.current = 1;
          // 자동 이행 플래그는 10분 간격으로만 재시도 — 업로드 실패가 반복돼도 push 폭주 방지
          const allowAutoKeep = canMarkAutoMigrationKeep();
          let autoKeepFired = false;
          if (
            allowAutoKeep &&
            Object.keys(fromServerAlerts).length === 0 &&
            Object.keys(mergedAlerts).length > 0
          ) {
            // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만 — 충돌창 판단에서 제외됨
            safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
            autoKeepFired = true;
          }
          // 매수저널: 서버에 있으면 교체, 서버가 비어있으면(컬럼 신설 직후 등)
          // 이 기기 기록을 보존하고 다음 push로 서버에 올린다.
          const serverBuyJournal = normalizeBuyJournalStrict(j.buy_journal, pulledOwners);
          if (serverBuyJournal.length > 0) {
            skipBuyJournalLocalChangedRef.current = 1;
            setBuyJournal(serverBuyJournal);
          } else if (allowAutoKeep && buyJournalEntries.length > 0) {
            // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만 — 충돌창 판단에서 제외됨
            safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
            autoKeepFired = true;
          }
          if (autoKeepFired) recordAutoMigrationKeep();
        } else if (hasLocalChanges) {
          // ─ 로컬에 미반영 변경이 있고 충돌이 없거나(서버가 더 최신이 아님)
          //   충돌 시 사용자가 "이 기기로 덮어쓰기"를 선택한 경우 → 로컬을 서버에 올림.
          //   (충돌 시 직전 서버 상태는 위에서 자동 백업됨)
          const rPush = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "push",
              key,
              positions: pos,
              cashByOwner: cash,
              holdingsSortByOwner: holdingsSort,
              sellLogByOwner,
              buyJournal: buyJournalEntries,
              ownerNames: owners,
              targetStockWeightByOwner: loadAllTargetStockWeights(),
              ownerScratchpadByOwner: loadAllOwnerScratchpads(),
              rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
              usdKrw: fxRef.current.usd,
              eurKrw: fxRef.current.eur,
              ...getAlertThresholdsPayload(),
            }),
          });
          const jPush = (await rPush.json()) as { ok?: boolean; updated_at?: string; error?: string };
          if (!rPush.ok) {
            setSyncMessage(jPush.error ?? "서버 업로드 실패");
          } else {
            const pushedTs = jPush.updated_at ?? new Date().toISOString();
            safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
            safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
            window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
            clearLocalChanged();
            setSyncMessage("이 기기의 변경 데이터를 서버에 올렸습니다.");
            setLastSyncedAt(pushedTs);
            setLastSellLogSyncedAt(pushedTs);
            setSellLogDirty(false);
          }
        } else {
          // ─ 이미 동기화된 상태
          if (!lastSyncTs) {
            // 최초 연결 시 lastSyncTs 를 서버 기준으로 초기화
            safeSetItem(
              LAST_SYNC_TS_KEY,
              serverTs.length > 0 ? serverTs : new Date().toISOString(),
            );
          }
          setSyncMessage("서버와 동기화 상태입니다.");
          setLastSyncedAt(
            serverTs.length > 0 ? serverTs : lastSyncTs || new Date().toISOString(),
          );
        }
      } else {
        // ─ 서버에 데이터 없음
        if (forcePull) {
          // 키 변경·초기화 직후: 빈 state를 서버에 올리지 않음. 새 키로 깨끗하게 시작.
          setSyncMessage("새 동기화 키입니다. 데이터를 입력하면 자동으로 서버에 저장됩니다.");
          return;
        }
        // ─ 최초 등록: 이 기기 내용을 처음 올림
        const r2 = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "push",
            key,
            positions: pos,
            cashByOwner: cash,
            holdingsSortByOwner: holdingsSort,
            sellLogByOwner,
            buyJournal: buyJournalEntries,
            ownerNames: owners,
            targetStockWeightByOwner: loadAllTargetStockWeights(),
            ownerScratchpadByOwner: loadAllOwnerScratchpads(),
            rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
            usdKrw: fxRef.current.usd,
            eurKrw: fxRef.current.eur,
            ...getAlertThresholdsPayload(),
          }),
        });
        const j2 = (await r2.json()) as { ok?: boolean; updated_at?: string; error?: string };
        if (!r2.ok) {
          setSyncMessage(j2.error ?? "서버 업로드 실패");
        } else {
          const pushedTs = j2.updated_at ?? new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
          setSyncMessage("서버에 기존 데이터가 없어 이 기기 내용을 올렸습니다.");
          setLastSyncedAt(pushedTs);
          setLastSellLogSyncedAt(pushedTs);
          setSellLogDirty(false);
        }
      }
    } catch {
      setSyncMessage("네트워크 오류로 동기화에 실패했습니다.");
    } finally {
      setSyncBusy(false);
    }
  },
  [],
  );

  useEffect(() => {
    void fetch("/api/sync")
      .then((r) => r.json())
      .then((j: { ok?: boolean }) => {
        setServerHealth(j.ok === true ? "ok" : "error");
      })
      .catch(() => setServerHealth("error"));
  }, []);

  useEffect(() => {
    const pos = loadPositions();
    const cash = loadCashByOwner();
    const log = loadSellLog();
    const buyJ = loadBuyJournal();
    const owners = loadOwnerNames(); // SSR 불일치 방지로 useState 초기값은 DEFAULT — 여기서 실제 로컬 값 로드
    skipMarkLocalChangedRef.current = 2; // 디스크→state 재적용은 "수정"이 아님
    skipSellLogLocalChangedRef.current = 1;
    skipOwnerLocalChangedRef.current = 1; // 초기 로드 시 ownerNames 효과가 로컬 변경으로 오인되는 것을 방지
    setPositions(pos);
    setCashByOwner(cash);
    skipBuyJournalLocalChangedRef.current = 1;
    setBuyJournal(buyJ);
    setSellLog(log);
    setOwnerNames(owners);
    const loadedAlerts = loadAlertThresholdsFromStorage();
    skipAlertThresholdsHydrateRef.current = 1;
    setAlertThresholdsByKey(loadedAlerts);
    // URL ?key=... 파라미터가 있으면 localStorage보다 우선 적용 (북마크 복원용)
    const urlKey = (() => {
      try {
        const p = new URLSearchParams(window.location.search).get("key") ?? "";
        return p.trim();
      } catch { return ""; }
    })();
    const savedKey = urlKey.length >= 8
      ? urlKey
      : (typeof window !== "undefined" ? window.localStorage.getItem(SYNC_KEY_STORAGE) ?? "" : "");
    // URL 파라미터 키가 localStorage 키와 다르면 덮어씀
    if (urlKey.length >= 8 && urlKey !== window.localStorage.getItem(SYNC_KEY_STORAGE)) {
      safeSetItem(SYNC_KEY_STORAGE, urlKey);
    }
    const savedSellLogSyncTs =
      typeof window !== "undefined" ? window.localStorage.getItem(LAST_SELL_LOG_SYNC_TS_KEY) ?? "" : "";
    const savedSellLogDirty =
      typeof window !== "undefined" ? window.localStorage.getItem(SELL_LOG_DIRTY_KEY) === "1" : false;
    setCloudSyncKey(savedKey);
    setSyncKeyDraft(savedKey);
    setLastSellLogSyncedAt(savedSellLogSyncTs.trim() || null);
    setSellLogDirty(savedSellLogDirty);
    const savedLastSyncTs =
      typeof window !== "undefined" ? window.localStorage.getItem(LAST_SYNC_TS_KEY) ?? "" : "";
    setLastSyncedAt(savedLastSyncTs.trim() || null);
    const storedAuto = typeof window !== "undefined" ? window.localStorage.getItem(AUTO_SYNC_STORAGE) : null;
    const auto = storedAuto !== "0"; // 명시적으로 끈 경우(0)만 false, 나머지는 기본 true
    setAutoSync(auto);
    const holdSort = loadHoldingsSort();
    setHoldingsSortByOwner(holdSort);
    try {
      setShowHoldingsAlertColumn(
        window.localStorage.getItem(HOLDINGS_ALERT_COLUMN_VISIBLE_KEY) === "1",
      );
    } catch {
      setShowHoldingsAlertColumn(false);
    }
    try {
      const aggCol = window.localStorage.getItem(AGG_ALERT_COLUMN_VISIBLE_KEY);
      setShowAggAlertColumn(aggCol === null ? true : aggCol === "1");
    } catch {
      setShowAggAlertColumn(true);
    }
    setIsHydrated(true);

    if (savedKey.length < 8) {
      setSyncReady(true);
      return;
    }

    void (async () => {
      await syncWithServerForKey(savedKey, pos, cash, holdSort, log, buyJ, loadOwnerNames());
      setSyncReady(true);
    })();
  }, [syncWithServerForKey]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(HOLDINGS_SORT_STORAGE_KEY, JSON.stringify(holdingsSortByOwner));
  }, [holdingsSortByOwner, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(STORAGE_KEY, JSON.stringify(positions));
    if (skipMarkLocalChangedRef.current > 0) {
      skipMarkLocalChangedRef.current -= 1;
    } else {
      // 사용자가 직접 수정한 경우 → 다음 동기화 시 Push 유도
      markLocalChanged();
    }
  }, [positions, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(CASH_STORAGE_KEY, JSON.stringify(cashByOwner));
    if (skipMarkLocalChangedRef.current > 0) {
      skipMarkLocalChangedRef.current -= 1;
    } else {
      markLocalChanged();
    }
  }, [cashByOwner, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(alertThresholdsByKey));
    if (skipAlertThresholdsHydrateRef.current > 0) {
      skipAlertThresholdsHydrateRef.current -= 1;
    } else {
      markLocalChanged();
    }
  }, [alertThresholdsByKey, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(HOLDINGS_ALERT_COLUMN_VISIBLE_KEY, showHoldingsAlertColumn ? "1" : "0");
  }, [showHoldingsAlertColumn, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(AGG_ALERT_COLUMN_VISIBLE_KEY, showAggAlertColumn ? "1" : "0");
  }, [showAggAlertColumn, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(SELL_LOG_KEY, JSON.stringify(sellLog));
    if (skipSellLogLocalChangedRef.current > 0) {
      skipSellLogLocalChangedRef.current -= 1;
    } else {
      markLocalChanged();
      safeSetItem(SELL_LOG_DIRTY_KEY, "1");
      setSellLogDirty(true);
    }
  }, [sellLog, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    safeSetItem(BUY_JOURNAL_KEY, JSON.stringify(buyJournal));
    if (skipBuyJournalLocalChangedRef.current > 0) {
      skipBuyJournalLocalChangedRef.current -= 1;
    } else {
      // 사용자가 매수 기록을 추가·수정한 경우 → 다음 동기화 시 Push 유도
      markLocalChanged();
    }
  }, [buyJournal, isHydrated]);

  // 로컬 스냅샷 읽기 + 동기화 키가 있으면 서버 스냅샷도 병합
  // cloudSyncKey 의존: 키가 뒤늦게 설정돼도(UI 입력·URL 파라미터 등) 서버 fetch가 즉시 재실행됨
  useEffect(() => {
    if (!isHydrated) return;
    const local = loadDailySnapshots();
    setDailySnapshots(local);

    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setCronDailySnapshotRecordedAt(null);
      return;
    }

    void fetch(`/api/snapshot?sync_key=${encodeURIComponent(key)}&days=180`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          json: {
            snapshots?: DailySnapshot[];
            latestDailySnapshotRecordedAt?: string | null;
          } | null,
        ) => {
        if (!json) return;
        const snaps = json.snapshots ?? [];
        if (
          typeof json.latestDailySnapshotRecordedAt === "string" &&
          json.latestDailySnapshotRecordedAt.trim()
        ) {
          setCronDailySnapshotRecordedAt(json.latestDailySnapshotRecordedAt.trim());
        } else {
          setCronDailySnapshotRecordedAt(null);
        }
        if (!snaps.length) return;
        // 서버 스냅샷과 로컬 스냅샷 병합
        // ★ 경쟁 조건 방지: 서버 응답이 올 때 최신 localStorage를 다시 읽어서 병합합니다.
        //   (effect 시작 이후 saveDailySnapshot으로 새로 저장된 데이터를 포함시키기 위함)
        const freshLocal = loadDailySnapshots();
        const localMap = new Map(freshLocal.map((s) => [s.date, s]));
        const mergeToday = todayKST();
        for (const s of snaps) {
          const existing = localMap.get(s.date);

          const serverLooksEmpty =
            !Number.isFinite(s.totalValue) ||
            s.totalValue <= 0 ||
            !s.ownerValues ||
            Object.keys(s.ownerValues).length === 0;
          const localLooksValid =
            !!existing &&
            Number.isFinite(existing.totalValue) &&
            existing.totalValue > 0 &&
            !!existing.ownerValues &&
            Object.keys(existing.ownerValues).length > 0;

          if (serverLooksEmpty && localLooksValid) continue;

          // 시점 일관성: 과거 날짜는 서버(크론 KST 16:00 종가)를 신뢰하고,
          // 오늘은 로컬(실시간)을 우선한다.
          //  - 과거를 로컬 우선으로 두면, 저녁(미국장)에 앱을 켰을 때의 중간 시세가
          //    그 날 값으로 굳어 종가 기준과 어긋난 가짜 변동이 생긴다.
          //  - 오늘은 아직 진행 중이라 실시간 로컬값이 더 최신이라 우선.
          const isPastDay = s.date < mergeToday;
          const preferServer = isPastDay;

          if (localLooksValid && !serverLooksEmpty) {
            const base = preferServer ? s : existing!;
            const other = preferServer ? existing! : s;
            const baseOwners = new Set(Object.keys(base.ownerValues ?? {}));
            const extraOwnerValues: Record<string, number> = {};
            const extraBreakdown: Record<string, number> = {};
            for (const [owner, val] of Object.entries(other.ownerValues ?? {})) {
              if (!baseOwners.has(owner)) extraOwnerValues[owner] = val;
            }
            for (const [key, val] of Object.entries(other.breakdownValues ?? {})) {
              const ownerPart = key.split(" · ")[0] ?? "";
              if (!baseOwners.has(ownerPart)) extraBreakdown[key] = val;
            }
            const mergedOwnerValues = { ...(base.ownerValues ?? {}), ...extraOwnerValues };
            const mergedBreakdown = { ...(base.breakdownValues ?? {}), ...extraBreakdown };
            // totalValue는 항상 ownerValues의 합과 일치해야 함.
            // 보충된 보유자(extraOwnerValues)가 있으면 base.totalValue로는 과소 계상되므로 재계산.
            const mergedTotalValue = Object.values(mergedOwnerValues).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
            localMap.set(s.date, {
              ...base,
              ownerValues: mergedOwnerValues,
              breakdownValues: Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
              totalValue: mergedTotalValue,
            });
            continue;
          }

          localMap.set(s.date, s);
        }
        const merged = [...localMap.values()].sort((a, b) => a.date.localeCompare(b.date));
        setDailySnapshots(merged);
        safeSetItem(DAILY_SNAPSHOTS_KEY, JSON.stringify(merged));
      })
      .catch(() => {});
  }, [isHydrated, cloudSyncKey]);

  useEffect(() => {
    if (!isHydrated || !syncReady || !autoSync || cloudSyncKey.length < 8) return;
    // 로컬 변경이 없으면 불필요한 push를 생략 — Pull 직후 state가 바뀌어도 push 안 함
    if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
    if (pushDebounceRef.current) clearTimeout(pushDebounceRef.current);
    pushDebounceRef.current = setTimeout(async () => {
      // debounce 후 다시 확인 (그 사이 pull이 들어왔을 수 있음)
      if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
      // ── 덮어쓰기 가드: push 전에 서버가 더 최신인지 확인 ──
      // 모바일에서 며칠 전 열어둔 탭이 복원된 채 수정하면, 다른 기기가 올린
      // 최신 서버 데이터를 옛 state로 통째로 덮어쓸 수 있다. 서버 updated_at이
      // 로컬 마지막 동기 시각보다 새로우면 블라인드 push 대신 충돌 플로우
      // (서버 상태 자동 백업 + 사용자 확인)로 위임한다.
      // meta 확인 자체가 실패하면(네트워크 등) 기존 동작대로 push를 진행한다.
      try {
        const metaRes = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "meta", key: cloudSyncKey }),
        });
        if (metaRes.ok) {
          const meta = (await metaRes.json().catch(() => ({}))) as {
            found?: boolean;
            updated_at?: string | null;
          };
          const serverTs = typeof meta.updated_at === "string" ? meta.updated_at : "";
          const lastSyncTs = window.localStorage.getItem(LAST_SYNC_TS_KEY) ?? "";
          if (meta.found && isServerSnapshotNewerThanLocal(serverTs, lastSyncTs)) {
            setSyncMessage("서버에 다른 기기의 최신 데이터가 있어 확인이 필요합니다.");
            await syncWithServerForKey(
              cloudSyncKey,
              positions,
              cashByOwner,
              holdingsSortByOwner,
              sellLog,
              buyJournal,
              ownerNames,
            );
            return;
          }
        }
      } catch {
        // meta 확인 실패는 무시하고 평소대로 push
      }
      if (window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1") return;
      void fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key: cloudSyncKey,
          // 라이브 시세를 currentPrice에 실어 보내 서버·크론 폴백값을 최신화(가짜 등락 방지)
          positions: positionsWithLivePrices(positions, marketQuery.data?.quotes),
          cashByOwner,
          holdingsSortByOwner,
          sellLogByOwner: sellLog,
          buyJournal,
          ownerNames,
          targetStockWeightByOwner: loadAllTargetStockWeights(),
          ownerScratchpadByOwner: loadAllOwnerScratchpads(),
          rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
          // 동기화 시점 환율 — 텔레그램이 "대시보드가 본 값"을 그대로 재현하는 데 사용
          usdKrw: fxRef.current.usd,
          eurKrw: fxRef.current.eur,
          ...getAlertThresholdsPayload(),
        }),
      }).then(async (r) => {
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
          const pushedTs = j.updated_at ?? new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
          setLastSyncedAt(pushedTs);
          setLastSellLogSyncedAt(pushedTs);
          setSellLogDirty(false);
          setSyncMessage("서버에 자동 저장했습니다.");
        } else {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          setSyncMessage(j.error ?? "자동 저장 실패(서버 응답 오류). GET /api/sync 로 상태를 확인하세요.");
        }
      });
    }, 2000);
    return () => {
      if (pushDebounceRef.current) clearTimeout(pushDebounceRef.current);
    };
    // marketQuery.data?.quotes는 의도적으로 deps에서 제외 — 시세 틱마다 push가 트리거되면 안 됨.
    // push 시점에 클로저로 현재 시세를 읽어 currentPrice만 실어 보낸다(데이터 변경 시에만 push).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, cashByOwner, holdingsSortByOwner, sellLog, buyJournal, ownerNames, alertThresholdsByKey, isHydrated, syncReady, autoSync, cloudSyncKey, syncWithServerForKey]);

  /** 탭 복귀 재동기화 마지막 실행 시각 — 잦은 포커스 전환 시 과도한 pull 방지(60초 스로틀) */
  const visibilityResyncLastRunRef = useRef(0);

  // ── 탭 복귀 시 재동기화 ──
  // pull은 원래 페이지 로드 시 1회뿐이라, 모바일 브라우저가 며칠 전 탭을
  // 새로고침 없이 복원하면 옛 데이터가 그대로 보였다. 탭이 다시 보일 때
  // syncWithServerForKey를 돌려 서버가 더 최신이면 받아오고(로컬 변경 없을 때),
  // 충돌이면 기존 확인 플로우를 태운다.
  useEffect(() => {
    if (!isHydrated || !syncReady || !autoSync || cloudSyncKey.length < 8) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - visibilityResyncLastRunRef.current < 60_000) return;
      if (syncBusy) return;
      visibilityResyncLastRunRef.current = now;
      void syncWithServerForKey(
        cloudSyncKey,
        positions,
        cashByOwner,
        holdingsSortByOwner,
        sellLog,
        buyJournal,
        ownerNames,
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [isHydrated, syncReady, autoSync, cloudSyncKey, positions, cashByOwner, holdingsSortByOwner, sellLog, buyJournal, ownerNames, syncBusy, syncWithServerForKey]);

  async function handlePullCloud() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    setSyncBusy(true);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull", key }),
      });
      const j = (await r.json()) as {
        error?: string;
        found?: boolean;
        positions?: unknown;
        cash_by_owner?: unknown;
        holdings_sort_by_owner?: unknown;
        sell_log_by_owner?: unknown;
        buy_journal?: unknown;
        owner_names?: unknown;
        target_stock_weight_by_owner?: unknown;
        owner_scratchpad_by_owner?: unknown;
        rebalance_calculator_by_owner?: unknown;
        alert_thresholds_by_position?: unknown;
        updated_at?: string | null;
      };
      if (!r.ok) {
        setSyncMessage(j.error ?? "불러오기 실패");
        return;
      }
      if (j.found) {
        skipMarkLocalChangedRef.current = 2;
        skipOwnerLocalChangedRef.current = 1;
        skipSellLogLocalChangedRef.current = 1;
        const valid = Array.isArray(j.positions)
          ? (j.positions as unknown[]).filter((x): x is Position => isValidPosition(x))
          : [];
        const pulledOwners = inferOwnerNamesFromSyncPayload(j);
        const allowedOwners = new Set(pulledOwners);
        const filtered = valid.filter((p) => allowedOwners.has(p.owner));
        setPositions(mergeDuplicatePositions(filtered));
        setCashByOwner(normalizeCashStrict(j.cash_by_owner, pulledOwners));
        setHoldingsSortByOwner(normalizeHoldingsSortStrict(j.holdings_sort_by_owner, pulledOwners));
        setSellLog(normalizeSellLogStrict(j.sell_log_by_owner, pulledOwners));
        setOwnerNames(pulledOwners);
        if (typeof j.updated_at === "string") {
          safeSetItem(LAST_SYNC_TS_KEY, j.updated_at);
          safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, j.updated_at);
          window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
          clearLocalChanged();
        }
        // 매수저널: 서버에 있으면 교체, 비어있으면 이 기기 기록 보존(다음 push로 올림).
        // HAS_LOCAL_CHANGES 설정은 위의 removeItem 이후여야 지워지지 않는다.
        // 자동 이행 플래그는 10분 간격으로만 재시도(push 폭주 방지).
        const allowAutoKeepPull = canMarkAutoMigrationKeep();
        let autoKeepFiredPull = false;
        const pulledBuyJournal = normalizeBuyJournalStrict(j.buy_journal, pulledOwners);
        if (pulledBuyJournal.length > 0) {
          skipBuyJournalLocalChangedRef.current = 1;
          setBuyJournal(pulledBuyJournal);
        } else if (allowAutoKeepPull && buyJournal.length > 0) {
          // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만
          safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
          autoKeepFiredPull = true;
        }
        setSyncMessage("서버에서 불러왔습니다.");
        setLastSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
        setLastSellLogSyncedAt(typeof j.updated_at === "string" ? j.updated_at : null);
        setSellLogDirty(false);
        mergeAndPersistTargetStockWeightsFromServer(j.target_stock_weight_by_owner);
        mergeAndPersistOwnerScratchpadsFromServer(j.owner_scratchpad_by_owner);
        mergeAndPersistRebalanceCalculatorFromServer(j.rebalance_calculator_by_owner);
        const localAlertsPull = loadAlertThresholdsFromStorage();
        const fromServerPull = mergeAlertThresholdsFromServer(
          j.alert_thresholds_by_position,
          pulledOwners,
        );
        const mergedPullAlerts = mergeAlertThresholdsOnPull(
          localAlertsPull,
          j.alert_thresholds_by_position,
          pulledOwners,
        );
        setAlertThresholdsByKey(mergedPullAlerts);
        safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(mergedPullAlerts));
        skipAlertThresholdsHydrateRef.current = 1;
        if (
          allowAutoKeepPull &&
          Object.keys(fromServerPull).length === 0 &&
          Object.keys(mergedPullAlerts).length > 0
        ) {
          // 자동 이행(사용자 수정 아님): 수정 시각 없이 플래그만
          safeSetItem(HAS_LOCAL_CHANGES_KEY, "1");
          autoKeepFiredPull = true;
        }
        if (autoKeepFiredPull) recordAutoMigrationKeep();
        // 관심종목도 서버에서 다시 불러오기
        setWatchlistLoaded(false);
      } else {
        setSyncMessage("서버에 아직 데이터가 없습니다. 먼저 이 기기에서 올리기를 해 보세요.");
      }
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function handlePushCloud() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    setSyncBusy(true);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key,
          positions,
          cashByOwner,
          holdingsSortByOwner,
          sellLogByOwner: sellLog,
          buyJournal,
          ownerNames,
          targetStockWeightByOwner: loadAllTargetStockWeights(),
          ownerScratchpadByOwner: loadAllOwnerScratchpads(),
          rebalanceCalculatorByOwner: buildRebalanceCalculatorByOwnerFromLocal(),
          usdKrw: fxRef.current.usd,
          eurKrw: fxRef.current.eur,
          ...getAlertThresholdsPayload(),
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "업로드 실패");
      } else {
        const pushedTs = (j as { updated_at?: string }).updated_at ?? new Date().toISOString();
        safeSetItem(LAST_SYNC_TS_KEY, pushedTs);
        safeSetItem(LAST_SELL_LOG_SYNC_TS_KEY, pushedTs);
        window.localStorage.removeItem(SELL_LOG_DIRTY_KEY);
        clearLocalChanged();
        setSyncMessage("서버에 올렸습니다.");
        setLastSyncedAt(pushedTs);
        setLastSellLogSyncedAt(pushedTs);
        setSellLogDirty(false);
      }
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  /** 이 기기 localStorage·state 기준 전체 스냅샷(기준선·목표비중·메모 등 포함) */
  const buildLocalSnapshotForBackup = useCallback(() => {
    safeSetItem(ALERT_THRESHOLDS_STORAGE_KEY, JSON.stringify(alertThresholdsByKey));
    return {
      positions,
      cash_by_owner: cashByOwner,
      holdings_sort_by_owner: holdingsSortByOwner,
      sell_log_by_owner: sellLog,
      owner_names: ownerNames,
      target_stock_weight_by_owner: loadAllTargetStockWeights(),
      owner_scratchpad_by_owner: loadAllOwnerScratchpads(),
      rebalance_calculator_by_owner: buildRebalanceCalculatorByOwnerFromLocal(),
      alert_thresholds_by_position: getAlertThresholdsForSync(),
      // 매수 일지는 로컬 전용이므로 메인 sync에는 없지만 백업에는 포함(브라우저 캐시 삭제 대비)
      buy_journal_entries: buyJournal,
      source_updated_at: lastSyncedAt ?? new Date().toISOString(),
    };
  }, [
    positions,
    cashByOwner,
    holdingsSortByOwner,
    sellLog,
    ownerNames,
    buyJournal,
    alertThresholdsByKey,
    lastSyncedAt,
  ]);

  /** 현재 기기의 수기 입력 전체를 백업 테이블에 저장합니다. */
  async function handleBackupSnapshot() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    const ok = window.confirm(
      [
        "이 기기에 있는 데이터를 백업합니다.",
        "",
        "포함: 종목·현금·보유자·매도일지·보유 순서·목표 비중·메모·리밸런스 계산·기준선(익·손 %·가격) 등",
        "",
        "백업을 진행할까요?",
      ].join("\n"),
    );
    if (!ok) return;

    setSyncBusy(true);
    try {
      const r = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: key, snapshot: buildLocalSnapshotForBackup() }),
      });
      const j = (await r.json()) as { ok?: boolean; message?: string; error?: string; warning?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "백업 실패");
      } else {
        setSyncMessage(j.warning ?? j.message ?? "백업을 저장했습니다.");
        void refreshLatestBackupAt();
      }
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  /** 서버에 쌓인 백업 행을 JSON 파일로 내려받습니다(브라우저 다운로드). */
  async function handleDownloadBackups() {
    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }
    const ok = window.confirm(
      [
        "① 이 기기의 잔고·기준선·목표비중 등 수기 입력을 백업 테이블에 한 줄 추가하고,",
        "② 이어서 서버에 쌓인 백업 목록을 JSON 파일로 내려받습니다.",
        "",
        "내려받은 파일은 내 PC의 다운로드 폴더 등에 남습니다. 웹이 그 파일을 대신 지우지는 못합니다(브라우저 보안). 필요 없으면 직접 삭제하세요.",
        "",
        "파일에는 동기화 키와 백업 데이터가 들어갑니다. 타인과 공유하지 마세요.",
        "",
        "진행할까요?",
      ].join("\n"),
    );
    if (!ok) return;

    setSyncBusy(true);
    try {
      const rSnap = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: key, snapshot: buildLocalSnapshotForBackup() }),
      });
      const jSnap = (await rSnap.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!rSnap.ok) {
        setSyncMessage(
          jSnap.error ??
            (rSnap.status === 404
              ? "서버에 해당 키의 잔고가 없어 백업을 만들 수 없습니다. 먼저 동기화해 주세요."
              : "백업(스냅샷 저장)에 실패했습니다."),
        );
        return;
      }

      const r = await fetch(`/api/backup/export?sync_key=${encodeURIComponent(key)}`);
      const text = await r.text();
      if (!r.ok) {
        let msg = "백업 내려받기 실패";
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        setSyncMessage(msg);
        return;
      }
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `portfolio-backups-${new Date().toISOString().slice(0, 19).replace(/:/g, "-").replace("T", "_")}.json`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSyncMessage("서버에 백업 한 줄을 추가한 뒤, JSON을 내려받았습니다.");
      void refreshLatestBackupAt();
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  /** 백업 JSON 파일을 읽어 선택 목록을 띄웁니다. 실제 복원은 handleRestoreSpecificBackup에서. */
  async function handleRestoreFromBackupFile(ev: ChangeEvent<HTMLInputElement>) {
    const input = ev.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    let text: string;
    try {
      text = await file.text();
    } catch {
      setSyncMessage("파일을 읽을 수 없습니다.");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      setSyncMessage("JSON 형식이 아닙니다.");
      return;
    }

    if (!raw || typeof raw !== "object") {
      setSyncMessage("파일 내용이 올바르지 않습니다.");
      return;
    }

    const root = raw as { format?: unknown; sync_key?: unknown; backups?: unknown };
    if (
      root.format !== "portfolio_snapshot_backups_v1" ||
      !Array.isArray(root.backups) ||
      root.backups.length === 0
    ) {
      setSyncMessage("이 앱에서 내려받은 백업 파일이 아니거나, 백업 목록이 비어 있습니다.");
      return;
    }

    const parsed = (root.backups as unknown[]).filter(
      (b): b is { id?: string; created_at: string; snapshot: Record<string, unknown> } =>
        b !== null &&
        typeof b === "object" &&
        typeof (b as { created_at?: unknown }).created_at === "string" &&
        typeof (b as { snapshot?: unknown }).snapshot === "object",
    );

    if (parsed.length === 0) {
      setSyncMessage("백업 항목을 파싱하지 못했습니다.");
      return;
    }

    setPendingBackups(parsed);
    setPendingBackupFileKey(typeof root.sync_key === "string" ? root.sync_key.trim() : "");
    setSyncMessage("");
  }

  /** 선택한 인덱스의 백업을 서버에 push한 뒤 화면을 갱신합니다. */
  async function handleRestoreSpecificBackup(idx: number) {
    const backups = pendingBackups;
    if (!backups || idx < 0 || idx >= backups.length) return;

    const key = cloudSyncKey.trim();
    if (key.length < 8) {
      setSyncMessage("동기화 키를 8자 이상 저장해 주세요.");
      return;
    }

    const fileKey = pendingBackupFileKey;
    if (fileKey && fileKey !== key) {
      const okKey = window.confirm(
        [
          "파일에 적힌 동기화 키와 현재 이 기기 키가 다릅니다.",
          `파일 키 끝 4자: …${fileKey.slice(-4)}`,
          `현재 키 끝 4자: …${key.slice(-4)}`,
          "",
          "현재 키로 서버에 올릴까요? (잘못 고르면 다른 키의 데이터를 덮어씁니다.)",
        ].join("\n"),
      );
      if (!okKey) return;
    }

    const entry = backups[idx];
    const kstTime = new Date(entry.created_at).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const ok = window.confirm(
      [
        `백업 시각: ${kstTime} (KST)`,
        "",
        "이 시점의 백업으로 서버 메인 잔고를 덮어쓴 뒤, 화면을 서버에서 다시 불러옵니다.",
        "",
        "복원할까요?",
      ].join("\n"),
    );
    if (!ok) return;

    setSyncBusy(true);
    try {
      const s = entry.snapshot;
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "push",
          key,
          positions: s.positions ?? [],
          cashByOwner: s.cash_by_owner ?? {},
          holdingsSortByOwner: s.holdings_sort_by_owner ?? {},
          sellLogByOwner: s.sell_log_by_owner ?? {},
          ownerNames: s.owner_names ?? [],
          ...("target_stock_weight_by_owner" in s && s.target_stock_weight_by_owner != null
            ? { targetStockWeightByOwner: s.target_stock_weight_by_owner }
            : {}),
          ...("owner_scratchpad_by_owner" in s && s.owner_scratchpad_by_owner != null
            ? { ownerScratchpadByOwner: s.owner_scratchpad_by_owner }
            : {}),
          ...("rebalance_calculator_by_owner" in s && s.rebalance_calculator_by_owner != null
            ? { rebalanceCalculatorByOwner: s.rebalance_calculator_by_owner }
            : {}),
          ...("alert_thresholds_by_position" in s && s.alert_thresholds_by_position != null
            ? { alertThresholdsByPosition: s.alert_thresholds_by_position }
            : {}),
          ...(Array.isArray(s.buy_journal_entries) && s.buy_journal_entries.length > 0
            ? { buyJournal: s.buy_journal_entries }
            : {}),
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setSyncMessage(j.error ?? "복원(서버 반영)에 실패했습니다.");
        return;
      }
      // 매수 일지: 위 push로 서버에도 반영되지만, 직후 pull 전에 화면이 비지 않도록 로컬도 즉시 복원
      if (Array.isArray(s.buy_journal_entries) && s.buy_journal_entries.length > 0) {
        safeSetItem(BUY_JOURNAL_KEY, JSON.stringify(s.buy_journal_entries));
        skipBuyJournalLocalChangedRef.current = 1;
        setBuyJournal(loadBuyJournal());
      }
      setPendingBackups(null);
      await handlePullCloud();
      setSyncMessage(`${kstTime} 백업으로 복원했습니다.`);
      void refreshLatestBackupAt();
    } catch {
      setSyncMessage("네트워크 오류입니다.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleSaveSyncKey() {
    const k = syncKeyDraft.trim();
    if (k.length < 8) {
      setSyncMessage("동기화 키는 8자 이상으로 정해 주세요.");
      return;
    }
    const prevKey = cloudSyncKey.trim();
    const isKeyChange = k !== prevKey && prevKey.length >= 8;

    if (isKeyChange) {
      // 키가 바뀌는 경우: React state 비동기 갱신·여러 useEffect 타이밍 경쟁으로
      // 옛 키 데이터가 남거나 빈 데이터가 새어나가는 문제를 원천 차단하기 위해
      // 로컬 데이터를 모두 지우고 페이지를 새로 로드한다.
      // 새로 로드되면 hydration 경로가 새 키로 서버에서 깨끗하게 pull한다(검증된 경로).
      const keysToRemove = [
        LEGACY_POSITIONS_STORAGE_KEY, CASH_STORAGE_KEY,
        HOLDINGS_SORT_STORAGE_KEY, DAILY_SNAPSHOTS_KEY, SELL_LOG_KEY,
        BUY_JOURNAL_KEY, LAST_SYNC_TS_KEY, LAST_SELL_LOG_SYNC_TS_KEY,
        SELL_LOG_DIRTY_KEY, HAS_LOCAL_CHANGES_KEY, LOCAL_CHANGES_AT_KEY, SNAPSHOT_PUSHED_DATE_KEY,
        SNAPSHOT_PUSHED_TOTAL_KEY, ALERT_THRESHOLDS_STORAGE_KEY,
        TARGET_WEIGHT_STORAGE_KEY, CALCULATOR_TARGET_STORAGE_KEY,
        OWNER_SCRATCHPAD_STORAGE_KEY,
      ];
      keysToRemove.forEach((key) => window.localStorage.removeItem(key));
      // STORAGE_KEY는 제거하면 재로드 시 샘플 데이터(DEFAULT_POSITIONS)가 뜨므로 빈 배열로 덮어씀
      safeSetItem(STORAGE_KEY, "[]");
      safeSetItem(SYNC_KEY_STORAGE, k);
      setSyncMessage("동기화 키를 변경했습니다. 새 키 데이터를 불러오는 중…");
      // 새 키로 페이지 재로드 → hydration이 서버에서 새 키 데이터를 pull
      window.location.href = `${window.location.pathname}?key=${encodeURIComponent(k)}`;
      return;
    }

    // 같은 키 재저장: 로컬 변경이 없으면 서버에서 pull
    const isFirstValidKeySave = prevKey.length < 8 && k.length >= 8;
    const noLocalChanges = window.localStorage.getItem(HAS_LOCAL_CHANGES_KEY) !== "1";
    const shouldForcePull = isFirstValidKeySave || noLocalChanges;
    if (shouldForcePull) {
      clearLocalChanged();
      window.localStorage.removeItem(LAST_SYNC_TS_KEY);
    }

    safeSetItem(SYNC_KEY_STORAGE, k);
    setCloudSyncKey(k);
    setSyncMessage("키를 저장했습니다. 서버와 맞추는 중…");
    await syncWithServerForKey(
      k,
      positions,
      cashByOwner,
      holdingsSortByOwner,
      sellLog,
      buyJournal,
      ownerNames,
      shouldForcePull,
    );
  }

  async function handleClearLocalData() {
    const keysToRemove = [
      STORAGE_KEY,
      LEGACY_POSITIONS_STORAGE_KEY,
      CASH_STORAGE_KEY,
      HOLDINGS_SORT_STORAGE_KEY,
      DAILY_SNAPSHOTS_KEY,
      SELL_LOG_KEY,
      BUY_JOURNAL_KEY,
      LAST_SYNC_TS_KEY,
      LAST_SELL_LOG_SYNC_TS_KEY,
      SELL_LOG_DIRTY_KEY,
      HAS_LOCAL_CHANGES_KEY,
      LOCAL_CHANGES_AT_KEY,
      SNAPSHOT_PUSHED_DATE_KEY,
      SNAPSHOT_PUSHED_TOTAL_KEY,
      ALERT_THRESHOLDS_STORAGE_KEY,
      TARGET_WEIGHT_STORAGE_KEY,
      CALCULATOR_TARGET_STORAGE_KEY,
      OWNER_SCRATCHPAD_STORAGE_KEY,
    ];
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
    // 자동 push 트리거 방지
    skipMarkLocalChangedRef.current = 10;
    skipOwnerLocalChangedRef.current = 5;
    skipSellLogLocalChangedRef.current = 5;
    setPositions([]);
    setCashByOwner(DEFAULT_CASH_BY_OWNER);
    setSellLog({});
    setBuyJournal([]);
    setWatchlistRows([]);
    setWatchlistLoaded(true);
    setPendingClearConfirm(false);

    // 서버의 "현재 키" 행도 빈 데이터로 덮어쓴다(보유자 목록은 유지).
    //  안 그러면 '키 저장'·'서버에서 불러오기' 때 서버에 남은 옛 데이터가 다시 살아난다.
    //  다른 동기화 키 행은 키마다 별도 행이라 영향받지 않는다.
    const key = cloudSyncKey.trim();
    if (key.length >= 8) {
      setSyncBusy(true);
      setSyncMessage("비우기 전에 서버 백업 중…");
      // 안전장치: 비우기 직전에 현재 서버 상태를 백업 테이블에 자동 저장(실수 대비, 복원 가능)
      try {
        await fetch("/api/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sync_key: key }),
        });
      } catch {
        // 백업 실패해도 초기화는 진행 (아래에서 비움)
      }
      setSyncMessage("서버의 이 키 데이터를 비우는 중…");
      try {
        const r = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "push",
            key,
            positions: [],
            cashByOwner: DEFAULT_CASH_BY_OWNER,
            holdingsSortByOwner: {},
            sellLogByOwner: {},
            ownerNames,
            targetStockWeightByOwner: {},
            ownerScratchpadByOwner: {},
            rebalanceCalculatorByOwner: {},
            alertThresholdsByPosition: {},
          }),
        });
        // 관심종목도 서버에서 비운다
        await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sync_key: key, entries: [] }),
        });
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { updated_at?: string };
          const ts = j.updated_at ?? new Date().toISOString();
          safeSetItem(LAST_SYNC_TS_KEY, ts);
          setLastSyncedAt(ts);
          setSyncMessage("초기화 완료. 서버의 이 키 데이터까지 비웠습니다. (직전 상태는 자동 백업되어 「백업에서 복원」으로 되살릴 수 있습니다)");
        } else {
          setSyncMessage("로컬은 비웠지만 서버 비우기에 실패했습니다. '서버로 올리기'를 눌러 주세요.");
        }
      } catch {
        setSyncMessage("로컬은 비웠지만 네트워크 오류로 서버 비우기에 실패했습니다.");
      } finally {
        setSyncBusy(false);
      }
    } else {
      setSyncMessage("초기화 완료(로컬). 동기화 키가 없어 서버는 변경하지 않았습니다.");
    }
  }

  useEffect(() => {
    if (!syncReady || !cloudSyncKey || cloudSyncKey.length < 8 || watchlistLoaded) return;
    setWatchlistLoaded(true);
    void (async () => {
      try {
        const r = await fetch(`/api/watchlist?sync_key=${encodeURIComponent(cloudSyncKey)}`);
        const j = (await r.json()) as {
          ok?: boolean;
          entries?: Array<{ symbol: string; name?: string; group?: string; owner?: string; owners?: string[] }>;
        };
        if (r.ok && j.entries && j.entries.length > 0) {
          setWatchlistRows(
            j.entries.map((e) => {
              const owners =
                Array.isArray(e.owners) && e.owners.length > 0
                  ? e.owners
                  : e.owner
                    ? [e.owner]
                    : [WATCHLIST_OWNER_ALL];
              return {
                symbol: e.symbol,
                name: e.name ?? "",
                group: e.group ?? "",
                owners,
              };
            }),
          );
        }
      } catch {
        // ignore
      }
    })();
  }, [syncReady, cloudSyncKey, watchlistLoaded]);

  async function handleSaveWatchlist() {
    if (!cloudSyncKey || cloudSyncKey.length < 8) {
      setWatchlistMessage("먼저 동기화 키를 저장해 주세요.");
      return;
    }
    setWatchlistBusy(true);
    setWatchlistMessage("");
    try {
      const entries = watchlistRows
        .map((row) => ({
          symbol: row.symbol.trim().toUpperCase(),
          ...(row.name.trim() ? { name: row.name.trim() } : {}),
          ...(row.group?.trim() ? { group: row.group.trim() } : {}),
          ...(row.owners?.includes(WATCHLIST_OWNER_ALL)
            ? {}
            : row.owners && row.owners.length > 0
              ? { owners: row.owners }
              : {}),
        }))
        .filter((e) => e.symbol.length > 0);
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_key: cloudSyncKey, entries }),
      });
      const j = (await res.json()) as { error?: string };
      setWatchlistMessage(res.ok ? "관심종목을 저장했습니다." : (j.error ?? "저장 실패"));
    } catch {
      setWatchlistMessage("네트워크 오류입니다.");
    } finally {
      setWatchlistBusy(false);
    }
  }

  async function handleTelegramTest(dryRun: boolean) {
    if (!cloudSyncKey || cloudSyncKey.length < 8) {
      setTelegramTestResult({ ok: false, error: "먼저 동기화 키를 저장해 주세요." });
      return;
    }
    setTelegramTestBusy(true);
    setTelegramTestResult(null);
    try {
      const res = await fetch("/api/alert/kakao-price-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sync_key: cloudSyncKey,
          dry_run: dryRun,
          // 실제 발송은 같은 날 여러 번 눌러도 브리핑을 다시 보낼 수 있게 함 (Cron과 별개 manual 로그 무시)
          ...(dryRun ? {} : { force_resend: true }),
        }),
      });
      const j = await res.json() as typeof telegramTestResult;
      setTelegramTestResult(j);
    } catch {
      setTelegramTestResult({ ok: false, error: "네트워크 오류입니다." });
    } finally {
      setTelegramTestBusy(false);
    }
  }

  // 종목 추가 후 티커 입력칸 자동 포커스
  useEffect(() => {
    if (focusSymbolTrigger === 0) return;
    addSymbolInputRef.current?.focus();
  }, [focusSymbolTrigger]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const savedScrollY = window.scrollY;

    // 붙여넣기 오류가 남아 있으면 저장 차단
    if (buyPasteError && !buyPasteError.startsWith("ℹ️")) {
      return;
    }

    const quantity = Number(form.quantity);
    const avgPrice = Number(form.avgPrice);

    if (!form.symbol.trim()) {
      setBuyPasteError("ℹ️ 티커(종목코드)를 입력해주세요.");
      return;
    }
    if (!form.name.trim()) return;
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return;

    const purchaseUsdKrwNum = Number(form.purchaseUsdKrw);
    const purchaseEurKrwNum = Number(form.purchaseEurKrw);
    /** USD 매수: 매입 USD/KRW가 비어 있으면 현재 환율로 원화 차감(달러 예수 부족 시) */
    const effectivePurchaseUsdKrw =
      Number.isFinite(purchaseUsdKrwNum) && purchaseUsdKrwNum > 0 ? purchaseUsdKrwNum : usdKrw;
    /** EUR 매수: 매입환율 필드가 비어 있거나 잘못되면 현재 EUR/KRW로 원화 차감 */
    const effectivePurchaseEurKrw =
      Number.isFinite(purchaseEurKrwNum) && purchaseEurKrwNum > 0 ? purchaseEurKrwNum : eurKrw;
    if (form.currency === "USD") {
      if (!Number.isFinite(effectivePurchaseUsdKrw) || effectivePurchaseUsdKrw <= 0) return;
    }
    if (form.currency === "EUR") {
      if (!Number.isFinite(effectivePurchaseEurKrw) || effectivePurchaseEurKrw <= 0) return;
    }

    const ownersOrdered = ownerNames.filter((o) => form.selectedOwners.includes(o));
    if (ownersOrdered.length === 0) return;

    const symbol = form.symbol.trim().toUpperCase();
    const nameTrimmed = form.name.trim();
    const accountType: "해외주식" | "국내주식" =
      form.currency === "KRW" ? "국내주식" : "해외주식";
    const accountName = accountType === "국내주식" ? "국내주식-주계좌" : "미국주식-주계좌";

    for (const own of ownersOrdered) {
      const existing = positions.find(
        (p) => p.owner === own && p.symbol === symbol && p.currency === form.currency,
      );
      if (existing && existing.name.trim() !== nameTrimmed) {
        setAddPositionError(
          `「${own}」에 이미 등록된 ${symbol}의 종목명은 「${existing.name.trim()}」입니다. 기존과 동일한 종목명으로 맞춘 뒤 추가해 주세요.`,
        );
        return;
      }
    }
    setAddPositionError("");

    const shortOwners: OwnerName[] = [];
    /** USD 매수 보유자별: 달러로 전액 vs 원화로 전액 */
    let usdDeductPlans: Record<string, { deductUsd: number; deductKrw: number }> | null = null;
    let fxDeductUsd = 0;
    let fxDeductKrw = 0;

    if (form.currency === "USD") {
      usdDeductPlans = {};
      for (const owner of ownersOrdered) {
        const w = cashByOwner[owner] ?? { usd: 0, krw: 0 };
        const plan = usdPurchaseCashPlan(quantity, avgPrice, effectivePurchaseUsdKrw, w);
        if (!plan) shortOwners.push(owner);
        else usdDeductPlans[owner] = plan;
      }
    } else {
      const { deductUsd, deductKrw } = purchaseCashDeduction({
        currency: form.currency,
        quantity,
        avgPrice,
        purchaseEurKrw: form.currency === "EUR" ? effectivePurchaseEurKrw : purchaseEurKrwNum,
      });
      fxDeductUsd = deductUsd;
      fxDeductKrw = deductKrw;
      for (const owner of ownersOrdered) {
        const w = cashByOwner[owner] ?? { usd: 0, krw: 0 };
        const usdOk = fxDeductUsd <= CASH_CHECK_EPS || w.usd >= fxDeductUsd - CASH_CHECK_EPS;
        const krwOk = fxDeductKrw <= CASH_CHECK_EPS || w.krw >= fxDeductKrw - CASH_CHECK_EPS;
        if (!usdOk || !krwOk) shortOwners.push(owner);
      }
    }
    if (shortOwners.length > 0) {
      const msg =
        shortOwners.length === ownersOrdered.length
          ? "매입에 필요한 금액(주문+수수료)보다 현금 잔고가 적습니다."
          : `매입에 필요한 금액(주문+수수료)보다 현금이 부족한 보유자: ${shortOwners.join(", ")}`;
      setAddPositionError(msg);
      showActionErrorToast("현금이 부족합니다.");
      return;
    }

    const cg = form.chartGroup.trim();
    // 매수일: 입력했으면 그 날짜, 아니면 오늘(KST)
    const ymdCandidateForBase = form.purchaseDateForFx.trim();
    const tradeDateForBase =
      /^\d{4}-\d{2}-\d{2}$/.test(ymdCandidateForBase) ? ymdCandidateForBase : todayKST();
    // USD 매수인데 매입환율을 직접/정산조회로 확정하지 못했으면(빈칸 → 현재환율 임시),
    // 매수일을 저장하고 정산대기로 표시 → T+2 09:00 KST 지나면 자동으로 정산환율 보정
    const usdFxFinalized =
      form.currency === "USD" && Number.isFinite(purchaseUsdKrwNum) && purchaseUsdKrwNum > 0;
    const usdFxPending = form.currency === "USD" && !usdFxFinalized;
    const base: Omit<Position, "owner"> = {
      symbol,
      name: nameTrimmed,
      quantity,
      avgPrice,
      currentPrice: avgPrice,
      currency: form.currency,
      accountType,
      accountName,
      ...(form.currency === "USD"
        ? { purchaseUsdKrw: effectivePurchaseUsdKrw, purchaseDate: tradeDateForBase }
        : {}),
      ...(form.currency === "EUR" ? { purchaseEurKrw: effectivePurchaseEurKrw } : {}),
      ...(usdFxPending
        ? { purchaseFxPending: true, purchaseFxAtAdd: effectivePurchaseUsdKrw }
        : {}),
      ...(cg ? { chartGroup: cg } : {}),
    };

    const needsAlertThresholdPrompt = ownersOrdered.some((owner) => {
      const posKey = makePositionKey({ owner, symbol, currency: form.currency });
      const isNewPosition = !positions.some((p) => makePositionKey(p) === posKey);
      if (!isNewPosition) return false;
      return !hasAlertThresholdRule(resolveAlertRule(alertThresholdsByKey, owner, symbol));
    });

    setPositions((prev) => {
      let acc = prev;
      for (const owner of ownersOrdered) {
        const nextEntry: Position = { ...base, owner };
        acc = applyPositionUpsert(acc, nextEntry);
      }
      return acc;
    });

    setCashByOwner((prev) => {
      const next = { ...prev };
      for (const owner of ownersOrdered) {
        const w = next[owner] ?? { usd: 0, krw: 0 };
        const plan = usdDeductPlans?.[owner];
        if (plan) {
          next[owner] = { usd: w.usd - plan.deductUsd, krw: w.krw - plan.deductKrw };
        } else {
          next[owner] = { usd: w.usd - fxDeductUsd, krw: w.krw - fxDeductKrw };
        }
      }
      return next;
    });

    const ymdCandidate = form.purchaseDateForFx.trim();
    const tradeDate =
      /^\d{4}-\d{2}-\d{2}$/.test(ymdCandidate) ? ymdCandidate : todayKST();

    const newBuys: BuyJournalEntry[] = ownersOrdered.map((owner) => {
      const fx =
        form.currency === "KRW"
          ? 1
          : form.currency === "USD"
            ? effectivePurchaseUsdKrw
            : effectivePurchaseEurKrw;
      const totalKrw =
        form.currency === "KRW" ? quantity * avgPrice : quantity * avgPrice * fx;
      const id =
        typeof globalThis.crypto !== "undefined" &&
        typeof globalThis.crypto.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `buy-${Date.now()}-${symbol}-${owner}`;
      return {
        id,
        date: tradeDate,
        owner,
        symbol,
        name: nameTrimmed,
        qty: quantity,
        buyPrice: avgPrice,
        currency: form.currency,
        fxRate: fx,
        totalKrw,
        ...(usdFxPending && form.currency === "USD" ? { fxPending: true } : {}),
      };
    });

    setBuyJournal((prev) => [...prev, ...newBuys].slice(-BUY_JOURNAL_MAX));

    setForm({
      symbol: "",
      name: "",
      quantity: "",
      avgPrice: "",
      purchaseUsdKrw: "",
      purchaseEurKrw: "",
      purchaseDateForFx: "",
      chartGroup: "",
      currency: form.currency,
      accountType,
      selectedOwners: form.selectedOwners,
    });

    if (needsAlertThresholdPrompt) {
      setShowHoldingsAlertColumn(true);
      showActionSuccessToast(
        "종목이 반영되었습니다. 「종목별 합산」에서 익·손 %를, 보유 표 「기준선」열에서 익·손 가격을 입력한 뒤 저장해 주세요.",
      );
    } else {
      showActionSuccessToast("종목이 정상적으로 반영되었습니다.");
    }

    // 누락 보유자 추적 업데이트
    setAddOwnerTracker((prev) => {
      const idx = prev.findIndex((e) => e.symbol === symbol);
      const prevDone = idx >= 0 ? prev[idx].doneOwners : [];
      const updated = {
        symbol,
        name: nameTrimmed,
        isKorean: form.currency === "KRW",
        doneOwners: [...new Set([...prevDone, ...ownersOrdered])],
      };
      if (idx >= 0) return prev.map((e, i) => (i === idx ? updated : e));
      return [...prev, updated];
    });

    requestAnimationFrame(() => {
      window.scrollTo({ top: savedScrollY, behavior: "instant" });
    });
    setFocusSymbolTrigger((n) => n + 1);
  }

  // ── 이미지 파싱 → 매수 일괄 반영 ──────────────────────────────────────────
  function handleImageBuyConfirm(trades: ConfirmedBuyTrade[]) {
    for (const t of trades) {
      const symbol = (t.symbol || t.name).trim().toUpperCase();
      const nameTrimmed = t.name.trim();
      const accountType: "해외주식" | "국내주식" = t.currency === "KRW" ? "국내주식" : "해외주식";
      const accountName = accountType === "국내주식" ? "국내주식-주계좌" : "미국주식-주계좌";
      const ownersOrdered = ownerNames.filter((o) => t.owners.includes(o));
      if (!symbol || !nameTrimmed || t.qty <= 0 || t.price <= 0 || ownersOrdered.length === 0) continue;

      setPositions((prev) => {
        const next = [...prev];
        for (const owner of ownersOrdered) {
          const idx = next.findIndex(
            (p) => p.owner === owner && p.symbol === symbol && p.currency === t.currency,
          );
          if (idx >= 0) {
            const existing = next[idx];
            const totalQty = existing.quantity + t.qty;
            const blendedAvg = (existing.quantity * existing.avgPrice + t.qty * t.price) / totalQty;
            next[idx] = { ...existing, quantity: totalQty, avgPrice: blendedAvg };
          } else {
            next.push({
              symbol,
              name: nameTrimmed,
              quantity: t.qty,
              avgPrice: t.price,
              currentPrice: t.price,
              currency: t.currency,
              purchaseUsdKrw: t.currency === "USD" ? (usdKrw ?? undefined) : undefined,
              purchaseEurKrw: t.currency === "EUR" ? (eurKrw ?? undefined) : undefined,
              // USD는 매수일(t.date) 저장 + 정산대기 → T+2 지나면 정산환율로 자동 보정
              ...(t.currency === "USD" && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
                ? { purchaseDate: t.date, purchaseFxPending: true, purchaseFxAtAdd: usdKrw ?? undefined }
                : {}),
              accountType,
              accountName,
              owner,
            });
          }
        }
        return next;
      });

      const newBuys: BuyJournalEntry[] = ownersOrdered.map((owner) => {
        const fx = t.currency === "KRW" ? 1 : t.currency === "USD" ? (usdKrw ?? 1) : (eurKrw ?? 1);
        return {
          id: `buy-img-${Date.now()}-${symbol}-${owner}`,
          date: t.date,
          owner,
          symbol,
          name: nameTrimmed,
          qty: t.qty,
          buyPrice: t.price,
          currency: t.currency,
          fxRate: fx,
          totalKrw: t.currency === "KRW" ? t.qty * t.price : t.qty * t.price * fx,
          ...(t.currency === "USD" && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? { fxPending: true } : {}),
        };
      });
      setBuyJournal((prev) => [...prev, ...newBuys].slice(-BUY_JOURNAL_MAX));
    }
    showActionSuccessToast(`매수 ${trades.length}건이 반영되었습니다.`);
  }

  // ── 이미지 파싱 → 매도 일괄 반영 ──────────────────────────────────────────
  function handleImageSellConfirm(trades: ConfirmedSellTrade[]) {
    setSellLog((prev) => {
      const next = { ...prev };
      for (const t of trades) {
        if (!t.owner || !t.name || t.qty <= 0 || t.sellPrice <= 0) continue;
        const fx = t.fxRate > 0 ? t.fxRate : t.currency === "KRW" ? 1 : (usdKrw ?? 1);
        const avgP = t.avgPrice > 0 ? t.avgPrice : t.sellPrice;
        const realizedKrw =
          t.currency === "KRW"
            ? (t.sellPrice - avgP) * t.qty
            : (t.sellPrice - avgP) * t.qty * fx;
        const entry: SellLogEntry = {
          id: `sell-img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          date: t.date,
          symbol: (t.symbol || t.name).trim().toUpperCase(),
          name: t.name.trim(),
          qty: t.qty,
          sellPrice: t.sellPrice,
          avgPrice: avgP,
          currency: t.currency,
          fxRate: fx,
          realizedKrw,
        };
        next[t.owner] = [...(next[t.owner] ?? []), entry];
      }
      return next;
    });
    showActionSuccessToast(`매도 ${trades.length}건이 반영되었습니다.`);
  }

  function handleDeleteRow(rowIndex: number) {
    if (rowIndex < 0) return;
    setPositions((prev) => prev.filter((_, idx) => idx !== rowIndex));
  }

  function startEditRow(p: Position, rowIndex: number) {
    if (rowIndex < 0) return;
    setEditingRowIndex(rowIndex);
    setEditSymbol(p.symbol);
    setEditName(p.name);
    setEditChartGroup(p.chartGroup ?? "");
    setEditQuantity(String(p.quantity));
    setEditAvgPrice(String(p.avgPrice));
    setEditPurchaseUsdKrw(
      p.currency === "USD" ? String(p.purchaseUsdKrw ?? "") : "",
    );
    setEditPurchaseEurKrw(
      p.currency === "EUR" ? String(p.purchaseEurKrw ?? "") : "",
    );
  }

  function cancelEditRow() {
    setEditingRowIndex(null);
    setPendingSaveConfirm(false);
    setEditSymbol("");
    setEditName("");
    setEditChartGroup("");
    setEditQuantity("");
    setEditAvgPrice("");
    setEditPurchaseUsdKrw("");
    setEditPurchaseEurKrw("");
  }

  function saveEditRow() {
    if (editingRowIndex === null) return;
    const q = Number(editQuantity);
    const a = Number(editAvgPrice);
    const px = Number(editPurchaseUsdKrw);
    const peur = Number(editPurchaseEurKrw);
    const sym = editSymbol.trim().toUpperCase();
    const nm = editName.trim();
    const cg = editChartGroup.trim() || undefined;
    if (!sym || !nm) return;
    if (!Number.isFinite(q) || q <= 0) return;
    if (!Number.isFinite(a) || a <= 0) return;
    setPositions((prev) =>
      prev.map((p, idx) => {
        if (idx !== editingRowIndex) return p;
        if (p.currency === "USD") {
          if (!Number.isFinite(px) || px <= 0) return p;
          // 직접 환율을 입력하면 정산대기·추가당시환율 내역 해제(자동 보정이 덮어쓰지 않도록)
          const { purchaseFxPending: _dropPending, purchaseFxAtAdd: _dropAtAdd, ...rest } = p;
          void _dropPending;
          void _dropAtAdd;
          return { ...rest, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a, purchaseUsdKrw: px };
        }
        if (p.currency === "EUR") {
          if (!Number.isFinite(peur) || peur <= 0) return p;
          return { ...p, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a, purchaseEurKrw: peur };
        }
        return { ...p, symbol: sym, name: nm, chartGroup: cg, quantity: q, avgPrice: a };
      }),
    );
    cancelEditRow();
  }

  function moveRow(rowIndex: number, direction: "up" | "down") {
    setPositions((prev) => {
      const idx = rowIndex;
      if (idx < 0 || idx >= prev.length) return prev;
      const owner = prev[idx].owner;
      const ownerIndices = prev
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.owner === owner)
        .map(({ i }) => i);
      const posInOwner = ownerIndices.indexOf(idx);
      if (direction === "up" && posInOwner === 0) return prev;
      if (direction === "down" && posInOwner === ownerIndices.length - 1) return prev;
      const swapIdx =
        direction === "up" ? ownerIndices[posInOwner - 1] : ownerIndices[posInOwner + 1];
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  }

  const holdingsDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  /** 입력 순 보기: 종목 행 순서 드래그 시 positions 배열을 보유자 구간 안에서 재배열 */
  function reorderHoldingsDrag(owner: string, e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeIdx = Number(active.id);
    const overIdx = Number(over.id);
    if (
      !Number.isFinite(activeIdx) ||
      !Number.isFinite(overIdx) ||
      activeIdx < 0 ||
      overIdx < 0
    ) {
      return;
    }
    setPositions((prev) => {
      const globalIndices = prev.map((p, i) => (p.owner === owner ? i : -1)).filter((i) => i >= 0);
      const oldPos = globalIndices.indexOf(activeIdx);
      const newPos = globalIndices.indexOf(overIdx);
      if (oldPos < 0 || newPos < 0) return prev;
      const ownerSlice = globalIndices.map((gi) => prev[gi]);
      const movedSlice = arrayMove(ownerSlice, oldPos, newPos);
      const next = [...prev];
      globalIndices.forEach((gi, k) => {
        next[gi] = movedSlice[k];
      });
      return next;
    });
  }

  function handleAddOwner() {
    const next = window.prompt("추가할 보유자 이름을 입력하세요.");
    const name = next?.trim();
    if (!name) return;
    if (ownerNames.includes(name)) return;
    setOwnerNames((prev) => [...prev, name]);
    setCashByOwner((prev) => ({ ...prev, [name]: prev[name] ?? { usd: 0, krw: 0 } }));
    setHoldingsSortByOwner((prev) => ({ ...prev, [name]: prev[name] ?? "manual" }));
    markLocalChanged();
  }

  function handleRenameOwner(name: string) {
    const next = window.prompt("새 보유자 이름", name);
    const renamed = next?.trim();
    if (!renamed || renamed === name) return;
    if (ownerNames.includes(renamed)) return;
    setOwnerNames((prev) => prev.map((n) => (n === name ? renamed : n)));
    setPositions((prev) => prev.map((p) => (p.owner === name ? { ...p, owner: renamed } : p)));
    setCashByOwner((prev) => {
      const current = prev[name] ?? { usd: 0, krw: 0 };
      const rest = { ...prev };
      delete rest[name];
      return { ...rest, [renamed]: current };
    });
    setHoldingsSortByOwner((prev) => {
      const current = prev[name] ?? "manual";
      const rest = { ...prev };
      delete rest[name];
      return { ...rest, [renamed]: current };
    });
    setForm((prev) => ({
      ...prev,
      selectedOwners: prev.selectedOwners.map((o) => (o === name ? renamed : o)),
    }));
    setSellLog((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      next[renamed] = [...(next[renamed] ?? []), ...next[name]];
      delete next[name];
      return next;
    });
    setSellLogForm((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      next[renamed] = next[name];
      delete next[name];
      return next;
    });
    markLocalChanged();
  }

  function handleDeleteOwner(name: string) {
    if (ownerNames.length <= 1) return;
    const hasData =
      positions.some((p) => p.owner === name) ||
      (cashByOwner[name]?.usd ?? 0) > 0 ||
      (cashByOwner[name]?.krw ?? 0) > 0;
    const ok = window.confirm(
      hasData
        ? `${name} 보유자를 삭제하면 연결된 종목/현금도 함께 삭제됩니다. 계속할까요?`
        : `${name} 보유자를 삭제할까요?`,
    );
    if (!ok) return;
    const fallbackOwner = ownerNames.find((n) => n !== name) ?? "김승주";
    setOwnerNames((prev) => prev.filter((n) => n !== name));
    setPositions((prev) => prev.filter((p) => p.owner !== name));
    setCashByOwner((prev) => {
      const rest = { ...prev };
      delete rest[name];
      return rest;
    });
    setHoldingsSortByOwner((prev) => {
      const rest = { ...prev };
      delete rest[name];
      return rest;
    });
    setForm((prev) => {
      const selected = prev.selectedOwners.filter((o) => o !== name);
      return { ...prev, selectedOwners: selected.length > 0 ? selected : [fallbackOwner] };
    });
    setSellLog((prev) => { const next = { ...prev }; delete next[name]; return next; });
    setSellLogForm((prev) => { const next = { ...prev }; delete next[name]; return next; });
    markLocalChanged();
  }

  const holdingsViewOwner = activeTopNav.startsWith("owner-")
    ? activeTopNav.slice("owner-".length)
    : null;
  const positionsByOwnerForTab = useMemo(() => {
    if (!holdingsViewOwner) return positionsByOwner;
    return positionsByOwner.filter((g) => g.ownerName === holdingsViewOwner);
  }, [holdingsViewOwner, positionsByOwner]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeTopNav]);

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100">
      {actionSuccessToast ? (
        <div
          className="center-toast-enter pointer-events-none fixed left-1/2 top-1/2 z-[60] w-max max-w-[min(88vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-slate-900/72 px-7 py-5 text-center shadow-2xl backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <div className="mb-2 text-3xl leading-none text-emerald-400">✓</div>
          <p className="text-sm font-medium leading-snug text-slate-100">{actionSuccessToast}</p>
        </div>
      ) : null}
      {actionErrorToast ? (
        <div
          className="pointer-events-none fixed bottom-16 left-1/2 z-[60] max-w-[min(90vw,24rem)] -translate-x-1/2 rounded-lg border border-rose-500/55 bg-rose-950/95 px-4 py-2.5 text-center text-sm font-medium text-rose-100 shadow-lg shadow-rose-950/55 sm:bottom-20"
          role="alert"
          aria-live="assertive"
        >
          {actionErrorToast}
        </div>
      ) : null}
      <DashboardHeader activeTopNav={activeTopNav} cloudSyncKey={cloudSyncKey} cronDailySnapshotRecordedAt={cronDailySnapshotRecordedAt} eurKrw={eurKrw} goDashboardSection={goDashboardSection} goDashboardTop={goDashboardTop} holdingsMenuPos={holdingsMenuPos} holdingsMenuRef={holdingsMenuRef} holdingsNavOpen={holdingsNavOpen} holdingsNavRef={holdingsNavRef} lastSyncedAt={lastSyncedAt} marketQuery={marketQuery} ownerNames={ownerNames} setHoldingsNavOpen={setHoldingsNavOpen} usdKrw={usdKrw} />

      <div className="mx-auto w-full max-w-[1600px] px-2 py-4 sm:py-6 md:px-4">
        <main className="min-w-0">
          <div
            className={cn(
              activeTopNav === "dashboard" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "dashboard"}
          >
          <div className="space-y-4 font-sans sm:space-y-6">

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  { key: "appr", label: "총 평가금액", sub: "실시간", value: `₩${fmtInt(kisMetrics.totalAppraisal)}` },
                  { key: "cost", label: "총 매수 금액", sub: "주식 원가 기준", value: `₩${fmtInt(kisMetrics.totalCost)}` },
                  { key: "dep", label: "예수금(현금)", sub: "USD·KRW 합산", value: `₩${fmtInt(kisMetrics.deposit)}` },
                ] as const
              ).map((c) => (
                <div
                  key={c.key}
                  className="rounded-lg border border-slate-700/80 bg-slate-800/60 p-3 shadow-sm sm:p-4"
                >
                  <p className="text-[11px] font-medium text-slate-400 sm:text-xs">{c.label}</p>
                  {isMarketLoading ? (
                    <div className="mt-1.5 h-6 w-28 animate-pulse rounded bg-slate-700/60 sm:h-7 sm:w-36" />
                  ) : (
                    <p className="mt-1 text-lg font-bold tabular-nums text-white sm:text-xl">{c.value}</p>
                  )}
                  <p className="mt-0.5 text-[10px] text-slate-500 sm:text-[11px]">{c.sub}</p>
                </div>
              ))}
            </section>

            <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {summaryCards.map((card) => (
                <div
                  key={card.label}
                  className="rounded-lg border border-slate-700/80 bg-slate-800/60 p-3 shadow-sm sm:p-4"
                >
                  <p className="text-[11px] font-medium text-slate-400 sm:text-xs">{card.label}</p>
                  {isMarketLoading ? (
                    <div className="mt-1.5 h-6 w-24 animate-pulse rounded bg-slate-700/60 sm:h-7 sm:w-32" />
                  ) : (
                    <p
                      className={cn(
                        "mt-1 text-lg font-bold tabular-nums sm:text-xl",
                        card.positive === true
                          ? "text-red-400"
                          : card.positive === false
                            ? "text-sky-400"
                            : "text-white",
                      )}
                    >
                      {card.value}
                    </p>
                  )}
                  {card.sub ? (
                    <p className="mt-0.5 text-[10px] text-slate-500 sm:text-[11px]">{card.sub}</p>
                  ) : null}
                  {card.change ? (
                    <p className="mt-0.5 text-[10px] font-medium text-red-400 sm:text-[11px]">{card.change}</p>
                  ) : null}
                </div>
              ))}
            </section>

            <section
              className="rounded-lg border border-amber-500/35 bg-amber-950/20 px-3 py-3 sm:px-4"
              aria-label="기준선 도달 종목"
            >
              <h2 className="text-sm font-semibold text-amber-100 sm:text-base">기준선 도달 종목</h2>
              <p className="mt-1 text-[10px] text-amber-200/70 sm:text-[11px]">
                「종목별 합산」의 수익률 %·「보유 종목」표의 익·손 가격
                조건 중 <span className="font-medium text-amber-100">현재 만족</span>하는 종목만 여기 모읍니다. 시세는
                약 30초 주기로 갱신됩니다.
              </p>
              {alertLineHits.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  조건을 만족하는 종목이 없습니다. (기준을 입력하지 않았거나, 아직 도달하지 않은 경우)
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {alertLineHitsByOwner.map(({ owner, hits }) => (
                    <div
                      key={owner}
                      className="overflow-hidden rounded-md border border-amber-500/25 bg-slate-950/40"
                    >
                      <p className="border-b border-amber-500/20 bg-amber-950/30 px-2 py-1.5 text-xs font-semibold text-amber-100">
                        {owner}
                        <span className="ml-1.5 font-normal text-amber-200/70">({hits.length}종목)</span>
                      </p>
                      <Table className="text-[11px]">
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="h-7 px-2 py-1">종목</TableHead>
                            <TableHead className="h-7 px-2 py-1">조건</TableHead>
                            <TableHead className="h-7 px-2 py-1 text-right tabular-nums">현재가</TableHead>
                            <TableHead className="h-7 px-2 py-1 text-right tabular-nums">수익률</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {hits.map((h) => (
                            <TableRow key={h.key} className="border-amber-500/10">
                              <TableCell className="max-w-[7rem] px-2 py-1.5 align-top">
                                <span className="block truncate font-medium text-slate-100">{h.name}</span>
                                <span className="block truncate text-[10px] text-slate-500">{h.symbol}</span>
                              </TableCell>
                              <TableCell className="max-w-[6.5rem] px-2 py-1.5 align-top text-[10px] leading-snug text-amber-100/90">
                                {h.reasons.join(" · ")}
                              </TableCell>
                              <TableCell className="whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums text-slate-300">
                                {h.currentPrice.toLocaleString(MONEY_INT_LOCALE, {
                                  maximumFractionDigits: 6,
                                })}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums font-medium",
                                  h.returnPct != null
                                    ? signedPnlTextClass(h.returnPct)
                                    : "text-slate-500",
                                )}
                              >
                                {h.returnPct != null
                                  ? `${h.returnPct >= 0 ? "+" : ""}${h.returnPct.toFixed(2)}%`
                                  : "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="space-y-4">
            <h2 className="font-semibold">포트폴리오 비중 (가족·퇴직연금)</h2>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div className="col-span-1 sm:col-span-2">
                <PortfolioAllOwnersTodayProfitCard
                  owners={ownerGroupDailySummaryForGrid.map((o) => {
                    const pos = positionsByOwner.find((g) => g.ownerName === o.ownerName);
                    return {
                      ...o,
                      sectionPnL: pos?.sectionPnL ?? 0,
                      sectionPnLPct: pos?.sectionPnLPct ?? 0,
                    };
                  })}
                  onReorder={handleReorderOwners}
                />
              </div>
              {/* 트리맵(ResponsiveContainer)은 dashboard 탭이 활성이고 클라이언트 하이드레이션이 완료된 이후에만 마운트
                  — display:none 상태에서 width/height=-1 오류 방지, SSR↔CSR Recharts 불일치(hydration #418) 방지 */}
              {activeTopNav === "dashboard" && isHydrated && allocationByOwnerForGrid.map(({ ownerName, data, total }) => {
                const pos = positionsByOwner.find((g) => g.ownerName === ownerName);
                return <FamilyAllocationDonut
                  key={ownerName}
                  ownerName={ownerName}
                  data={data}
                  total={total}
                  sectionPnL={pos?.sectionPnL}
                  sectionPnLPct={pos?.sectionPnLPct}
                  watchlistEntries={watchlistRows.filter(
                    (row) =>
                      !!row.symbol?.trim() &&
                      (!row.owners ||
                        row.owners.length === 0 ||
                        row.owners.includes(WATCHLIST_OWNER_ALL) ||
                        row.owners.includes(ownerName)),
                  )}
                  cloudSyncKey={cloudSyncKey}
                />;
              })}
            </div>
          </section>
          </div>
          <div
            className={cn(
              activeTopNav === "section-trend" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-trend"}
          >
          {/* 차트는 섹션이 활성일 때만 마운트 — display:none 컨테이너에서 ResponsiveContainer가 width/height=-1을 보고하는 문제 방지 */}
          {activeTopNav === "section-trend" && (
            <>
          {/* 일별 자산 추이 — 총 평가금액 추이 */}
          <section id="section-trend" className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 text-base font-semibold text-slate-100 sm:text-lg">
              총 평가금액 추이
            </h2>
            <p className="mb-1 text-[10px] text-slate-500 sm:text-xs">
              (일별 자산 추이) 앱·서버에 저장된 날만 쌓입니다(최대 180일). 동기화 키로 서버 누적도 불러옵니다.
            </p>
            <div className="mt-2 min-h-[200px] rounded-md border border-slate-700/50 bg-slate-900/30 p-1">
            <DailyTrendChart
              snapshots={dailySnapshots}
              ownerNames={ownerNames}
              liveChangeByDate={dailyLiveChangeByDate}
              tradeMarkers={dailyTrendTradeMarkers}
            />
            </div>
          </section>
          <DailyChangeCalendar snapshots={dailySnapshots} liveChangeByDate={dailyLiveChangeByDate} cronRecordedAt={cronDailySnapshotRecordedAt} />
            </>
          )}

          </div>
          <div
            className={cn(
              activeTopNav === "dashboard" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "dashboard"}
          >
          <TechnicalSignalSection enrichedPositions={enrichedPositions} goDashboardSection={goDashboardSection} historyQuery={historyQuery} setSignalDetailTarget={setSignalDetailTarget} signalBySymbol={signalBySymbol} />
          </div>

          {/* 리밸런싱 계산기 (구버전·숨김) */}
          <section id="section-rebalance-old" className="hidden rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">리밸런싱 계산기</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              그룹별 목표 비중(%)을 입력하면 필요한 매수/매도 금액과 주수를 자동으로 계산합니다.
            </p>
            <RebalancingCalculator
              allocationByOwner={allocationByOwner}
              enrichedPositions={enrichedPositions}
              usdKrw={usdKrw}
              eurKrw={eurKrw}
              marketQuotes={marketQuery.data?.quotes}
              watchlistRows={watchlistRows}
              watchlistOwnerAllToken={WATCHLIST_OWNER_ALL}
              cloudSyncKey={cloudSyncKey}
            />
          </section>

          <div
            className={cn(
              activeTopNav === "section-holdings" ||
                activeTopNav === "section-holdings-by-symbol" ||
                activeTopNav.startsWith("owner-")
                ? "block"
                : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={
              !(
                activeTopNav === "section-holdings" ||
                activeTopNav === "section-holdings-by-symbol" ||
                activeTopNav.startsWith("owner-")
              )
            }
          >
          {(activeTopNav === "section-holdings" || activeTopNav.startsWith("owner-")) ? (
          <HoldingsSection alertThresholdsByKey={alertThresholdsByKey} buyJournal={buyJournal} cancelEditRow={cancelEditRow} editAvgPrice={editAvgPrice} editChartGroup={editChartGroup} editingRowIndex={editingRowIndex} editName={editName} editPurchaseEurKrw={editPurchaseEurKrw} editPurchaseUsdKrw={editPurchaseUsdKrw} editQuantity={editQuantity} editSymbol={editSymbol} eurKrw={eurKrw} handleDeleteRow={handleDeleteRow} historyQuery={historyQuery} holdingsDndSensors={holdingsDndSensors} holdingsSortByOwner={holdingsSortByOwner} holdingsSummaryCollapsed={holdingsSummaryCollapsed} holdingsViewOwner={holdingsViewOwner} marketQuery={marketQuery} moveRow={moveRow} ownerNames={ownerNames} patchPositionAlertPrice={patchPositionAlertPrice} pendingConfirm={pendingConfirm} pendingSaveConfirm={pendingSaveConfirm} positions={positions} positionsByOwnerForTab={positionsByOwnerForTab} reorderHoldingsDrag={reorderHoldingsDrag} saveAlertThresholdsForOwner={saveAlertThresholdsForOwner} saveEditRow={saveEditRow} savingAlertOwner={savingAlertOwner} sellLog={sellLog} sellLogErrorByOwner={sellLogErrorByOwner} sellLogForm={sellLogForm} setCashByOwner={setCashByOwner} setEditAvgPrice={setEditAvgPrice} setEditChartGroup={setEditChartGroup} setEditName={setEditName} setEditPurchaseEurKrw={setEditPurchaseEurKrw} setEditPurchaseUsdKrw={setEditPurchaseUsdKrw} setEditQuantity={setEditQuantity} setEditSymbol={setEditSymbol} setHoldingsSortByOwner={setHoldingsSortByOwner} setHoldingsSummaryCollapsed={setHoldingsSummaryCollapsed} setPendingConfirm={setPendingConfirm} setPendingSaveConfirm={setPendingSaveConfirm} setSellLog={setSellLog} setSellLogDetailOpenOwner={setSellLogDetailOpenOwner} setSellLogErrorByOwner={setSellLogErrorByOwner} setSellLogForm={setSellLogForm} setShowHoldingsAlertColumn={setShowHoldingsAlertColumn} setShowSymbolPnl={setShowSymbolPnl} setSignalDetailTarget={setSignalDetailTarget} showActionSuccessToast={showActionSuccessToast} showHoldingsAlertColumn={showHoldingsAlertColumn} showSymbolPnl={showSymbolPnl} signalBySymbol={signalBySymbol} startEditRow={startEditRow} usdKrw={usdKrw} />
          ) : null}

          {activeTopNav === "section-holdings-by-symbol" ? (
            <HoldingsBySymbolSection alertThresholdsByKey={alertThresholdsByKey} holdingsAggregatedBySymbolSorted={holdingsAggregatedBySymbolSorted} holdingsAggSource={holdingsAggSource} holdingsBySymbolSort={holdingsBySymbolSort} holdingsBySymbolView={holdingsBySymbolView} holdingsSymbolGrandTotals={holdingsSymbolGrandTotals} patchSymbolAlertPct={patchSymbolAlertPct} saveAllAlertThresholds={saveAllAlertThresholds} savingAlertAll={savingAlertAll} setHoldingsBySymbolSort={setHoldingsBySymbolSort} setHoldingsBySymbolView={setHoldingsBySymbolView} setShowAggAlertColumn={setShowAggAlertColumn} showAggAlertColumn={showAggAlertColumn} />
          ) : null}

          </div>

          <div
            className={cn(
              activeTopNav === "section-add" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-add"}
          >
          <AddPositionSection addFormFxManualRef={addFormFxManualRef} addOwnerTracker={addOwnerTracker} addPositionError={addPositionError} addSymbolInputRef={addSymbolInputRef} buyPasteError={buyPasteError} buyPasteText={buyPasteText} eurKrw={eurKrw} filteredHoldingsTickers={filteredHoldingsTickers} form={form} handleAddOwner={handleAddOwner} handleAddSymbolInput={handleAddSymbolInput} handleDeleteOwner={handleDeleteOwner} handleRenameOwner={handleRenameOwner} handleSubmit={handleSubmit} holdingsTickerSuggestHl={holdingsTickerSuggestHl} holdingsTickerSuggestOpen={holdingsTickerSuggestOpen} ownerNames={ownerNames} positions={positions} purchaseFxAutoBusy={purchaseFxAutoBusy} setAddOwnerTracker={setAddOwnerTracker} setBuyPasteError={setBuyPasteError} setBuyPasteText={setBuyPasteText} setForm={setForm} setHoldingsTickerSuggestHl={setHoldingsTickerSuggestHl} setHoldingsTickerSuggestOpen={setHoldingsTickerSuggestOpen} setShowTradeImageImport={setShowTradeImageImport} skipAddFormAutoChartGroupRef={skipAddFormAutoChartGroupRef} skipAddFormAutoNameRef={skipAddFormAutoNameRef} totalCashKrw={totalCashKrw} usdKrw={usdKrw} watchlistRows={watchlistRows} />
          </div>

          <div
            className={cn(
              activeTopNav === "section-realized" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-realized"}
          >
          <RealizedSection eurKrw={eurKrw} ownerNames={ownerNames} positions={positions} sellLog={sellLog} sellLogErrorByOwner={sellLogErrorByOwner} sellLogForm={sellLogForm} sellLogListExpanded={sellLogListExpanded} sellLogListViewOwner={sellLogListViewOwner} sellLogOwnerForSection={sellLogOwnerForSection} sellLogSymOwnerFilter={sellLogSymOwnerFilter} sellLogSymSummaryExpanded={sellLogSymSummaryExpanded} sellOwnerTracker={sellOwnerTracker} sellPasteText={sellPasteText} sellTickerHl={sellTickerHl} sellTickerInputRefs={sellTickerInputRefs} sellTickerOpen={sellTickerOpen} sellTickerSearch={sellTickerSearch} setCashByOwner={setCashByOwner} setPositions={setPositions} setSellLog={setSellLog} setSellLogDetailOpenOwner={setSellLogDetailOpenOwner} setSellLogErrorByOwner={setSellLogErrorByOwner} setSellLogForm={setSellLogForm} setSellLogListExpanded={setSellLogListExpanded} setSellLogListViewOwner={setSellLogListViewOwner} setSellLogOwnerForSection={setSellLogOwnerForSection} setSellLogSymOwnerFilter={setSellLogSymOwnerFilter} setSellLogSymSummaryExpanded={setSellLogSymSummaryExpanded} setSellOwnerTracker={setSellOwnerTracker} setSellPasteText={setSellPasteText} setSellTickerHl={setSellTickerHl} setSellTickerOpen={setSellTickerOpen} setSellTickerSearch={setSellTickerSearch} setShowSymbolPnl={setShowSymbolPnl} setShowTradeImageImport={setShowTradeImageImport} showActionSuccessToast={showActionSuccessToast} showSymbolPnl={showSymbolPnl} usdKrw={usdKrw} />
          </div>

          <div
            className={cn(
              activeTopNav === "section-rebalance" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-rebalance"}
          >
          {/* 리밸런싱 계산기 */}
          <section id="section-rebalance" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <h2 className="mb-1 font-semibold">리밸런싱 계산기</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              그룹별 목표 비중(%)을 입력하면 필요한 매수/매도 금액과 주수를 자동으로 계산합니다.
            </p>
            <RebalancingCalculator
              allocationByOwner={allocationByOwner}
              enrichedPositions={enrichedPositions}
              usdKrw={usdKrw}
              eurKrw={eurKrw}
              marketQuotes={marketQuery.data?.quotes}
              watchlistRows={watchlistRows}
              watchlistOwnerAllToken={WATCHLIST_OWNER_ALL}
              cloudSyncKey={cloudSyncKey}
            />
          </section>
          </div>

          <div
            className={cn(
              activeTopNav === "section-watchlist" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-watchlist"}
          >
          {/* 관심종목 (텔레그램 MA·RSI·BB·VOL) */}
          <WatchlistSection handleSaveWatchlist={handleSaveWatchlist} ownerNames={ownerNames} setWatchlistRows={setWatchlistRows} watchlistBusy={watchlistBusy} watchlistMessage={watchlistMessage} watchlistRows={watchlistRows} />
          </div>

          <div
            className={cn(
              activeTopNav === "section-telegram" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-telegram"}
          >
          {/* 텔레그램 가격 변동 알림 섹션 */}
          <TelegramAlertSection handleTelegramTest={handleTelegramTest} telegramTestBusy={telegramTestBusy} telegramTestResult={telegramTestResult} />
          </div>

          <div
            className={cn(
              activeTopNav === "section-sync" ? "block" : "hidden",
              "space-y-4 sm:space-y-6",
            )}
            aria-hidden={activeTopNav !== "section-sync"}
          >
          <SyncSection autoSync={autoSync} cloudSyncKey={cloudSyncKey} handleBackupSnapshot={handleBackupSnapshot} handleClearLocalData={handleClearLocalData} handleDownloadBackups={handleDownloadBackups} handlePullCloud={handlePullCloud} handlePushCloud={handlePushCloud} handleRestoreFromBackupFile={handleRestoreFromBackupFile} handleRestoreSpecificBackup={handleRestoreSpecificBackup} handleSaveSyncKey={handleSaveSyncKey} hasLoadedLatestBackup={hasLoadedLatestBackup} lastSellLogSyncedAt={lastSellLogSyncedAt} lastSyncedAt={lastSyncedAt} latestBackupAt={latestBackupAt} pendingBackups={pendingBackups} pendingClearConfirm={pendingClearConfirm} restoreBackupFileInputRef={restoreBackupFileInputRef} sellLogDirty={sellLogDirty} serverHealth={serverHealth} setAutoSync={setAutoSync} setPendingBackups={setPendingBackups} setPendingClearConfirm={setPendingClearConfirm} setSyncKeyDraft={setSyncKeyDraft} setSyncMessage={setSyncMessage} syncBusy={syncBusy} syncKeyDraft={syncKeyDraft} syncMessage={syncMessage} syncReady={syncReady} />
          </div>

        </main>
      </div>

      {showTradeImageImport && (
        <TradeImageImport
          ownerNames={ownerNames}
          knownSecurities={[
            ...watchlistRows.map((w) => ({ symbol: w.symbol, name: w.name })),
            ...positions.map((p) => ({ symbol: p.symbol, name: p.name })),
          ].filter((s) => s.symbol && s.name)}
          onBuyConfirm={handleImageBuyConfirm}
          onSellConfirm={handleImageSellConfirm}
          onClose={() => setShowTradeImageImport(false)}
        />
      )}

      <TechnicalSignalDetailModal
        open={signalDetailTarget !== null}
        onClose={() => setSignalDetailTarget(null)}
        symbol={signalDetailTarget?.symbol ?? ""}
        name={signalDetailTarget?.name ?? ""}
        prices={
          signalDetailTarget
            ? (historyQuery.data?.history?.[signalDetailTarget.symbol] ?? [])
            : []
        }
      />
      {sellLogDetailOpenOwner !== null && (
        <SellLogDetailModal sellLog={sellLog} sellLogDetailOpenOwner={sellLogDetailOpenOwner} sellLogOwnersForModal={sellLogOwnersForModal} setSellLogDetailOpenOwner={setSellLogDetailOpenOwner} />
      )}
    </div>
  );
}
