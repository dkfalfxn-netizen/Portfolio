"use client";

import { parseBrokerNotification, resolveBrokerOwner } from "@/lib/broker-notification-parser";
import { HOLDINGS_CHART_GROUP_PRESETS, OwnerName, Position, WatchlistRow } from "@/lib/portfolio-types";
import { cn } from "@/lib/utils";
import { fmtInt } from "@/lib/format-money";
import { type RefObject, type FormEvent, type Dispatch, type SetStateAction } from "react";

export type AddPositionSectionProps = {
  addFormFxManualRef: RefObject<boolean>;
  addOwnerTracker: { symbol: string; name: string; isKorean: boolean; doneOwners: string[]; }[];
  addPositionError: string;
  addSymbolInputRef: RefObject<HTMLInputElement | null>;
  buyPasteError: string;
  buyPasteText: string;
  eurKrw: number;
  filteredHoldingsTickers: { symbol: string; name: string; }[];
  form: { symbol: string; name: string; quantity: string; avgPrice: string; purchaseUsdKrw: string; purchaseEurKrw: string; purchaseDateForFx: string; chartGroup: string; currency: "USD" | "EUR" | "KRW"; accountType: "\uD574\uC678\uC8FC\uC2DD" | "\uAD6D\uB0B4\uC8FC\uC2DD"; selectedOwners: OwnerName[]; };
  handleAddOwner: () => void;
  handleAddSymbolInput: (value: string) => void;
  handleDeleteOwner: (name: string) => void;
  handleRenameOwner: (name: string) => void;
  handleSubmit: (e: FormEvent<HTMLFormElement>) => void;
  holdingsTickerSuggestHl: number;
  holdingsTickerSuggestOpen: boolean;
  ownerNames: string[];
  positions: Position[];
  purchaseFxAutoBusy: boolean;
  setAddOwnerTracker: Dispatch<SetStateAction<{ symbol: string; name: string; isKorean: boolean; doneOwners: string[]; }[]>>;
  setBuyPasteError: Dispatch<SetStateAction<string>>;
  setBuyPasteText: Dispatch<SetStateAction<string>>;
  setForm: Dispatch<SetStateAction<{ symbol: string; name: string; quantity: string; avgPrice: string; purchaseUsdKrw: string; purchaseEurKrw: string; purchaseDateForFx: string; chartGroup: string; currency: "USD" | "EUR" | "KRW"; accountType: "\uD574\uC678\uC8FC\uC2DD" | "\uAD6D\uB0B4\uC8FC\uC2DD"; selectedOwners: OwnerName[]; }>>;
  setHoldingsTickerSuggestHl: Dispatch<SetStateAction<number>>;
  setHoldingsTickerSuggestOpen: Dispatch<SetStateAction<boolean>>;
  setShowTradeImageImport: Dispatch<SetStateAction<boolean>>;
  skipAddFormAutoChartGroupRef: RefObject<boolean>;
  skipAddFormAutoNameRef: RefObject<boolean>;
  totalCashKrw: number;
  usdKrw: number;
  watchlistRows: WatchlistRow[];
};

export function AddPositionSection({
  addFormFxManualRef,
  addOwnerTracker,
  addPositionError,
  addSymbolInputRef,
  buyPasteError,
  buyPasteText,
  eurKrw,
  filteredHoldingsTickers,
  form,
  handleAddOwner,
  handleAddSymbolInput,
  handleDeleteOwner,
  handleRenameOwner,
  handleSubmit,
  holdingsTickerSuggestHl,
  holdingsTickerSuggestOpen,
  ownerNames,
  positions,
  purchaseFxAutoBusy,
  setAddOwnerTracker,
  setBuyPasteError,
  setBuyPasteText,
  setForm,
  setHoldingsTickerSuggestHl,
  setHoldingsTickerSuggestOpen,
  setShowTradeImageImport,
  skipAddFormAutoChartGroupRef,
  skipAddFormAutoNameRef,
  totalCashKrw,
  usdKrw,
  watchlistRows,
}: AddPositionSectionProps) {
  return (
    <section id="section-add" className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold">종목 추가</h2>
              <button
                type="button"
                className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
                onClick={() => setShowTradeImageImport(true)}
              >
                📋 문자/이미지로 거래 입력
              </button>
            </div>
            <div className="mb-4 rounded-xl border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">보유자 관리</p>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border px-2 py-1 text-xs transition-all hover:bg-muted active:scale-95"
                  onClick={handleAddOwner}
                >
                  + 보유자 추가
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ownerNames.map((name) => (
                  <div key={name} className="flex items-center gap-1 rounded-md border bg-background px-2 py-1">
                    <span className="text-xs font-medium">{name}</span>
                    <button
                      type="button"
                      className="rounded px-1 text-[11px] text-muted-foreground hover:bg-muted"
                      onClick={() => handleRenameOwner(name)}
                    >
                      이름수정
                    </button>
                    <button
                      type="button"
                      className="rounded px-1 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                      disabled={ownerNames.length <= 1}
                      onClick={() => handleDeleteOwner(name)}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            </div>
            {/* ── 미래에셋 체결 알림 붙여넣기 (매수) ── */}
            <div className="mb-4 rounded-xl border border-slate-700/50 bg-slate-900/30 p-3">
              <p className="mb-1.5 text-[11px] font-semibold text-slate-300">
                증권사 체결 알림 붙여넣기 <span className="font-normal text-slate-500">— 미래에셋·하나·메리츠증권 체결 알림 텍스트를 그대로 붙여넣으면 자동 입력됩니다</span>
              </p>
              <textarea
                rows={3}
                placeholder={"[미래에셋증권] 전량체결 또는 [하나증권] 퇴직연금 매매체결 안내\n체결 알림 텍스트를 그대로 붙여넣으세요"}
                className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/70"
                value={buyPasteText}
                onChange={(e) => {
                  const text = e.target.value;
                  setBuyPasteText(text);
                  if (!text.trim()) { setBuyPasteError(""); return; }
                  const parsed = parseBrokerNotification(text);
                  if (!parsed) {
                    setBuyPasteError("지원하지 않는 형식입니다. (미래에셋·하나·메리츠증권 체결 알림만 지원)");
                    return;
                  }
                  if (parsed.tradeType === "sell") {
                    setBuyPasteError("⚠️ 매도 체결 내역입니다. '실현손익 입력' 탭에 붙여넣어 주세요.");
                    return;
                  }
                  const autoOwner = resolveBrokerOwner(parsed, ownerNames) || undefined;
                  // 기존 보유 종목 검색 (심볼 또는 종목명으로)
                  const existingPos = positions.find(
                    (p) => (parsed.symbol && p.symbol === parsed.symbol) || p.name === parsed.name,
                  );
                  // 티커가 없으면 관심종목에서 종목명으로 티커를 끌어온다
                  const wlMatch = !existingPos && !parsed.symbol
                    ? watchlistRows.find((w) => w.symbol && w.name && w.name.trim() === parsed.name.trim())
                    : undefined;
                  // 기존 보유면 저장된 티커·종목명 사용, 신규면 알림 내용/관심종목 사용
                  const resolvedSymbol = existingPos ? existingPos.symbol : (parsed.symbol || wlMatch?.symbol || "");
                  const resolvedName = existingPos ? existingPos.name : (wlMatch?.name || parsed.name);
                  const isNewStock = !existingPos && !parsed.symbol && !wlMatch;
                  const ownerUnresolved = !autoOwner && !!parsed.accountName;
                  setBuyPasteError(
                    isNewStock && ownerUnresolved
                      ? "ℹ️ 보유 목록에 없는 종목입니다. 티커와 담당자를 직접 입력해주세요."
                      : isNewStock
                        ? "ℹ️ 보유 목록에 없는 종목입니다. 티커(종목코드)를 직접 입력해주세요."
                        : ownerUnresolved
                          ? `ℹ️ 계좌명(${parsed.accountName})으로 담당자를 특정할 수 없습니다. 담당자를 직접 선택해주세요.`
                          : "",
                  );
                  setForm((prev) => ({
                    ...prev,
                    symbol: resolvedSymbol,
                    name: resolvedName,
                    quantity: String(parsed.qty),
                    avgPrice: String(parsed.price),
                    currency: parsed.currency,
                    ...(parsed.date ? { purchaseDateForFx: parsed.date } : {}),
                    ...(autoOwner ? { selectedOwners: [autoOwner] } : {}),
                  }));
                  setBuyPasteText("");
                }}
              />
              {buyPasteError && (
                <p className={`mt-1 text-[11px] font-medium ${buyPasteError.startsWith("ℹ️") ? "text-blue-400" : "text-red-400"}`}>
                  {buyPasteError}
                </p>
              )}
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              담당자를 선택한 뒤 추가하세요.
              같은 티커·담당자·계좌(해외/국내+계좌명)·통화로 다시 추가하면 기존 줄에{" "}
              <span className="font-medium text-foreground">수량이 더해지고 평단은 가중평균</span>으로
              갱신됩니다. 이 경우{" "}
              <span className="font-medium text-foreground">종목명은 기존 줄과 정확히 같아야</span> 하며
              다르면 저장되지 않습니다.
              국내 주식은 6자리 종목코드(예: <span className="font-medium text-foreground">005930</span>)
              또는 <span className="font-medium text-foreground">KRX:005930</span> 형식으로 입력하면 실시간 시세가 반영됩니다.
              KOSDAQ은 <span className="font-medium text-foreground">KQ:293490</span> 형식을 사용하세요.
              유로 표시 종목은 통화를 <span className="font-medium text-foreground">EUR</span>로 두고, 티커는 Yahoo Finance 심볼(예: 유럽{" "}
              <span className="font-medium text-foreground">ASML.AS</span>, 에르메스{" "}
              <span className="font-medium text-foreground">RMS</span> 또는 <span className="font-medium text-foreground">RMS.PA</span>
              )을 입력하면 시세가 반영됩니다.
              <span className="font-medium text-foreground">차트 그룹</span>에{" "}
              <span className="font-medium text-foreground">현금</span>을 넣으면 원형 차트·보유 표에서 현금과
              MMF 등 현금성 자산 줄을 같은 조각으로 합산할 수 있습니다.
            </p>
            <form
              onSubmit={handleSubmit}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6"
            >
              <datalist id="holdings-chart-group-presets">
                {HOLDINGS_CHART_GROUP_PRESETS.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
              <div className="col-span-2 flex flex-col gap-2 sm:col-span-3 md:col-span-6">
                <span className="text-[11px] font-medium text-muted-foreground">담당자</span>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                  {ownerNames.map((name) => {
                    const isSelected = form.selectedOwners.includes(name);
                    const anySelected = form.selectedOwners.length > 0;
                    return (
                    <label
                      key={name}
                      className={`flex cursor-pointer items-center gap-1.5 text-sm select-none transition-opacity ${anySelected && !isSelected ? "opacity-30" : "opacity-100"}`}
                    >
                      <input
                        type="radio"
                        name="buy-form-owner"
                        className="cursor-pointer accent-primary"
                        checked={isSelected}
                        onChange={() => {
                          skipAddFormAutoNameRef.current = false;
                          skipAddFormAutoChartGroupRef.current = false;
                          setForm((prev) => ({ ...prev, selectedOwners: [name] }));
                        }}
                      />
                      <span className={isSelected ? "font-semibold text-foreground" : ""}>{name}</span>
                    </label>
                    );
                  })}
                </div>
              </div>
              <div className="relative min-w-0">
                <input
                  ref={addSymbolInputRef}
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm leading-tight"
                  placeholder="티커 (예: NVDA, 005930)"
                  value={form.symbol}
                  onChange={(e) => {
                    handleAddSymbolInput(e.target.value);
                    setHoldingsTickerSuggestOpen(true);
                  }}
                  onFocus={() => setHoldingsTickerSuggestOpen(true)}
                  onBlur={() => {
                    window.setTimeout(() => setHoldingsTickerSuggestOpen(false), 120);
                  }}
                  onKeyDown={(e) => {
                    if (!holdingsTickerSuggestOpen || filteredHoldingsTickers.length === 0) return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHoldingsTickerSuggestHl((h) =>
                        Math.min(filteredHoldingsTickers.length - 1, h + 1),
                      );
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHoldingsTickerSuggestHl((h) => Math.max(0, h - 1));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const o = filteredHoldingsTickers[holdingsTickerSuggestHl];
                      if (o) {
                        handleAddSymbolInput(o.symbol);
                        setHoldingsTickerSuggestOpen(false);
                      }
                    } else if (e.key === "Escape") {
                      setHoldingsTickerSuggestOpen(false);
                    }
                  }}
                  autoComplete="off"
                  required
                />
                {holdingsTickerSuggestOpen && filteredHoldingsTickers.length > 0 ? (
                  <ul
                    role="listbox"
                    className="absolute left-0 right-0 top-full z-[80] mt-0.5 max-h-36 overflow-y-auto rounded-md border border-border bg-popover py-0.5 text-popover-foreground shadow-md"
                  >
                    {filteredHoldingsTickers.map((o, i) => (
                      <li key={o.symbol}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === holdingsTickerSuggestHl}
                          className={cn(
                            "flex w-full min-w-0 items-center gap-1 truncate px-2 py-0.5 text-left text-[11px] leading-snug",
                            i === holdingsTickerSuggestHl ? "bg-muted" : "hover:bg-muted/80",
                          )}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleAddSymbolInput(o.symbol);
                            setHoldingsTickerSuggestOpen(false);
                          }}
                        >
                          <span className="shrink-0 font-medium tabular-nums">{o.symbol}</span>
                          {o.name ? (
                            <span className="min-w-0 truncate text-muted-foreground">
                              ({o.name})
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="종목명"
                value={form.name}
                onChange={(e) => {
                  const v = e.target.value;
                  skipAddFormAutoNameRef.current = v.trim() !== "";
                  setForm((prev) => ({ ...prev, name: v }));
                }}
                required
              />
              <input
                type="number"
                min="0.000001"
                step="any"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="수량"
                value={form.quantity}
                onChange={(e) => setForm((prev) => ({ ...prev, quantity: e.target.value }))}
                required
              />
              <input
                type="number"
                min="0.000001"
                step="any"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="평단가"
                value={form.avgPrice}
                onChange={(e) => setForm((prev) => ({ ...prev, avgPrice: e.target.value }))}
                required
              />
              {/* 매입 환율: USD/EUR 해외 통화일 때 표시, 평단가 바로 다음 */}
              {form.currency === "USD" ? (
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={`매입 USD/KRW (예: ${fmtInt(usdKrw)})`}
                  value={form.purchaseUsdKrw}
                  onChange={(e) => {
                    addFormFxManualRef.current = true;
                    setForm((prev) => ({ ...prev, purchaseUsdKrw: e.target.value }));
                  }}
                />
              ) : form.currency === "EUR" ? (
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={`매입 EUR/KRW (예: ${fmtInt(eurKrw)})`}
                  value={form.purchaseEurKrw}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, purchaseEurKrw: e.target.value }))
                  }
                />
              ) : (
                <div />
              )}
              {form.currency === "USD" ? (
                <div className="col-span-2 flex flex-col gap-1 sm:col-span-3 md:col-span-6">
                  <label className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">매입일 (선택)</span>
                    <input
                      type="date"
                      className="rounded-md border bg-background px-2 py-1.5 text-sm"
                      value={form.purchaseDateForFx}
                      onChange={(e) => {
                        addFormFxManualRef.current = false;
                        setForm((prev) => ({ ...prev, purchaseDateForFx: e.target.value }));
                      }}
                    />
                    {purchaseFxAutoBusy ? (
                      <span className="text-[11px] text-muted-foreground">환율 조회 중…</span>
                    ) : null}
                  </label>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    입력하면 매입일 다음날부터 이틀째 되는 날{" "}
                    <span className="font-medium text-foreground">09:00 한국시각</span> 부근 Yahoo
                    USD/KRW로 매입 환율 칸을 채웁니다. 증권사 결제(T+2 영업일 등)와 다를 수 있습니다.
                  </p>
                </div>
              ) : null}
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={form.currency}
                onChange={(e) => {
                  const c = e.target.value as "USD" | "EUR" | "KRW";
                  skipAddFormAutoNameRef.current = false;
                  skipAddFormAutoChartGroupRef.current = false;
                  addFormFxManualRef.current = false;
                  setForm((prev) => ({
                    ...prev,
                    currency: c,
                    accountType: c === "KRW" ? "국내주식" : "해외주식",
                    purchaseUsdKrw: c === "USD" ? prev.purchaseUsdKrw : "",
                    purchaseEurKrw: c === "EUR" ? prev.purchaseEurKrw : "",
                    purchaseDateForFx: c === "USD" ? prev.purchaseDateForFx : "",
                  }));
                }}
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="KRW">KRW</option>
              </select>
              <input
                className="col-span-2 rounded-md border bg-background px-3 py-2 text-sm sm:col-span-3 md:col-span-6"
                placeholder="차트 그룹 (선택 · 예: 현금, MMF 등 현금성 자산)"
                value={form.chartGroup}
                onChange={(e) => {
                  const v = e.target.value;
                  skipAddFormAutoChartGroupRef.current = v.trim() !== "";
                  setForm((prev) => ({ ...prev, chartGroup: v }));
                }}
                list="holdings-chart-group-presets"
                autoComplete="off"
              />
              {addPositionError ? (
                <p
                  role="alert"
                  className="col-span-2 text-sm text-destructive sm:col-span-3 md:col-span-6"
                >
                  {addPositionError}
                </p>
              ) : null}
              <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-3 md:col-span-6">
                <span className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {form.currency === "KRW" ? "국내주식" : "해외주식"}
                </span>
                <button
                  type="submit"
                  disabled={!!(buyPasteError && !buyPasteError.startsWith("ℹ️"))}
                  className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  추가
                </button>
              </div>
            </form>

            {/* ── 종목 추가 누락 보유자 알림 ──────────────────────────────────── */}
            {addOwnerTracker.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5">
                {addOwnerTracker.map((item) => {
                  const missing = ownerNames.filter((n) => !item.doneOwners.includes(n));
                  const allDone = missing.length === 0;
                  const displayLabel = item.isKorean ? item.name : item.symbol;
                  return (
                    <div
                      key={item.symbol}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                        allDone
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : "border-amber-500/35 bg-amber-500/8 text-amber-200"
                      }`}
                    >
                      <span className="shrink-0 text-sm">{allDone ? "✓" : "⚠️"}</span>
                      <span className="font-semibold">{displayLabel}</span>
                      {allDone ? (
                        <span className="text-emerald-400">— 모든 보유자 입력 완료</span>
                      ) : (
                        <span>
                          — 아직 미입력:{" "}
                          <strong className="text-amber-300">{missing.join(", ")}</strong>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setAddOwnerTracker((prev) =>
                            prev.filter((e) => e.symbol !== item.symbol),
                          )
                        }
                        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label="알림 닫기"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="mt-2 text-xs text-muted-foreground">
              현금(USD·KRW)은 아래 각 보유 종목 표 상단에서 입력합니다. 전체 현금
              합계(원화): ₩{fmtInt(totalCashKrw)}
            </p>
          </section>
  );
}
