const ROOT = "https://www.etfcheck.co.kr";

/**
 * 직접 `/mobile/search?keyword=` 접속 시 리다이렉트로 `keyword` 가 누락되는 경우가 있음.
 * `/?redirect=`에 경로+쿼리를 한 번에 넣으면 SPA가 검색창까지 복구함.
 */
export function etfCheckSearchUrl(keyword: string): string {
  const q = keyword.trim();
  if (!q) return `${ROOT}/mobile/search`;
  const pathWithQuery = `/mobile/search?keyword=${encodeURIComponent(q)}`;
  return `${ROOT}/?redirect=${encodeURIComponent(pathWithQuery)}`;
}

/**
 * 국내 상장 6자리면 티커 우선, 아니면 상품명(또는 티커)로 검색.
 */
export function etfCheckSearchKeyword(symbol: string, name: string): string {
  const s = symbol.trim();
  const n = (name ?? "").trim();
  if (/^\d{6}$/.test(s)) return s;
  if (n) return n;
  return s;
}

/**
 * ETF CHECK에서 의미 있는 검색이 될 법한 ETF/ETN 여부 (일반 주식 오탐 최소화).
 */
export function isLikelyEtfForEtfCheck(symbol: string, name: string): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  if (/\bETF\b|\bETN\b/i.test(n)) return true;
  if (/^(KODEX|TIGER|ACE|HANARO|KBSTAR|KOSEF)\s/i.test(n)) return true;
  if (/^(SOL|RISE|ARIRANG|TIMEFOLIO|WON|TREX|KTOP|KOACT|TRUE|MASTER)\s/i.test(n)) return true;
  if (/\b(iShares|SPDR|Invesco|Vanguard|ProShares|VanEck|Global X)\b/i.test(n)) return true;
  return false;
}
