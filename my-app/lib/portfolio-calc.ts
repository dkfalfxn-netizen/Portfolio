import { CASH_CHECK_EPS, SellLogEntry, TRADING_FEE_RATE } from "@/lib/portfolio-types";

export function calcSellRealizedKrw(entry: Pick<SellLogEntry, "qty" | "sellPrice" | "avgPrice" | "currency" | "fxRate">): number {
  const qty = Number(entry.qty);
  const sell = Number(entry.sellPrice);
  const avg = Number(entry.avgPrice);
  const fx = Number(entry.fxRate) || 1;
  if (!Number.isFinite(qty) || !Number.isFinite(sell) || !Number.isFinite(avg)) return 0;
  const sellNotionalKrw =
    entry.currency === "KRW" ? sell * qty : sell * qty * fx;
  const buyNotionalKrw =
    entry.currency === "KRW" ? avg * qty : avg * qty * fx;
  /** 매도 금액 기준 수수료 차감(매입 쪽은 종목 추가 시 별도 반영) */
  const netProceedsKrw = sellNotionalKrw * (1 - TRADING_FEE_RATE);
  return netProceedsKrw - buyNotionalKrw;
}

/**
 * USD 종목 매수: 달러 예수금이 충분하면 USD만 차감, 아니면 EUR와 같이 전액을 현재(또는 입력) USD/KRW로 원화 차감.
 */
export function usdPurchaseCashPlan(
  quantity: number,
  avgPrice: number,
  purchaseUsdKrw: number,
  wallet: { usd: number; krw: number },
): { deductUsd: number; deductKrw: number } | null {
  const qty = Number(quantity);
  const px = Number(avgPrice);
  const fx = Number(purchaseUsdKrw);
  if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0) return null;
  if (!Number.isFinite(fx) || fx <= 0) return null;
  const withFee = qty * px * (1 + TRADING_FEE_RATE);
  const krwNeed = withFee * fx;
  if (wallet.usd >= withFee - CASH_CHECK_EPS) return { deductUsd: withFee, deductKrw: 0 };
  if (wallet.krw >= krwNeed - CASH_CHECK_EPS) return { deductUsd: 0, deductKrw: krwNeed };
  return null;
}

/** 종목 추가 시 현금 차감: KRW·EUR (USD는 usdPurchaseCashPlan) */
export function purchaseCashDeduction(params: {
  currency: "EUR" | "KRW";
  quantity: number;
  avgPrice: number;
  purchaseEurKrw: number;
}): { deductUsd: number; deductKrw: number } {
  const qty = Number(params.quantity);
  const px = Number(params.avgPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(px)) return { deductUsd: 0, deductKrw: 0 };
  const withFee = qty * px * (1 + TRADING_FEE_RATE);
  if (params.currency === "KRW") return { deductUsd: 0, deductKrw: withFee };
  const eurKrw = Number(params.purchaseEurKrw);
  if (!Number.isFinite(eurKrw) || eurKrw <= 0) return { deductUsd: 0, deductKrw: 0 };
  return { deductUsd: 0, deductKrw: withFee * eurKrw };
}
