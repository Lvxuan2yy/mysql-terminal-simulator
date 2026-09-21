/* ============================================================================
 * MySQL 终端模拟器 —— 交互层
 * 终端渲染 / 键盘输入（支持中文输入法）/ 历史 / 补全 / 侧栏
 * ==========================================================================*/
(function () {
  'use strict';

  var Core = window.MySQLCore;
  var SQL = null;      // sql.js 模块
  var engine = null;
  var el = {};

  var buffer = '';            // 未结束的语句累积
  var history = [];
  var hIdx = -1;
  var draft = '';
  var exited = false;
  var DONE_KEY = 'mysqlsim.done.v2';
  var doneSet = {};
  var toastTimer = null;

  /* 终端回滚：与真实终端一致——清屏只清"当前一屏"，旧内容留在回滚缓冲里
     （向上滚动仍可回看）；只有「重新连接」才真正清空一切、恢复初始状态。 */
  var SCROLLBACK_MAX = 5000;   // 回滚缓冲上限（行），超出后丢弃最旧的行
  var clearAnchor = null;      // 清屏时插入的锚点（标记"这一屏从哪开始"）
  var activeSpacer = null;     // 撑满剩余高度的空白块，让清屏后看起来是空屏
  var clearHintShown = false;

  var KEYWORDS = ('SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DATABASE DROP ALTER ADD COLUMN ' +
    'INDEX PRIMARY KEY UNIQUE NOT NULL DEFAULT AUTO_INCREMENT ENGINE CHARSET COLLATE COMMENT SHOW DATABASES TABLES ' +
    'COLUMNS FIELDS STATUS VARIABLES ENGINES PROCESSLIST WARNINGS CHARSET COLLATION GRANTS INDEXES KEYS CREATE ' +
    'DESC DESCRIBE USE EXPLAIN JOIN LEFT RIGHT INNER OUTER FULL CROSS ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR ' +
    'LIKE IN IS BETWEEN EXISTS DISTINCT ASC UNION ALL CASE WHEN THEN ELSE END COUNT SUM AVG MIN MAX ROUND ABS ' +
    'CONCAT CONCAT_WS GROUP_CONCAT SEPARATOR IF IFNULL NULLIF NOW CURDATE CURTIME DATE_FORMAT UNIX_TIMESTAMP ' +
    'FROM_UNIXTIME CHAR_LENGTH LENGTH UPPER LOWER UCASE LCASE SUBSTRING SUBSTR LEFT RIGHT TRIM REPLACE LOCATE ' +
    'GREATEST LEAST RANK ROW_NUMBER DENSE_RANK OVER PARTITION TRUNCATE REPLACE BEGIN COMMIT ROLLBACK SAVEPOINT ' +
    'PENDING PAID SHIPPED DONE CANCELLED').split(/\s+/);

  /* ---------------- 工具 ---------------- */

  function $(sel) { return document.querySelector(sel); }

  function b64ToU8(b64) {
    var bin = atob(b64), len = bin.length, u8 = new Uint8Array(len);
    for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('on'); }, 2200);
  }


  /* ---------------- 终端输出 ---------------- */

  function line(text, cls, promptPrefix) {
    var div = document.createElement('div');
    div.className = 'line' + (cls ? ' ' + cls : '');
    if (promptPrefix && String(text).indexOf(promptPrefix) === 0) {
      var sp = document.createElement('span');
      sp.className = 'p';
      sp.textContent = promptPrefix;
      div.appendChild(sp);
      div.appendChild(document.createTextNode(String(text).slice(promptPrefix.length)));
    } else {
      div.textContent = text;
    }
    // 清屏后新输出要插在空白块「之前」，这样新内容从上往下填、空白留在下方，
    // 与真实终端清屏后的观感一致
    if (activeSpacer && activeSpacer.parentNode === el.scroll) {
      el.scroll.insertBefore(div, activeSpacer);
      adjustSpacer();
    } else {
      el.scroll.appendChild(div);
    }
    if (el.scroll.children.length > SCROLLBACK_MAX) trimScrollback();
    return div;
  }

  function write(text, cls) {
    String(text === undefined || text === null ? '' : text).split('\n').forEach(function (l) {
      var c = cls;
      if (!c || c === 'out') {
        if (/^\+[-+]+\+$/.test(l)) c = 't-border';
        else if (/^\|/.test(l)) c = 't-row';
        else if (/^(\d+ rows? in set|Empty set|Query OK|Database changed)/.test(l)) c = 't-tail';
        else c = 'out';
      }
      line(l, c);
    });
  }

  function scrollEnd() {
    el.scroll.scrollTop = el.scroll.scrollHeight;
  }

  /** 元素在滚动内容里的纵向偏移（与当前滚动位置无关） */
  function contentTop(elm) {
    var sr = el.scroll.getBoundingClientRect();
    var er = elm.getBoundingClientRect();
    return (er.top - sr.top) + el.scroll.scrollTop;
  }

  /** 让空白块始终等于"清屏后剩余的可视高度"，新内容多了它就自动收缩 */
  function adjustSpacer() {
    if (!activeSpacer || !clearAnchor) return;
    var sc = el.scroll;
    var cs = window.getComputedStyle(sc);
    var padTop = parseFloat(cs.paddingTop) || 0;
    var padBottom = parseFloat(cs.paddingBottom) || 0;
    var avail = sc.clientHeight - padTop - padBottom;
    var used = contentTop(activeSpacer) - contentTop(clearAnchor);
    var h = avail + padTop - used;
    activeSpacer.style.height = (h > 0 ? h : 0) + 'px';
  }

  /** 退役当前的锚点与空白块（彻底清空 / 重新连接时调用） */
  function retireClear() {
    if (activeSpacer && activeSpacer.parentNode) activeSpacer.parentNode.removeChild(activeSpacer);
    if (clearAnchor && clearAnchor.parentNode) clearAnchor.parentNode.removeChild(clearAnchor);
    activeSpacer = null;
    clearAnchor = null;
  }

  /** 回滚缓冲超限：从最旧的开始丢，但不越过清屏锚点 */
  function trimScrollback() {
    var sc = el.scroll;
    var over = sc.children.length - SCROLLBACK_MAX;
    for (var i = 0; i < over; i++) {
      var c = sc.firstElementChild;
      if (!c || c === clearAnchor || c === activeSpacer) return;
      sc.removeChild(c);
    }
  }

  /**
   * 清屏（clear / Ctrl+L）：和真实终端一样只清"当前一屏"——
   * 在当前位置插一个空白块把旧内容顶上去，旧内容仍在 DOM 里，
   * 鼠标滚轮向上滚就能看到以前的命令。只有 reconnect() 才真清空。
   */
  function clearScreen() {
    var sc = el.scroll;
    var cs = window.getComputedStyle(sc);
    var padTop = parseFloat(cs.paddingTop) || 0;
    var padBottom = parseFloat(cs.paddingBottom) || 0;
    var avail = sc.clientHeight - padTop - padBottom;

    retireClear();

    clearAnchor = document.createElement('div');
    clearAnchor.className = 'clr-anchor';
    sc.appendChild(clearAnchor);

    activeSpacer = document.createElement('div');
    activeSpacer.className = 'clr-spacer';
    activeSpacer.style.height = Math.max(0, avail + padTop) + 'px';
    sc.appendChild(activeSpacer);

    trimScrollback();
    scrollEnd();

    if (!clearHintShown) {
      clearHintShown = true;
      toast('已清屏：向上滚动仍可回看历史；点「重新连接」才会彻底清空');
    }
  }

  /** 彻底清空终端内容（仅「重新连接」使用） */
  function resetScreen() {
    retireClear();
    el.scroll.innerHTML = '';
  }

  /* ---------------- 输入区 ---------------- */

  function currentPrompt() { return buffer ? '    -> ' : 'mysql> '; }

  function refreshPrompt() { el.prompt.textContent = currentPrompt(); }

  function renderInput() {
    var v = el.hidden.value;
    var pos = (el.hidden.selectionStart === null || el.hidden.selectionStart === undefined)
      ? v.length : el.hidden.selectionStart;
    el.input.textContent = '';
    el.input.appendChild(document.createTextNode(v.slice(0, pos)));
    var c = document.createElement('span');
    c.className = 'caret';
    c.textContent = 'x';
    el.input.appendChild(c);
    el.input.appendChild(document.createTextNode(v.slice(pos)));
  }

  function setInput(v) {
    el.hidden.value = v;
    try { el.hidden.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ }
    renderInput();
  }

  function focusInput() {
    if (exited) return;
    el.hidden.focus({ preventScroll: true });
  }

  function isTerminated(t) {
    return /;\s*$/.test(t) || /\\[gG]\s*$/.test(t);
  }

  /* ---------------- 执行 ---------------- */

  function showBanner() {
    engine.banner().split('\n').forEach(function (l) {
      if (/^(提示：|      )/.test(l)) line(l, 'note');
      else line(l, 'out');
    });
  }

  function startEngine() {
    engine = new Core.Engine(SQL, Core.seedAll);
    engine.init();
  }

  function runStatements(text) {
    var blocks;
    engine.counter++;
    try {
      blocks = engine.run(text);
    } catch (e) {
      write('ERROR 1105 (HY000): ' + (e && e.message ? e.message : String(e)), 'err');
      scrollEnd();
      return;
    }
    blocks.forEach(function (b) {
      if (b.kind === 'clear') { clearScreen(); return; }
      if (b.kind === 'exit') { doExit(); return; }
      write(b.text, b.kind === 'err' ? 'err' : (b.kind === 'note' ? 'note' : 'out'));
    });
    markDone(text);
    refreshSidebar();
    scrollEnd();
  }

  /** 直接由界面触发的语句（侧栏点击等），带命令行回显 */
  function send(sql) {
    if (exited) { toast('连接已关闭，请先点右上角「重新连接」'); return; }
    line('mysql> ' + sql, 'typed', 'mysql> ');
    buffer = '';
    refreshPrompt();
    runStatements(sql);
  }

  function submit() {
    if (exited) return;
    var v = el.hidden.value;
    var promptText = currentPrompt();
    line(promptText + v, 'typed', promptText);
    el.hidden.value = '';
    if (v.trim()) { history.push(v); hIdx = -1; }
    buffer += (buffer ? '\n' : '') + v;
    var t = buffer.trim();
    if (!t) { buffer = ''; refreshPrompt(); renderInput(); scrollEnd(); return; }
    if (!isTerminated(t)) { refreshPrompt(); renderInput(); scrollEnd(); return; }
    buffer = '';
    refreshPrompt();
    renderInput();
    runStatements(t);
  }

  function cancelInput() {
    var promptText = currentPrompt();
    line(promptText + el.hidden.value + '^C', 'note', promptText);
    el.hidden.value = '';
    buffer = '';
    refreshPrompt();
    renderInput();
    scrollEnd();
  }

  function doExit() {
    exited = true;
    el.term.classList.remove('focused');
    el.conn.classList.add('dead');
    el.connText.textContent = '连接已关闭';
    line('（已断开。点右上角「重新连接」或按 Ctrl+R 恢复会话）', 'note');
    scrollEnd();
  }

  function reconnect() {
    exited = false;
    buffer = '';
    el.hidden.value = '';
    // 重新连接 = 全新的会话：屏幕、↑↓ 命令历史一起回到初始状态
    history = [];
    hIdx = -1;
    draft = '';
    startEngine();
    resetScreen();
    showBanner();
    refreshPrompt();
    renderInput();
    refreshSidebar();
    el.conn.classList.remove('dead');
    el.connText.textContent = 'root@localhost:3306';
    focusInput();
    scrollEnd();
    toast('已重新连接（示例数据已恢复到初始状态）');
  }

  /* ---------------- 历史与补全 ---------------- */

  function histPrev() {
    if (!history.length) return;
    if (hIdx === -1) { draft = el.hidden.value; hIdx = history.length; }
    hIdx = Math.max(0, hIdx - 1);
    setInput(history[hIdx]);
  }

  function histNext() {
    if (hIdx === -1) return;
    hIdx++;
    if (hIdx >= history.length) { hIdx = -1; setInput(draft); return; }
    setInput(history[hIdx]);
  }

  function complete() {
    var v = el.hidden.value;
    var pos = (el.hidden.selectionStart === null || el.hidden.selectionStart === undefined)
      ? v.length : el.hidden.selectionStart;
    var m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(v.slice(0, pos));
    if (!m) return;
    var word = m[1], start = pos - word.length, lower = word.toLowerCase();

    var pool = KEYWORDS.slice();
    if (engine) pool = pool.concat(engine.tableNames());
    var seen = {}, uniq = [];
    pool.forEach(function (k) {
      if (k.toLowerCase().indexOf(lower) !== 0) return;
      if (seen[k.toLowerCase()]) return;
      seen[k.toLowerCase()] = 1;
      uniq.push(k);
    });
    if (!uniq.length) return;

    var fill;
    if (uniq.length === 1) {
      fill = uniq[0];
    } else {
      fill = uniq[0];
      uniq.forEach(function (h) {
        while (fill && h.toLowerCase().indexOf(fill.toLowerCase()) !== 0) fill = fill.slice(0, -1);
      });
      if (!fill || fill.length <= word.length) {
        line('mysql> ' + v, 'typed', 'mysql> ');
        for (var i = 0; i < uniq.length; i += 8) {
          line('    ' + uniq.slice(i, i + 8).join('  '), 'note');
        }
        scrollEnd();
        return;
      }
    }
    el.hidden.value = v.slice(0, start) + fill + v.slice(pos);
    try { el.hidden.setSelectionRange(start + fill.length, start + fill.length); } catch (e) { /* ignore */ }
    renderInput();
  }

  /* ---------------- 练习题完成度 ---------------- */

  function loadDone() {
    try {
      var raw = localStorage.getItem(DONE_KEY);
      doneSet = raw ? JSON.parse(raw) : {};
    } catch (e) { doneSet = {}; }
  }

  function saveDone() {
    try { localStorage.setItem(DONE_KEY, JSON.stringify(doneSet)); } catch (e) { /* ignore */ }
  }

  /** 练习完成度：判定逻辑在核心层（Core.matchExercises），此处只负责记账与提示 */
  function markDone(text) {
    var hits;
    try { hits = Core.matchExercises(text); } catch (e) { return; }
    if (!hits.length) return;
    var changed = false;
    hits.forEach(function (i) {
      if (!doneSet[i]) { doneSet[i] = 1; changed = true; }
    });
    if (changed) {
      saveDone();
      renderExercises();
      var total = Core.EXERCISES.length;
      var cnt = Object.keys(doneSet).length;
      if (cnt === total) toast('🎉 全部 ' + total + ' 道练习已通关！');
      else toast('练习进度 ' + cnt + ' / ' + total);
    }
  }

  /* ---------------- 侧栏 ---------------- */

  function refreshSidebar() {
    if (!engine) return;
    renderDbList();
    renderTableList();
  }

  function renderDbList() {
    var names = engine.databaseNames().sort();
    el.dblist.innerHTML = '';
    names.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'dbrow' + (n === engine.current ? ' cur' : '');
      var g = document.createElement('span'); g.className = 'glyph'; g.textContent = n === engine.current ? '▸' : '·';
      var t = document.createElement('span'); t.className = 'n'; t.textContent = n;
      row.appendChild(g); row.appendChild(t);
      if (Core.SYSTEM_DATABASES.indexOf(n) > -1) {
        var b = document.createElement('span'); b.className = 'badge'; b.textContent = '系统';
        row.appendChild(b);
      }
      row.title = '点击切换到 ' + n;
      row.onclick = function () { send('USE `' + n + '`;'); };
      el.dblist.appendChild(row);
    });
  }

  function renderTableList() {
    var db = engine.current;
    var objs = engine.objectList ? engine.objectList(db)
      : engine.tableNames(db).map(function (n) { return { name: n, isView: false }; });
    el.tbltitle.textContent = db + ' 中的表与视图';
    el.tbllist.innerHTML = '';
    if (!objs.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '（无表）';
      el.tbllist.appendChild(e);
      return;
    }
    objs.forEach(function (o) {
      var n = o.name;
      var meta = engine.meta(n, db);
      var row = document.createElement('div');
      row.className = 'tblrow' + (o.isView ? ' isview' : '');
      var g = document.createElement('span'); g.className = 'glyph'; g.textContent = o.isView ? '◇' : '▤';
      var t = document.createElement('span'); t.textContent = n;
      row.appendChild(g); row.appendChild(t);
      var c = document.createElement('span');
      c.className = 'cols' + (o.isView ? ' vw' : '');
      c.textContent = o.isView ? '视图' + (meta ? ' · ' + meta.columns.length + ' 列' : '')
        : (meta ? meta.columns.length + ' 列' : '');
      row.appendChild(c);
      row.title = o.isView ? ('视图 ' + n + '：点一下填入查询语句') : ('表 ' + n + '：点一下填入查询语句');
      row.onclick = function () {
        setInput('SELECT * FROM `' + n + '` LIMIT 20;');
        focusInput();
        toast('已填入查询，按 Enter 执行');
      };
      el.tbllist.appendChild(row);
    });
  }

  function renderExercises() {
    var box = el.ex;
    box.innerHTML = '';
    var lvNames = { 1: '基础', 2: '进阶', 3: '挑战' };
    var lastLv = 0;
    Core.EXERCISES.forEach(function (ex, i) {
      if (ex.level !== lastLv) {
        lastLv = ex.level;
        var cnt = Core.EXERCISES.filter(function (x) { return x.level === ex.level; }).length;
        var done = Core.EXERCISES.filter(function (x) { return x.level === ex.level && doneSet[Core.EXERCISES.indexOf(x)]; }).length;
        var h = document.createElement('div');
        h.className = 'exlv';
        var lv = document.createElement('span');
        lv.className = 'lv lv' + ex.level;
        lv.textContent = 'L' + ex.level + ' ' + lvNames[ex.level];
        var c = document.createElement('span');
        c.className = 'cnt';
        c.textContent = done + ' / ' + cnt;
        h.appendChild(lv); h.appendChild(c);
        box.appendChild(h);
      }

      var card = document.createElement('div');
      card.className = 'ex' + (doneSet[i] ? ' done' : '');

      var head = document.createElement('div');
      head.className = 'ex-head';
      var title = document.createElement('span');
      title.className = 'ex-title';
      title.textContent = (i + 1) + '. ' + ex.title;
      head.appendChild(title);
      if (doneSet[i]) {
        var chk = document.createElement('span');
        chk.className = 'chk';
        chk.textContent = '✓';
        head.appendChild(chk);
      }
      card.appendChild(head);

      var p = document.createElement('div');
      p.className = 'ex-prompt';
      p.textContent = ex.prompt;
      card.appendChild(p);

      var row = document.createElement('div');
      row.className = 'ex-row';

      var hint = document.createElement('div');
      hint.className = 'ex-hint';
      hint.textContent = '提示：' + ex.hint;
      var ans = document.createElement('div');
      ans.className = 'ex-ans';

      var bHint = document.createElement('button');
      bHint.className = 'mini';
      bHint.textContent = '提示';
      bHint.onclick = function () { hint.classList.toggle('on'); };

      var bAns = document.createElement('button');
      bAns.className = 'mini';
      bAns.textContent = '答案';
      bAns.onclick = function () {
        if (!ans.innerHTML) {
          var pre = document.createElement('div');
          pre.textContent = ex.answer;
          ans.appendChild(pre);
          var fill = document.createElement('span');
          fill.className = 'fill';
          fill.textContent = '▸ 填入输入框';
          fill.onclick = function () {
            var one = ex.answer.split('\n').filter(function (l) { return l.trim() && l.trim().indexOf('--') !== 0; }).join(' ');
            setInput(one);
            focusInput();
            toast('已填入，按 Enter 执行');
          };
          ans.appendChild(fill);
        }
        ans.classList.toggle('on');
      };

      row.appendChild(bHint);
      row.appendChild(bAns);
      card.appendChild(row);
      card.appendChild(hint);
      card.appendChild(ans);
      box.appendChild(card);
    });
  }

  function renderDifferences() {
    var box = el.diff;
    box.innerHTML = '';
    var intro = document.createElement('div');
    intro.className = 'pane-note';
    intro.textContent = '本模拟器在浏览器内嵌 SQLite 引擎之上做了一层 MySQL 方言兼容层：凡是被转译的语法，使用方式与真实 MySQL 一致；' +
      '下面列出的是「确实和真实 MySQL 不一样」的地方。学习和写作业够用，生产环境判断仍请以真实 MySQL 为准。';
    box.appendChild(intro);
    Core.DIFFERENCES.forEach(function (g) {
      var d = document.createElement('div');
      d.className = 'dgrp';
      var h = document.createElement('h4');
      h.textContent = g.group;
      d.appendChild(h);
      var ul = document.createElement('ul');
      g.items.forEach(function (it) {
        var li = document.createElement('li');
        li.textContent = it;
        ul.appendChild(li);
      });
      d.appendChild(ul);
      box.appendChild(d);
    });
  }

  function renderHelp() {
    el.help.textContent = Core.HELP_TEXT;
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    el.hidden.addEventListener('input', renderInput);
    el.hidden.addEventListener('click', renderInput);
    el.hidden.addEventListener('keyup', renderInput);
    el.hidden.addEventListener('focus', function () { el.term.classList.add('focused'); });
    el.hidden.addEventListener('blur', function () { el.term.classList.remove('focused'); });

    el.hidden.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;

      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); histPrev(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); histNext(); return; }
      if (e.key === 'Tab') { e.preventDefault(); complete(); return; }

      if (e.ctrlKey && !e.altKey) {
        var k = e.key.toLowerCase();
        if (k === 'c') { e.preventDefault(); cancelInput(); return; }
        if (k === 'l') { e.preventDefault(); clearScreen(); return; }
        if (k === 'd') { e.preventDefault(); if (!el.hidden.value && !buffer) doExit(); return; }
        if (k === 'r') { e.preventDefault(); reconnect(); return; }
      }
    });

    // 点击终端任意处即聚焦输入框；但用户正在框选文本时不抢焦点
    function maybeFocus() {
      var sel = window.getSelection();
      if (sel && String(sel).length) return;
      focusInput();
    }
    el.term.addEventListener('mouseup', maybeFocus);
    $('.term-head').addEventListener('mousedown', function (e) {
      e.preventDefault();
      focusInput();
    });
    el.inputwrap.addEventListener('mousedown', function (e) { e.preventDefault(); focusInput(); });

    document.querySelectorAll('.tab').forEach(function (t) {
      t.onclick = function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('on'); });
        document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        var p = document.getElementById('panel-' + t.dataset.panel);
        if (p) p.classList.add('on');
      };
    });

    $('#btn-reconnect').onclick = reconnect;
    $('#btn-clear').onclick = function () { clearScreen(); focusInput(); };
    $('#btn-side').onclick = function () {
      el.side.classList.toggle('hide');
      this.classList.toggle('on', !el.side.classList.contains('hide'));
    };
    $('#btn-help').onclick = function () {
      document.querySelector('.tab[data-panel="help"]').click();
      el.side.classList.remove('hide');
      $('#btn-side').classList.add('on');
    };
    $('#btn-about').onclick = function () {
      line('', 'out');
      line('MySQL 终端模拟器 · 单文件离线版', 'sys');
      line('  引擎：SQLite 3.49 (WebAssembly)，运行于浏览器内，全程不联网、不上传任何数据', 'note');
      line('  兼容层：MySQL 8.0 方言转译 + SHOW/DESC 元数据 + MySQL 风格错误码与表格排版', 'note');
      line('  便携：整个工具就是这一个 HTML 文件（约 1 MB），拷到任何电脑双击即可运行，', 'note');
      line('        不需要安装、不需要联网、不写注册表；发给别人也是直接发这一个文件。', 'note');
      line('  环境：需要 2017 年以后发布的浏览器（Chrome / Edge / Firefox / Safari）。', 'note');
      line('        若用 360、QQ 等双核浏览器，请切到「极速模式」。', 'note');
      line('  数据：仅存在当前浏览器内存里，关掉标签页即消失；唯一的本地记录是', 'note');
      line('        「练习题完成进度」（localStorage，7 字节左右，清空浏览器数据即清除）。', 'note');
      line('  终端：清屏（clear / Ctrl+L）和真实终端一样只清「当前一屏」，旧内容留在回滚', 'note');
      line('        缓冲里，向上滚动即可回看；要彻底清空、恢复初始数据，请点右上角「重新连接」', 'note');
      line('        （Ctrl+R）——它会重建数据库、清空屏幕与 ↑↓ 命令历史。', 'note');
      line('  声明：本项目为学习用途的仿真工具，与 Oracle / MySQL 官方无关。', 'note');
      line('  未实现项见右侧「差异」面板。', 'note');
      scrollEnd();
    };

    window.addEventListener('resize', function () { /* 保持滚动位置 */ });
  }

  /* ---------------- 启动 ---------------- */

  function hideBoot() { el.boot.classList.add('hide'); }

  function showBootError(msg, friendly) {
    window.__BOOT_SETTLED = true;   // 告诉最前面的自检守卫：已经有结论，别再来覆盖
    el.boot.classList.add('err');
    el.boot.innerHTML = '';
    var h = document.createElement('div');
    h.textContent = friendly ? '⚠️ 当前浏览器无法运行本工具' : '⚠️ 引擎初始化失败';
    var p = document.createElement('div');
    p.style.maxWidth = '620px';
    p.style.textAlign = 'center';
    p.style.lineHeight = '1.8';
    if (friendly) {
      p.textContent = msg;
    } else {
      p.textContent = msg + '　请确认浏览器已启用 WebAssembly，并尝试用 Chrome / Edge / Firefox 打开本文件。';
    }
    el.boot.appendChild(h); el.boot.appendChild(p);
  }

  /** 环境能力检测：把底层报错换成用户看得懂的话（换电脑/老内核时最常见） */
  function envProblem() {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
      return '检测到本机浏览器不支持 WebAssembly，无法运行内置的 SQL 引擎。\n\n'
        + '请改用 Chrome、Edge、Firefox，或 2017 年以后版本的新版 Safari；\n'
        + '如果你用的是 360、QQ、搜狗等双核浏览器，'
        + '请把地址栏右侧的内核开关切到「极速模式」后刷新。';
    }
    if (typeof Uint8Array !== 'function' || typeof JSON !== 'object') {
      return '本机浏览器版本过旧，缺少必要的基础能力。请改用 Chrome / Edge / Firefox 打开。';
    }
    return null;
  }

  function boot() {
    el.boot = $('#boot');
    el.scroll = $('#scroll');
    el.term = $('#term');
    el.input = $('#input');
    el.inputwrap = $('#inputline');
    el.prompt = $('#prompt');
    el.hidden = $('#hidden');
    el.toast = $('#toast');
    el.side = $('#side');
    el.dblist = $('#dblist');
    el.tbllist = $('#tbllist');
    el.tbltitle = $('#tbltitle');
    el.ex = $('#ex-list');
    el.diff = $('#diff');
    el.help = $('#help');
    el.conn = $('#conn');
    el.connText = $('#connText');

    loadDone();
    renderDifferences();
    renderHelp();
    renderExercises();
    bind();

    window.addEventListener('error', function (ev) {
      if (!SQL) showBootError('脚本错误：' + (ev.message || '未知'));
    });

    try {
      var env = envProblem();
      if (env) { showBootError(env, true); return; }
      if (typeof window.initSqlJs !== 'function') throw new Error('未找到 sql.js 引擎脚本（window.initSqlJs 缺失）。');
      if (!window.__SQLJS_WASM_B64) throw new Error('未找到内嵌的引擎二进制数据。');
    } catch (e) { showBootError(e.message); return; }

    window.initSqlJs({ wasmBinary: b64ToU8(window.__SQLJS_WASM_B64) })
      .then(function (mod) {
        SQL = mod;
        startEngine();
        window.__BOOT_SETTLED = true;   // 声明启动流程已完成，自检守卫不再介入
        hideBoot();
        showBanner();
        refreshPrompt();
        renderInput();
        refreshSidebar();
        focusInput();
        scrollEnd();
      })
      .catch(function (e) {
        var m = (e && e.message) || String(e);
        if (/instantiate|wasm|magic|unexpected|compil|table index/i.test(m)) {
          showBootError('内置引擎无法启动（' + m + '）。\n\n'
            + '如果这个文件是从别处复制或传输过来的，可能已损坏或被截断，'
            + '请重新获取一份完整的 HTML（正常大小约 1 MB）后重试。', true);
        } else {
          showBootError(m);
        }
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
