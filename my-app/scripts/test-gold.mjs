const res = await fetch('https://finance.naver.com/marketindex/goldDailyQuote.nhn?page=1', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Referer': 'https://finance.naver.com/'
  }
});
console.log('status:', res.status);
const html = await res.text();

// Look for date-related content
const idx = html.indexOf('date');
console.log('--- around first "date" ---');
console.log(html.substring(Math.max(0, idx - 20), idx + 300));

// Try regex
const match = html.match(/class="date"[^>]*>(\d{4}\.\d{2}\.\d{2})/);
console.log('\ndate match:', match ? match[1] : 'NO MATCH');

const numMatch = html.match(/class="num"[^>]*>([\d,]+(?:\.\d+)?)/);
console.log('num match:', numMatch ? numMatch[1] : 'NO MATCH');
