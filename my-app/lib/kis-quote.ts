/**
 * 한국투자증권(KIS) 미국 현재가 조회 — 서버 전용.
 *
 * Railway의 broker.py / auth.py 로직을 Vercel 서버리스로 이식한 것.
 *  - appkey/secret은 서버 env(KIS_APP_KEY/KIS_APP_SECRET)에서만 읽음 → 브라우저에 절대 노출 안 됨.
 *  - KIS는 토큰 발급을 분당 1회로 제한 → Vercel은 stateless라 토큰을 Supabase(kis_token_cache)에 캐시해 재사용.
 *  - 시세 거래소 코드: 미국 거래소 운영(프리04:00~애프터20:00 ET)엔 NAS/NYS/AMS(라이브),
 *    그 외 야간(=한국 낮)엔 주간거래 BAQ/BAY/BAA(블루오션). _us_market_session과 동일.
 *
 * ⚠️ 이 파일은 서버(Route Handler)에서만 import. 클라이언트 컴포넌트에서 쓰지 말 것.
 */
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export type KisUsQuote = {
  symbol: string;
  excd: string;
  price: number;
  prevClose: number;
  change: number;
  changeRate: number;
  volume: number;
  asOf: string;
};

function kisBaseUrl(): string {
  const env = (process.env.KIS_ENV ?? "live").trim().toLowerCase();
  return env === "paper" || env === "vts"
    ? "https://openapivts.koreainvestment.com:29443"
    : "https://openapi.koreainvestment.com:9443";
}
const kisAppKey = () => (process.env.KIS_APP_KEY ?? "").trim();
const kisAppSecret = () => (process.env.KIS_APP_SECRET ?? "").trim();

export function kisCredentialsConfigured(): boolean {
  return kisAppKey().length > 0 && kisAppSecret().length > 0;
}

/** 미국 시세 코드 선택: 'regular'(NAS/NYS/AMS, 04:00~20:00 ET 평일) / 'extended'(BAQ/BAY/BAA, 야간·주말). */
function usMarketSession(): "regular" | "extended" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (wd === "Sat" || wd === "Sun") return "extended";
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const etMin = (hh % 24) * 60 + mm;
  return etMin >= 4 * 60 && etMin < 20 * 60 ? "regular" : "extended";
}

const REGULAR_TRY_ORDER = ["NAS", "NYS", "AMS"];
const DAYTIME_TRY_ORDER = ["BAQ", "BAY", "BAA"];

function moneyFloat(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── 토큰: 메모리(웜 인스턴스) + Supabase(영속) 캐시 ──────────────────────────
let memToken = "";
let memExpSec = 0;
const RENEW_BEFORE = 60; // 만료 60초 전까지 사용

async function issueAndStoreToken(nowSec: number): Promise<string> {
  const res = await fetch(`${kisBaseUrl()}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: kisAppKey(),
      appsecret: kisAppSecret(),
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`KIS 토큰 발급 실패 (status ${res.status})`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("KIS 토큰 응답에 access_token 없음");
  memToken = j.access_token;
  memExpSec = nowSec + (Number(j.expires_in) || 86400);
  const sb = createSupabaseAdmin();
  if (sb) {
    await sb.from("kis_token_cache").upsert({
      id: "default",
      access_token: memToken,
      expires_at: Math.floor(memExpSec),
      updated_at: new Date().toISOString(),
    });
  }
  return memToken;
}

let tokenInFlight: Promise<string> | null = null;

async function resolveToken(): Promise<string> {
  const nowSec = Date.now() / 1000;
  if (memToken && nowSec < memExpSec - RENEW_BEFORE) return memToken;

  const sb = createSupabaseAdmin();
  if (sb) {
    const { data } = await sb
      .from("kis_token_cache")
      .select("access_token, expires_at")
      .eq("id", "default")
      .maybeSingle();
    const exp = Number(data?.expires_at);
    if (data?.access_token && Number.isFinite(exp) && nowSec < exp - RENEW_BEFORE) {
      memToken = data.access_token;
      memExpSec = exp;
      return memToken;
    }
  }

  try {
    return await issueAndStoreToken(nowSec);
  } catch (e) {
    // 발급 실패(분당 1회 제한 등) → 다른 인스턴스가 막 갱신했을 수 있으니 Supabase 재확인
    if (sb) {
      const { data } = await sb
        .from("kis_token_cache")
        .select("access_token, expires_at")
        .eq("id", "default")
        .maybeSingle();
      const exp = Number(data?.expires_at);
      if (data?.access_token && Number.isFinite(exp) && nowSec < exp - RENEW_BEFORE) {
        memToken = data.access_token;
        memExpSec = exp;
        return memToken;
      }
    }
    throw e;
  }
}

/** 동시 호출(일괄 조회의 병렬 종목들)이 토큰을 중복 발급하지 않도록 in-flight 공유. */
async function getToken(): Promise<string> {
  const nowSec = Date.now() / 1000;
  if (memToken && nowSec < memExpSec - RENEW_BEFORE) return memToken;
  if (!tokenInFlight) {
    tokenInFlight = resolveToken().finally(() => {
      tokenInFlight = null;
    });
  }
  return tokenInFlight;
}

async function fetchPriceForExcd(
  token: string,
  ticker: string,
  excd: string,
): Promise<{ last: number; base: number; diff: number; rate: number; tvol: number } | null> {
  const url =
    `${kisBaseUrl()}/uapi/overseas-price/v1/quotations/price` +
    `?AUTH=&EXCD=${encodeURIComponent(excd)}&SYMB=${encodeURIComponent(ticker)}`;
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: kisAppKey(),
      appsecret: kisAppSecret(),
      tr_id: "HHDFS00000300",
      custtype: "P",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { output?: Record<string, unknown> };
  const o = j.output ?? {};
  return {
    last: moneyFloat(o.last),
    base: moneyFloat(o.base),
    diff: moneyFloat(o.diff),
    rate: moneyFloat(o.rate),
    tvol: moneyFloat(o.tvol),
  };
}

/** 미국 종목 1건 현재가. 현재 세션에 맞는 거래소 코드로 조회. 실패·미지원·시세없음 → null. */
export async function getKisUsQuote(symbol: string): Promise<KisUsQuote | null> {
  const sym = (symbol || "").trim().toUpperCase();
  if (!sym || !kisCredentialsConfigured()) return null;
  const token = await getToken();
  const order = usMarketSession() === "regular" ? REGULAR_TRY_ORDER : DAYTIME_TRY_ORDER;
  for (const excd of order) {
    try {
      const r = await fetchPriceForExcd(token, sym, excd);
      if (r && r.last > 0) {
        return {
          symbol: sym,
          excd,
          price: r.last,
          prevClose: r.base,
          change: r.diff,
          changeRate: r.rate,
          volume: r.tvol,
          asOf: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
      }
    } catch {
      // 다음 거래소 시도
    }
  }
  return null;
}

/** 여러 종목 일괄 조회. {SYMBOL: quote} 맵 반환(시세 없는 종목은 생략). */
export async function getKisUsQuotes(symbols: string[]): Promise<Record<string, KisUsQuote>> {
  const uniq = [...new Set(symbols.map((s) => (s || "").trim().toUpperCase()).filter(Boolean))];
  const out: Record<string, KisUsQuote> = {};
  await Promise.all(
    uniq.map(async (sym) => {
      const q = await getKisUsQuote(sym);
      if (q) out[sym] = q;
    }),
  );
  return out;
}

// ── 국내 ETF 구성종목 (KIS: ETF 구성종목시세) ───────────────────────────────

export type KisEtfComponent = {
  /** 구성종목 코드(국내 6자리 등) */
  code: string;
  name: string;
  /** ETF 내 비중(%) */
  weightPct: number | null;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
};

export type KisEtfComponentsResult = {
  items: KisEtfComponent[];
  /** 비어 있을 때 원인 진단(키 값 등 비밀은 포함하지 않음) — 화면에 힌트로 노출 */
  diag: string;
};

const KIS_ETF_COMPONENT_TTL_MS = 60 * 1000;
const kisEtfComponentCache = new Map<string, { at: number; items: KisEtfComponent[] }>();

function pickStr(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

type KisEtfJsonResult =
  | { kind: "notjson"; status: number; text: string }
  | { kind: "json"; ok: boolean; status: number; j: Record<string, unknown>; msg: string };

async function fetchKisEtfComponentJson(code: string): Promise<KisEtfJsonResult> {
  const token = await getToken();
  const url =
    `${kisBaseUrl()}/uapi/etfetn/v1/quotations/inquire-component-stock-price` +
    `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${encodeURIComponent(code)}&FID_COND_SCR_DIV_CODE=11216`;
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: kisAppKey(),
      appsecret: kisAppSecret(),
      tr_id: "FHKST121600C0",
      custtype: "P",
    },
    cache: "no-store",
  });
  const text = await res.text();
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "notjson", status: res.status, text };
  }
  const msg = `${String(j.msg_cd ?? "")} ${String(j.msg1 ?? "")}`.trim();
  return { kind: "json", ok: res.ok, status: res.status, j, msg };
}

/** 진단용 대조군: 평범한 국내 주식형 ETF(KODEX 200)도 같은 호출로 구성종목이 오는지 확인 */
let kisEtfControlCache: string | null = null;
async function kisEtfControlProbe(): Promise<string> {
  if (kisEtfControlCache) return kisEtfControlCache;
  try {
    const r = await fetchKisEtfComponentJson("069500");
    if (r.kind === "notjson") return `비JSON(HTTP ${r.status})`;
    const o2 = r.j.output2;
    const desc = Array.isArray(o2) ? `array(${o2.length})` : typeof o2;
    kisEtfControlCache = `${desc}${String(r.j.rt_cd) !== "0" ? ` rt_cd=${String(r.j.rt_cd)} ${r.msg}` : ""}`;
    return kisEtfControlCache;
  } catch (e) {
    return `예외(${e instanceof Error ? e.message.slice(0, 40) : "?"})`;
  }
}

/**
 * 국내 ETF 구성종목 + 비중 + 전일대비.
 * ETF 6자리 코드(예: 381180)를 넣는다. 미설정·실패·빈 응답이면 items=[] 와 diag 를 돌려준다.
 */
export async function getKisEtfComponents(etfCode: string): Promise<KisEtfComponentsResult> {
  const code = (etfCode || "").trim().toUpperCase();
  if (!code) return { items: [], diag: "ETF 코드가 비어 있음" };
  if (!kisCredentialsConfigured()) {
    return { items: [], diag: "서버에 KIS_APP_KEY/KIS_APP_SECRET 이 설정되지 않음" };
  }
  const cached = kisEtfComponentCache.get(code);
  if (cached && Date.now() - cached.at < KIS_ETF_COMPONENT_TTL_MS) return { items: cached.items, diag: "" };

  try {
    const r = await fetchKisEtfComponentJson(code);
    if (r.kind === "notjson") return { items: [], diag: `KIS 응답이 JSON이 아님 (HTTP ${r.status}): ${r.text.slice(0, 80)}` };
    const { j, status, msg } = r;
    if (!r.ok) return { items: [], diag: `KIS HTTP ${status} ${msg}`.trim() };
    if (j.rt_cd !== undefined && String(j.rt_cd) !== "0") {
      return { items: [], diag: `KIS rt_cd=${String(j.rt_cd)} ${msg}`.trim() };
    }

    const list = Array.isArray(j.output2) ? (j.output2 as Record<string, unknown>[]) : [];
    if (list.length === 0) {
      const o2 = j.output2;
      const o2desc = Array.isArray(o2) ? `array(${o2.length})` : o2 === null ? "null" : typeof o2;
      const o1 = j.output1 && typeof j.output1 === "object" ? Object.keys(j.output1 as object).slice(0, 8).join(",") : String(typeof j.output1);
      const control = code === "069500" ? "" : ` / 대조 069500=${await kisEtfControlProbe()}`;
      return {
        items: [],
        diag: `KIS 응답에 구성종목(output2) 없음 — rt_cd=${String(j.rt_cd)} msg=${msg || "-"} output2=${o2desc} output1.keys=[${o1}]${control}`,
      };
    }

    const items: KisEtfComponent[] = list
      .map((o): KisEtfComponent => {
        const price = moneyFloat(o.stck_prpr);
        const diffAbs = moneyFloat(o.prdy_vrss);
        const sign = String(o.prdy_vrss_sign ?? "");
        const down = sign === "4" || sign === "5";
        const diff = down ? -Math.abs(diffAbs) : Math.abs(diffAbs);
        let rate = moneyFloat(o.prdy_ctrt);
        if (down && rate > 0) rate = -rate;
        const weight = moneyFloat(o.etf_cnfg_issu_rlim);
        return {
          code: pickStr(o, "stck_shrn_iscd", "stck_iscd", "mksc_shrn_iscd"),
          name: pickStr(o, "hts_kor_isnm", "stck_hnm"),
          weightPct: weight > 0 ? weight : null,
          price: price > 0 ? price : null,
          previousClose: price > 0 ? price - diff : null,
          changePct: price > 0 ? rate : null,
        };
      })
      .filter((x) => x.code.length > 0);

    items.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1));
    if (items.length === 0) return { items: [], diag: "KIS 구성종목 항목에 종목코드 필드가 없음" };
    kisEtfComponentCache.set(code, { at: Date.now(), items });
    return { items, diag: "" };
  } catch (e) {
    return { items: [], diag: `KIS 호출 예외: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160) };
  }
}
