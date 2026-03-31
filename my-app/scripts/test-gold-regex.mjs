// 실제 코드와 동일한 로직으로 테스트
const res = await fetch('https://finance.naver.com/marketindex/goldDailyQuote.nhn?page=1', {
  method: 'GET',
  cache: 'no-store',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'text/html,application/xhtml+xml',
    Referer: 'https://finance.naver.com/',
  },
});
console.log('status:', res.status, res.headers.get('content-type'));
const html = await res.text();

// 실제 코드의 정규식
const match = html.match(/<td class="date">\d{4}\.\d{2}\.\d{2}<\/td>\s*<td class="num">([\d,]+(?:\.\d+)?)<\/td>/);
console.log('regex match:', match ? match[1] : 'NO MATCH');

if (!match) {
  // HTML 일부 출력해서 구조 확인
  const tdIdx = html.indexOf('<td class=');
  console.log('first <td class=...>:', html.substring(tdIdx, tdIdx + 150));
}
