"use client";

import type { StockSplit } from "@/lib/stock-splits";

type Props = {
  pendingDue: StockSplit[];
  confirmedIds: Set<string>;
  upcoming: { split: StockSplit; daysLeft: number }[];
  notice: { splitId: string; text: string; auto: boolean } | null;
  undoAvailable: string | null;
  onUndo: () => void;
  onDismissNotice: () => void;
  onApplyManually: (id: string) => void;
};

const ratioLabel = (s: StockSplit) => (s.factor >= 1 ? `${s.factor}:1 분할` : `1:${Math.round(1 / s.factor)} 병합`);

/** 주식 분할 안내/적용 배너 — 예정(D-n), 반영 대기, 적용 완료(되돌리기) */
export function SplitNoticeBanner({
  pendingDue,
  confirmedIds,
  upcoming,
  notice,
  undoAvailable,
  onUndo,
  onDismissNotice,
  onApplyManually,
}: Props) {
  if (pendingDue.length === 0 && upcoming.length === 0 && !notice) return null;
  return (
    <div className="space-y-2" data-testid="split-banner">
      {notice ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <span className="font-medium">✅ {notice.text}</span>
          {undoAvailable ? (
            <button type="button" onClick={onUndo} className="rounded border border-emerald-400/50 px-2 py-0.5 hover:bg-emerald-500/20">
              되돌리기
            </button>
          ) : null}
          <button type="button" onClick={onDismissNotice} className="ml-auto text-emerald-300/70 hover:text-emerald-100" aria-label="닫기">
            ✕
          </button>
        </div>
      ) : null}
      {pendingDue.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <span className="font-medium">
            ⚠️ {s.symbol} {ratioLabel(s)} 반영 대기 —{" "}
            {confirmedIds.has(s.id)
              ? "시세 분할이 확인되어 곧 자동 적용됩니다."
              : "시세에서 분할이 아직 확인되지 않았습니다. 확인되면 자동 적용됩니다. (이 종목은 적용 전까지 추가·매수 입력이 막힙니다)"}
          </span>
          {!confirmedIds.has(s.id) ? (
            <button type="button" onClick={() => onApplyManually(s.id)} className="rounded border border-amber-400/60 px-2 py-0.5 hover:bg-amber-500/20">
              수동 적용
            </button>
          ) : null}
        </div>
      ))}
      {upcoming.map(({ split: s, daysLeft }) => (
        <div key={s.id} className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
          📅 {s.symbol} {ratioLabel(s)} 예정 — {s.date.slice(5).replace("-", "/")} 분할 반영 거래 시작 (D-{daysLeft}). 시세가 바뀌면 보유 수량·평단가·알림 가격이 자동으로 조정됩니다.
        </div>
      ))}
    </div>
  );
}
