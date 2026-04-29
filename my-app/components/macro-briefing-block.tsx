"use client";

import { BriefingSummaryText } from "@/components/briefing-summary-text";
import { coerceNumberedSummaryLines, splitMacroBriefingParts } from "@/lib/briefing-format";

function stripV2LinkPreamble(links: string): string {
  return links
    .replace(/^참고 링크 \(위 요약의 \[N\]과 동일 번호 · Google 뉴스 RSS\)\s*\n+/m, "")
    .trim();
}

type Props = { text: string };

/**
 * macro-fed / macro-themes: 상단 **요약(번호)**, 하단 **참고 링크(헤드라인·URL)**.
 * 한 블록으로 붙이면 일부 뷰(Discord 등)가 길이 제한으로 본문만 잘리는 것을 UI에서 분리해 완화.
 */
export function MacroBriefingBlock({ text }: Props) {
  const { body, linksSection } = splitMacroBriefingParts(text);
  const bodyShown = linksSection
    ? coerceNumberedSummaryLines(body, 6)
    : coerceNumberedSummaryLines(text, 6);
  if (!linksSection) {
    return <BriefingSummaryText text={bodyShown} />;
  }
  const linksText = stripV2LinkPreamble(linksSection);

  return (
    <div className="space-y-3">
      <div>
        <BriefingSummaryText text={bodyShown} className="text-slate-200" />
      </div>
      <div className="border-t border-slate-600/50 pt-3">
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">참고 링크</p>
        <p className="mb-1.5 text-[11px] text-slate-500">
          요약의 [N]과 아래 번호를 맞춰 보세요. 위 AI 요약은 RSS <strong>헤드라인(제목)</strong>만 반영합니다. 기사 본문은 서버가 읽지 않으며, 원문은 링크를 열어 직접 확인하세요.
        </p>
        <div className="max-h-[min(50vh,22rem)] overflow-y-auto pr-1">
          <BriefingSummaryText text={linksText} className="text-slate-300" />
        </div>
      </div>
    </div>
  );
}
