// 네이버 증권 API 테스트 (거래소 구분 불필요)
for (const [name, code] of [["리가켐바이오","141080"],["비츠로셀","082920"],["서희건설","035890"],["쓰리빌리언","394800"]]) {
  const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const d = await r.json();
  console.log(`${name}(${code}): close=${d.closePrice}, prev=${d.compareToPreviousClosePrice}, change=${d.fluctuationsRatio}%`);
}
