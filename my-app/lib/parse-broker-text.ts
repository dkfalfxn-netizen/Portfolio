/**
 * 증권사 체결/주문 알림 문자(텍스트)를 붙여넣으면 매수·매도 거래로 파싱하고,
 * 증권사·계좌 종류 키워드로 보유자(계좌)를 자동 인식한다.
 *
 * 지원 예시:
 *  - [미래에셋증권] 일부체결 …            → 미래에셋 → "ISA" 계좌
 *  - [메리츠증권] 해외주식 …              → 메리츠 → "직투" 계좌
 *  - [하나증권] 퇴직연금 … (개인형 IRP)   → "IRP" 계좌
 *  - [하나증권] 퇴직연금 … (확정기여형 DC) → "DC" 계좌
 *
 * 보유자 매핑 규칙은 아래 OWNER_RULES에서 조정한다. 실제 보유자명(ownerNames)에
 * 해당 토큰이 포함된 항목으로 연결된다(예: 토큰 "ISA" → "김승주 ISA").
 */

import type { ParsedTrade, ParsedTradeCurrency } from "@/app/api/parse-trade-image/route";

/** 계좌번호로 보유자를 구분한다(이름이 마스킹돼 같아 보이는 경우 등). 최우선 적용.
 *  test는 "계좌번호" 줄에서 뽑은 번호 문자열에 대해 검사한다.
 *  예: 메리츠 3066**27-01 → 김도율, 3066**62-01 → 김찬율 */
const ACCOUNT_RULES: { test: RegExp; owner: string }[] = [
  { test: /27-?01\b/, owner: "김도율" },
  { test: /62-?01\b/, owner: "김찬율" },
];

/** (우선순위 순) 텍스트에 이 정규식이 맞으면 해당 토큰의 보유자로 매핑한다.
 *  하나증권은 IRP/DC 둘 다 쓰므로 계좌 종류 키워드를 증권사보다 먼저 본다. */
const OWNER_RULES: { test: RegExp; token: string }[] = [
  { test: /개인형|IRP/i, token: "IRP" },
  { test: /확정기여형|DC\s*형|\(DC/i, token: "DC" },
  { test: /미래에셋/, token: "ISA" },
  { test: /메리츠/, token: "직투" },
];

export type ParsedBrokerTrade = ParsedTrade & {
  /** 자동 인식된 보유자명(ownerNames 중 하나). 못 찾으면 null */
  detectedOwner: string | null;
};

/** 종목명→티커 매칭에 쓰는 알려진 종목 목록(관심종목·보유종목) */
export type KnownSecurity = { symbol: string; name: string };

/** 매칭용 정규화: 공백·괄호·특수문자 제거, 소문자 */
function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").replace(/[()[\]·.,'"-]/g, "");
}

/** 종목명으로 알려진 종목에서 티커를 찾는다(정확·포함 양방향) */
function lookupSymbolByName(name: string, known: KnownSecurity[]): string {
  const target = normName(name);
  if (!target) return "";
  // 1) 이름 정규화 정확 일치
  const exact = known.find((k) => normName(k.name) === target);
  if (exact) return exact.symbol;
  // 2) 한쪽이 다른 쪽을 포함(긴 이름·축약 대비). 가장 길게 겹치는 것 우선
  const candidates = known
    .filter((k) => {
      const kn = normName(k.name);
      return kn.length >= 2 && (kn.includes(target) || target.includes(kn));
    })
    .sort((a, b) => normName(b.name).length - normName(a.name).length);
  return candidates[0]?.symbol ?? "";
}

function toNum(s: string | undefined | null): number {
  if (!s) return 0;
  const n = Number(s.replace(/[,\s원]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 토큰(ISA/직투/IRP/DC)을 실제 보유자명으로 해석 */
function resolveOwner(token: string, ownerNames: string[]): string | null {
  const tk = token.trim().toUpperCase();
  // 1) 정확히 일치
  const exact = ownerNames.find((o) => o.trim().toUpperCase() === tk);
  if (exact) return exact;
  // 2) 보유자명이 토큰을 포함 (예: "김승주 ISA" ⊇ "ISA")
  const contains = ownerNames.find((o) => o.toUpperCase().includes(tk));
  if (contains) return contains;
  return null;
}

function detectOwner(block: string, ownerNames: string[]): string | null {
  // 1) 계좌번호 우선 — 이름이 마스킹돼 같아 보여도 계좌번호로 구분
  const acctMatch = block.match(/계좌번호\s*[:：]\s*([A-Za-z0-9*\-]+)/);
  const acctNo = acctMatch?.[1] ?? "";
  if (acctNo) {
    for (const rule of ACCOUNT_RULES) {
      if (rule.test.test(acctNo)) {
        const owner = resolveOwner(rule.owner, ownerNames);
        if (owner) return owner;
      }
    }
  }
  // 2) 증권사·계좌 종류 키워드
  for (const rule of OWNER_RULES) {
    if (rule.test.test(block)) {
      const owner = resolveOwner(rule.token, ownerNames);
      if (owner) return owner;
    }
  }
  return null;
}

/** "06/04" → "YYYY-MM-DD" (연도는 올해 기준). 없으면 오늘 */
function parseDate(block: string): string {
  const today = new Date();
  const m = block.match(/체결일자\s*[:：]\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (m) {
    const mm = String(Number(m[1])).padStart(2, "0");
    const dd = String(Number(m[2])).padStart(2, "0");
    return `${today.getFullYear()}-${mm}-${dd}`;
  }
  const y = today.getFullYear();
  const mo = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** 한 메시지 블록을 거래로 파싱. 종목/수량을 못 찾거나 체결수량 0이면 null */
function parseBlock(block: string, ownerNames: string[], known: KnownSecurity[]): ParsedBrokerTrade | null {
  // 종목명: "종목명 : ..." 또는 "■ 종목 : ..."
  const nameMatch = block.match(/(?:종목명|종목)\s*[:：]\s*(.+)/);
  if (!nameMatch) return null;
  let rawName = nameMatch[1].trim();

  // 괄호 안 코드 추출: "ACE …(A446770)" → 코드 A446770
  let symbol = "";
  const codeMatch = rawName.match(/\(([A-Za-z0-9]+)\)\s*$/);
  if (codeMatch) {
    symbol = codeMatch[1].trim();
    rawName = rawName.replace(/\([A-Za-z0-9]+\)\s*$/, "").trim();
  }
  const name = rawName;
  if (!name) return null;

  // 괄호 코드가 없으면 관심종목·보유종목에서 종목명으로 티커를 찾는다
  if (!symbol) {
    symbol = lookupSymbolByName(name, known);
  }

  // 매매구분/주문구분: 매수/매도/현금매수/현금매도
  const typeMatch = block.match(/(?:매매구분|주문구분)\s*[:：]\s*(\S+)/);
  const typeStr = typeMatch?.[1] ?? "";
  const isSell = /매도/.test(typeStr);
  const type: ParsedTrade["type"] = isSell ? "sell" : "buy";

  // 수량: 체결수량 우선, 없으면 (주문)수량
  let qty = 0;
  const filledQty = block.match(/체결수량\s*[:：]\s*([\d,]+)/);
  if (filledQty) qty = toNum(filledQty[1]);
  else {
    const q = block.match(/(?:^|\s|■)\s*수량\s*[:：]\s*([\d,]+)/);
    if (q) qty = toNum(q[1]);
  }
  if (qty <= 0) return null; // 미체결(체결수량 0 등)은 건너뜀

  // 단가/가격: 체결단가 우선, 없으면 가격
  let price = 0;
  const filledPrice = block.match(/체결단가\s*[:：]\s*([\d,]+)/);
  if (filledPrice) price = toNum(filledPrice[1]);
  else {
    const p = block.match(/(?:^|\s|■)\s*가격\s*[:：]\s*([\d,]+)/);
    if (p) price = toNum(p[1]);
  }

  // 통화: USD 표기가 있으면 USD, 아니면 KRW
  const currency: ParsedTradeCurrency = /USD|\$/.test(block) ? "USD" : "KRW";

  return {
    type,
    date: parseDate(block),
    symbol: symbol || name,
    name,
    qty,
    price,
    currency,
    detectedOwner: detectOwner(block, ownerNames),
  };
}

/** 여러 증권사 알림 문자를 한꺼번에 붙여넣어도 블록별로 파싱한다. */
export function parseBrokerText(
  text: string,
  ownerNames: string[],
  known: KnownSecurity[] = [],
): ParsedBrokerTrade[] {
  if (!text.trim()) return [];
  // "[XXX증권]" 같은 대괄호 헤더가 나오는 지점에서 블록을 나눈다.
  let blocks: string[];
  if (/\[[^\]]+\]/.test(text)) {
    blocks = text.split(/(?=\[[^\]]+\])/g);
  } else {
    // 헤더가 없으면 빈 줄 2개 이상으로 분리
    blocks = text.split(/\n\s*\n/g);
  }
  const out: ParsedBrokerTrade[] = [];
  for (const b of blocks) {
    if (!b.trim()) continue;
    const t = parseBlock(b, ownerNames, known);
    if (t) out.push(t);
  }
  return out;
}
