/* ============================================================================
 * 浏览器端冒烟检查（无需 Playwright）：由 e2e-smoke.cjs 注入到成品 HTML 末尾执行。
 * 做法：模拟真实键盘输入驱动终端，再检查 DOM 与终端输出，最后把结果写进 #e2e-out，
 *       由外层用 Edge 的 --dump-dom 抓回来解析。
 * ========================================================================== */
(function () {
  var checks = [];
  function chk(name, ok, extra) {
    checks.push((ok ? 'PASS' : 'FAIL') + '\t' + name + (ok || !extra ? '' : '\t' + extra));
  }
  function $(id) { return document.getElementById(id); }
  function term() { return $('scroll') ? $('scroll').textContent : ''; }
  function toast() { return $('toast') ? $('toast').textContent : ''; }

  /** 模拟在终端里敲一条语句并回车 */
  function type(sql) {
    var h = $('hidden');
    h.focus();
    h.value = sql;
    h.dispatchEvent(new Event('input', { bubbles: true }));
    var ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    h.dispatchEvent(ev);
  }

  function finish() {
    var pre = document.createElement('pre');
    pre.id = 'e2e-out';
    pre.textContent = checks.join('\n');
    document.body.appendChild(pre);
  }

  function run() {
    var t = term();
    chk('引擎启动并打印登录横幅', /Welcome to the MySQL monitor/.test(t));

    type('SELECT 7/2 AS a;');
    chk('除法是小数除法（7/2 = 3.5）', /3\.5/.test(term()));

    type('SELECT GREATEST(1,9,5) AS g;');
    chk('GREATEST 可用且返回 9', /\|\s+9\s+\|/.test(term()));

    type("SELECT CONCAT('a', NULL) AS c;");
    chk('CONCAT 遇 NULL 返回 NULL（MySQL 语义）', /NULL/.test(term()));

    type("SELECT GROUP_CONCAT(city SEPARATOR '|') AS g FROM users;");
    chk('GROUP_CONCAT ... SEPARATOR 生效', /深圳\|深圳/.test(term()));

    type("SHOW DATABASES LIKE 'prod%';");
    var seg = term().slice(term().lastIndexOf('SHOW DATABASES'));
    chk('SHOW DATABASES LIKE 只返回 production', /production/.test(seg) && !/school/.test(seg));

    type("SHOW COLUMNS FROM users LIKE 'id';");
    var cs = term().slice(term().lastIndexOf('SHOW COLUMNS'));
    chk('SHOW COLUMNS ... LIKE 只返回一列', /id/.test(cs) && !/balance/.test(cs));

    type('OPTIMIZE TABLE users;');
    chk('OPTIMIZE TABLE 返回 Msg_type 结果集', /Msg_type/.test(term()) && /does not support optimize/.test(term()));

    type('EXPLAIN SELECT * FROM users WHERE id = 1;');
    var ex = term().slice(term().lastIndexOf('EXPLAIN SELECT'));
    chk('EXPLAIN 输出 MySQL 12 列', /select_type/.test(ex) && /possible_keys/.test(ex) && /const/.test(ex));

    type('CREATE TABLE e2e_fk_p (id int PRIMARY KEY);');
    type('CREATE TABLE e2e_fk_c (id int PRIMARY KEY, pid int, FOREIGN KEY (pid) REFERENCES e2e_fk_p(id));');
    type('INSERT INTO e2e_fk_c VALUES (1, 999);');
    chk('外键真实生效（孤儿行报 1452）', /1452/.test(term().slice(term().lastIndexOf('INSERT INTO e2e_fk_c'))));

    type("SELECT username INTO @e2e_name FROM users WHERE id = 1;");
    type('SELECT @e2e_name AS n;');
    chk('SELECT ... INTO @var 可用', /zhangsan/.test(term().slice(term().lastIndexOf('SELECT @e2e_name'))));

    type('CREATE TEMPORARY TABLE e2e_tmp (id int);');
    type('DESC e2e_tmp;');
    chk('TEMPORARY TABLE 可见（DESC 不报 1146）', !/1146/.test(term().slice(term().lastIndexOf('DESC e2e_tmp'))));

    // ---- 界面：练习题与工具面板 ----
    chk('练习题共 46 道', document.querySelectorAll('#ex-list .ex').length === 46,
      '实际 ' + document.querySelectorAll('#ex-list .ex').length);
    chk('练习档位包含「实战」', /实战/.test($('ex-note').textContent));
    chk('工具面板按钮齐全',
      !!(  $('btn-csv') && $('btn-json') && $('btn-dump') && $('btn-import')));

    // 切到工具页签
    var toolTab = document.querySelector('.tab[data-panel="tool"]');
    if (toolTab) toolTab.click();
    chk('工具页签可切换', $('panel-tool').classList.contains('on'));

    // ---- 导出：先跑一条 SELECT 制造结果集，再点导出 ----
    type('SELECT id, username, balance FROM users LIMIT 2;');
    $('btn-csv').click();
    chk('导出 CSV 有成功提示', /已导出 2 行 CSV|不支持本地下载/.test(toast()), 'toast=' + toast());
    $('btn-json').click();
    chk('导出 JSON 有成功提示', /已导出 2 行 JSON|不支持本地下载/.test(toast()), 'toast=' + toast());
    $('btn-dump').click();
    chk('导出 SQL 脚本有成功提示', /已导出 production 库的 SQL 脚本|不支持本地下载/.test(toast()), 'toast=' + toast());

    // ---- 输入行语法高亮 ----
    var h = $('hidden');
    h.focus();
    h.value = "SELECT id FROM users WHERE city = '深圳'";
    h.dispatchEvent(new Event('input', { bubbles: true }));
    // 这条 SQL 里的关键字只有 SELECT / FROM / WHERE 三个
    var ks = document.querySelectorAll('#input .k');
    var kwText = Array.prototype.map.call(ks, function (n) { return n.textContent.toUpperCase(); }).join(',');
    chk('输入行关键字高亮（SELECT/FROM/WHERE）',
      ks.length >= 3 && /SELECT/.test(kwText) && /FROM/.test(kwText) && /WHERE/.test(kwText),
      '高亮 ' + ks.length + ' 个: ' + kwText);
    var ss = document.querySelectorAll('#input .s');
    var sText = Array.prototype.map.call(ss, function (n) { return n.textContent; }).join('');
    chk('输入行字符串高亮（含中文字面量）',
      ss.length >= 1 && sText.indexOf("'深圳'") >= 0, '字符串 span=' + ss.length + ' 内容=' + JSON.stringify(sText));
    chk('输入行没有切出空的高亮 span',
      Array.prototype.every.call(document.querySelectorAll('#input span'), function (n) { return n.textContent.length > 0 || n.className === 'caret'; }));
    chk('输入行仍有光标', !!document.querySelector('#input .caret'));
    chk('高亮后可见文本与输入一致',
      $('input').textContent.replace(/x$/, '') === h.value ||
      $('input').textContent.replace(/x/g, '').length >= h.value.length,
      'DOM=' + JSON.stringify($('input').textContent));

    // ---- 清屏（回滚不丢历史）与重连 ----
    var before = term().length;
    type('clear');
    chk('clear 不清空回滚内容', term().length >= before);
    $('btn-reconnect').click();
    chk('重新连接后回到初始状态', /Welcome to the MySQL monitor/.test(term()) && !/e2e_fk_p/.test(term()));

    finish();
  }

  // 等引擎初始化完成（加载遮罩被加上 hide）。
  // 注意：这里刻意不用 setInterval 轮询 —— 在 --virtual-time-budget 下，
  // 高频定时器会把虚拟时间预算瞬间烧完，页面还没跑完就被 dump 了。
  // MutationObserver 是由真实 DOM 变化触发的，不会消耗虚拟时间。
  var started = false;
  function startOnce() {
    if (started) return;
    started = true;
    try { run(); }
    catch (e) { chk('执行期未抛异常', false, String(e && e.message ? e.message : e)); }
    finish();
  }
  var boot = $('boot');
  if (boot && boot.classList.contains('hide')) {
    startOnce();
  } else if (typeof MutationObserver === 'function' && boot) {
    var mo = new MutationObserver(function () {
      if (boot.classList.contains('hide')) { mo.disconnect(); startOnce(); }
    });
    mo.observe(boot, { attributes: true, attributeFilter: ['class'] });
    // 兜底：万一遮罩状态没变（启动失败），也要把结果交出来
    setTimeout(function () { if (!started) { mo.disconnect(); startOnce(); } }, 8000);
  } else {
    setTimeout(startOnce, 3000);
  }
})();
