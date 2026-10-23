#!/usr/bin/env node
// 直接连 NapCat 的 OneBot WebSocket，打印 open/error/close 的真实错误。
// 用来区分：是 NapCat 拒绝了连接，还是我们的重连逻辑卡住了。
const url = process.argv[2] || 'ws://127.0.0.1:3001';

console.log(`尝试连接 ${url}`);
const ws = new WebSocket(url);

ws.addEventListener('open', () => console.log('✅ open'));
ws.addEventListener('message', (ev) => {
  console.log('← 收到帧：', String(ev.data).slice(0, 200));
});
ws.addEventListener('error', (ev) => {
  console.log('❌ error：', ev.message || '(无 message)');
  const err = ev.error;
  if (err) console.log('   detail：', err.code || err.message || String(err));
});
ws.addEventListener('close', (ev) => {
  console.log(`close：code=${ev.code} reason=${ev.reason || '(空)'}`);
});

setTimeout(() => {
  console.log('（结束探测）');
  process.exit(0);
}, 6000);
