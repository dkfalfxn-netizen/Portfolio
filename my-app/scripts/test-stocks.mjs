const symbols = {
  "리가켐바이오": ["141080.KS", "141080.KQ"],
  "비츠로셀":    ["082920.KS", "082920.KQ"],
  "서희건설":    ["035890.KS", "035890.KQ"],
};

for (const [name, tickers] of Object.entries(symbols)) {
  for (const sym of tickers) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? null;
    const prevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
    const currency = meta?.currency ?? null;
    console.log(`${name} ${sym}: price=${price}, prevClose=${prevClose}, currency=${currency}`);
  }
}
