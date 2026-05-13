/**
 * 리밸 계산기와 동일한 규칙으로, 그룹(슬라이스) 목표 %(포트 전체)를
 * 구성 종목별 포트 전체 목표 %로 분해합니다. 대시보드 툴팁 표시용.
 */
import type { CalculatorMemberSplitMode } from "@/lib/portfolio-target-weights";

const GROUP_UNDECIDED_MEMBER_SYMBOL = "__CALC_UNDECIDED__";

function normSym(s: string): string {
  return (s ?? "").trim();
}

function valueBasedRatios(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sum = values.reduce((a, v) => a + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (sum <= 0) return values.map(() => 1 / n);
  return values.map((v) => (Number.isFinite(v) && v > 0 ? v / sum : 0));
}

function memberRatiosForSymbols(
  symbols: string[],
  withinSliceWeights: number[],
  splitStrings: Record<string, string>,
): number[] {
  if (symbols.length === 0) return [];
  const weights = symbols.map((sym) => {
    const raw = (splitStrings[sym] ?? "").trim().replace(",", ".");
    if (raw === "") return NaN;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  });
  const anyFilled = weights.some((w) => Number.isFinite(w));
  const allFilled = weights.every((w) => Number.isFinite(w));
  if (!anyFilled || !allFilled) return valueBasedRatios(withinSliceWeights);
  const sum = weights.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (sum <= 0) return valueBasedRatios(withinSliceWeights);
  return weights.map((w) => (Number.isFinite(w) ? w / sum : 0));
}

/** split LS 숫자 → 계산기와 동일한 입력 문자열 */
function persistedSplitToInputString(sym: string, splitNumeric: Record<string, number>): string {
  const n = splitNumeric[sym];
  if (!Number.isFinite(n)) return "";
  return String(n);
}

/**
 * 종목별 **포트폴리오 전체** 목표 비중 (%).
 */
export function memberPortfolioTargetPctMap(opts: {
  groupTargetPct: number;
  memberSymbolsOrdered: string[];
  /** 종목 순서와 동일: 슬라이스 내 비중 등 비율 분배에 사용 */
  withinSliceWeights: number[];
  /** LS `memberSplits` 해당 그룹 */
  splitNumeric: Record<string, number>;
  mode: CalculatorMemberSplitMode;
}): Record<string, number> {
  const { groupTargetPct, memberSymbolsOrdered, withinSliceWeights, splitNumeric, mode } = opts;
  const gTar = Number.isFinite(groupTargetPct) ? groupTargetPct : 0;

  const pairs = memberSymbolsOrdered
    .map((sym, i) => ({
      sym: normSym(sym),
      w: withinSliceWeights[i] ?? 0,
    }))
    .filter(
      (p) =>
        p.sym.length > 0 &&
        p.sym.toUpperCase() !== normSym(GROUP_UNDECIDED_MEMBER_SYMBOL).toUpperCase(),
    );

  const syms = pairs.map((p) => p.sym);
  const weightsAligned = pairs.map((p) => p.w);

  const splitStrings: Record<string, string> = {};
  for (const sym of syms) {
    splitStrings[sym] = persistedSplitToInputString(sym, splitNumeric);
  }

  if (mode === "targetPct") {
    const pcts: number[] = [];
    let invalid = false;
    for (const sym of syms) {
      const raw = (splitStrings[sym] ?? "").trim().replace(",", ".");
      if (raw === "") {
        pcts.push(0);
        continue;
      }
      const n = parseFloat(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        invalid = true;
        break;
      }
      pcts.push(n);
    }
    if (!invalid && pcts.length === syms.length) {
      const sumPct = pcts.reduce((a, b) => a + b, 0);
      if (sumPct > 0) {
        const scale = gTar / sumPct;
        const out: Record<string, number> = {};
        syms.forEach((sym, i) => {
          out[sym] = pcts[i]! * scale;
        });
        return out;
      }
    }
    // targetPct 불가 시 weight 규칙으로 폴백
  }

  const ratios = memberRatiosForSymbols(syms, weightsAligned, splitStrings);
  const out: Record<string, number> = {};
  syms.forEach((sym, i) => {
    out[sym] = gTar * (ratios[i] ?? 0);
  });
  return out;
}
