#!/usr/bin/env node
// 探测可用的搜索源。只做"一搜就有"的浅层检索，不抓正文。
const QUERY = process.argv[2] || '北京今天天气';

const sources = [
  {
    name: 'bing-rss',
    url: `https://cn.bing.com/search?format=rss&q=${encodeURIComponent(QUERY)}&setlang=zh-CN&cc=CN`
  },
  {
    name: 'bing-rss-com',
    url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(QUERY)}`
  },
  {
    name: 'ddg-html',
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(QUERY)}`
  }
];

for (const s of sources) {
  const started = Date.now();
  try {
    const res = await fetch(s.url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'application/rss+xml, text/xml, text/html;q=0.9, */*;q=0.8'
      },
      signal: AbortSignal.timeout(12000)
    });
    const text = await res.text();
    const items = (text.match(/<item>/g) || []).length;
    const results = (text.match(/class="result__a"/g) || []).length;
    console.log(`✅ ${s.name}  HTTP ${res.status}  ${Date.now() - started}ms  ${text.length} 字节  items=${items} ddg=${results}`);
    if (items > 0) {
      const first = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<description>([\s\S]*?)<\/description>/.exec(text);
      if (first) {
        console.log(`   首条：${first[1].replace(/<!\[CDATA\[|\]\]>/g, '').slice(0, 80)}`);
        console.log(`   摘要：${first[2].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').slice(0, 120)}`);
      }
    } else if (results > 0) {
      console.log('   （DuckDuckGo 可解析）');
    }
  } catch (error) {
    console.log(`❌ ${s.name}  ${Date.now() - started}ms  ${error?.message ?? error}`);
  }
}
