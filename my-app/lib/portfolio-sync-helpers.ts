import { CashByOwner } from "@/lib/portfolio-positions";
import { HoldingsSortMode, parseCashPair } from "@/lib/portfolio-storage";
import { BUY_JOURNAL_MAX, BuyJournalEntry, OWNER_NAMES_STORAGE_KEY, OwnerName, Position, STORAGE_KEY, SellLogEntry } from "@/lib/portfolio-types";

/** 서버 pull 전용: owner_names 기준으로만 cash 복원 (DEFAULT 강제 주입 없음) */
/** 서버 pull 전용: 매수저널 복원 (loadBuyJournal과 동일 검증 + owner_names 필터) */
export function normalizeBuyJournalStrict(raw: unknown, owners: OwnerName[]): BuyJournalEntry[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(owners);
  return raw
    .filter(
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
    )
    .filter((e) => allowed.has(e.owner))
    .slice(-BUY_JOURNAL_MAX);
}

export function normalizeCashStrict(raw: unknown, owners: OwnerName[]): CashByOwner {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base: CashByOwner = {};
  for (const name of owners) {
    base[name] = parseCashPair(obj[name] ?? { usd: 0, krw: 0 });
  }
  return base;
}

/** 서버 pull 전용: owner_names 기준으로만 정렬 설정 복원 (DEFAULT 강제 주입 없음) */
export function normalizeHoldingsSortStrict(
  raw: unknown,
  owners: OwnerName[],
): Record<OwnerName, HoldingsSortMode> {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base: Record<OwnerName, HoldingsSortMode> = {};
  for (const name of owners) {
    const v = obj[name];
    base[name] =
      v === "manual" || v === "valueAsc" || v === "valueDesc" || v === "group"
        ? v
        : "manual";
  }
  return base;
}

/** 서버 pull 전용: owner_names 기준으로만 매도 로그 복원 */
export function normalizeSellLogStrict(
  raw: unknown,
  owners: OwnerName[],
): Record<string, SellLogEntry[]> {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base: Record<string, SellLogEntry[]> = {};
  for (const name of owners) {
    const entries = obj[name];
    if (!Array.isArray(entries)) {
      base[name] = [];
      continue;
    }
    // 필수 최소 필드(id, symbol, qty, realizedKrw)만 확인하고, 누락 필드는 기본값으로 복원.
    // 이전에 fxRate 등이 없던 구버전 항목도 조용히 삭제되지 않도록 방어.
    base[name] = entries
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
  return base;
}

/**
 * 서버 `updated_at`이 로컬 `portfolio_last_sync_ts_v1`보다 새로운지.
 * 로컬 시각이 비어 있으면(저장소 삭제·최초) 항상 true → 서버 스냅샷을 반영해야 함.
 * 문자열만 `>`로 비교하면 `"" > ""`가 false가 되어 pull 적용이 건너뛰어질 수 있다.
 */
/**
 * 충돌 자동 해소 기준: 이 기기가 이 시간 안에 서버와 동기화된 적이 있으면
 * 데이터가 낡지 않았다고 보고, 묻지 않고 이 기기 변경을 우선 저장한다(서버는 자동 백업).
 * 모달은 이 시간보다 오래 동기화가 끊겼던 기기(며칠 묵은 탭 등)에서만 띄운다.
 */
export const CONFLICT_AUTO_PUSH_IF_SYNCED_WITHIN_MS = 60 * 60_000;

/** 자동 이행(매수저널·알림 보존) 플래그 최소 재시도 간격 — 업로드가 계속 실패해도 push 폭주 방지 */
export const AUTO_KEEP_AT_KEY = "portfolio_auto_migration_keep_at_v1";
export const AUTO_KEEP_MIN_INTERVAL_MS = 10 * 60_000;

export function canMarkAutoMigrationKeep(): boolean {
  try {
    const raw = window.localStorage.getItem(AUTO_KEEP_AT_KEY);
    if (!raw) return true;
    const t = Date.parse(raw);
    return !Number.isFinite(t) || Date.now() - t >= AUTO_KEEP_MIN_INTERVAL_MS;
  } catch {
    return true;
  }
}

export function recordAutoMigrationKeep(): void {
  try {
    window.localStorage.setItem(AUTO_KEEP_AT_KEY, new Date().toISOString());
  } catch {
    //
  }
}

/** 충돌 확인창용 KST 시각 표기: "6. 13. 09:12" (파싱 실패 시 "시각 미상") */
export function formatKstForConflict(isoRaw: string): string {
  const t = Date.parse(isoRaw.trim());
  if (!Number.isFinite(t)) return "시각 미상";
  return new Date(t).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function isServerSnapshotNewerThanLocal(serverTsRaw: string, lastSyncTsRaw: string): boolean {
  const serverTs = serverTsRaw.trim();
  const lastSyncTs = lastSyncTsRaw.trim();
  if (lastSyncTs.length === 0) return true;
  if (serverTs.length === 0) return false;
  const a = Date.parse(serverTs);
  const b = Date.parse(lastSyncTs);
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
  return serverTs > lastSyncTs;
}

/**
 * 서버 push용: 라이브 시세가 있으면 currentPrice를 최신값으로 교체.
 * 클라이언트는 평소 currentPrice를 갱신하지 않아(추가 시점 가격에 고정) 서버 값이 오래되는데,
 * 이러면 크론이 시세 조회에 실패한 날 폴백(currentPrice)이 매우 stale해져 가짜 등락을 만든다.
 * push 시점에 최신 시세를 실어 보내면 크론 폴백값이 항상 최신에 가깝게 유지된다.
 */
export function positionsWithLivePrices(
  list: Position[],
  quotes: Record<string, { price?: number | null } | undefined> | undefined,
): Position[] {
  if (!quotes) return list;
  return list.map((p) => {
    const lp = quotes[p.symbol]?.price;
    return typeof lp === "number" && Number.isFinite(lp) && lp > 0 ? { ...p, currentPrice: lp } : p;
  });
}

/**
 * 미국 주간거래/시간외 현재가 폴링 대상 시간 — 평일(KST)이면 종일.
 * KIS 주간거래·정규·시간외 데이터가 하루 중 넓은 시간대에 들어오므로 시간은 제한하지 않고
 * 주말(미국 휴장)만 제외한다. 세션이 없어 시세가 안 오면 엔드포인트가 알아서 빈 값을 주고,
 * 프론트는 price>0일 때만 덮어쓰므로 안전하다.
 */
export function isUsTradingDayPollWindow(now: Date = new Date()): boolean {
  // 미국 거래일(월~금)은 반드시 미국 동부(ET) 요일로 판단.
  // KST 기준으로 하면 미국 금요일 오후(=KST 토요일 새벽)가 잘못 제외돼 정규장이 안 잡힌다.
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  return wd !== "Sat" && wd !== "Sun";
}

/** 포지션·보유자 로컬 캐시가 없으면(부분 삭제) 동기 시각만 남아 pull이 건너뛰어지는 문제를 막기 위함 */
export function isLocalPortfolioCacheCleared(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const pos = window.localStorage.getItem(STORAGE_KEY);
    const owners = window.localStorage.getItem(OWNER_NAMES_STORAGE_KEY);
    return pos == null || pos === "" || owners == null || owners === "";
  } catch {
    return true;
  }
}
