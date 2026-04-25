export type GoogleNewsHeadline = {
  title: string;
  url: string;
};

function decodeXmlText(raw: string): string {
  let t = raw
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .trim();
  t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  t = t.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  t = t.replace(/<[^>]+>/g, "");
  return t.trim();
}

function extractInnerXml(tag: string, xml: string): string | null {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>(?:\\s*<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>\\s*)?</${tag}>`,
    "i",
  );
  const m = xml.match(re);
  return m ? m[1] : null;
}

/**
 * Google News RSS `<item>`에서 제목·링크 추출. 링크가 없거나 http가 아니면 건너뜀.
 */
export function parseGoogleNewsRssHeadlines(xml: string, limit = 28): GoogleNewsHeadline[] {
  const out: GoogleNewsHeadline[] = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
  for (const item of itemBlocks) {
    if (out.length >= limit) break;
    const titleRaw = extractInnerXml("title", item);
    const linkRaw = extractInnerXml("link", item);
    if (!titleRaw) continue;
    const title = decodeXmlText(titleRaw);
    if (title.length < 6) continue;
    let url = linkRaw ? decodeXmlText(linkRaw).split(/\s/)[0].trim() : "";
    if (!url.startsWith("http")) {
      const guidRaw = extractInnerXml("guid", item);
      if (guidRaw) {
        const g = decodeXmlText(guidRaw).trim();
        if (g.startsWith("http")) url = g;
      }
    }
    if (!url.startsWith("http")) continue;
    out.push({ title, url });
  }
  return dedupeHeadlines(out);
}

export function dedupeHeadlines(items: GoogleNewsHeadline[]): GoogleNewsHeadline[] {
  const seen = new Set<string>();
  const out: GoogleNewsHeadline[] = [];
  for (const it of items) {
    const key = it.url || it.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function headlinesToTitles(items: GoogleNewsHeadline[]): string[] {
  return items.map((x) => x.title);
}

/** 요약 본문 아래에 붙이는 출처 블록 (번호 = 프롬프트·요약 [N]과 일치) */
export function formatHeadlinesSourceBlock(items: GoogleNewsHeadline[]): string {
  return items
    .map((it, i) => `${i + 1}. ${it.title}\n${it.url}`)
    .join("\n\n");
}

/** Supabase `source_titles` jsonb: 구버전 string[] / 신버전 {title,url}[] 모두 수용 */
export function normalizeStoredSourceTitles(raw: unknown): GoogleNewsHeadline[] {
  if (!Array.isArray(raw)) return [];
  const out: GoogleNewsHeadline[] = [];
  for (const x of raw) {
    if (typeof x === "string") {
      const t = x.trim();
      if (t.length >= 6) out.push({ title: t, url: "" });
      continue;
    }
    if (x && typeof x === "object" && "title" in x) {
      const o = x as { title?: unknown; url?: unknown };
      const title = typeof o.title === "string" ? o.title.trim() : "";
      const url = typeof o.url === "string" ? o.url.trim() : "";
      if (title.length < 6) continue;
      out.push({ title, url: url.startsWith("http") ? url : "" });
    }
  }
  return dedupeHeadlines(out);
}
