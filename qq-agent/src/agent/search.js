// 极简搜索：只查"一搜就有"的公开事实，只返回标题 + 摘要。
//
// 为什么不用 CLI 内置的 WebSearch/WebFetch：
//   · WebFetch 能访问任意 URL（包括内网），是 SSRF 通道，已在安全基线里禁掉；
//   · 内置搜索无法约束"查什么、查多深"，而这里只要一个能力。
//
// 安全边界（写死在代码里，不靠提示词约束）：
//   · 只请求 bing.com 一个域名 —— 模型给不了 URL，只给关键词；
//   · 查询长度硬截断；
//   · 只取 RSS 里的标题与摘要，**从不抓取网页正文**（抓正文就等于把 SSRF 又放回来了）；
//   · 返回条数与每条长度都有上限，避免把上下文撑爆。
const ENDPOINT = 'https://cn.bing.com/search';
const MAX_QUERY_CHARS = 100;
const DEFAULT_LIMIT = 5;
const MAX_SNIPPET_CHARS = 220;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 去掉 CDATA、HTML 标签，并解码常见实体。 */
function plain(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析 Bing 的 RSS 结果。 */
function parseRss(xml, limit) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = re.exec(xml)) && items.length < limit) {
    const block = match[1];
    const title = plain(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '');
    const snippet = plain(/<description>([\s\S]*?)<\/description>/.exec(block)?.[1] ?? '');
    const link = plain(/<link>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? '');
    if (title && snippet) {
      items.push({
        title,
        snippet: snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}…` : snippet,
        // 链接只作为来源标识返回，不提供"按链接抓取"的能力
        source: (() => {
          try { return new URL(link).hostname; } catch { return ''; }
        })()
      });
    }
  }
  return items;
}

/**
 * 执行一次浅层搜索。
 * @param {string} query
 * @param {{limit?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, items?:Array, reason?:string}>}
 */
export async function webSearch(query, { limit = DEFAULT_LIMIT, timeoutMs = 10000 } = {}) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
  if (!q) return { ok: false, reason: '搜索词为空' };

  const url = `${ENDPOINT}?format=rss&q=${encodeURIComponent(q)}&setlang=zh-CN&cc=CN&count=${limit}`;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, text/xml, text/html;q=0.9, */*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, reason: `搜索服务返回 HTTP ${res.status}` };
    const xml = await res.text();
    const items = parseRss(xml, Math.max(1, Math.min(8, limit)));
    if (!items.length) return { ok: false, reason: '没有搜到结果' };
    return { ok: true, items };
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? '搜索超时' : (error?.message ?? String(error));
    return { ok: false, reason: msg };
  }
}
