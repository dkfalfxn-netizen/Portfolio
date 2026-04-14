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
