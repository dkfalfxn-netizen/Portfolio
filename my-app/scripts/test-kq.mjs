// 394800 .KS vs .KQ 테스트
for (const sym of ["394800.KS", "394800.KQ"]) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const data = await r.json();
  const meta = data?.chart?.result?.[0]?.meta;
  console.log(`${sym}: price=${meta?.regularMarketPrice ?? "null"}, currency=${meta?.currency ?? "null"}`);
}
