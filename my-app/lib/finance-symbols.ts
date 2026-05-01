/** Yahoo Chart / 시세용 심볼 정규화 (kakao-price-move와 동일 규칙) */
export function isKrxCommodity(symbol: string): boolean {
  return /^M\d{8}$/i.test(symbol.trim());
}

export function toYahooSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "RMS") return "RMS.PA";
  if (normalized.startsWith("KRX:")) return `${normalized.replace("KRX:", "")}.KS`;
  if (/^[0-9][0-9A-Z]{5}$/.test(normalized)) return `${normalized}.KS`;
  if (normalized.startsWith("KQ:")) return `${normalized.replace("KQ:", "")}.KQ`;
  return normalized;
}

/**
 * 종목 추가 시 티커만으로 거래 통화 추정 (명확할 때만).
 * - 미완성 입력(예: "06")에서는 null → 통화 유지
 */
export function inferTradingCurrencyFromTicker(raw: string): "KRW" | "USD" | "EUR" | null {
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if (isKrxCommodity(s)) return "KRW";
  const prefixed = /^KRX:|^KQ:/i.test(raw.trim());
  if (prefixed) return "KRW";
  if (/^[0-9][0-9A-Z]{5}$/.test(s)) return "KRW";

  const eurHints = /\.(PA|DE|AS|MI|MC|BR|VI|SW|LS|MX|WA)$/i;
  if (eurHints.test(s) || s === "RMS") return "EUR";

  if (/^[A-Z]{1,4}\.[A-Z]{1,4}$/.test(s)) return "USD";
  if (s.length >= 2 && /^[A-Z][A-Z0-9.-]{0,19}$/.test(s)) return "USD";

  return null;
}
