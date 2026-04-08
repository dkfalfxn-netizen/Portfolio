import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { sendAlertEmail, type AlertViolation } from "@/lib/resend";
import type { AlertRule } from "@/app/api/alert/config/route";
import { saveAllSnapshots } from "@/app/api/snapshot/route";

type Position = {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  currency: "USD" | "EUR" | "KRW";
  purchaseUsdKrw?: number;
  purchaseEurKrw?: number;
  accountType: "해외주식" | "국내주식";
  accountName: string;
  owner: string;
};

type CashEntry = { usd: number; krw: number };

const FALLBACK_USD_KRW = 1350;
const FALLBACK_EUR_KRW = 1450;

function calcValueKrw(p: Position, usdKrw: number, eurKrw: number): number {
  if (p.currency === "USD") return p.quantity * p.currentPrice * usdKrw;
  if (p.currency === "EUR") return p.quantity * p.currentPrice * eurKrw;
  return p.quantity * p.currentPrice;
}

function checkRules(
  positions: Position[],
  cashByOwner: Record<string, CashEntry>,
  rules: AlertRule[],
  usdKrw: number,
  eurKrw: number,
): AlertViolation[] {
  const violations: AlertViolation[] = [];

  const owners = [...new Set(positions.map((p) => p.owner))];

  for (const rule of rules) {
    const ownerList = rule.owner === "전체" ? owners : [rule.owner];

    for (const owner of ownerList) {
      const ownerPositions = positions.filter((p) => p.owner === owner);
      const cash = cashByOwner[owner] ?? { usd: 0, krw: 0 };
      const totalKrw =
        ownerPositions.reduce((s, p) => s + calcValueKrw(p, usdKrw, eurKrw), 0) +
        cash.krw +
        cash.usd * usdKrw;

      if (totalKrw <= 0) continue;

      const symbolPositions =
        rule.symbol === "전체"
          ? ownerPositions
          : ownerPositions.filter((p) => p.symbol === rule.symbol);

      const symbolValue = symbolPositions.reduce(
        (s, p) => s + calcValueKrw(p, usdKrw, eurKrw),
        0,
      );
      const currentPct = (symbolValue / totalKrw) * 100;

      const overMax = rule.maxPct !== undefined && currentPct > rule.maxPct;
      const underMin = rule.minPct !== undefined && currentPct < rule.minPct;

      if (overMax || underMin) {
        violations.push({
          owner,
          symbol: rule.symbol,
          currentPct,
          minPct: rule.minPct,
          maxPct: rule.maxPct,
        });
      }
    }
  }

  return violations;
}

/** Vercel Cron(GET) + 수동 버튼(POST) 모두 지원 */
async function handleCheck(syncKey?: string | null) {
  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  /**
   * 알림 유무와 관계없이 매일 실행: Supabase `portfolio_snapshots`에 있는 모든 sync_key에 대해
   * 오늘(KST) 일별 평가 스냅샷을 `portfolio_daily_snapshots`에 저장합니다.
   * (이전에는 알림 규칙이 0건이면 여기까지 도달하지 못해 방문 없이 기록이 안 되는 버그가 있었음)
   */
  await saveAllSnapshots().catch(() => {});

  /** sync_key가 주어지면 해당 계정만, 없으면 전체 alert_configs 순회 */
  const query =
    syncKey && syncKey.length >= 8
      ? admin.from("alert_configs").select("sync_key, email, rules").eq("sync_key", syncKey)
      : admin.from("alert_configs").select("sync_key, email, rules");

  const { data: configs, error: cfgErr } = await query;
  if (cfgErr) return NextResponse.json({ error: cfgErr.message }, { status: 500 });
  if (!configs || configs.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "설정된 알림 규칙이 없습니다. 일별 자산 스냅샷은 서버에 저장되었습니다.",
      snapshotsSaved: true,
    });
  }

  const results: { syncKey: string; violations: number; sent: boolean }[] = [];

  for (const cfg of configs) {
    const { data: snap } = await admin
      .from("portfolio_snapshots")
      .select("positions, cash_by_owner")
      .eq("sync_key", cfg.sync_key)
      .maybeSingle();

    if (!snap) continue;

    const positions = Array.isArray(snap.positions) ? (snap.positions as Position[]) : [];
    const cashByOwner = (snap.cash_by_owner ?? {}) as Record<string, CashEntry>;
    const rules = Array.isArray(cfg.rules) ? (cfg.rules as AlertRule[]) : [];

    const violations = checkRules(
      positions,
      cashByOwner,
      rules,
      FALLBACK_USD_KRW,
      FALLBACK_EUR_KRW,
    );

    let sent = false;
    if (violations.length > 0 && cfg.email) {
      const { ok } = await sendAlertEmail(cfg.email, violations);
      sent = ok;
    }

    results.push({ syncKey: cfg.sync_key, violations: violations.length, sent });
  }

  return NextResponse.json({ ok: true, results, snapshotsSaved: true });
}

/** Vercel Cron은 GET으로 호출 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  return handleCheck(null);
}

/** 수동 버튼은 POST로 호출 (sync_key 전달) */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }
  const syncKey =
    typeof (body as { sync_key?: unknown }).sync_key === "string"
      ? (body as { sync_key: string }).sync_key
      : null;
  return handleCheck(syncKey);
}
