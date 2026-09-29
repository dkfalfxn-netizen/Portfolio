// ── 증권사 체결 알림 파서 ─────────────────────────────────────────────────────
export type BrokerNotificationParsed = {
  accountName: string;       // 정확한 이름 또는 마스킹된 이름 (김*주)
  name: string;
  symbol: string;            // 없으면 빈 문자열 (하나증권 등)
  tradeType: "buy" | "sell";
  qty: number;
  price: number;
  currency: "KRW" | "USD" | "EUR";
  date?: string;             // YYYY-MM-DD (없으면 호출부에서 오늘 날짜 사용)
  accountKind?: string;      // 계좌 종류 토큰: "ISA" | "직투" | "IRP" | "DC"
  accountNumber?: string;    // 계좌번호 문자열 (구분용)
};

/** 계좌번호 끝자리 → 보유자명 (이름 마스킹으로 구분 불가한 경우). 필요시 여기에 추가. */
export const ACCOUNT_NUMBER_OWNER_RULES: { test: RegExp; owner: string }[] = [
  { test: /27-?01\b/, owner: "김도율" },
  { test: /62-?01\b/, owner: "김찬율" },
];

/** 마스킹된 이름(김*주)을 ownerNames 목록에서 찾아 실제 이름 반환. 유일하게 매칭되면 반환, 아니면 빈 문자열 */
export function resolveOwnerFromMasked(masked: string, ownerNames: string[]): string {
  if (!masked) return "";
  // 마스킹 없으면 그대로 exact match 시도
  if (!masked.includes("*")) return ownerNames.find((n) => n === masked) ? masked : "";
  const first = masked[0];
  const last = masked[masked.length - 1];
  const matches = ownerNames.filter((n) => n.length >= 2 && n[0] === first && n[n.length - 1] === last);
  return matches.length === 1 ? matches[0] : "";
}

/** 이름(마스킹 가능)이 보유자명의 사람 부분과 맞는지 — "김승주 ISA"의 사람부분 "김승주" 기준 */
export function brokerNameMatchesOwner(accountName: string, owner: string): boolean {
  if (!accountName) return true;
  const personPart = owner.split(/\s+/)[0] ?? owner;
  if (accountName.includes("*")) {
    const f = accountName[0];
    const l = accountName[accountName.length - 1];
    return personPart.length >= 2 && personPart[0] === f && personPart[personPart.length - 1] === l;
  }
  return owner.includes(accountName) || accountName.includes(personPart);
}

/** 증권사 파싱 결과에서 보유자(계좌)를 결정.
 *  1) 계좌번호 규칙 → 2) 계좌종류(ISA/직투/IRP/DC)+이름 조합 → 3) 이름 단독(마스킹 해석) */
export function resolveBrokerOwner(parsed: BrokerNotificationParsed, ownerNames: string[]): string {
  // 1) 계좌번호로 특정
  if (parsed.accountNumber) {
    for (const rule of ACCOUNT_NUMBER_OWNER_RULES) {
      if (rule.test.test(parsed.accountNumber)) {
        const o = ownerNames.find((n) => n === rule.owner) ?? ownerNames.find((n) => n.includes(rule.owner));
        if (o) return o;
      }
    }
  }
  // 2) 계좌 종류 토큰으로 후보를 좁히고, 여럿이면 이름으로 특정
  const kind = parsed.accountKind?.trim().toUpperCase();
  if (kind) {
    const cands = ownerNames.filter((n) => n.toUpperCase().includes(kind));
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
      const narrowed = cands.filter((o) => brokerNameMatchesOwner(parsed.accountName, o));
      if (narrowed.length >= 1) return narrowed[0];
      return cands[0];
    }
  }
  // 3) 이름 단독
  const exact = ownerNames.find((n) => n === parsed.accountName);
  return exact ?? resolveOwnerFromMasked(parsed.accountName, ownerNames);
}

export function parsePriceField(raw: string): { price: number; currency: "KRW" | "USD" | "EUR" } {
  if (raw.includes("$") || raw.toUpperCase().includes("USD"))
    return { currency: "USD", price: parseFloat(raw.replace(/[^0-9.]/g, "")) };
  if (raw.includes("€") || raw.toUpperCase().includes("EUR"))
    return { currency: "EUR", price: parseFloat(raw.replace(/[^0-9.]/g, "")) };
  return { currency: "KRW", price: parseInt(raw.replace(/[^\d]/g, ""), 10) };
}

/** 미래에셋증권 카카오 체결 알림
 * 예) [미래에셋증권] 전량체결 / 계좌명 : 김찬율 / 종목명 : SOL 미국원자력SMR(A0051G0) */
export function parseMiraeAssetNotification(text: string): BrokerNotificationParsed | null {
  if (!text.includes("미래에셋")) return null;
  const get = (key: string) => {
    const m = text.match(new RegExp(`${key}\\s*:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  const 종목명Raw = get("종목명");
  const 매매구분 = get("매매구분");
  const 체결수량Raw = get("체결수량");
  const 체결단가Raw = get("체결단가");
  const 계좌명 = get("계좌명");
  if (!종목명Raw || !매매구분 || !체결수량Raw || !체결단가Raw) return null;

  const nameMatch = 종목명Raw.match(/^(.+?)\(([^)]+)\)$/);
  const name = nameMatch ? nameMatch[1].trim() : 종목명Raw.trim();
  const symbol = nameMatch ? nameMatch[2].trim() : "";
  const qty = parseInt(체결수량Raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const { price, currency } = parsePriceField(체결단가Raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const tradeType: "buy" | "sell" = 매매구분.includes("매도") ? "sell" : "buy";
  // 미래에셋 → ISA 계좌
  return { accountName: 계좌명, name, symbol, tradeType, qty, price, currency, accountKind: "ISA", accountNumber: get("계좌번호") };
}

/** 하나증권 퇴직연금 체결 알림
 * 예) [하나증권] 퇴직연금 매매체결 안내 / ■ 종목 : TIGER 테슬라채권혼합Fn / ■ 수량 : 5 주 */
export function parseHanaNotification(text: string): BrokerNotificationParsed | null {
  if (!text.includes("하나증권")) return null;
  const get = (key: string) => {
    const m = text.match(new RegExp(`■\\s*${key}\\s*:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  const 주문구분 = get("주문구분");
  const 종목 = get("종목");
  const 수량Raw = get("수량");
  const 가격Raw = get("가격");
  if (!주문구분 || !종목 || !수량Raw || !가격Raw) return null;

  const qty = parseInt(수량Raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const { price, currency } = parsePriceField(가격Raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const tradeType: "buy" | "sell" = 주문구분.includes("매도") ? "sell" : "buy";
  // 헤더 "퇴직연금"으로 보유자 추론
  const accountName = text.includes("퇴직연금") ? "퇴직연금" : "";
  // 개인형 IRP / 확정기여형(DC) 구분
  const accountKind = /개인형|IRP/i.test(text) ? "IRP" : /확정기여형|DC\s*형|\(DC/i.test(text) ? "DC" : undefined;
  return { accountName, name: 종목.trim(), symbol: "", tradeType, qty, price, currency, accountKind };
}

/** 메리츠증권 해외주식 주문체결 안내
 * 예) [메리츠증권] 해외주식 주문체결 안내 / 종목명 : FIDELITY CRYPTO...(FDIG) / 체결단가 : USD 44.8300 */
export function parseMeritzNotification(text: string): BrokerNotificationParsed | null {
  if (!text.includes("메리츠")) return null;
  const get = (key: string) => {
    const m = text.match(new RegExp(`${key}\\s*:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  const 종목명Raw = get("종목명");
  const 매매구분 = get("매매구분");
  const 체결수량Raw = get("체결수량");
  const 체결단가Raw = get("체결단가");
  const 계좌명Raw = get("계좌명");
  const 체결일자Raw = get("체결일자"); // MM/DD 형식
  if (!종목명Raw || !매매구분 || !체결수량Raw || !체결단가Raw) return null;

  // "FIDELITY CRYPTO INDUSTRY AND DIGITAL PAY(FDIG)" → name / symbol 분리
  const nameMatch = 종목명Raw.match(/^(.+?)\(([^)]+)\)$/);
  const name = nameMatch ? nameMatch[1].trim() : 종목명Raw.trim();
  const symbol = nameMatch ? nameMatch[2].trim() : "";

  const qty = parseInt(체결수량Raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const { price, currency } = parsePriceField(체결단가Raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const tradeType: "buy" | "sell" = 매매구분.includes("매도") ? "sell" : "buy";

  // 체결일자 MM/DD → YYYY-MM-DD
  let date: string | undefined;
  const dateMatch = 체결일자Raw.match(/^(\d{1,2})\/(\d{2})$/);
  if (dateMatch) {
    const year = new Date().getFullYear();
    date = `${year}-${dateMatch[1].padStart(2, "0")}-${dateMatch[2]}`;
  }

  // 메리츠 → 직투 계좌 (계좌번호로 김도율/김찬율 등 추가 구분)
  return { accountName: 계좌명Raw, name, symbol, tradeType, qty, price, currency, date, accountKind: "직투", accountNumber: get("계좌번호") };
}

/** 지원하는 모든 증권사 파서를 순서대로 시도 */
export function parseBrokerNotification(text: string): BrokerNotificationParsed | null {
  return parseMiraeAssetNotification(text) ?? parseHanaNotification(text) ?? parseMeritzNotification(text);
}

// 하위 호환: 기존 타입명 유지
