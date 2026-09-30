"use client";

import { TRADING_FEE_RATE, SellLogEntry, OwnerName, REALIZED_SYMBOL_PNL_TOGGLE_KEY, Position } from "@/lib/portfolio-types";
import { calcSellRealizedKrw } from "@/lib/portfolio-calc";
import { parseBrokerNotification, resolveBrokerOwner } from "@/lib/broker-notification-parser";
import { fmtInt } from "@/lib/format-money";
import { Fragment, type RefObject, type Dispatch, type SetStateAction } from "react";
import { CashByOwner } from "@/lib/portfolio-positions";

export type RealizedSectionProps = {
  eurKrw: number;
  ownerNames: string[];
  positions: Position[];
  sellLog: Record<string, SellLogEntry[]>;
  sellLogErrorByOwner: Record<string, string>;
  sellLogForm: Record<string, { date: string; symbol: string; name: string; qty: string; sellPrice: string; avgPrice: string; currency: "USD" | "EUR" | "KRW"; fxRate: string; note: string; selectedOwners: string[]; ownerOverrides: Record<string, { qty: string; avgPrice: string; fxRate: string; }>; editingId: string | null; }>;
  sellLogListExpanded: boolean;
  sellLogListViewOwner: string;
  sellLogOwnerForSection: string;
  sellLogSymOwnerFilter: string[];
  sellLogSymSummaryExpanded: boolean;
  sellOwnerTracker: { symbol: string; date: string; doneOwners: string[]; } | null;
  sellPasteText: string;
  sellTickerHl: Record<string, number>;
  sellTickerInputRefs: RefObject<Record<string, HTMLInputElement | null>>;
  sellTickerOpen: Record<string, boolean>;
  sellTickerSearch: Record<string, string>;
  setCashByOwner: Dispatch<SetStateAction<CashByOwner>>;
  setPositions: Dispatch<SetStateAction<Position[]>>;
  setSellLog: Dispatch<SetStateAction<Record<string, SellLogEntry[]>>>;
  setSellLogDetailOpenOwner: Dispatch<SetStateAction<string | null>>;
  setSellLogErrorByOwner: Dispatch<SetStateAction<Record<string, string>>>;
  setSellLogForm: Dispatch<SetStateAction<Record<string, { date: string; symbol: string; name: string; qty: string; sellPrice: string; avgPrice: string; currency: "USD" | "EUR" | "KRW"; fxRate: string; note: string; selectedOwners: string[]; ownerOverrides: Record<string, { qty: string; avgPrice: string; fxRate: string; }>; editingId: string | null; }>>>;
  setSellLogListExpanded: Dispatch<SetStateAction<boolean>>;
  setSellLogListViewOwner: Dispatch<SetStateAction<string>>;
  setSellLogOwnerForSection: Dispatch<SetStateAction<string>>;
  setSellLogSymOwnerFilter: Dispatch<SetStateAction<string[]>>;
  setSellLogSymSummaryExpanded: Dispatch<SetStateAction<boolean>>;
  setSellOwnerTracker: Dispatch<SetStateAction<{ symbol: string; date: string; doneOwners: string[]; } | null>>;
  setSellPasteText: Dispatch<SetStateAction<string>>;
  setSellTickerHl: Dispatch<SetStateAction<Record<string, number>>>;
  setSellTickerOpen: Dispatch<SetStateAction<Record<string, boolean>>>;
  setSellTickerSearch: Dispatch<SetStateAction<Record<string, string>>>;
  setShowSymbolPnl: Dispatch<SetStateAction<Record<string, boolean>>>;
  setShowTradeImageImport: Dispatch<SetStateAction<boolean>>;
  showActionSuccessToast: (message: string) => void;
  showSymbolPnl: Record<string, boolean>;
  usdKrw: number;
};

export function RealizedSection({
  eurKrw,
  ownerNames,
  positions,
  sellLog,
  sellLogErrorByOwner,
  sellLogForm,
  sellLogListExpanded,
  sellLogListViewOwner,
  sellLogOwnerForSection,
  sellLogSymOwnerFilter,
  sellLogSymSummaryExpanded,
  sellOwnerTracker,
  sellPasteText,
  sellTickerHl,
  sellTickerInputRefs,
  sellTickerOpen,
  sellTickerSearch,
  setCashByOwner,
  setPositions,
  setSellLog,
  setSellLogDetailOpenOwner,
  setSellLogErrorByOwner,
  setSellLogForm,
  setSellLogListExpanded,
  setSellLogListViewOwner,
  setSellLogOwnerForSection,
  setSellLogSymOwnerFilter,
  setSellLogSymSummaryExpanded,
  setSellOwnerTracker,
  setSellPasteText,
  setSellTickerHl,
  setSellTickerOpen,
  setSellTickerSearch,
  setShowSymbolPnl,
  setShowTradeImageImport,
  showActionSuccessToast,
  showSymbolPnl,
  usdKrw,
}: RealizedSectionProps) {
  return (
    <section id="section-realized" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-semibold">실현손익 입력</h2>
              <button
                type="button"
                className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
                onClick={() => setShowTradeImageImport(true)}
              >
                📋 문자/이미지로 거래 입력
              </button>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              종목 추가 아래에서 보유자별 매도 기록을 입력합니다. 실현손익은 매도 체결 금액(원화換算)에{" "}
              <span className="font-medium text-foreground">{((TRADING_FEE_RATE * 100).toFixed(1))}%</span>
              매도 수수료를 차감한 금액입니다.
            </p>
            {(() => {
              const owner = sellLogOwnerForSection;
              const listViewOwner = sellLogListViewOwner;
              const listLog = sellLog[listViewOwner] ?? [];
              // 기록 목록 표에서 e.realizedKrw를 표시하므로 합계도 동일 기준으로 통일
              const listTotalRealizedKrw = listLog.reduce((s, e) => s + e.realizedKrw, 0);
              // 총이익(손실 미차감): 이익 항목만 합산
              const listGrossRealizedKrw = listLog.reduce((s, e) => s + (e.realizedKrw > 0 ? e.realizedKrw : 0), 0);
              const log = sellLog[owner] ?? [];
              // 순손익(손실 차감): 이익 - 손실
              const totalRealized = log.reduce((s, e) => s + e.realizedKrw, 0);
              // 총이익(손실 미차감): 이익 항목만 합산
              const grossRealized = log.reduce((s, e) => s + (e.realizedKrw > 0 ? e.realizedKrw : 0), 0);
              const allSellLogEntries: SellLogEntry[] = Object.values(sellLog).flat();
              type SymPnlRow = {
                date: string;
                symbol: string;
                name: string;
                qty: number;
                costKrw: number;
                realizedKrw: number;
              };
              const symPnlByDateSymbol = new Map<string, SymPnlRow>();
              const dailyRealizedAllOwners = new Map<string, number>();
              for (const e of allSellLogEntries) {
                const rk = e.realizedKrw; // 저장된 값 사용(목록 표와 동일 기준)
                dailyRealizedAllOwners.set(e.date, (dailyRealizedAllOwners.get(e.date) ?? 0) + rk);
                const dsKey = `${e.date}::${e.symbol}`;
                const prev =
                  symPnlByDateSymbol.get(dsKey) ??
                  ({
                    date: e.date,
                    symbol: e.symbol,
                    name: e.name,
                    qty: 0,
                    costKrw: 0,
                    realizedKrw: 0,
                  } satisfies SymPnlRow);
                const fx = e.fxRate ?? 1;
                const costKrw = e.currency === "KRW" ? e.avgPrice * e.qty : e.avgPrice * e.qty * fx;
                symPnlByDateSymbol.set(dsKey, {
                  date: e.date,
                  symbol: e.symbol,
                  name: e.name,
                  qty: prev.qty + e.qty,
                  costKrw: prev.costKrw + costKrw,
                  realizedKrw: prev.realizedKrw + rk,
                });
              }
              const symPnlList = [...symPnlByDateSymbol.values()];
              const symPnlDatesDesc = [...new Set(symPnlList.map((r) => r.date))].sort((a, b) =>
                b.localeCompare(a),
              );
              const symPnlByDate = new Map<string, SymPnlRow[]>();
              for (const r of symPnlList) {
                const list = symPnlByDate.get(r.date) ?? [];
                list.push(r);
                symPnlByDate.set(r.date, list);
              }
              for (const d of symPnlByDate.keys()) {
                symPnlByDate.get(d)!.sort((a, b) => b.realizedKrw - a.realizedKrw);
              }

              const listByDate = new Map<string, SellLogEntry[]>();
              for (const e of listLog) {
                const list = listByDate.get(e.date) ?? [];
                list.push(e);
                listByDate.set(e.date, list);
              }
              const listDatesDesc = [...listByDate.keys()].sort((a, b) => b.localeCompare(a));
              for (const d of listByDate.keys()) {
                listByDate.get(d)!.sort((a, b) => b.id.localeCompare(a.id));
              }
              const listDailyRealized = (d: string) =>
                (listByDate.get(d) ?? []).reduce((s, e) => s + e.realizedKrw, 0);

              // ── 종목별 합산 ────────────────────────────────────────────
              const symActiveOwners = sellLogSymOwnerFilter.length === 0 ? ownerNames : sellLogSymOwnerFilter;
              const symFilteredEntries = symActiveOwners.flatMap((o) => sellLog[o] ?? []);
              type SymSummaryRow = { symbol: string; name: string; count: number; totalQty: number; totalRealizedKrw: number };
              const symSummaryMap = new Map<string, SymSummaryRow>();
              for (const e of symFilteredEntries) {
                const prev = symSummaryMap.get(e.symbol) ?? { symbol: e.symbol, name: e.name, count: 0, totalQty: 0, totalRealizedKrw: 0 };
                symSummaryMap.set(e.symbol, {
                  ...prev,
                  count: prev.count + 1,
                  totalQty: prev.totalQty + e.qty,
                  totalRealizedKrw: prev.totalRealizedKrw + e.realizedKrw,
                });
              }
              const symSummaryRows = [...symSummaryMap.values()].sort((a, b) => b.totalRealizedKrw - a.totalRealizedKrw);
              const symSummaryTotal = symSummaryRows.reduce((s, r) => s + r.totalRealizedKrw, 0);
              const symSummaryGrossTotal = symSummaryRows.reduce((s, r) => s + (r.totalRealizedKrw > 0 ? r.totalRealizedKrw : 0), 0);
              const toggleSymOwner = (name: string) => {
                setSellLogSymOwnerFilter((prev) => {
                  const current = prev.length === 0 ? ownerNames : prev;
                  const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
                  if (next.length === 0) return prev; // 최소 1명 유지
                  return next.length === ownerNames.length ? [] : next; // 전체 선택이면 빈 배열(=전체)
                });
              };
              // ────────────────────────────────────────────────────────────

              const ownerTickerOptions = Array.from(
                new Map(
                  positions.map((p) => [
                    p.symbol,
                    { symbol: p.symbol, name: p.name, avgPrice: p.avgPrice, currency: p.currency },
                  ]),
                ).values(),
              ).sort((a, b) => a.symbol.localeCompare(b.symbol));
              const defaultSellLogBlank = (sectionOwnerKey: string) => ({
                date: new Date().toISOString().slice(0, 10),
                symbol: "",
                name: "",
                qty: "",
                sellPrice: "",
                avgPrice: "",
                currency: "USD" as const,
                fxRate: String(Math.round(usdKrw)),
                note: "",
                selectedOwners: [sectionOwnerKey] as OwnerName[],
                ownerOverrides: {},
                editingId: null as string | null,
              });

              const form = sellLogForm[owner] ?? defaultSellLogBlank(owner);

              /** 폼 상태는 보유자(섹션)별 분리 저장. `sellLogOwnerForSection`을 바꿀 때는 `formOwnerKey`에 새 키를 넘기지 않으면 버그(틀린 보유자 슬롯에 쓸 수 있음) */
              const setForm2 = (
                patch: Partial<typeof form>,
                formOwnerKey = owner,
              ) => {
                setSellLogForm((prev) => {
                  const prevForm = prev[formOwnerKey];
                  const base = prevForm ?? defaultSellLogBlank(formOwnerKey);
                  return { ...prev, [formOwnerKey]: { ...base, ...patch } };
                });
                setSellLogErrorByOwner((prevErr) => ({ ...prevErr, [formOwnerKey]: "" }));
              };
              const selectedSymbol = form.symbol.trim().toUpperCase();
              const ownersWithTicker = selectedSymbol
                ? ownerNames.filter((name) =>
                    positions.some((p) => p.owner === name && p.symbol === selectedSymbol),
                  )
                : [];
              const calcRealized = (entry: typeof form) => {
                const qty = Number(entry.qty);
                const sell = Number(entry.sellPrice);
                const avg = Number(entry.avgPrice);
                const fx = Number(entry.fxRate) || 1;
                if (!Number.isFinite(qty) || !Number.isFinite(sell) || !Number.isFinite(avg)) return 0;
                return calcSellRealizedKrw({
                  qty,
                  sellPrice: sell,
                  avgPrice: avg,
                  currency: entry.currency,
                  fxRate: fx,
                });
              };
              const handleTickerChange = (nextSymbol: string) => {
                const selected = ownerTickerOptions.find((x) => x.symbol === nextSymbol);
                if (!selected) return setForm2({ symbol: nextSymbol }, owner);
                const ownersForSymbol = ownerNames.filter((name) =>
                  positions.some((p) => p.owner === name && p.symbol === selected.symbol),
                );
                const nextOwner = ownersForSymbol[0] ?? owner;
                const nextFxRate =
                  selected.currency === "KRW" ? "1" : selected.currency === "EUR" ? String(Math.round(eurKrw)) : String(Math.round(usdKrw));
                const ownerPos = positions.find((p) => p.owner === nextOwner && p.symbol === selected.symbol);
                const ownerFxRate =
                  selected.currency === "KRW"
                    ? "1"
                    : selected.currency === "EUR"
                      ? String(Math.round(ownerPos?.purchaseEurKrw ?? eurKrw))
                      : String(Math.round(ownerPos?.purchaseUsdKrw ?? usdKrw));
                setSellLogOwnerForSection(nextOwner);
                setForm2(
                  {
                    symbol: selected.symbol,
                    name: selected.name,
                    avgPrice: ownerPos ? String(ownerPos.avgPrice) : String(selected.avgPrice),
                    currency: selected.currency,
                    fxRate: ownerFxRate || nextFxRate,
                    selectedOwners: ownersForSymbol.length > 0 ? [ownersForSymbol[0]] : [],
                    ownerOverrides: {},
                  },
                  nextOwner,
                );
              };
              const handleSave = () => {
                const symbol = form.symbol.trim().toUpperCase();
                const sell = Number(form.sellPrice);
                if (!symbol || !Number.isFinite(sell) || sell <= 0) return;
                const targetOwner = form.selectedOwners[0] ?? owner;
                const hasHolding = (ownerName: string) => positions.some((p) => p.owner === ownerName && p.symbol === symbol);
                if (!hasHolding(targetOwner)) {
                  setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: `오류: ${targetOwner} 보유자에게 ${symbol} 보유 내역이 없습니다.` }));
                  return;
                }
                const reduceByOwner = new Map<string, number>();
                if (!form.editingId) {
                  const q = Number(form.qty);
                  if (Number.isFinite(q) && q > 0) {
                    reduceByOwner.set(targetOwner, q);
                  }
                  const insufficientOwners: string[] = [];
                  for (const [targetOwner, q] of reduceByOwner) {
                    const holdingQty = positions
                      .filter((p) => p.owner === targetOwner && p.symbol === symbol)
                      .reduce((s, p) => s + p.quantity, 0);
                    if (holdingQty + 1e-9 < q) {
                      insufficientOwners.push(`${targetOwner}(보유 ${holdingQty}, 입력 ${q})`);
                    }
                  }
                  if (insufficientOwners.length > 0) {
                    setSellLogErrorByOwner((prev) => ({
                      ...prev,
                      [owner]: `오류: 보유수량보다 많이 입력했습니다. ${insufficientOwners.join(", ")}`,
                    }));
                    return;
                  }
                }
                const qty = Number(form.qty);
                const avg = Number(form.avgPrice);
                const fx = Number(form.fxRate) || 1;
                const entry: SellLogEntry = {
                  // eslint-disable-next-line react-hooks/purity -- 클릭 핸들러(handleSave) 안에서만 실행되며 렌더 중 호출되지 않음
                  id: form.editingId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  date: form.date,
                  symbol,
                  name: form.name.trim() || symbol,
                  qty,
                  sellPrice: sell,
                  avgPrice: avg,
                  currency: form.currency,
                  fxRate: fx,
                  realizedKrw: calcSellRealizedKrw({
                    qty,
                    sellPrice: sell,
                    avgPrice: avg,
                    currency: form.currency,
                    fxRate: fx,
                  }),
                  note: form.note.trim() || undefined,
                };
                if (!form.editingId) {
                  setSellLog((prev) => {
                    const q = Number(form.qty);
                    const a = Number(form.avgPrice);
                    const f = Number(form.fxRate) || 1;
                    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(a) || a <= 0) return prev;
                    const e2: SellLogEntry = {
                      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      date: form.date,
                      symbol,
                      name: form.name.trim() || symbol,
                      qty: q,
                      sellPrice: sell,
                      avgPrice: a,
                      currency: form.currency,
                      fxRate: f,
                      realizedKrw: calcSellRealizedKrw({ qty: q, sellPrice: sell, avgPrice: a, currency: form.currency, fxRate: f }),
                      note: form.note.trim() || undefined,
                    };
                    return { ...prev, [targetOwner]: [...(prev[targetOwner] ?? []), e2] };
                  });
                  // 매도대금 현금 자동 반영 — 매도 수수료(0.2%) 차감한 순입금액 기준
                  // (매수는 수수료 포함 차감, 실현손익도 수수료 차감하므로 입금도 net로 통일)
                  setCashByOwner((prev) => {
                    let next = { ...prev };
                    const formFx = Number(form.fxRate) || eurKrw; // EUR 원화 환산은 입력 환율 우선
                    for (const [targetOwner, q] of reduceByOwner) {
                      const currentCash = next[targetOwner] ?? { usd: 0, krw: 0 };
                      const netProceeds = q * sell * (1 - TRADING_FEE_RATE);
                      if (form.currency === "KRW") {
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            krw: currentCash.krw + netProceeds,
                          },
                        };
                      } else if (form.currency === "USD") {
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            usd: currentCash.usd + netProceeds,
                          },
                        };
                      } else {
                        // EUR: 입력 환율(form.fxRate)로 원화 환산해 입금
                        next = {
                          ...next,
                          [targetOwner]: {
                            ...currentCash,
                            krw: currentCash.krw + netProceeds * formFx,
                          },
                        };
                      }
                    }
                    return next;
                  });
                  setPositions((prev) => {
                    let next = [...prev];
                    for (const [targetOwner, q] of reduceByOwner) {
                      let remain = q;
                      next = next.map((p) => {
                        if (remain <= 0 || p.owner !== targetOwner || p.symbol !== symbol) return p;
                        const cut = Math.min(p.quantity, remain);
                        remain -= cut;
                        return { ...p, quantity: p.quantity - cut };
                      });
                      next = next.filter((p) => p.quantity > 0);
                    }
                    return next;
                  });
                } else {
                  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(avg) || avg <= 0) return;
                  setSellLog((prev) => {
                    const existing = prev[owner] ?? [];
                    return { ...prev, [owner]: existing.map((e) => (e.id === form.editingId ? entry : e)) };
                  });
                }
                const newRealizedSaveOk =
                  !form.editingId &&
                  Number.isFinite(Number(form.qty)) &&
                  Number(form.qty) > 0 &&
                  Number.isFinite(Number(form.avgPrice)) &&
                  Number(form.avgPrice) > 0;
                if (form.editingId || newRealizedSaveOk) {
                  showActionSuccessToast("실현손익이 정상적으로 반영되었습니다.");
                }
                // 누락 보유자 추적 업데이트 (신규 저장만)
                if (newRealizedSaveOk) {
                  setSellOwnerTracker((prev) => {
                    const sym = symbol;
                    const dt = form.date;
                    const prevDone = prev?.symbol === sym && prev?.date === dt ? prev.doneOwners : [];
                    return { symbol: sym, date: dt, doneOwners: [...new Set([...prevDone, targetOwner])] };
                  });
                }
                setForm2({
                  symbol: "", name: "", qty: "", sellPrice: "", avgPrice: "",
                  currency: "USD", fxRate: String(Math.round(usdKrw)),
                  note: "", selectedOwners: [owner], ownerOverrides: {}, editingId: null,
                });
                setSellTickerSearch((prev) => { const next = { ...prev }; delete next[owner]; return next; });
                window.setTimeout(() => { sellTickerInputRefs.current[owner]?.focus(); }, 0);
              };
              const handleListEdit = (e: SellLogEntry) => {
                setSellLogOwnerForSection(listViewOwner);
                setSellLogForm((prev) => {
                  const base =
                    prev[listViewOwner] ?? {
                      date: new Date().toISOString().slice(0, 10),
                      symbol: "",
                      name: "",
                      qty: "",
                      sellPrice: "",
                      avgPrice: "",
                      currency: "USD" as const,
                      fxRate: String(Math.round(usdKrw)),
                      note: "",
                      selectedOwners: [listViewOwner],
                      ownerOverrides: {},
                      editingId: null,
                    };
                  return {
                    ...prev,
                    [listViewOwner]: {
                      ...base,
                      date: e.date,
                      symbol: e.symbol,
                      name: e.name,
                      qty: String(e.qty),
                      sellPrice: String(e.sellPrice),
                      avgPrice: String(e.avgPrice),
                      currency: e.currency,
                      fxRate: String(e.fxRate),
                      note: e.note ?? "",
                      selectedOwners: [listViewOwner],
                      ownerOverrides: {},
                      editingId: e.id,
                    },
                  };
                });
                setSellLogErrorByOwner((p) => ({ ...p, [listViewOwner]: "" }));
              };
              const handleListDelete = (id: string) => {
                setSellLog((prev) => ({
                  ...prev,
                  [listViewOwner]: (prev[listViewOwner] ?? []).filter((x) => x.id !== id),
                }));
              };
              const preview = calcRealized(form);
              return (
                <div className="space-y-2">
                  {/* ── 미래에셋 체결 알림 붙여넣기 (매도) ── */}
                  <div className="rounded-xl border border-slate-700/50 bg-slate-900/30 p-3">
                    <p className="mb-1.5 text-[11px] font-semibold text-slate-300">
                      증권사 체결 알림 붙여넣기 <span className="font-normal text-slate-500">— 미래에셋·하나·메리츠증권 체결 알림 텍스트를 그대로 붙여넣으면 자동 입력됩니다</span>
                    </p>
                    <textarea
                      rows={3}
                      placeholder={"[미래에셋증권] 전량체결 또는 [하나증권] 퇴직연금 매매체결 안내\n체결 알림 텍스트를 그대로 붙여넣으세요"}
                      className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70"
                      value={sellPasteText}
                      onChange={(e) => {
                        const text = e.target.value;
                        setSellPasteText(text);
                        if (!text.trim()) {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "" }));
                          return;
                        }
                        const parsed = parseBrokerNotification(text);
                        if (!parsed) {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "지원하지 않는 형식입니다. (미래에셋·하나·메리츠증권 체결 알림만 지원)" }));
                          return;
                        }
                        if (parsed.tradeType === "buy") {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [owner]: "⚠️ 매수 체결 내역입니다. '종목 추가' 탭에 붙여넣어 주세요." }));
                          return;
                        }
                        // 증권사/계좌종류/계좌번호로 보유자 자동 전환
                        const resolvedBrokerOwner = resolveBrokerOwner(parsed, ownerNames);
                        const ownerUnresolved = !resolvedBrokerOwner && !!parsed.accountName;
                        const autoOwner = resolvedBrokerOwner || owner;
                        if (autoOwner !== owner) setSellLogOwnerForSection(autoOwner);
                        // 해당 보유자의 포지션에서 티커·평균단가 자동 조회
                        const pos = positions.find(
                          (p) => p.owner === autoOwner && (
                            (parsed.symbol && p.symbol === parsed.symbol) || p.name === parsed.name
                          ),
                        );
                        const resolvedSellSymbol = pos ? pos.symbol : (parsed.symbol || "");
                        const resolvedSellName = pos ? pos.name : parsed.name;
                        const avgPrice = pos ? String(pos.avgPrice) : "";
                        const fxRate = parsed.currency === "KRW" ? "1"
                          : parsed.currency === "EUR" ? String(Math.round(eurKrw))
                          : String(Math.round(usdKrw));
                        // 담당자 미특정 안내 (우선순위 1)
                        if (ownerUnresolved) {
                          setSellLogErrorByOwner((prev) => ({
                            ...prev,
                            [autoOwner]: `ℹ️ 계좌명(${parsed.accountName})으로 담당자를 특정할 수 없습니다. 담당자를 직접 선택해주세요.`,
                          }));
                        } else if (!pos && !parsed.symbol) {
                          setSellLogErrorByOwner((prev) => ({
                            ...prev,
                            [autoOwner]: "ℹ️ 보유 목록에 없는 종목입니다. 티커(종목코드)를 직접 입력해주세요.",
                          }));
                        } else if (!pos && parsed.symbol) {
                          setSellLogErrorByOwner((prev) => ({
                            ...prev,
                            [autoOwner]: "ℹ️ 보유 목록에 없는 종목입니다. 평균매입단가를 직접 입력해주세요.",
                          }));
                        } else {
                          setSellLogErrorByOwner((prev) => ({ ...prev, [autoOwner]: "" }));
                        }
                        setForm2(
                          {
                            symbol: resolvedSellSymbol,
                            name: resolvedSellName,
                            qty: String(parsed.qty),
                            sellPrice: String(parsed.price),
                            avgPrice,
                            currency: parsed.currency,
                            fxRate: pos
                              ? (parsed.currency === "USD" ? String(Math.round(pos.purchaseUsdKrw ?? usdKrw))
                                : parsed.currency === "EUR" ? String(Math.round(pos.purchaseEurKrw ?? eurKrw))
                                : "1")
                              : fxRate,
                            selectedOwners: [autoOwner],
                            ...(parsed.date ? { date: parsed.date } : {}),
                          },
                          autoOwner,
                        );
                        setSellPasteText("");
                      }}
                    />
                    {sellLogErrorByOwner[owner] && (
                      <p className={`mt-1.5 text-[11px] font-medium ${sellLogErrorByOwner[owner].startsWith("ℹ️") ? "text-blue-400" : "text-red-400"}`}>
                        {sellLogErrorByOwner[owner]}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      보유자는 전부 표시됩니다(해당 티커를 안 갖고 있으면 &quot;· 미보유&quot;). 그 티커는 실제로 보유한 보유자만 저장됩니다.
                    </span>
                    <button
                      type="button"
                      className="text-xs underline-offset-2 hover:underline text-right leading-relaxed"
                      onClick={() => setSellLogDetailOpenOwner(owner)}
                    >
                      <span className="text-muted-foreground">총이익 </span>
                      <span className={`font-semibold tabular-nums ${grossRealized > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                        {grossRealized >= 0 ? "+" : ""}₩{fmtInt(grossRealized)}
                      </span>
                      <span className="mx-1 text-muted-foreground">/</span>
                      <span className="text-muted-foreground">순손익 </span>
                      <span className={`font-bold tabular-nums ${totalRealized > 0 ? "text-red-500" : totalRealized < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                        {totalRealized >= 0 ? "+" : ""}₩{fmtInt(totalRealized)}
                      </span>
                    </button>
                  </div>
                  <div className="rounded-xl border border-slate-700/50 bg-slate-900/30 p-3 space-y-3 text-xs">
                    {/* 행 1: 날짜 · 티커 · 통화 */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">날짜</span>
                        <input type="date" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 outline-none focus:border-indigo-500/70" value={form.date} onChange={(e) => setForm2({ date: e.target.value })} />
                      </label>
                      <label className="relative flex flex-col gap-1 sm:col-span-2">
                        <span className="text-[10px] font-medium text-slate-400">티커 / 종목명</span>
                        {(() => {
                          const q = (sellTickerSearch[owner] ?? "").toLowerCase();
                          const filtered = ownerTickerOptions.filter((opt) =>
                            !q || opt.symbol.toLowerCase().includes(q) || opt.name.toLowerCase().includes(q)
                          );
                          const hl = sellTickerHl[owner] ?? 0;
                          const selectByIndex = (idx: number) => {
                            const opt = filtered[idx];
                            if (!opt) return;
                            handleTickerChange(opt.symbol);
                            setSellTickerSearch((prev) => { const next = { ...prev }; delete next[owner]; return next; });
                            setSellTickerOpen((prev) => ({ ...prev, [owner]: false }));
                            setSellTickerHl((prev) => ({ ...prev, [owner]: 0 }));
                          };
                          return (
                            <>
                              <input
                                ref={(el) => { sellTickerInputRefs.current[owner] = el; }}
                                className="w-full rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70"
                                placeholder="티커 또는 종목명 검색"
                                value={sellTickerSearch[owner] ?? (form.symbol ? `${form.symbol}(${form.name})` : "")}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setSellTickerSearch((prev) => ({ ...prev, [owner]: v }));
                                  setSellTickerOpen((prev) => ({ ...prev, [owner]: true }));
                                  setSellTickerHl((prev) => ({ ...prev, [owner]: 0 }));
                                  if (v === "") handleTickerChange("");
                                }}
                                onFocus={() => setSellTickerOpen((prev) => ({ ...prev, [owner]: true }))}
                                onBlur={() => window.setTimeout(() => setSellTickerOpen((prev) => ({ ...prev, [owner]: false })), 150)}
                                onKeyDown={(e) => {
                                  if (!sellTickerOpen[owner] || filtered.length === 0) return;
                                  if (e.key === "ArrowDown") { e.preventDefault(); setSellTickerHl((prev) => ({ ...prev, [owner]: Math.min((prev[owner] ?? 0) + 1, filtered.length - 1) })); }
                                  else if (e.key === "ArrowUp") { e.preventDefault(); setSellTickerHl((prev) => ({ ...prev, [owner]: Math.max((prev[owner] ?? 0) - 1, 0) })); }
                                  else if (e.key === "Enter") { e.preventDefault(); selectByIndex(hl); }
                                  else if (e.key === "Escape") { setSellTickerOpen((prev) => ({ ...prev, [owner]: false })); }
                                }}
                                autoComplete="off"
                              />
                              {sellTickerOpen[owner] && filtered.length > 0 && (
                                <ul
                                  className="absolute left-0 top-full z-50 mt-0.5 max-h-48 w-max min-w-full overflow-y-auto rounded border shadow-lg"
                                  style={{ background: "var(--background, #18181b)", color: "inherit" }}
                                  onMouseDown={(e) => e.preventDefault()}
                                >
                                  {filtered.map((opt, idx) => (
                                    <li
                                      key={opt.symbol}
                                      className="cursor-pointer px-2 py-1"
                                      style={{ background: idx === hl ? "var(--accent, #27272a)" : "transparent" }}
                                      onMouseEnter={() => setSellTickerHl((prev) => ({ ...prev, [owner]: idx }))}
                                      onMouseDown={(e) => { e.preventDefault(); selectByIndex(idx); }}
                                    >
                                      <span className="font-mono">{opt.symbol}</span>
                                      <span className="ml-1 text-muted-foreground">{opt.name}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </>
                          );
                        })()}
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">통화</span>
                        <select className="cursor-pointer rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 outline-none focus:border-indigo-500/70" value={form.currency} onChange={(e) => setForm2({ currency: e.target.value as "USD" | "EUR" | "KRW" })}>
                          <option value="USD">USD</option><option value="EUR">EUR</option><option value="KRW">KRW</option>
                        </select>
                      </label>
                    </div>

                    {/* 행 2: 담당자 (라디오 버튼) */}
                    <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-3 py-2">
                      <p className="mb-2 text-[10px] font-medium text-slate-400">담당자</p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {ownerNames.map((name) => {
                          const isSelected = (form.selectedOwners[0] ?? "") === name;
                          const anySelected = form.selectedOwners.length > 0;
                          const noHolding = Boolean(selectedSymbol) && !ownersWithTicker.includes(name);
                          return (
                            <label
                              key={name}
                              className={`flex cursor-pointer items-center gap-1.5 select-none transition-opacity ${anySelected && !isSelected ? "opacity-30" : "opacity-100"}`}
                            >
                              <input
                                type="radio"
                                name={`sell-form-owner-${owner}`}
                                className="cursor-pointer accent-primary"
                                checked={isSelected}
                                onChange={() => {
                                  const match = positions.find((p) => p.owner === name && p.symbol === selectedSymbol);
                                  const matchedFxRate = form.currency === "KRW" ? "1"
                                    : form.currency === "EUR" ? String(Math.round(match?.purchaseEurKrw ?? eurKrw))
                                    : String(Math.round(match?.purchaseUsdKrw ?? usdKrw));
                                  setSellLogOwnerForSection(name);
                                  setForm2(
                                    {
                                      symbol: form.symbol, name: form.name, date: form.date,
                                      qty: form.qty, sellPrice: form.sellPrice, note: form.note,
                                      currency: form.currency, editingId: form.editingId,
                                      selectedOwners: [name], ownerOverrides: {},
                                      avgPrice: match ? String(match.avgPrice) : form.avgPrice,
                                      fxRate: matchedFxRate,
                                    },
                                    name,
                                  );
                                }}
                              />
                              <span className={`text-sm ${isSelected ? "font-semibold text-foreground" : ""}`}>
                                {name}
                                {noHolding && <span className="ml-0.5 text-[10px] text-slate-500">· 미보유</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    {/* 행 3: 수량 · 매도가 · 매수평단가 · 매입환율 */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">수량</span>
                        <input type="number" min="0" step="any" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.qty} onChange={(e) => setForm2({ qty: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">매도가</span>
                        <input type="number" min="0" step="any" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.sellPrice} onChange={(e) => setForm2({ sellPrice: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">매수평단가</span>
                        <input type="number" min="0" step="any" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.avgPrice} onChange={(e) => setForm2({ avgPrice: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium text-slate-400">매입 환율 (₩)</span>
                        <input type="number" min="0" step="1" className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-right text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="0" value={form.fxRate} onChange={(e) => setForm2({ fxRate: e.target.value })} />
                      </label>
                    </div>

                    {/* 행 4: 메모 · 저장 */}
                    <div className="flex gap-2">
                      <input className="flex-1 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1.5 text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70" placeholder="메모 (선택)" value={form.note} onChange={(e) => setForm2({ note: e.target.value })} />
                      <button
                        type="button"
                        disabled={!!(sellLogErrorByOwner[owner] && sellLogErrorByOwner[owner].startsWith("⚠️"))}
                        className="shrink-0 cursor-pointer rounded-md bg-primary px-4 py-1.5 font-semibold text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={handleSave}
                      >
                        {form.editingId ? "수정 저장" : "+ 기록 추가"}
                      </button>
                    </div>

                    {/* 실현손익 예상 */}
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold">
                        실현손익 예상: <span className={preview >= 0 ? "text-red-400" : "text-blue-400"}>{preview >= 0 ? "+" : ""}₩{fmtInt(preview)}</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground">(매도 {(TRADING_FEE_RATE * 100).toFixed(1)}% 반영)</span>
                    </div>

                    {/* ── 실현손익 누락 보유자 알림 ──────────────────────────── */}
                    {sellOwnerTracker && (() => {
                      const holders = ownerNames.filter((n) =>
                        positions.some((p) => p.owner === n && p.symbol === sellOwnerTracker.symbol),
                      );
                      const missing = holders.filter((n) => !sellOwnerTracker.doneOwners.includes(n));
                      const allDone = missing.length === 0;
                      return (
                        <div
                          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                            allDone
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                              : "border-amber-500/35 bg-amber-500/8 text-amber-200"
                          }`}
                        >
                          <span className="shrink-0 text-sm">{allDone ? "✓" : "⚠️"}</span>
                          <span className="font-semibold">{sellOwnerTracker.symbol}</span>
                          <span className="text-[10px] text-muted-foreground">{sellOwnerTracker.date}</span>
                          {allDone ? (
                            <span className="text-emerald-400">— 보유자 전원 입력 완료</span>
                          ) : (
                            <span>
                              — 아직 미입력:{" "}
                              <strong className="text-amber-300">{missing.join(", ")}</strong>
                            </span>
                          )}
                          {!allDone && (
                            <button
                              type="button"
                              onClick={() => setSellOwnerTracker(null)}
                              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                              aria-label="알림 닫기"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {symPnlList.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border bg-muted/20 p-2">
                      <div className="mb-2 flex justify-end">
                        <button
                          type="button"
                          className="rounded border px-2 py-0.5 text-[10px] hover:bg-muted"
                          onClick={() =>
                            setShowSymbolPnl((prev) => ({
                              ...prev,
                              [REALIZED_SYMBOL_PNL_TOGGLE_KEY]: !prev[REALIZED_SYMBOL_PNL_TOGGLE_KEY],
                            }))
                          }
                        >
                          {showSymbolPnl[REALIZED_SYMBOL_PNL_TOGGLE_KEY]
                            ? "종목별 접기 ▲"
                            : "종목별 손익 ▼ (전원 합산)"}
                        </button>
                      </div>
                      {showSymbolPnl[REALIZED_SYMBOL_PNL_TOGGLE_KEY] && (
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="py-1 pr-2 text-left font-medium">종목</th>
                              <th className="py-1 pr-2 text-right font-medium">총매도량</th>
                              <th className="py-1 pr-2 text-right font-medium">매수원가(₩)</th>
                              <th className="py-1 pr-2 text-right font-medium">실현손익(₩)</th>
                              <th className="py-1 text-right font-medium">수익률</th>
                            </tr>
                          </thead>
                          <tbody>
                            {symPnlDatesDesc.map((d) => {
                              const daySum = dailyRealizedAllOwners.get(d) ?? 0;
                              const dayRows = symPnlByDate.get(d) ?? [];
                              return (
                                <Fragment key={d}>
                                  <tr className="border-b border-border/50 bg-muted/50">
                                    <td colSpan={5} className="py-1.5 pl-1 text-[10px] font-semibold sm:text-xs">
                                      <span className="text-sm tabular-nums text-foreground sm:text-base">
                                        {d}
                                      </span>
                                      <span className="ml-2 text-muted-foreground">— 당일 합산 실현손익</span>{" "}
                                      <span
                                        className={
                                          daySum > 0
                                            ? "text-red-500"
                                            : daySum < 0
                                              ? "text-blue-500"
                                              : "text-muted-foreground"
                                        }
                                      >
                                        {daySum >= 0 ? "+" : ""}₩{fmtInt(daySum)}
                                      </span>
                                    </td>
                                  </tr>
                                  {dayRows.map((s) => {
                                    const pct = s.costKrw > 0 ? (s.realizedKrw / s.costKrw) * 100 : 0;
                                    return (
                                      <tr
                                        key={`${d}-${s.symbol}`}
                                        className="border-b border-border/30 last:border-0"
                                      >
                                        <td className="py-1 pr-2">
                                          <span className="font-medium">{s.name}</span>
                                          <span className="ml-1 text-muted-foreground">{s.symbol}</span>
                                        </td>
                                        <td className="py-1 pr-2 text-right tabular-nums">{s.qty}</td>
                                        <td className="py-1 pr-2 text-right tabular-nums">
                                          ₩{fmtInt(s.costKrw)}
                                        </td>
                                        <td
                                          className={`py-1 pr-2 text-right tabular-nums font-semibold ${s.realizedKrw > 0 ? "text-red-500" : s.realizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                        >
                                          {s.realizedKrw >= 0 ? "+" : ""}₩
                                          {fmtInt(s.realizedKrw)}
                                        </td>
                                        <td
                                          className={`py-1 text-right tabular-nums font-semibold ${pct > 0 ? "text-red-500" : pct < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                        >
                                          {pct >= 0 ? "+" : ""}
                                          {pct.toFixed(2)}%
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                  <div className="overflow-x-auto rounded-lg border bg-muted/20 p-2">
                    <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold">기록 목록</p>
                        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span>열람</span>
                          <select
                            className="max-w-[10rem] cursor-pointer rounded border bg-background px-2 py-0.5 text-xs"
                            value={sellLogListViewOwner}
                            onChange={(e) => setSellLogListViewOwner(e.target.value)}
                          >
                            {ownerNames.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <span className="text-[10px] text-muted-foreground tabular-nums">({listLog.length}건)</span>
                        {listLog.length > 0 ? (
                          <span className="text-[10px] text-muted-foreground">
                            · 총이익{" "}
                            <span className={`tabular-nums font-semibold ${listGrossRealizedKrw > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                              {listGrossRealizedKrw >= 0 ? "+" : ""}₩{fmtInt(listGrossRealizedKrw)}
                            </span>
                            {" / "}순손익{" "}
                            <span
                              className={`tabular-nums font-semibold ${
                                listTotalRealizedKrw > 0
                                  ? "text-red-500"
                                  : listTotalRealizedKrw < 0
                                    ? "text-blue-500"
                                    : "text-muted-foreground"
                              }`}
                            >
                              {listTotalRealizedKrw >= 0 ? "+" : ""}₩{fmtInt(listTotalRealizedKrw)}
                            </span>
                            <span className="opacity-70">
                              {" "}
                              (수수료 {(TRADING_FEE_RATE * 100).toFixed(1)}% 반영)
                            </span>
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="w-fit rounded border px-2 py-0.5 text-[10px] hover:bg-muted sm:ml-auto"
                        onClick={() => setSellLogListExpanded((v) => !v)}
                      >
                        {sellLogListExpanded ? "접기 ▲" : "펼치기 ▼"}
                      </button>
                    </div>
                    {sellLogListExpanded ? (
                      listLog.length > 0 ? (
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="py-1 pr-2 text-left font-medium">종목</th>
                              <th className="py-1 pr-2 text-right font-medium">수량</th>
                              <th className="py-1 pr-2 text-right font-medium">매도가</th>
                              <th className="py-1 pr-2 text-right font-medium">평단가</th>
                              <th className="py-1 pr-2 text-right font-medium">실현손익</th>
                              <th className="py-1 text-right font-medium">관리</th>
                            </tr>
                          </thead>
                          <tbody>
                            {listDatesDesc.map((d) => {
                              const dayEnt = listByDate.get(d) ?? [];
                              const dayTotal = listDailyRealized(d);
                              return (
                                <Fragment key={`list-${d}`}>
                                  <tr className="border-b border-border/50 bg-muted/40">
                                    <td colSpan={6} className="px-0 py-0">
                                      <div className="flex flex-col gap-0.5 px-1 py-2 sm:flex-row sm:items-baseline sm:gap-3">
                                        <span className="text-sm font-bold tabular-nums tracking-tight text-foreground sm:text-base">
                                          {d}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground sm:text-[11px]">
                                          당일 합산 실현손익
                                        </span>
                                        <span
                                          className={`text-xs font-semibold tabular-nums sm:text-sm ${dayTotal > 0 ? "text-red-500" : dayTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                        >
                                          {dayTotal >= 0 ? "+" : ""}₩{fmtInt(dayTotal)}
                                        </span>
                                      </div>
                                    </td>
                                  </tr>
                                  {dayEnt.map((e) => (
                                    <tr key={e.id} className="border-b border-border/30 last:border-0">
                                      <td className="py-1 pr-2">
                                        {e.name} <span className="text-muted-foreground">({e.symbol})</span>
                                      </td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{e.qty}</td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{e.sellPrice}</td>
                                      <td className="py-1 pr-2 text-right tabular-nums">{e.avgPrice}</td>
                                      <td
                                        className={`py-1 pr-2 text-right tabular-nums font-semibold ${calcSellRealizedKrw(e) > 0 ? "text-red-500" : calcSellRealizedKrw(e) < 0 ? "text-blue-500" : "text-muted-foreground"}`}
                                      >
                                        {calcSellRealizedKrw(e) >= 0 ? "+" : ""}₩
                                        {fmtInt(calcSellRealizedKrw(e))}
                                      </td>
                                      <td className="py-1 text-right">
                                        <div className="flex justify-end gap-1">
                                          <button
                                            type="button"
                                            className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                                            onClick={() => handleListEdit(e)}
                                          >
                                            수정
                                          </button>
                                          <button
                                            type="button"
                                            className="rounded border px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                                            onClick={() => handleListDelete(e.id)}
                                          >
                                            삭제
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">이 보유자의 매도 기록이 없습니다.</p>
                      )
                    ) : null}
                  </div>

                  {/* 종목별 합산 패널 */}
                  <div className="overflow-x-auto rounded-lg border bg-muted/20 p-2">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold">종목별 합산</p>
                        {/* 보유자 필터 토글 버튼 */}
                        <div className="flex flex-wrap gap-1">
                          {ownerNames.map((name) => {
                            const active = sellLogSymOwnerFilter.length === 0 || sellLogSymOwnerFilter.includes(name);
                            return (
                              <button
                                key={name}
                                type="button"
                                onClick={() => toggleSymOwner(name)}
                                className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                                  active
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:bg-muted"
                                }`}
                              >
                                {name}
                              </button>
                            );
                          })}
                        </div>
                        {symSummaryRows.length > 0 && (
                          <span className={`text-[10px] tabular-nums font-semibold ${symSummaryTotal > 0 ? "text-red-500" : symSummaryTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                            합산 {symSummaryTotal >= 0 ? "+" : ""}₩{fmtInt(Math.round(symSummaryTotal))}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="w-fit rounded border px-2 py-0.5 text-[10px] hover:bg-muted"
                        onClick={() => setSellLogSymSummaryExpanded((v) => !v)}
                      >
                        {sellLogSymSummaryExpanded ? "접기 ▲" : "펼치기 ▼"}
                      </button>
                    </div>
                    {sellLogSymSummaryExpanded && (
                      symSummaryRows.length > 0 ? (
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="py-1 pr-2 text-left font-medium">종목</th>
                              <th className="py-1 pr-2 text-right font-medium">거래 횟수</th>
                              <th className="py-1 pr-2 text-right font-medium">총 수량</th>
                              <th className="py-1 text-right font-medium">실현손익 합계</th>
                            </tr>
                          </thead>
                          <tbody>
                            {symSummaryRows.map((row) => (
                              <tr key={row.symbol} className="border-b border-border/30 last:border-0 hover:bg-muted/30">
                                <td className="py-1 pr-2">
                                  <span className="font-medium">{row.name}</span>
                                  <span className="ml-1 text-[10px] text-muted-foreground">({row.symbol})</span>
                                </td>
                                <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{row.count}회</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{row.totalQty}</td>
                                <td className={`py-1 text-right tabular-nums font-semibold ${row.totalRealizedKrw > 0 ? "text-red-500" : row.totalRealizedKrw < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                  {row.totalRealizedKrw >= 0 ? "+" : ""}₩{fmtInt(Math.round(row.totalRealizedKrw))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-border">
                              <td className="py-1.5 pr-2 text-[10px] text-muted-foreground" colSpan={3}>총이익 (손실 미차감)</td>
                              <td className={`py-1.5 text-right tabular-nums text-xs font-semibold ${symSummaryGrossTotal > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                                {symSummaryGrossTotal >= 0 ? "+" : ""}₩{fmtInt(Math.round(symSummaryGrossTotal))}
                              </td>
                            </tr>
                            <tr className="border-t border-border/50">
                              <td className="py-1.5 pr-2 text-xs font-bold text-foreground" colSpan={3}>순손익 (손실 차감)</td>
                              <td className={`py-1.5 text-right tabular-nums text-xs font-bold ${symSummaryTotal > 0 ? "text-red-500" : symSummaryTotal < 0 ? "text-blue-500" : "text-muted-foreground"}`}>
                                {symSummaryTotal >= 0 ? "+" : ""}₩{fmtInt(Math.round(symSummaryTotal))}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">선택한 보유자의 매도 기록이 없습니다.</p>
                      )
                    )}
                  </div>
                </div>
              );
            })()}
          </section>
  );
}
