/** 보유자×티커별 짧은 메모 — 목표 비중 열 아래 빠른 메모(로컬만) */

const STORAGE_KEY = "portfolio-owner-asset-quicknotes_v1";

type Bucket = Record<string, Record<string, string>>;

function parseBucket(raw: string | null): Bucket {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as unknown;
    if (typeof j !== "object" || j === null || Array.isArray(j)) return {};
    return j as Bucket;
  } catch {
    return {};
  }
}

/** 해당 보유자의 티커별 메모 */
export function loadOwnerAssetQuicknotes(ownerName: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  const all = parseBucket(window.localStorage.getItem(STORAGE_KEY));
  const row = all[ownerName];
  return row && typeof row === "object" && !Array.isArray(row)
    ? Object.fromEntries(
        Object.entries(row).filter(([k, v]) => typeof k === "string" && typeof v === "string"),
      )
    : {};
}

/** 한 칸 업데이트 후 저장 */
export function persistOwnerAssetQuicknote(ownerName: string, ticker: string, text: string): void {
  if (typeof window === "undefined") return;
  const all = parseBucket(window.localStorage.getItem(STORAGE_KEY));
  const prev = all[ownerName] ? { ...all[ownerName] } : {};
  const t = text.replace(/\u0000/g, "");
  if (!t.trim()) delete prev[ticker];
  else prev[ticker] = t.slice(0, 4_000);
  if (Object.keys(prev).length === 0) delete all[ownerName];
  else all[ownerName] = prev;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota */
  }
}
