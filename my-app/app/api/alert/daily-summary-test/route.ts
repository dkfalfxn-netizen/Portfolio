import { NextRequest, NextResponse } from "next/server";

type Source = "bok" | "kcif" | "both";

type Body = {
  source?: Source;
  sync_key?: string;
};

function isSource(v: unknown): v is Source {
  return v === "bok" || v === "kcif" || v === "both";
}

async function trigger(req: NextRequest, path: string): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}> {
  const secret = process.env.CRON_SECRET?.trim();
  const url = `${req.nextUrl.origin}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON 파싱 실패" }, { status: 400 });
  }

  const source = body.source;
  if (!isSource(source)) {
    return NextResponse.json({ ok: false, error: "source는 bok|kcif|both 이어야 합니다." }, { status: 400 });
  }

  const syncKey = typeof body.sync_key === "string" ? body.sync_key.trim() : "";
  const expected = process.env.TELEGRAM_ALERT_SYNC_KEY?.trim() ?? "";
  if (!syncKey || !expected || syncKey !== expected) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized: 동기화 키가 일치하지 않습니다." },
      { status: 401 },
    );
  }

  if (source === "bok") {
    const bok = await trigger(req, "/api/cron/bok-financial-market");
    return NextResponse.json(
      {
        ok: bok.ok,
        source,
        ...(bok.ok
          ? { message: "BOK 요약 테스트 발송 완료", payload: { bok: bok.body } }
          : { error: String(bok.body.error ?? `BOK 호출 실패 (${bok.status})`), payload: { bok: bok.body } }),
      },
      { status: bok.ok ? 200 : bok.status },
    );
  }

  if (source === "kcif") {
    const kcif = await trigger(req, "/api/cron/kcif-pdf-summary");
    return NextResponse.json(
      {
        ok: kcif.ok,
        source,
        ...(kcif.ok
          ? { message: "KCIF PDF 요약 테스트 발송 완료", payload: { kcif: kcif.body } }
          : {
              error: String(kcif.body.error ?? `KCIF 호출 실패 (${kcif.status})`),
              payload: { kcif: kcif.body },
            }),
      },
      { status: kcif.ok ? 200 : kcif.status },
    );
  }

  const bok = await trigger(req, "/api/cron/bok-financial-market");
  if (!bok.ok) {
    return NextResponse.json(
      {
        ok: false,
        source,
        error: String(bok.body.error ?? `BOK 호출 실패 (${bok.status})`),
        payload: { bok: bok.body },
      },
      { status: bok.status },
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 60_000));

  const kcif = await trigger(req, "/api/cron/kcif-pdf-summary");
  return NextResponse.json(
    {
      ok: kcif.ok,
      source,
      ...(kcif.ok
        ? {
            message: "BOK/KCIF 요약 테스트를 1분 간격으로 모두 발송했습니다.",
            payload: { bok: bok.body, kcif: kcif.body },
          }
        : {
            error: String(kcif.body.error ?? `KCIF 호출 실패 (${kcif.status})`),
            payload: { bok: bok.body, kcif: kcif.body },
          }),
    },
    { status: kcif.ok ? 200 : kcif.status },
  );
}
