"use client";

/**
 * 주식 분할 자동 반영 훅.
 *  1) 알려진 분할(KNOWN_SPLITS)일이 지났고 반영 안 된 보유 행이 있으면 "대기"로 본다.
 *  2) 시세(Yahoo)에 같은 분할 이벤트가 확인되면(= 시세가 분할 가격으로 바뀐 뒤) 자동 적용한다.
 *  3) 적용 직전 상태를 되돌리기용으로 저장한다. 시세 확인이 안 되면 수동 적용 버튼만 제공한다.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { StockSplitsResponse } from "@/app/api/stock-splits/route";
import type { AlertThresholdsByKey } from "@/lib/alert-thresholds";
import { todayKST } from "@/lib/date-utils";
import { safeSetItem } from "@/lib/portfolio-storage";
import type { BuyJournalEntry, Position } from "@/lib/portfolio-types";
import {
  KNOWN_SPLITS,
  applySplitToAlertThresholds,
  applySplitToBuyJournal,
  applySplitToPositions,
  pendingSplitsForPositions,
  positionMatchesSplit,
  splitConfirmedByFeed,
  type StockSplit,
} from "@/lib/stock-splits";

export const SPLIT_UNDO_STORAGE_KEY = "portfolio_split_undo_v1";

type UndoSnapshot = {
  splitId: string;
  at: number;
  positions: Position[];
  buyJournal: BuyJournalEntry[];
  alerts: AlertThresholdsByKey;
};

export type SplitNotice = { splitId: string; text: string; auto: boolean };

function loadUndo(): UndoSnapshot | null {
  try {
    const raw = window.localStorage.getItem(SPLIT_UNDO_STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as UndoSnapshot;
    return j && typeof j.splitId === "string" && Array.isArray(j.positions) ? j : null;
  } catch {
    return null;
  }
}

export function useStockSplits(args: {
  ready: boolean;
  positions: Position[];
  setPositions: Dispatch<SetStateAction<Position[]>>;
  buyJournal: BuyJournalEntry[];
  setBuyJournal: Dispatch<SetStateAction<BuyJournalEntry[]>>;
  alertThresholdsByKey: AlertThresholdsByKey;
  setAlertThresholdsByKey: Dispatch<SetStateAction<AlertThresholdsByKey>>;
}) {
  const { ready, positions, setPositions, buyJournal, setBuyJournal, alertThresholdsByKey, setAlertThresholdsByKey } = args;
  const today = useMemo(() => todayKST(), []);
  const [notice, setNotice] = useState<SplitNotice | null>(null);
  const [undoAvailable, setUndoAvailable] = useState<string | null>(null);
  const appliedThisSession = useRef<Set<string>>(new Set());

  // 분할일이 지났지만 아직 반영 안 된 분할
  const pendingDue = useMemo(
    () => (ready ? pendingSplitsForPositions(positions, KNOWN_SPLITS, today) : []),
    [ready, positions, today],
  );

  // 분할일이 임박(21일 이내)했고 보유 중인 분할 — 안내용
  const upcoming = useMemo(() => {
    if (!ready) return [] as { split: StockSplit; daysLeft: number }[];
    const t0 = Date.parse(`${today}T00:00:00Z`);
    return KNOWN_SPLITS.filter((s) => s.date > today && positions.some((p) => positionMatchesSplit(p, s)))
      .map((s) => ({ split: s, daysLeft: Math.round((Date.parse(`${s.date}T00:00:00Z`) - t0) / 86_400_000) }))
      .filter((u) => u.daysLeft <= 21);
  }, [ready, positions, today]);

  const pendingKey = pendingDue.map((s) => s.id).join(",");
  const feedQuery = useQuery<StockSplitsResponse>({
    queryKey: ["stock-splits", pendingKey],
    enabled: ready && pendingDue.length > 0,
    queryFn: async () => {
      const symbols = [...new Set(pendingDue.map((s) => s.symbol))].join(",");
      const res = await fetch(`/api/stock-splits?symbols=${encodeURIComponent(symbols)}`);
      if (!res.ok) throw new Error(`stock-splits ${res.status}`);
      return (await res.json()) as StockSplitsResponse;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });

  const confirmedIds = useMemo(() => {
    const events = feedQuery.data?.splits ?? [];
    return new Set(pendingDue.filter((s) => splitConfirmedByFeed(s, events)).map((s) => s.id));
  }, [pendingDue, feedQuery.data]);

  const applySplit = useCallback(
    (s: StockSplit, auto: boolean) => {
      const r = applySplitToPositions(positions, s);
      if (r.changedRows === 0) return;
      const undo: UndoSnapshot = { splitId: s.id, at: Date.now(), positions, buyJournal, alerts: alertThresholdsByKey };
      safeSetItem(SPLIT_UNDO_STORAGE_KEY, JSON.stringify(undo));
      setPositions(r.positions);
      setBuyJournal(applySplitToBuyJournal(buyJournal, s, r.owners));
      setAlertThresholdsByKey(applySplitToAlertThresholds(alertThresholdsByKey, s, r.owners));
      setUndoAvailable(s.id);
      setNotice({
        splitId: s.id,
        auto,
        text: `${s.symbol} ${s.factor >= 1 ? `${s.factor}:1 분할` : `1:${Math.round(1 / s.factor)} 병합`}을 반영했습니다 — 보유 수량·평단가·알림 가격(${r.changedRows}행)이 조정되었습니다.`,
      });
    },
    [positions, buyJournal, alertThresholdsByKey, setPositions, setBuyJournal, setAlertThresholdsByKey],
  );

  // 시세에서 확인된 분할은 자동 적용 (세션당 1회 시도)
  useEffect(() => {
    if (!ready) return;
    const target = pendingDue.find((s) => confirmedIds.has(s.id) && !appliedThisSession.current.has(s.id));
    if (!target) return;
    // 다음 틱에 적용 — 상태 갱신 후 다음 분할은 다음 렌더에서 처리
    const timer = setTimeout(() => {
      if (appliedThisSession.current.has(target.id)) return;
      appliedThisSession.current.add(target.id);
      applySplit(target, true);
    }, 0);
    return () => clearTimeout(timer);
  }, [ready, pendingDue, confirmedIds, applySplit]);

  const applyManually = useCallback(
    (id: string) => {
      const s = KNOWN_SPLITS.find((x) => x.id === id);
      if (s) {
        appliedThisSession.current.add(id);
        applySplit(s, false);
      }
    },
    [applySplit],
  );

  const undo = useCallback(() => {
    const u = loadUndo();
    if (!u) return;
    setPositions(u.positions);
    setBuyJournal(u.buyJournal);
    setAlertThresholdsByKey(u.alerts);
    try {
      window.localStorage.removeItem(SPLIT_UNDO_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    // 되돌린 분할을 같은 세션에서 다시 자동 적용하지 않음
    appliedThisSession.current.add(u.splitId);
    setUndoAvailable(null);
    setNotice({ splitId: u.splitId, auto: false, text: `${u.splitId.split("@")[0]} 분할 반영을 되돌렸습니다. (필요하면 '수동 적용'으로 다시 반영할 수 있습니다)` });
  }, [setPositions, setBuyJournal, setAlertThresholdsByKey]);

  /** 분할 적용 대기 중인 종목인지 — 대기 중에는 같은 종목 추가를 막아 수량 기준이 섞이지 않게 한다 */
  const isSymbolSplitPending = useCallback(
    (symbol: string) => pendingDue.some((s) => positionMatchesSplit({ symbol }, s)),
    [pendingDue],
  );

  return {
    pendingDue,
    confirmedIds,
    upcoming,
    notice,
    dismissNotice: () => setNotice(null),
    undoAvailable,
    undo,
    applyManually,
    isSymbolSplitPending,
    feedFailed: feedQuery.isError,
  };
}
