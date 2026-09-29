import { DEFAULT_OWNER_NAMES } from "@/lib/portfolio-holdings-helpers";
import { BUY_JOURNAL_KEY, BuyJournalEntry, DAILY_SNAPSHOTS_KEY, DailySnapshot, HOLDINGS_SORT_STORAGE_KEY, OWNER_NAMES_STORAGE_KEY, OwnerName, SELL_LOG_KEY, SNAPSHOT_MAX_DAYS, SellLogEntry } from "@/lib/portfolio-types";

export function normalizeOwnerNames(raw: unknown): OwnerName[] {
  if (!Array.isArray(raw)) return [...DEFAULT_OWNER_NAMES];
  const seen = new Set<string>();
  const names: OwnerName[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) return [...DEFAULT_OWNER_NAMES];
  return names;
}

/** 서버 owner_names 등: 빈 배열은 빈 배열(기본 보유자 주입 없음) */
export function parseOwnerNamesNoDefault(raw: unknown): OwnerName[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: OwnerName[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function inferOwnerNamesFromSyncPayload(payload: {
  owner_names?: unknown;
  positions?: unknown;
  cash_by_owner?: unknown;
  holdings_sort_by_owner?: unknown;
}): OwnerName[] {
  const explicit = parseOwnerNamesNoDefault(payload.owner_names);
  // DB에 저장된 owner_names가 있으면 그것만 신뢰 (cash/sort 잔여 키로 부활 방지)
  if (explicit.length > 0) {
    return explicit;
  }
  const fromPositions = Array.isArray(payload.positions)
    ? payload.positions
        .map((p) => (p && typeof p === "object" ? (p as { owner?: unknown }).owner : undefined))
        .filter((name): name is string => typeof name === "string")
    : [];
  /** 레거시: 잔액 0 cash 키·sort 키만으로는 부활하지 않음 */
  const fromCash: string[] = [];
  if (payload.cash_by_owner && typeof payload.cash_by_owner === "object") {
    for (const [name, value] of Object.entries(payload.cash_by_owner as Record<string, unknown>)) {
      if (typeof name !== "string" || !name.trim()) continue;
      const p = parseCashPair(value);
      if (p.usd > 0 || p.krw > 0) fromCash.push(name);
    }
  }
  const inferred = parseOwnerNamesNoDefault([...fromPositions, ...fromCash]);
  if (inferred.length > 0) return inferred;
  return [...DEFAULT_OWNER_NAMES];
}

export function loadOwnerNames(): OwnerName[] {
  if (typeof window === "undefined") return [...DEFAULT_OWNER_NAMES];
  try {
    const raw = window.localStorage.getItem(OWNER_NAMES_STORAGE_KEY);
    if (!raw) return [...DEFAULT_OWNER_NAMES];
    return normalizeOwnerNames(JSON.parse(raw) as unknown);
  } catch {
    return [...DEFAULT_OWNER_NAMES];
  }
}

export function loadDailySnapshots(): DailySnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DAILY_SNAPSHOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is DailySnapshot =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as DailySnapshot).date === "string" &&
        typeof (s as DailySnapshot).ownerValues === "object",
    );
  } catch {
    return [];
  }
}

export function loadBuyJournal(): BuyJournalEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BUY_JOURNAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is BuyJournalEntry =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as BuyJournalEntry).id === "string" &&
        typeof (e as BuyJournalEntry).date === "string" &&
        typeof (e as BuyJournalEntry).owner === "string" &&
        typeof (e as BuyJournalEntry).symbol === "string" &&
        typeof (e as BuyJournalEntry).name === "string" &&
        typeof (e as BuyJournalEntry).qty === "number" &&
        typeof (e as BuyJournalEntry).buyPrice === "number" &&
        typeof (e as BuyJournalEntry).fxRate === "number" &&
        typeof (e as BuyJournalEntry).totalKrw === "number" &&
        ((e as BuyJournalEntry).currency === "USD" ||
          (e as BuyJournalEntry).currency === "EUR" ||
          (e as BuyJournalEntry).currency === "KRW"),
    );
  } catch {
    return [];
  }
}

export function loadSellLog(): Record<string, SellLogEntry[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SELL_LOG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, SellLogEntry[]> = {};
    for (const [owner, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      out[owner] = entries
        .filter(
          (e): e is Record<string, unknown> =>
            e !== null &&
            typeof e === "object" &&
            typeof (e as Record<string, unknown>).id === "string" &&
            typeof (e as Record<string, unknown>).symbol === "string" &&
            typeof (e as Record<string, unknown>).qty === "number" &&
            typeof (e as Record<string, unknown>).realizedKrw === "number",
        )
        .map((e): SellLogEntry => {
          const currency =
            e.currency === "USD" || e.currency === "EUR" || e.currency === "KRW"
              ? e.currency
              : "KRW";
          return {
            id: e.id as string,
            date: typeof e.date === "string" ? e.date : "",
            symbol: e.symbol as string,
            name: typeof e.name === "string" && e.name ? e.name : (e.symbol as string),
            qty: e.qty as number,
            sellPrice: typeof e.sellPrice === "number" ? e.sellPrice : 0,
            avgPrice: typeof e.avgPrice === "number" ? e.avgPrice : 0,
            currency,
            fxRate: typeof e.fxRate === "number" && e.fxRate > 0 ? e.fxRate : 1,
            realizedKrw: e.realizedKrw as number,
            note: typeof e.note === "string" ? e.note : undefined,
          };
        });
    }
    return out;
  } catch {
    return {};
  }
}

/** localStorage.setItem 안전 래퍼 — QuotaExceededError·프라이빗 모드 예외 방어 */
export function safeSetItem(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    //
  }
}

export function saveDailySnapshot(snap: DailySnapshot) {
  if (typeof window === "undefined") return;
  try {
    const existing = loadDailySnapshots();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - SNAPSHOT_MAX_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    // 같은 날짜 스냅샷은 항상 최신값으로 교체 (현금·종목 변경이 반영되도록)
    const updated = [...existing.filter((s) => s.date !== snap.date), snap]
      .filter((s) => s.date >= cutoffStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    safeSetItem(DAILY_SNAPSHOTS_KEY, JSON.stringify(updated));
  } catch {}
}


/** 보유 종목 표시 순: 입력 순(저장된 배열 순) / 평가금액 / 차트 그룹 */
export type HoldingsSortMode = "manual" | "valueAsc" | "valueDesc" | "group";

export function defaultHoldingsSort(): Record<OwnerName, HoldingsSortMode> {
  return Object.fromEntries(
    DEFAULT_OWNER_NAMES.map((name) => [name, "manual" as HoldingsSortMode]),
  );
}

export function loadHoldingsSort(): Record<OwnerName, HoldingsSortMode> {
  const base = defaultHoldingsSort();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(HOLDINGS_SORT_STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as unknown;
    return normalizeHoldingsSortFromServer(parsed);
  } catch {
    return base;
  }
}

export function normalizeHoldingsSortFromServer(raw: unknown): Record<OwnerName, HoldingsSortMode> {
  const base = defaultHoldingsSort();
  if (!raw || typeof raw !== "object") return base;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "manual" || v === "valueAsc" || v === "valueDesc" || v === "group") {
      base[name] = v;
    }
  }
  return base;
}

export function sortHoldingsItems<
  T extends { valueKrw: number; chartGroup?: string; symbol: string },
>(items: T[], mode: HoldingsSortMode): T[] {
  const copy = [...items];
  if (mode === "manual") return copy;
  if (mode === "valueAsc") return copy.sort((a, b) => a.valueKrw - b.valueKrw);
  if (mode === "valueDesc") return copy.sort((a, b) => b.valueKrw - a.valueKrw);
  if (mode === "group") {
    return copy.sort((a, b) => {
      const ga = (a.chartGroup ?? "").trim();
      const gb = (b.chartGroup ?? "").trim();
      if (ga === "" && gb !== "") return 1;
      if (gb === "" && ga !== "") return -1;
      if (ga !== gb) return ga.localeCompare(gb, "ko");
      return a.symbol.localeCompare(b.symbol);
    });
  }
  return copy;
}

/** 보유 표: 차트 그룹명(없으면 티커) 기준으로 묶어 헤더 아래에 종목 표시 — 원형 차트와 동일 키 */
export function buildHoldingsGroupBlocks<
  T extends { chartGroup?: string; symbol: string; valueKrw: number },
>(items: T[]): { label: string; items: T[]; sumKrw: number }[] {
  const keyFor = (p: T) => p.chartGroup?.trim() || p.symbol;
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const p of items) {
    const k = keyFor(p);
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k)!.push(p);
  }
  return order.map((label) => {
    const groupItems = map.get(label)!;
    const sumKrw = groupItems.reduce((s, x) => s + x.valueKrw, 0);
    return { label, items: groupItems, sumKrw };
  });
}

/** 그룹 헤더 툴팁: 포함 종목(이름·티커), 줄바꿈 목록 */

export function parseCashPair(raw: unknown): { usd: number; krw: number } {
  if (!raw || typeof raw !== "object") return { usd: 0, krw: 0 };
  const o = raw as { usd?: unknown; krw?: unknown };
  const usd = Number(o.usd ?? 0);
  const krw = Number(o.krw ?? 0);
  return {
    usd: Number.isFinite(usd) && usd >= 0 ? usd : 0,
    krw: Number.isFinite(krw) && krw >= 0 ? krw : 0,
  };
}
