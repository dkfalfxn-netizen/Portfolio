"use client";

/**
 * TradeImageImport
 *
 * 거래내역 스크린샷을 업로드하면 Gemini Vision으로 매수·매도를 자동 파싱해
 * 확인 후 저장할 수 있는 모달 컴포넌트입니다.
 *
 * 사용법:
 *   <TradeImageImport
 *     ownerNames={ownerNames}
 *     onBuyConfirm={(trades) => { ... }}
 *     onSellConfirm={(trades) => { ... }}
 *     onClose={() => setOpen(false)}
 *   />
 */

import { useCallback, useRef, useState } from "react";
import type { ParsedTrade, ParsedTradeCurrency } from "@/app/api/parse-trade-image/route";
import { parseBrokerText, type KnownSecurity } from "@/lib/parse-broker-text";

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type ConfirmedBuyTrade = {
  date: string;
  symbol: string;
  name: string;
  qty: number;
  price: number;
  currency: ParsedTradeCurrency;
  owners: string[];
};

export type ConfirmedSellTrade = {
  date: string;
  symbol: string;
  name: string;
  qty: number;
  sellPrice: number;
  avgPrice: number;
  currency: ParsedTradeCurrency;
  fxRate: number;
  owner: string;
};

type Props = {
  ownerNames: string[];
  /** 종목명→티커 매칭에 쓸 알려진 종목(관심종목·보유종목) */
  knownSecurities?: KnownSecurity[];
  onBuyConfirm: (trades: ConfirmedBuyTrade[]) => void;
  onSellConfirm: (trades: ConfirmedSellTrade[]) => void;
  onClose: () => void;
};

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function fmtNum(n: number, digits = 0) {
  return n.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────

export default function TradeImageImport({ ownerNames, knownSecurities = [], onBuyConfirm, onSellConfirm, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 파싱 결과 (편집 가능)
  const [trades, setTrades] = useState<ParsedTrade[]>([]);
  // 각 거래의 보유자 선택
  const [selectedOwners, setSelectedOwners] = useState<Record<number, string[]>>({});
  // 저장 완료 여부
  const [saved, setSaved] = useState(false);
  // 입력 방식: 이미지 | 텍스트(증권사 알림 문자)
  const [inputMode, setInputMode] = useState<"image" | "text">("text");
  const [brokerText, setBrokerText] = useState("");

  const defaultOwner = ownerNames[0] ?? "";

  // ─── 텍스트(증권사 알림 문자) 파싱 ────────────────────────────────────────────
  function handleParseText() {
    setError(null);
    setSaved(false);
    setPreviewUrl(null);
    const parsed = parseBrokerText(brokerText, ownerNames, knownSecurities);
    if (parsed.length === 0) {
      setTrades([]);
      setSelectedOwners({});
      setError("거래를 찾지 못했습니다. 증권사 체결/주문 알림 문자를 그대로 붙여넣어 주세요. (체결수량 0인 미체결은 제외됩니다)");
      return;
    }
    setTrades(parsed.map((p) => ({
      type: p.type, date: p.date, symbol: p.symbol, name: p.name,
      qty: p.qty, price: p.price, currency: p.currency,
      avgPrice: p.avgPrice, fxRate: p.fxRate,
    })));
    const initOwners: Record<number, string[]> = {};
    parsed.forEach((p, i) => { initOwners[i] = [p.detectedOwner ?? defaultOwner]; });
    setSelectedOwners(initOwners);
  }

  // ─── 이미지 처리 ───────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("이미지 파일(JPG, PNG, WEBP)만 업로드할 수 있습니다.");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setTrades([]);
    setSelectedOwners({});
    setSaved(false);
    setError(null);
    setLoading(true);

    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch("/api/parse-trade-image", { method: "POST", body: fd });
      const json = await res.json() as { trades?: ParsedTrade[]; error?: string };

      if (!res.ok || json.error) {
        throw new Error(json.error ?? "파싱 실패");
      }

      const parsed = json.trades ?? [];
      setTrades(parsed);

      // 기본 보유자: 첫 번째 보유자
      const initOwners: Record<number, string[]> = {};
      parsed.forEach((_, i) => { initOwners[i] = [defaultOwner]; });
      setSelectedOwners(initOwners);

      if (parsed.length === 0) {
        setError("거래 내역을 찾지 못했습니다. 더 선명한 이미지를 시도해 보세요.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "파싱 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [defaultOwner]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  // ─── 편집 핸들러 ───────────────────────────────────────────────────────────

  function updateTrade(i: number, patch: Partial<ParsedTrade>) {
    setTrades((prev) => prev.map((t, idx) => idx === i ? { ...t, ...patch } : t));
  }

  function removeTrade(i: number) {
    setTrades((prev) => prev.filter((_, idx) => idx !== i));
    setSelectedOwners((prev) => {
      const next: Record<number, string[]> = {};
      Object.entries(prev).forEach(([k, v]) => {
        const ki = Number(k);
        if (ki < i) next[ki] = v;
        else if (ki > i) next[ki - 1] = v;
      });
      return next;
    });
  }

  function toggleOwner(tradeIdx: number, owner: string) {
    setSelectedOwners((prev) => {
      const current = prev[tradeIdx] ?? [defaultOwner];
      const next = current.includes(owner)
        ? current.filter((o) => o !== owner)
        : [...current, owner];
      return { ...prev, [tradeIdx]: next.length ? next : [owner] };
    });
  }

  // ─── 저장 ──────────────────────────────────────────────────────────────────

  function handleConfirm() {
    const buyTrades: ConfirmedBuyTrade[] = [];
    const sellTrades: ConfirmedSellTrade[] = [];

    trades.forEach((t, i) => {
      const owners = selectedOwners[i] ?? [defaultOwner];
      if (t.type === "buy") {
        buyTrades.push({
          date: t.date,
          symbol: t.symbol || t.name,
          name: t.name,
          qty: t.qty,
          price: t.price,
          currency: t.currency,
          owners,
        });
      } else {
        // 매도는 보유자별 1건씩
        owners.forEach((owner) => {
          sellTrades.push({
            date: t.date,
            symbol: t.symbol || t.name,
            name: t.name,
            qty: t.qty,
            sellPrice: t.price,
            avgPrice: t.avgPrice ?? 0,
            currency: t.currency,
            fxRate: t.fxRate ?? 0,
            owner,
          });
        });
      }
    });

    if (buyTrades.length > 0) onBuyConfirm(buyTrades);
    if (sellTrades.length > 0) onSellConfirm(sellTrades);
    setSaved(true);
  }

  // ─── 렌더 ──────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="relative flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">거래 입력 (문자 붙여넣기 · 이미지)</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">증권사 체결/주문 알림 문자를 붙여넣으면 보유자(계좌)를 자동 인식합니다</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">

          {/* 입력 방식 토글 */}
          {!saved && (
            <div className="flex gap-1 rounded-lg bg-slate-800/60 p-1 text-xs">
              <button
                type="button"
                onClick={() => setInputMode("text")}
                className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${inputMode === "text" ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
              >
                📋 문자 붙여넣기
              </button>
              <button
                type="button"
                onClick={() => setInputMode("image")}
                className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${inputMode === "image" ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
              >
                📷 이미지
              </button>
            </div>
          )}

          {/* 텍스트 입력 영역 */}
          {!saved && inputMode === "text" && (
            <div className="space-y-2">
              <textarea
                value={brokerText}
                onChange={(e) => setBrokerText(e.target.value)}
                rows={8}
                placeholder={"증권사 체결/주문 알림 문자를 그대로 붙여넣으세요. 여러 건을 한꺼번에 붙여넣어도 됩니다.\n\n[미래에셋증권] 일부체결 …\n[메리츠증권] …\n[하나증권] 퇴직연금 …"}
                className="w-full rounded-lg border border-slate-600 bg-slate-950/60 px-3 py-2 text-xs text-slate-200 outline-none focus:border-blue-400"
              />
              <button
                type="button"
                onClick={handleParseText}
                disabled={!brokerText.trim()}
                className="w-full rounded-md bg-blue-600 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
              >
                분석하기
              </button>
              <p className="text-[10px] text-slate-500">
                자동 인식: 미래에셋→ISA · 메리츠→직투 · 개인형 IRP→IRP · 확정기여형(DC)→DC 계좌. 인식이 틀리면 아래 표에서 보유자를 직접 고치세요.
              </p>
            </div>
          )}

          {/* 업로드 영역 */}
          {!saved && inputMode === "image" && (
            <div
              className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed py-6 transition-colors cursor-pointer
                ${isDragging ? "border-blue-400 bg-blue-950/30" : "border-slate-600 hover:border-slate-400"}`}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
              {previewUrl ? (
                <img src={previewUrl} alt="업로드 이미지" className="max-h-36 rounded object-contain shadow" />
              ) : (
                <>
                  <span className="text-3xl">📲</span>
                  <p className="mt-2 text-sm text-slate-300">이미지를 끌어다 놓거나 클릭해서 선택</p>
                  <p className="text-xs text-slate-500">JPG · PNG · WEBP · 최대 10MB</p>
                </>
              )}
              {loading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-slate-900/80">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                  <p className="mt-2 text-xs text-slate-300">거래 내역 분석 중…</p>
                </div>
              )}
            </div>
          )}

          {/* 에러 */}
          {error && (
            <p className="rounded-lg bg-red-900/40 border border-red-700/50 px-3 py-2 text-xs text-red-300">{error}</p>
          )}

          {/* 파싱 결과 테이블 */}
          {trades.length > 0 && !saved && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-300">
                {trades.length}건 파싱됨 — 내용을 확인하고 저장하세요
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="py-1.5 pr-2 text-left font-medium">구분</th>
                      <th className="py-1.5 px-1 text-left font-medium">날짜</th>
                      <th className="py-1.5 px-1 text-left font-medium">종목</th>
                      <th className="py-1.5 px-1 text-right font-medium">수량</th>
                      <th className="py-1.5 px-1 text-right font-medium">단가</th>
                      <th className="py-1.5 px-1 text-right font-medium">통화</th>
                      {trades.some((t) => t.type === "sell") && (
                        <th className="py-1.5 px-1 text-right font-medium">매입단가</th>
                      )}
                      <th className="py-1.5 px-1 text-left font-medium">보유자</th>
                      <th className="py-1.5 pl-1 text-center font-medium">삭제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => (
                      <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/40">
                        {/* 구분 */}
                        <td className="py-1.5 pr-2">
                          <select
                            value={t.type}
                            onChange={(e) => updateTrade(i, { type: e.target.value as "buy" | "sell" })}
                            className={`rounded px-1 py-0.5 text-[11px] font-semibold outline-none
                              ${t.type === "buy" ? "bg-rose-900/60 text-rose-300" : "bg-blue-900/60 text-blue-300"}`}
                          >
                            <option value="buy">매수</option>
                            <option value="sell">매도</option>
                          </select>
                        </td>
                        {/* 날짜 */}
                        <td className="py-1.5 px-1">
                          <input
                            type="date"
                            value={t.date}
                            onChange={(e) => updateTrade(i, { date: e.target.value })}
                            className="w-[7.5rem] rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-[11px] text-slate-200 outline-none"
                          />
                        </td>
                        {/* 종목 */}
                        <td className="py-1.5 px-1">
                          <div className="flex flex-col gap-0.5">
                            <input
                              value={t.name}
                              onChange={(e) => updateTrade(i, { name: e.target.value })}
                              placeholder="종목명"
                              className="w-28 rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-[11px] text-slate-200 outline-none"
                            />
                            <input
                              value={t.symbol}
                              onChange={(e) => updateTrade(i, { symbol: e.target.value })}
                              placeholder="코드/티커"
                              className="w-28 rounded border border-slate-700 bg-slate-800/50 px-1 py-0.5 text-[10px] text-slate-400 outline-none"
                            />
                          </div>
                        </td>
                        {/* 수량 */}
                        <td className="py-1.5 px-1 text-right">
                          <input
                            type="number"
                            value={t.qty}
                            min={1}
                            onChange={(e) => updateTrade(i, { qty: Number(e.target.value) })}
                            className="w-16 rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-right text-[11px] text-slate-200 tabular-nums outline-none"
                          />
                        </td>
                        {/* 단가 */}
                        <td className="py-1.5 px-1 text-right">
                          <input
                            type="number"
                            value={t.price}
                            min={0}
                            onChange={(e) => updateTrade(i, { price: Number(e.target.value) })}
                            className="w-24 rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-right text-[11px] text-slate-200 tabular-nums outline-none"
                          />
                        </td>
                        {/* 통화 */}
                        <td className="py-1.5 px-1">
                          <select
                            value={t.currency}
                            onChange={(e) => updateTrade(i, { currency: e.target.value as ParsedTradeCurrency })}
                            className="rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-[11px] text-slate-200 outline-none"
                          >
                            <option value="KRW">KRW</option>
                            <option value="USD">USD</option>
                            <option value="EUR">EUR</option>
                          </select>
                        </td>
                        {/* 매입단가 (매도 전용) */}
                        {trades.some((t2) => t2.type === "sell") && (
                          <td className="py-1.5 px-1 text-right">
                            {t.type === "sell" ? (
                              <input
                                type="number"
                                value={t.avgPrice ?? 0}
                                min={0}
                                onChange={(e) => updateTrade(i, { avgPrice: Number(e.target.value) })}
                                placeholder="평균단가"
                                className="w-24 rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-right text-[11px] text-slate-200 tabular-nums outline-none"
                              />
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                        )}
                        {/* 보유자 선택 */}
                        <td className="py-1.5 px-1">
                          <div className="flex flex-wrap gap-1">
                            {ownerNames.map((owner) => {
                              const checked = (selectedOwners[i] ?? [defaultOwner]).includes(owner);
                              return (
                                <button
                                  key={owner}
                                  type="button"
                                  onClick={() => toggleOwner(i, owner)}
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors
                                    ${checked
                                      ? "bg-indigo-600 text-white"
                                      : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                                    }`}
                                >
                                  {owner}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                        {/* 삭제 */}
                        <td className="py-1.5 pl-1 text-center">
                          <button
                            type="button"
                            onClick={() => removeTrade(i)}
                            className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-700 hover:text-red-400"
                            aria-label="삭제"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-700">
                      <td colSpan={9} className="pt-1.5 text-right text-[10px] text-slate-500">
                        매수 {trades.filter((t) => t.type === "buy").length}건 · 매도 {trades.filter((t) => t.type === "sell").length}건
                        <span className="ml-2 text-slate-600">
                          (총 {trades.reduce((s, t) => s + t.qty * t.price, 0).toLocaleString("ko-KR", { maximumFractionDigits: 0 })} 원화 기준)
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="text-[10px] text-slate-500">
                * 종목코드가 없으면 종목명으로 티커를 채웁니다. 저장 후 보유 목록에서 직접 수정할 수 있습니다.
              </p>
            </div>
          )}

          {/* 저장 완료 */}
          {saved && (
            <div className="flex flex-col items-center gap-3 py-8">
              <span className="text-5xl">✅</span>
              <p className="text-sm font-semibold text-slate-200">저장됐습니다!</p>
              <p className="text-xs text-slate-400">서버 동기화가 필요하면 &apos;서버로 올리기&apos;를 눌러주세요.</p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { setTrades([]); setPreviewUrl(null); setSaved(false); setError(null); }}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-xs text-slate-300 hover:bg-slate-700"
                >
                  다른 이미지 추가
                </button>
                <button
                  onClick={onClose}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  닫기
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 푸터 버튼 */}
        {trades.length > 0 && !saved && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-700 px-4 py-3">
            <button
              onClick={() => { setTrades([]); setPreviewUrl(null); setError(null); if (fileRef.current) fileRef.current.value = ""; }}
              className="rounded-lg border border-slate-600 px-4 py-2 text-xs text-slate-300 hover:bg-slate-700"
            >
              다시 올리기
            </button>
            <button
              onClick={handleConfirm}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              {trades.length}건 저장
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
