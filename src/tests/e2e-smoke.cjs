/* ============================================================================
 * 无 Playwright 时的浏览器端兜底检查：把 e2e-inject.js 注入成品 HTML 的副本，
 * 用本机 Edge 的无头模式跑一遍，再把结果抓回来解析。
 *
 * 为什么需要它：项目的正式浏览器测试是 Playwright 写的，但在没有网络、
 * 装不上 playwright 的机器上跑不了；这个脚本零依赖，只用本机已装的 Edge。
 *
 * 跑法：node e2e-smoke.cjs      → 报告写到 _e2e_report.txt
 * 找不到 Edge 时直接跳过（退出码 0），不阻塞流水线。
 *
 * 实现要点：
 *   · 用文件描述符重定向，不用管道（受限环境里 piped stdio 会被拒）
 *   · 不等 Edge 自己退出（headless Edge 常常残留子进程），而是轮询 dump 出来的
 *     DOM 文件，出现 </html> 就认定抓取完成，然后 taskkill /T 收掉整棵进程树
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.dirname(path.dirname(__dirname));
const ARTIFACT = path.join(ROOT, 'mysql-terminal.html');
const INJECT = path.join(__dirname, 'e2e-inject.js');
const PROBE = path.join(__dirname, '_e2e_probe.html');
const DOM_OUT = path.join(__dirname, '_e2e_dom.html');
const REPORT = path.join(__dirname, '_e2e_report.txt');

const EDGE_CANDIDATES = [
  process.env.DSH_EDGE_PATH || '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));

function bail(msg, code) {
  fs.writeFileSync(REPORT, msg, 'utf8');
  console.log(msg);
  process.exit(code || 0);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  if (!EDGE) {
    bail('未找到本机 Edge，跳过浏览器兜底检查（正式浏览器测试请用 src/tests/*.py 里的 Playwright 脚本）。', 0);
  }
  if (!fs.existsSync(ARTIFACT)) {
    console.error('找不到成品 ' + ARTIFACT + '，请先运行 src/build.py');
    process.exit(1);
  }

  // 1) 生成注入了测试脚本的副本
  const html = fs.readFileSync(ARTIFACT, 'utf8');
  const inject = fs.readFileSync(INJECT, 'utf8');
  if (html.indexOf('</body>') < 0) {
    console.error('成品 HTML 里找不到 </body>，无法注入。');
    process.exit(1);
  }
  fs.writeFileSync(PROBE, html.replace('</body>', '<script>\n' + inject + '\n</script>\n</body>'), 'utf8');
  if (fs.existsSync(DOM_OUT)) fs.unlinkSync(DOM_OUT);

  // 2) 启动 Edge（stdio 全部走文件描述符）
  const outFd = fs.openSync(DOM_OUT, 'w');
  const errFd = fs.openSync(DOM_OUT + '.err', 'w');
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-extensions', '--no-first-run', '--disable-background-networking',
    '--user-data-dir=' + path.join(os.tmpdir(), '_dsh_e2e_profile'),
    '--virtual-time-budget=30000',
    '--dump-dom',
    'file:///' + PROBE.replace(/\\/g, '/')
  ], { stdio: ['ignore', outFd, errFd] });

  // 3) 轮询 dump 结果：出现 </html> 就算抓完
  let done = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      const t = fs.readFileSync(DOM_OUT, 'utf8');
      if (t.indexOf('</html>') >= 0) { done = true; break; }
    } catch (e) { /* 还没写 */ }
  }

  // 4) 收掉整棵进程树（headless Edge 经常不自己退出）
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  try { fs.closeSync(outFd); fs.closeSync(errFd); } catch (e) { /* ignore */ }

  if (!done) {
    bail('等待 Edge 输出 DOM 超时（90 秒）。可能原因：无头模式在这台机器上被策略拦住，或成品启动失败。', 1);
  }

  // 5) 解析结果
  const dom = fs.readFileSync(DOM_OUT, 'utf8');
  const start = dom.indexOf('<pre id="e2e-out">');
  if (start < 0) {
    bail('DOM 里没有 #e2e-out —— 说明注入的测试脚本没有跑到结束（引擎可能没启动，或脚本被 CSP 拦下）。\n'
      + 'DOM 大小：' + dom.length + ' 字节；遮罩已隐藏：' + (dom.indexOf('class="boot hide"') >= 0), 1);
  }
  const end = dom.indexOf('</pre>', start);
  const lines = dom.slice(start + '<pre id="e2e-out">'.length, end)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const pass = lines.filter((l) => l.startsWith('PASS'));
  const fail = lines.filter((l) => l.startsWith('FAIL'));

  const out = [];
  out.push('浏览器端兜底检查（Edge 无头模式 · 真实键盘事件驱动终端）');
  out.push('成品：' + ARTIFACT + '（' + fs.statSync(ARTIFACT).size + ' 字节）');
  out.push('通过 ' + pass.length + ' / 失败 ' + fail.length);
  out.push('');
  pass.forEach((l) => out.push('  ✓ ' + l.slice(5).replace(/\t/g, '  ')));
  fail.forEach((l) => out.push('  ✗ ' + l.slice(5).replace(/\t/g, '  ')));
  fs.writeFileSync(REPORT, out.join('\n'), 'utf8');
  console.log('报告已生成: _e2e_report.txt  通过 ' + pass.length + ' / 失败 ' + fail.length);
  if (fail.length) process.exit(1);
})();
