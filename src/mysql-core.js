/* ============================================================================
 * MySQLCore —— MySQL 终端仿真核心层
 * 无 DOM 依赖，可在浏览器与 Node 中运行，便于回归测试。
 * 职责：语句切分 / MySQL→SQLite 方言转译 / 建表元数据解析 / 结果集排版 /
 *      错误码映射 / 数据库注册表 / 命令分发（含 SHOW、DESC、USE 等）
 * ==========================================================================*/
var MySQLCore = (function () {
  'use strict';

  /* ======================= 0. 常量 ======================= */

  var SERVER_VERSION = '8.0.36-sim';
  var SERVER_VERSION_FULL = '8.0.36-mysql-sim';
  var CONNECTION_ID = 8;
  var SOCKET = '/var/run/mysqld/mysqld.sock';
  var CURRENT_USER = 'root@localhost';

  var SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'];

  /* ======================= 1. 文本宽度与对齐 ======================= */

  function cpWidth(cp) {
    if (cp === 0x200b || cp === 0xfeff) return 0;
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff)) return 0; // 组合符号
    if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2;
    return 1;
  }

  function dispWidth(str) {
    if (str === null || str === undefined) str = '';
    var s = String(str), w = 0, i;
    for (i = 0; i < s.length; i++) {
      var cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      w += cpWidth(cp);
    }
    return w;
  }

  function padRight(str, w) {
    var gap = w - dispWidth(str);
    return gap > 0 ? str + new Array(gap + 1).join(' ') : str;
  }

  function padLeft(str, w) {
    var gap = w - dispWidth(str);
    return gap > 0 ? new Array(gap + 1).join(' ') + str : str;
  }

  /* ======================= 2. 语句切分 ======================= */

  /**
   * 把一段输入切成多条语句。正确处理：单/双引号、反引号、-- 与 # 行注释、
   * 块注释、引号内转义与 '' 双写。\G 结尾标记为纵向输出。
   * @returns {Array<{sql:string, vertical:boolean, raw:string}>}
   */
  function splitStatements(input) {
    var out = [];
    var buf = '';
    var i = 0, n = input.length;
    var state = 'n'; // n 普通 / s 单引号 / d 双引号 / b 反引号 / l 行注释 / c 块注释
    var vertical = false;
    var routineBody = false;   // 存储过程/函数/触发器体内的分号不切句

    function flush() {
      var s = buf.trim();
      if (s) out.push({ sql: s, vertical: vertical, raw: s });
      buf = '';
      vertical = false;
      routineBody = false;
    }

    while (i < n) {
      var ch = input[i];
      var next = input[i + 1];

      if (state === 'l') {
        if (ch === '\n') state = 'n';
        i++;
        continue;
      }
      if (state === 'c') {
        if (ch === '*' && next === '/') { state = 'n'; i += 2; continue; }
        i++;
        continue;
      }
      if (state === 's' || state === 'd' || state === 'b') {
        var quote = state === 's' ? "'" : state === 'd' ? '"' : '`';
        buf += ch;
        if (ch === '\\' && state !== 'b' && i + 1 < n) { buf += input[i + 1]; i += 2; continue; }
        if (ch === quote) {
          if (next === quote) { buf += next; i += 2; continue; } // '' 双写
          state = 'n';
        }
        i++;
        continue;
      }

      // state === 'n'
      if (ch === "'") { state = 's'; buf += ch; i++; continue; }
      if (ch === '"') { state = 'd'; buf += ch; i++; continue; }
      if (ch === '`') { state = 'b'; buf += ch; i++; continue; }
      if (ch === '-' && next === '-' && (input[i + 2] === undefined || /\s/.test(input[i + 2]))) {
        state = 'l'; i += 2; continue;
      }
      if (ch === '#') { state = 'l'; i++; continue; }
      if (ch === '/' && next === '*') { state = 'c'; i += 2; continue; }
      if (ch === '\\' && (next === 'G' || next === 'g')) { vertical = next === 'G'; flush(); i += 2; continue; }
      if (ch === ';') {
        // 例程体（CREATE PROCEDURE/FUNCTION/TRIGGER ... BEGIN ... END）内的分号不算语句结束
        if (routineBody && !/\bEND\s*$/i.test(buf)) { buf += ch; i++; continue; }
        flush(); i++; continue;
      }
      buf += ch;
      i++;
      if (!routineBody && /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(buf)
        && /\bBEGIN\b/i.test(buf)) {
        routineBody = true;
      }
    }
    flush();
    return out;
  }

  /* ======================= 3. 建表语句解析（元数据 catalog） ======================= */

  function stripQuotes(s) {
    s = String(s).trim();
    if (s.length >= 2) {
      var a = s[0], b = s[s.length - 1];
      if ((a === "'" && b === "'") || (a === '"' && b === '"') || (a === '`' && b === '`')) {
        return s.slice(1, -1).split(a + a).join(a);
      }
    }
    return s;
  }

  /** 按顶层逗号拆分（忽略括号与引号内的逗号） */
  function splitTopLevel(body) {
    var parts = [], buf = '', depth = 0, i = 0;
    var state = 'n';
    while (i < body.length) {
      var ch = body[i];
      if (state !== 'n') {
        buf += ch;
        var q = state === 's' ? "'" : state === 'd' ? '"' : '`';
        if (ch === '\\' && state !== 'b') { buf += body[i + 1] || ''; i += 2; continue; }
        if (ch === q) {
          if (body[i + 1] === q) { buf += q; i += 2; continue; }
          state = 'n';
        }
        i++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { state = ch === "'" ? 's' : ch === '"' ? 'd' : 'b'; buf += ch; i++; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; i++; continue; }
      buf += ch;
      i++;
    }
    if (buf.trim()) parts.push(buf);
    return parts;
  }

  /** 取最外层括号内的内容，要求括号紧跟在 head 之后 */
  function extractParenBody(sql) {
    var start = sql.indexOf('(');
    if (start < 0) return null;
    var depth = 0, i = start, state = 'n';
    for (; i < sql.length; i++) {
      var ch = sql[i];
      if (state !== 'n') {
        var q = state === 's' ? "'" : state === 'd' ? '"' : '`';
        if (ch === '\\' && state !== 'b') { i++; continue; }
        if (ch === q) { if (sql[i + 1] === q) { i++; continue; } state = 'n'; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { state = ch === "'" ? 's' : ch === '"' ? 'd' : 'b'; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return { body: sql.slice(start + 1, i), head: sql.slice(0, start), tail: sql.slice(i + 1) }; }
    }
    return null;
  }

  function parseType(tokens) {
    // 列类型：单词 + 可选 (长度/枚举) + 可选多词后缀 + 可选 unsigned/zerofill
    var m = /^([A-Za-z][A-Za-z0-9_]*)\s*(\(((?:[^()']|'(?:[^']|'')*')*)\))?/.exec(tokens);
    if (!m) return { type: '', rest: tokens };
    var base = m[1];
    var rest = tokens.slice(m[0].length);
    var multi = /^\s+(PRECISION|VARYING|NATIONAL|LARGE\s+OBJECT)\b/i.exec(rest);
    if (multi) { base += ' ' + multi[1].replace(/\s+/g, ' '); rest = rest.slice(multi[0].length); }
    var suffix = '';
    if (/\bUNSIGNED\b/i.test(rest)) suffix += ' unsigned';
    if (/\bZEROFILL\b/i.test(rest)) suffix += ' zerofill';
    return { type: base + (m[3] !== undefined ? '(' + m[3] + ')' : '') + suffix, rest: rest };
  }

  /**
   * 解析 MySQL 原始 CREATE TABLE 语句，产出 DESC / SHOW CREATE TABLE / SHOW INDEX
   * 所需的结构化元数据。解析失败时返回 null，调用方回退到 PRAGMA。
   */
  function parseCreateTable(sql) {
    var ex = extractParenBody(sql);
    if (!ex) return null;
    var head = ex.head;
    var nameMatch = /(?:`([^`]+)`|([A-Za-z0-9_$]+))\s*$/.exec(head.replace(/\s+$/, ''));
    if (!nameMatch) return null;
    var name = nameMatch[1] || nameMatch[2];
    if (/^(TEMPORARY\s+)?TABLE$/i.test(name)) return null;

    var columns = [], indexes = [], foreignKeys = [];
    var parts = splitTopLevel(ex.body);
    var pendingPk = null;

    parts.forEach(function (raw) {
      var def = raw.trim();
      if (!def) return;
      var up = def.toUpperCase();

      if (/^PRIMARY\s+KEY\b/.test(up)) {
        var cm = /\(([\s\S]*)\)\s*$/.exec(def);
        if (cm) {
          pendingPk = splitTopLevel(cm[1]).map(function (c) { return stripQuotes(c.trim()); });
          indexes.push({ name: 'PRIMARY', unique: true, primary: true, columns: pendingPk });
        }
        return;
      }
      var uk = /^UNIQUE\s*(?:KEY|INDEX)?\s*(?:`([^`]+)`|([A-Za-z0-9_$]+))?\s*\(([\s\S]*)\)\s*$/.exec(def);
      if (uk) {
        indexes.push({
          name: uk[1] || uk[2] || ('uk_' + (uk[3] || '').replace(/[^A-Za-z0-9_]/g, '')),
          unique: true, primary: false,
          columns: splitTopLevel(uk[3]).map(function (c) { return stripQuotes(c.trim().replace(/\s*\(\d+\)\s*$/, '')); })
        });
        return;
      }
      var kk = /^(?:KEY|INDEX)\s+(?:`([^`]+)`|([A-Za-z0-9_$]+))?\s*(?:USING\s+\w+\s*)?\(([\s\S]*)\)\s*$/.exec(def);
      if (kk) {
        indexes.push({
          name: kk[1] || kk[2] || '', unique: false, primary: false,
          columns: splitTopLevel(kk[3]).map(function (c) { return stripQuotes(c.trim().replace(/\s*\(\d+\)\s*$/, '')); })
        });
        return;
      }
      if (/^CONSTRAINT\b/.test(up) && /FOREIGN\s+KEY/i.test(def)) {
        var fm = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+`?([A-Za-z0-9_$]+)`?\s*\(([^)]*)\)/i.exec(def);
        if (fm) foreignKeys.push({ columns: splitTopLevel(fm[1]).map(function (c) { return stripQuotes(c.trim()); }), refTable: fm[2], refColumns: splitTopLevel(fm[3]).map(function (c) { return stripQuotes(c.trim()); }) });
        return;
      }
      if (/^(?:FULLTEXT|SPATIAL|CHECK)\b/.test(up)) return;

      // 列定义
      var colM = /^(?:`([^`]+)`|([A-Za-z0-9_$]+))\s+([\s\S]+)$/.exec(def);
      if (!colM) return;
      var field = colM[1] || colM[2];
      var tp = parseType(colM[3]);
      var rest = tp.rest;
      var notNull = /\bNOT\s+NULL\b/i.test(rest);
      var explicitNull = /\bNULL\b/i.test(rest.replace(/\bNOT\s+NULL\b/gi, ''));
      var autoInc = /\bAUTO_INCREMENT\b/i.test(rest);
      var inlinePk = /\bPRIMARY\s+KEY\b/i.test(rest);
      var inlineUniq = /\bUNIQUE\b/i.test(rest);
      var dflt = null, hasDefault = false;
      var dm = /\bDEFAULT\s+('(?:[^']|'')*'|"(?:[^"]|"")*"|\([^()]*\)|[A-Za-z0-9_.+-]+(?:\s+[A-Za-z_]+)*?)(?=\s+(?:NOT\s+NULL|NULL|AUTO_INCREMENT|COMMENT|ON\s+UPDATE|PRIMARY|UNIQUE)\b|$)/i.exec(rest);
      if (dm) { hasDefault = true; dflt = stripQuotes(dm[1].trim()); }
      if (!hasDefault && /\bDEFAULT\s+CURRENT_TIMESTAMP(?:\(\d*\))?/i.test(rest)) { hasDefault = true; dflt = 'CURRENT_TIMESTAMP'; }
      var cm2 = /\bCOMMENT\s+('(?:[^']|'')*')/i.exec(rest);
      var comment = cm2 ? stripQuotes(cm2[1]) : '';
      var extra = '';
      if (autoInc) extra = 'auto_increment';
      if (hasDefault && /CURRENT_TIMESTAMP/i.test(String(dflt))) {
        extra = (extra ? extra + ' ' : '') + 'DEFAULT_GENERATED' + (/ON\s+UPDATE\s+CURRENT_TIMESTAMP/i.test(rest) ? ' on update CURRENT_TIMESTAMP' : '');
      }
      columns.push({
        field: field, type: tp.type || 'text',
        nullable: !notNull && !inlinePk,
        key: inlinePk ? 'PRI' : (inlineUniq ? 'UNI' : ''),
        defaultValue: hasDefault ? dflt : null,
        hasDefault: hasDefault, extra: extra, comment: comment
      });
    });

    // 回填表级主键 / 唯一键的 Key 标记
    if (pendingPk) {
      pendingPk.forEach(function (pc, idx) {
        columns.forEach(function (c) {
          if (c.field === pc && !c.key) c.key = idx === 0 ? 'PRI' : 'PRI';
          if (c.field === pc) c.nullable = false;
        });
      });
    }
    indexes.forEach(function (ix) {
      if (ix.primary) return;
      (ix.columns || []).forEach(function (cn, i) {
        columns.forEach(function (c) {
          if (c.field === cn && !c.key) c.key = ix.unique ? 'UNI' : (i === 0 ? 'MUL' : '');
        });
      });
    });

    // 表级 AUTO_INCREMENT = N（只在表选项里出现，列定义里的 AUTO_INCREMENT 没有等号）
    var aiM = /\bAUTO_INCREMENT\s*=\s*(\d+)/i.exec(sql);
    return {
      name: name, columns: columns, indexes: indexes, foreignKeys: foreignKeys,
      autoIncrementNext: aiM ? Number(aiM[1]) : null,
      raw: sql.replace(/\s*\n\s*/g, '\n').trim()
    };
  }

  /* ======================= 4. MySQL → SQLite 方言转译 ======================= */

  var INT_TYPES = '(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)';

  function translateCreateTable(sql) {
    var s = sql;

    // 4.1 去掉表选项尾巴（最后一个 ) 之后的 ENGINE=/CHARSET= 等）
    var lastParen = s.lastIndexOf(')');
    if (lastParen > -1) {
      var tail = s.slice(lastParen + 1);
      if (/^\s*(ENGINE|DEFAULT\s+CHARSET|CHARSET|COLLATE|COMMENT|AUTO_INCREMENT|ROW_FORMAT|AVG_ROW_LENGTH|KEY_BLOCK_SIZE|PACK_KEYS|STATS_|TABLESPACE|PARTITION)\b/i.test(tail)) {
        s = s.slice(0, lastParen + 1);
      }
    }

    // 4.2 索引定义：MySQL 的 KEY/INDEX 在 SQLite 里非法
    //     注意 `PRIMARY KEY (a,b)` 保留原样，不能被下面的 KEY 规则吞掉
    s = s.replace(/\b(?:FULLTEXT|SPATIAL)\s+(?:KEY|INDEX)\s+(?:`[^`]+`|[A-Za-z0-9_$]+)?\s*\([^)]*\)/gi,
      function (m, off, full) { return /\b(?:PRIMARY|UNIQUE|FOREIGN)\s*$/i.test(full.slice(0, off)) ? m : ''; });
    s = s.replace(/\b(?:KEY|INDEX)\s+(?:`[^`]+`|[A-Za-z0-9_$]+)?\s*(?:USING\s+\w+\s*)?\([^)]*\)/gi,
      function (m, off, full) { return /\b(?:PRIMARY|UNIQUE|FOREIGN)\s*$/i.test(full.slice(0, off)) ? m : ''; });
    // UNIQUE KEY 名称 (列) → UNIQUE (列)；UNIQUE INDEX 同理
    s = s.replace(/\bUNIQUE\s+(?:KEY|INDEX)\s+(?:`[^`]+`|[A-Za-z0-9_$]+)?\s*(\([^)]*\))/gi, 'UNIQUE $1');

    // 4.3 列级 MySQL 专有修饰
    s = s.replace(/\bCHARACTER\s+SET\s+[A-Za-z0-9_]+/gi, '');
    s = s.replace(/\bCOLLATE\s+[A-Za-z0-9_]+/gi, '');
    s = s.replace(/\bCOMMENT\s+'(?:[^']|'')*'/gi, '');
    s = s.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\(\d*\))?/gi, '');
    s = s.replace(/\b(UNSIGNED|ZEROFILL)\b/gi, '');
    s = s.replace(/\bDEFAULT\s+CURRENT_TIMESTAMP(?:\(\s*\d*\s*\))?/gi, "DEFAULT (datetime('now','localtime'))");
    s = s.replace(/\bDEFAULT\s+CURRENT_DATE\b/gi, "DEFAULT (date('now','localtime'))");
    s = s.replace(/\bDEFAULT\s+CURRENT_TIME\b/gi, "DEFAULT (time('now','localtime'))");

    // 4.4 AUTO_INCREMENT：类型改 INTEGER，去掉关键字（INTEGER PRIMARY KEY 即 rowid 别名，可自增）
    s = s.replace(new RegExp('\\b' + INT_TYPES + '\\s*(?:\\(\\s*\\d+\\s*\\))?(\\s*(?:NOT\\s+NULL)?)\\s*AUTO_INCREMENT\\b', 'gi'), 'INTEGER$1');
    s = s.replace(/\bAUTO_INCREMENT\b/gi, '');
    s = s.replace(/\bGENERATED\s+ALWAYS\s+AS\s*\([^)]*\)\s*(?:STORED|VIRTUAL)?/gi, '');

    // 4.5 类型兼容：ENUM/SET/JSON/GEOMETRY → TEXT
    s = s.replace(/\b(ENUM|SET)\s*\((?:[^()']|'(?:[^']|'')*')*\)/gi, 'TEXT');
    s = s.replace(/\b(JSON|GEOMETRY|POINT|LINESTRING)\b/gi, 'TEXT');

    // 4.6 清理因删除索引定义而死掉的逗号（可能连续出现，用循环兜底）
    var prev;
    do {
      prev = s;
      s = s.replace(/(,\s*)+\)/g, ')');
      s = s.replace(/\(\s*(,\s*)+/g, '(');
      s = s.replace(/(,\s*){2,}/g, ', ');
    } while (s !== prev);

    return s;
  }

  /** 跳过引号/注释/括号找到整词关键字首次出现的位置；找不到返回 -1 */
  function topLevelKeywordIndex(str, word) {
    var i = 0, n = str.length, depth = 0, state = 'n';
    while (i < n) {
      var ch = str[i], next = str[i + 1];
      if (state === 'l') { if (ch === '\n') state = 'n'; i++; continue; }
      if (state === 'c') { if (ch === '*' && next === '/') { state = 'n'; i += 2; continue; } i++; continue; }
      if (state !== 'n') {
        var q = state === 's' ? "'" : state === 'd' ? '"' : '`';
        if (ch === '\\' && state !== 'b') { i += 2; continue; }
        if (ch === q) { if (next === q) { i += 2; continue; } state = 'n'; }
        i++; continue;
      }
      if (ch === "'") { state = 's'; i++; continue; }
      if (ch === '"') { state = 'd'; i++; continue; }
      if (ch === '`') { state = 'b'; i++; continue; }
      if (ch === '#' || (ch === '-' && next === '-')) { state = 'l'; i += ch === '#' ? 1 : 2; continue; }
      if (ch === '/' && next === '*') { state = 'c'; i += 2; continue; }
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') { depth--; i++; continue; }
      if (depth === 0 && str.substr(i, word.length).toUpperCase() === word.toUpperCase()) {
        var before = i === 0 ? '' : str[i - 1];
        var after = str[i + word.length] || '';
        if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) return i;
      }
      i++;
    }
    return -1;
  }

  /** 找到 name( 形式的函数调用，返回函数名起始下标；找不到返回 -1 */
  function indexOfFunctionCall(str, name) {
    var re = new RegExp('(^|[^A-Za-z0-9_$.])' + name + '\\s*\\(', 'i');
    var m = re.exec(str);
    return m ? m.index + m[1].length : -1;
  }

  /** 从 open 处的 '(' 找到配对的 ')'，跳过引号内容；找不到返回 -1 */
  function matchParen(str, open) {
    var d = 0, state = 'n';
    for (var i = open; i < str.length; i++) {
      var ch = str[i], nx = str[i + 1];
      if (state === 'n') {
        if (ch === "'" || ch === '"' || ch === '`') { state = ch === "'" ? 's' : ch === '"' ? 'd' : 'b'; continue; }
        if (ch === '(') d++;
        else if (ch === ')') { d--; if (d === 0) return i; }
      } else {
        var q = state === 's' ? "'" : state === 'd' ? '"' : '`';
        if (ch === '\\' && state !== 'b') { i++; continue; }
        if (ch === q) { if (nx === q) i++; else state = 'n'; }
      }
    }
    return -1;
  }

  /**
   * MySQL 的 FIELD(x, a, b, ...) 展开成 CASE 表达式。
   * 底层引擎注册函数要求固定参数个数（sql.js 用 fn.length 作为 nArg），
   * 而 FIELD 是可变参数的，所以只能在转译阶段展开。
   */
  function rewriteField(sql) {
    var out = sql, guard = 0;
    while (guard++ < 20) {
      var at = indexOfFunctionCall(out, 'FIELD');
      if (at < 0) break;
      var open = out.indexOf('(', at);
      var close = matchParen(out, open);
      if (close < 0) break;
      var args = splitTopLevel(out.slice(open + 1, close));
      if (args.length < 2) {   // 用法非法，改个名让底层去报错，同时避免死循环
        out = out.slice(0, at) + 'FIELD_INVALID' + out.slice(at + 5);
        continue;
      }
      var target = args.shift().trim();
      var expr = '(CASE WHEN ' + target + ' IS NULL THEN 0' +
        args.map(function (v, i) { return ' WHEN ' + target + ' = ' + v.trim() + ' THEN ' + (i + 1); }).join('') +
        ' ELSE 0 END)';
      out = out.slice(0, at) + expr + out.slice(close + 1);
    }
    return out;
  }

  var GROUP_CONCAT_DISTINCT_NOTE = '（提示：GROUP_CONCAT(DISTINCT x SEPARATOR s) 在底层是"先按逗号拼接、再把逗号替换成分隔符"实现的，'
    + '所以当 x 的值本身含逗号时结果会与真实 MySQL 有出入；去掉 DISTINCT 即可完全一致。）';

  /**
   * 在引号与注释之外做替换（比 replaceOutsideQuotes 多认 `--` / `#` / 块注释）。
   * 必须认注释，否则 `/* a / b *​/` 这类注释里的除号会被误改成 `*1.0/`。
   * fn(str, i) 返回 { text, len } 表示在 i 处替换掉 len 个字符；返回 null 表示不动。
   */
  function mapOutsideQuotesAndComments(str, fn) {
    var out = '', i = 0, state = 'n';
    while (i < str.length) {
      var ch = str.charAt(i), nx = str.charAt(i + 1);
      if (state === 'n') {
        if (ch === "'" || ch === '"' || ch === '`') {
          state = ch === "'" ? 's' : ch === '"' ? 'd' : 'b';
          out += ch; i++; continue;
        }
        if (ch === '-' && nx === '-') { state = 'l'; out += '--'; i += 2; continue; }
        if (ch === '#') { state = 'l'; out += ch; i++; continue; }
        if (ch === '/' && nx === '*') { state = 'c'; out += '/*'; i += 2; continue; }
        var rep = fn(str, i);
        if (rep) { out += rep.text; i += rep.len; continue; }
        out += ch; i++; continue;
      }
      out += ch;
      if (state === 'l') { if (ch === '\n') state = 'n'; i++; continue; }
      if (state === 'c') {
        if (ch === '*' && nx === '/') { out += '/'; i += 2; state = 'n'; continue; }
        i++; continue;
      }
      var q = state === 's' ? "'" : state === 'd' ? '"' : '`';
      if (ch === '\\' && state !== 'b') { out += str.charAt(i + 1); i += 2; continue; }
      if (ch === q) { if (nx === q) { out += q; i += 2; continue; } state = 'n'; }
      i++;
    }
    return out;
  }

  /** 在引号/注释之外用"位置锚定"的正则替换（rx 需要带 g 标志） */
  function replaceOutsideAll(str, rx, fn) {
    return mapOutsideQuotesAndComments(str, function (s2, i) {
      rx.lastIndex = i;
      var m = rx.exec(s2);
      if (m && m.index === i) return { text: fn.apply(null, m), len: m[0].length };
      return null;
    });
  }

  /**
   * GROUP_CONCAT 的 SEPARATOR 重写。
   *
   * SQLite 的正确写法是 `group_concat(expr, sep [ORDER BY ...])`（分隔符要放在 ORDER BY 之前），
   * 而 MySQL 习惯写成 `group_concat(expr [ORDER BY ...] SEPARATOR 'sep')`。
   * 旧实现只是把 `SEPARATOR x` 换成第二个实参，于是：
   *   · 带 DISTINCT 时 → SQLite 直接报 "DISTINCT aggregates must have exactly one argument"
   *   · 带 ORDER BY 时 → 分隔符被 SQLite 忽略，静默改用逗号
   */
  function rewriteGroupConcat(sql, ctx) {
    var s = String(sql), out = '', idx = 0;
    while (idx < s.length) {
      var rel = indexOfFunctionCall(s.slice(idx), 'GROUP_CONCAT');
      if (rel < 0) { out += s.slice(idx); break; }
      var at = idx + rel;
      var open = s.indexOf('(', at);
      var close = open < 0 ? -1 : matchParen(s, open);
      if (close < 0) { out += s.slice(idx); break; }
      out += s.slice(idx, at);
      var inner = s.slice(open + 1, close);
      var mSep = /^([\s\S]*?)\s+SEPARATOR\s+('(?:[^']|'')*'|"(?:[^"]|"")*")\s*$/i.exec(inner);
      if (!mSep) {
        out += 'GROUP_CONCAT(' + inner + ')';
        idx = close + 1;
        continue;
      }
      var body = mSep[1].trim(), sep = mSep[2];
      var ordM = /\s+ORDER\s+BY\s+([\s\S]+)$/i.exec(body);
      var ord = ordM ? ordM[1].trim() : null;
      var core = ordM ? body.slice(0, ordM.index).trim() : body;
      if (/^DISTINCT\s+/i.test(core)) {
        if (ctx) {
          ctx.notes = ctx.notes || [];
          if (ctx.notes.indexOf(GROUP_CONCAT_DISTINCT_NOTE) < 0) ctx.notes.push(GROUP_CONCAT_DISTINCT_NOTE);
        }
        out += 'REPLACE(GROUP_CONCAT(' + core + (ord ? ' ORDER BY ' + ord : '') + '), \',\', ' + sep + ')';
      } else {
        out += 'GROUP_CONCAT(' + core + ', ' + sep + (ord ? ' ORDER BY ' + ord : '') + ')';
      }
      idx = close + 1;
    }
    return out;
  }

  /** 通用函数调用重写：把 f(...) 的实参交给 build(argsArray, rawArgs) 生成替换文本；返回 null 表示不改 */
  function rewriteFunctionCalls(sql, name, build) {
    var s = String(sql), out = '', idx = 0, guard = 0;
    while (idx < s.length && guard++ < 500) {
      var rel = indexOfFunctionCall(s.slice(idx), name);
      if (rel < 0) { out += s.slice(idx); break; }
      var at = idx + rel;
      var open = s.indexOf('(', at);
      var close = open < 0 ? -1 : matchParen(s, open);
      if (close < 0) { out += s.slice(idx); break; }
      out += s.slice(idx, at);
      var raw = s.slice(open + 1, close);
      var rep = build(splitTopLevel(raw), raw);
      out += (rep === null || rep === undefined) ? s.slice(at, close + 1) : rep;
      idx = close + 1;
    }
    return out;
  }

  /** ISNULL(expr) → (expr IS NULL)：SQLite 里 ISNULL 是后缀运算符，直接当函数调用会语法错误 */
  function rewriteIsNull(sql) {
    return rewriteFunctionCalls(sql, 'ISNULL', function (args, raw) {
      var a = splitTopLevel(raw);
      if (a.length !== 1) return null;
      return '((' + a[0].trim() + ') IS NULL)';
    });
  }

  /** TRIM([BOTH|LEADING|TRAILING] [remstr] FROM str) → LTRIM/RTRIM/TRIM(str, remstr) */
  function rewriteTrim(sql) {
    return rewriteFunctionCalls(sql, 'TRIM', function (args, raw) {
      var m = /^\s*(BOTH|LEADING|TRAILING)?\s*([\s\S]*?)\s+FROM\s+([\s\S]+)$/i.exec(raw);
      if (!m) return null;                       // 普通 TRIM(str) / TRIM(str, chars) 交给底层
      var dir = (m[1] || 'BOTH').toUpperCase();
      var rem = m[2].trim(), str = m[3].trim();
      if (!rem) return str;
      if (dir === 'LEADING') return 'LTRIM(' + str + ', ' + rem + ')';
      if (dir === 'TRAILING') return 'RTRIM(' + str + ', ' + rem + ')';
      return 'TRIM(' + str + ', ' + rem + ')';
    });
  }

  /** POSITION(substr IN str) → INSTR(str, substr) */
  function rewritePosition(sql) {
    return rewriteFunctionCalls(sql, 'POSITION', function (args, raw) {
      var m = /^([\s\S]+?)\s+IN\s+([\s\S]+)$/i.exec(raw);
      if (!m) return null;
      return 'INSTR(' + m[2].trim() + ', ' + m[1].trim() + ')';
    });
  }

  /** CONVERT(expr, type) → CAST(expr AS ...)；CONVERT(expr USING cs) → expr（字符集在此为空操作） */
  function rewriteConvert(sql) {
    return rewriteFunctionCalls(sql, 'CONVERT', function (args, raw) {
      var mUsing = /^([\s\S]+?)\s+USING\s+[A-Za-z0-9_]+\s*$/i.exec(raw);
      if (mUsing) return mUsing[1].trim();
      var m = /^([\s\S]+?),\s*([A-Za-z]+(?:\s*\([\d,\s]+\))?)\s*$/i.exec(raw);
      if (!m) return null;
      var t = m[2].toUpperCase();
      var cast = /^(SIGNED|UNSIGNED)/.test(t) ? 'INTEGER'
        : /^(DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)/.test(t) ? 'REAL'
        : 'TEXT';
      return 'CAST(' + m[1].trim() + ' AS ' + cast + ')';
    });
  }

  /** EXTRACT(unit FROM expr) */
  function rewriteExtract(sql) {
    return rewriteFunctionCalls(sql, 'EXTRACT', function (args, raw) {
      var m = /^\s*([A-Za-z_]+)\s+FROM\s+([\s\S]+)$/i.exec(raw);
      if (!m) return null;
      var unit = m[1].toUpperCase(), e = m[2].trim();
      if (unit === 'DATE') return 'date(' + e + ')';
      if (unit === 'TIME') return 'time(' + e + ')';
      if (unit === 'QUARTER') return 'CAST(((CAST(strftime(\'%m\',' + e + ') AS INTEGER)+2)/3) AS INTEGER)';
      if (unit === 'WEEK') return 'CAST(strftime(\'%W\',' + e + ') AS INTEGER)';
      if (unit === 'DAYOFYEAR') return 'CAST(strftime(\'%j\',' + e + ') AS INTEGER)';
      if (unit === 'DAYOFWEEK') return '(CAST(strftime(\'%w\',' + e + ') AS INTEGER)+1)';
      if (unit === 'WEEKDAY') return '((CAST(strftime(\'%w\',' + e + ') AS INTEGER)+6)%7)';
      var F = { YEAR: '%Y', MONTH: '%m', DAY: '%d', DAYOFMONTH: '%d', HOUR: '%H', MINUTE: '%M', SECOND: '%S' };
      if (F[unit]) return 'CAST(strftime(\'' + F[unit] + '\',' + e + ') AS INTEGER)';
      return null;
    });
  }

  /**
   * 日期算术：
   *   DATE_ADD(x, INTERVAL n unit) / DATE_SUB / ADDDATE / SUBDATE → MYSQL_DATE_ADD/SUB(x, n, 'unit')
   *   TIMESTAMPADD(unit, n, x) → MYSQL_DATE_ADD(x, n, 'unit')
   *   TIMESTAMPDIFF(unit, a, b) → MYSQL_TSDIFF('unit', a, b)
   * 不走 SQLite 的 datetime(x,'+1 month')：那条路对 1 月 31 日 +1 月会给出 3 月 3 日，
   * 而 MySQL 是收敛到 2 月 28 日，语义不同。
   */
  function rewriteDateFunctions(sql) {
    var s = String(sql);
    s = rewriteFunctionCalls(s, 'TIMESTAMPDIFF', function (args, raw) {
      var a = splitTopLevel(raw);
      if (a.length !== 3) return null;
      return "MYSQL_TSDIFF('" + a[0].trim().toUpperCase() + "', " + a[1].trim() + ', ' + a[2].trim() + ')';
    });
    s = rewriteFunctionCalls(s, 'TIMESTAMPADD', function (args, raw) {
      var a = splitTopLevel(raw);
      if (a.length !== 3) return null;
      return 'MYSQL_DATE_ADD(' + a[2].trim() + ', ' + a[1].trim() + ", '" + a[0].trim().toUpperCase() + "')";
    });
    [['DATE_ADD', 'ADD'], ['ADDDATE', 'ADD'], ['DATE_SUB', 'SUB'], ['SUBDATE', 'SUB']].forEach(function (pair) {
      s = rewriteFunctionCalls(s, pair[0], function (args, raw) {
        var m = /^([\s\S]+?),\s*INTERVAL\s+([\s\S]+?)\s+([A-Za-z_]+)\s*$/i.exec(raw);
        if (m) {
          return 'MYSQL_DATE_' + pair[1] + '(' + m[1].trim() + ', (' + m[2].trim() + "), '" + m[3].toUpperCase() + "')";
        }
        var a = splitTopLevel(raw);
        if (a.length === 2 && !/INTERVAL/i.test(raw)) {
          return 'MYSQL_DATE_' + pair[1] + '(' + a[0].trim() + ', (' + a[1].trim() + "), 'DAY')";
        }
        return null;
      });
    });
    return s;
  }

  /** INSERT(str,pos,len,newstr) 字符串函数（注意与 INSERT 语句区分：只有紧跟 '(' 才算函数） */
  function rewriteInsertFunc(sql) {
    return rewriteFunctionCalls(sql, 'INSERT', function (args, raw) {
      var a = splitTopLevel(raw);
      if (a.length !== 4) return null;
      return 'MYSQL_INSERT(' + a.map(function (x) { return x.trim(); }).join(', ') + ')';
    });
  }

  function translateStatement(sql, ctx) {
    var s = sql;
    var inDdl = /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(s);
    if (inDdl) return translateCreateTable(s);
    if (/FIELD\s*\(/i.test(s)) s = rewriteField(s);

    // ---- MySQL 专有函数语法糖（必须先于通用转译处理） ----
    if (/\bTRIM\s*\(/i.test(s)) s = rewriteTrim(s);
    if (/\bISNULL\s*\(/i.test(s)) s = rewriteIsNull(s);
    if (/\bPOSITION\s*\(/i.test(s)) s = rewritePosition(s);
    if (/\bCONVERT\s*\(/i.test(s)) s = rewriteConvert(s);
    if (/\bEXTRACT\s*\(/i.test(s)) s = rewriteExtract(s);
    if (/\b(?:DATE_ADD|DATE_SUB|ADDDATE|SUBDATE|TIMESTAMPADD|TIMESTAMPDIFF)\s*\(/i.test(s)) s = rewriteDateFunctions(s);
    // INSERT() 字符串函数：只有不是 DML 的 INSERT 语句时才重写（DML 里 INSERT 后面跟的是 INTO，不会命中）
    if (!/^\s*INSERT\b/i.test(s) && /\bINSERT\s*\(/i.test(s)) s = rewriteInsertFunc(s);

    // TRUNCATE TABLE / TRUNCATE
    s = s.replace(/^\s*TRUNCATE\s+(?:TABLE\s+)?/i, 'DELETE FROM ');
    // DROP TEMPORARY TABLE t → DROP TABLE t（底层不认识 TEMPORARY 关键字）
    s = s.replace(/^\s*DROP\s+TEMPORARY\s+TABLE\s+/i, 'DROP TABLE ');
    // INSERT IGNORE → INSERT OR IGNORE
    s = s.replace(/\bINSERT\s+IGNORE\s+INTO\b/i, 'INSERT OR IGNORE INTO');
    // INSERT ... ON DUPLICATE KEY UPDATE ... → INSERT ... ON CONFLICT DO UPDATE SET ...
    if (/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(s)) {
      s = s.replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i, 'ON CONFLICT DO UPDATE SET');
      // MySQL 的 VALUES(col) → SQLite 的 excluded.col
      s = s.replace(/\bVALUES\s*\(\s*(`?[A-Za-z0-9_$.]+`?)\s*\)/gi, 'excluded.$1');
      // SQLite 的 upsert 不接受 表名.列名 = ... 的写法，去掉左值前缀
      var odAt = s.search(/ON\s+CONFLICT\s+DO\s+UPDATE\s+SET/i);
      if (odAt > -1) {
        s = s.slice(0, odAt) + s.slice(odAt).replace(
          /(^|,)\s*`?[A-Za-z0-9_$]+`?\s*\.\s*(`?[A-Za-z0-9_$]+`?)\s*=/g,
          function (mm, pre, col) { return pre + ' ' + col + ' ='; });
      }
    }
    // RENAME TABLE a TO b → ALTER TABLE a RENAME TO b
    s = s.replace(/^\s*RENAME\s+TABLE\s+(`?[A-Za-z0-9_$]+`?)\s+TO\s+(`?[A-Za-z0-9_$]+`?)\s*$/i, 'ALTER TABLE $1 RENAME TO $2');
    // CAST(x AS SIGNED/UNSIGNED/CHAR) → INTEGER/TEXT
    s = s.replace(/\bAS\s+(SIGNED|UNSIGNED)(?:\s+INTEGER)?\b/gi, 'AS INTEGER');
    s = s.replace(/\bAS\s+(CHAR|NCHAR|BINARY)\b/gi, 'AS TEXT');
    // RLIKE 是 REGEXP 的同义词
    s = s.replace(/\bRLIKE\b/gi, 'REGEXP');
    // GROUP_CONCAT(x [ORDER BY ...] SEPARATOR 'y') → 底层能听懂的等价写法
    s = rewriteGroupConcat(s, ctx);
    // LIMIT a, b → LIMIT b OFFSET a
    s = s.replace(/\bLIMIT\s+(\d+)\s*,\s*(\d+)\b/gi, 'LIMIT $2 OFFSET $1');

    // ---- 运算符语义对齐 ----
    // MySQL 的 "/" 永远是小数除法（7/2 得 3.5000），而 SQLite 对两个整数做整除（7/2 得 3）。
    // 改写为 `a * 1.0 / b`：在左结合的优先级下与 `a / b` 完全等价，但强制走实数除法。
    // DIV 和 NULL 安全等于 <=> 需要识别两侧操作数，按"原子"（标识符 / 括号表达式 / 数字）匹配。
    var ATOM = '(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_$.]*|\\([^()]*\\)|[-+]?(?:\\d+\\.?\\d*|\\.\\d+))';
    // a DIV b → MySQL 是"截断取整的整数除法"（5.5 DIV 2 得 2），CAST 到 INTEGER 正好是朝零截断
    s = replaceOutsideAll(s, new RegExp('(' + ATOM + ')\\s+DIV\\s+(' + ATOM + ')', 'gi'),
      function (mm, a, b) { return 'CAST((' + a + ')*1.0/(' + b + ') AS INTEGER)'; });
    // a <=> b → SQLite 的 IS 就是 NULL 安全等于
    s = replaceOutsideAll(s, new RegExp('(' + ATOM + ')\\s*<=>\\s*(' + ATOM + ')', 'gi'),
      function (mm, a, b) { return '((' + a + ') IS (' + b + '))'; });
    s = mapOutsideQuotesAndComments(s, function (str, i) {
      if (str.charAt(i) !== '/') return null;
      if (str.charAt(i - 1) === '*' || str.charAt(i + 1) === '*') return null;

      return { text: '*1.0/', len: 1 };
    });

    // UPDATE / DELETE ... LIMIT n → 用 rowid 子查询限定（SQLite 默认不支持写语句的 LIMIT）
    if (/\sLIMIT\s+\d+\s*$/i.test(s) && /^\s*(?:UPDATE|DELETE)\b/i.test(s)) {
      var limN = /\sLIMIT\s+(\d+)\s*$/i.exec(s)[1];
      var limCore = s.replace(/\sLIMIT\s+\d+\s*$/i, '').trim();
      if (/^DELETE\b/i.test(limCore)) {
        var dRest = limCore.replace(/^\s*DELETE\s+FROM\s+/i, '');        // <表> [WHERE ...] [ORDER BY ...]
        var dName = dRest.split(/\s+/)[0];
        return 'DELETE FROM ' + dName + ' WHERE rowid IN (SELECT rowid FROM ' + dRest + ' LIMIT ' + limN + ')';
      }
      var uSetIdx = topLevelKeywordIndex(limCore, 'SET');
      if (uSetIdx > -1) {
        var uTbl = limCore.slice(limCore.search(/UPDATE/i) + 6, uSetIdx).trim();
        var uRest = limCore.slice(uSetIdx + 3);
        var uW = topLevelKeywordIndex(uRest, 'WHERE');
        var uAssign = uW > -1 ? uRest.slice(0, uW) : uRest;
        var uClause = uW > -1 ? ' ' + uRest.slice(uW) : '';             // WHERE ... [ORDER BY ...]
        return 'UPDATE ' + uTbl + ' SET ' + uAssign +
          ' WHERE rowid IN (SELECT rowid FROM ' + uTbl + uClause + ' LIMIT ' + limN + ')';
      }
    }
    // 时间函数对齐本地时区
    s = s.replace(/\bCURRENT_TIMESTAMP\b(?!\s*\()/gi, 'NOW()');
    s = s.replace(/\bCURRENT_DATE\b(?!\s*\()/gi, 'CURDATE()');
    s = s.replace(/\bCURRENT_TIME\b(?!\s*\()/gi, 'CURTIME()');
    // STRAIGHT_JOIN → JOIN
    s = s.replace(/\bSTRAIGHT_JOIN\b/gi, 'JOIN');
    // LEFT/RIGHT OUTER JOIN 归一化交由 SQLite 处理；SQL_CALC_FOUND_ROWS 丢弃
    s = s.replace(/\bSQL_CALC_FOUND_ROWS\b/gi, '');
    s = s.replace(/\bSQL_NO_CACHE\b/gi, '');

    // ---- 事务控制（MySQL → SQLite）----
    // START TRANSACTION [READ ONLY|READ WRITE|WITH CONSISTENT SNAPSHOT] → BEGIN
    if (/^\s*START\s+TRANSACTION\b/i.test(s)) return 'BEGIN';
    // BEGIN [WORK|TRANSACTION] → BEGIN
    if (/^\s*BEGIN\b/i.test(s)) return 'BEGIN';
    // 只读事务在 SQLite 里没有对应概念，直接放行
    if (/^\s*SET\s+TRANSACTION\b/i.test(s)) return 'SELECT 1 WHERE 0';

    // ---- 索引与表维护 ----
    // DROP INDEX idx ON tbl → DROP INDEX idx
    s = s.replace(/^\s*DROP\s+INDEX\s+(`?[A-Za-z0-9_$]+`?)\s+ON\s+`?[A-Za-z0-9_$]+`?\s*$/i, 'DROP INDEX $1');
    // ALTER TABLE t ADD [UNIQUE] INDEX|KEY name (cols) → CREATE [UNIQUE] INDEX name ON t(cols)
    var addIdx = /^\s*ALTER\s+TABLE\s+(`?[A-Za-z0-9_$]+`?)\s+ADD\s+(UNIQUE\s+)?(?:INDEX|KEY)\s+(`?[A-Za-z0-9_$]+`?)\s*\(([^)]*)\)\s*$/i.exec(s);
    if (addIdx) {
      return 'CREATE ' + (addIdx[2] ? 'UNIQUE ' : '') + 'INDEX ' + addIdx[3] + ' ON ' + addIdx[1] + ' (' + addIdx[4] + ')';
    }
    // ALTER TABLE t DROP INDEX|KEY name → DROP INDEX name
    var dropIdx = /^\s*ALTER\s+TABLE\s+`?[A-Za-z0-9_$]+`?\s+DROP\s+(?:INDEX|KEY)\s+(`?[A-Za-z0-9_$]+`?)\s*$/i.exec(s);
    if (dropIdx) return 'DROP INDEX ' + dropIdx[1];
    // 表维护语句（OPTIMIZE / REPAIR / ANALYZE / CHECK / FLUSH）一律由 runOne 直接接管，
    // 返回 MySQL 形态的 Table/Op/Msg_type/Msg_text 结果集，因此这里不再转译。
    // （旧实现把 OPTIMIZE/REPAIR/FLUSH 映射成 `SELECT 1 WHERE 0`，终端上会打印一句
    //   "Empty set"，形态与真实 MySQL 完全不符。）

    // EXPLAIN SELECT ... → EXPLAIN QUERY PLAN SELECT ...（可读性更好）
    if (/^\s*EXPLAIN\s+(?:FORMAT\s*=\s*\w+\s+)?(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(s)) {
      s = s.replace(/^\s*EXPLAIN\s+(?:FORMAT\s*=\s*\w+\s+)?/i, 'EXPLAIN QUERY PLAN ');
    }
    // SELECT ... FOR UPDATE / LOCK IN SHARE MODE → 去掉（无行锁语义，上层会提示）
    s = s.replace(/\s+FOR\s+UPDATE(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?\s*$/i, '');
    s = s.replace(/\s+LOCK\s+IN\s+SHARE\s+MODE\s*$/i, '');
    return s;
  }

  /* ======================= 5. 结果集排版 ======================= */

  function cellRaw(v) {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Uint8Array) return '<BLOB ' + v.length + 'B>';
    if (typeof v === 'number') {
      if (!isFinite(v)) return String(v);
      if (Number.isInteger(v)) return String(v);
      return String(parseFloat(v.toFixed(6)));
    }
    if (typeof v === 'boolean') return v ? '1' : '0';
    return String(v);
  }

  /** 横向表格用的单元格：换行压成空格，避免边框错位 */
  function cell(v) {
    return cellRaw(v).replace(/\r?\n/g, ' ');
  }

  function formatDuration(sec) {
    if (sec < 0.005) return '0.00';
    if (sec < 10) return sec.toFixed(2);
    return sec.toFixed(1);
  }

  /** 横向表格（mysql 默认输出） */
  function formatTable(rs) {
    var cols = rs.columns || [];
    var rows = rs.values || [];
    if (!cols.length) return '';
    var widths = cols.map(function (c) { return dispWidth(c); });
    var texts = rows.map(function (r) {
      return cols.map(function (c, i) {
        var t = cell(r[i]);
        var w = dispWidth(t);
        if (w > widths[i]) widths[i] = w;
        return t;
      });
    });
    // 数值列右对齐
    var numeric = cols.map(function (c, i) {
      var any = false;
      for (var k = 0; k < rows.length; k++) {
        var v = rows[k][i];
        if (v === null || v === undefined) continue;
        any = true;
        if (typeof v !== 'number') return false;
      }
      return any;
    });
    var border = '+' + widths.map(function (w) { return new Array(w + 3).join('-'); }).join('+') + '+';
    var lines = [border];
    lines.push('| ' + cols.map(function (c, i) { return padRight(c, widths[i]); }).join(' | ') + ' |');
    lines.push(border);
    texts.forEach(function (r) {
      lines.push('| ' + r.map(function (t, i) {
        return numeric[i] ? padLeft(t, widths[i]) : padRight(t, widths[i]);
      }).join(' | ') + ' |');
    });
    lines.push(border);
    return lines.join('\n');
  }

  /** 纵向输出（\G）——保留单元格内换行并缩进对齐 */
  function formatVertical(rs) {
    var cols = rs.columns || [];
    var rows = rs.values || [];
    var w = 0;
    cols.forEach(function (c) { w = Math.max(w, dispWidth(c)); });
    var lines = [];
    var bar = new Array(28).join('*');
    var indent = padRight('', w + 2);
    rows.forEach(function (r, idx) {
      lines.push(bar + ' ' + (idx + 1) + '. row ' + bar);
      cols.forEach(function (c, i) {
        var text = cellRaw(r[i]);
        if (text.indexOf('\n') >= 0) text = text.split('\n').join('\n' + indent);
        lines.push(padLeft(c, w) + ': ' + text);
      });
    });
    return lines.join('\n');
  }

  function rowsTail(count, sec) {
    if (count === 0) return 'Empty set (' + formatDuration(sec) + ' sec)';
    return count + (count === 1 ? ' row in set (' : ' rows in set (') + formatDuration(sec) + ' sec)';
  }

  /* ======================= 6. 错误映射 ======================= */

  function mapError(msg, ctx) {
    ctx = ctx || {};
    var m;

    if (/^no such table:\s*(.+)$/i.test(msg)) {
      m = /^no such table:\s*(.+)$/i.exec(msg);
      var t = m[1].trim();
      var full = /[.]/.test(t) || !ctx.db ? t : ctx.db + '.' + t;
      return 'ERROR 1146 (42S02): Table \'' + full + '\' doesn\'t exist';
    }
    if (/^no such column:\s*(.+)$/i.test(msg)) {
      m = /^no such column:\s*(.+)$/i.exec(msg);
      return 'ERROR 1054 (42S22): Unknown column \'' + m[1].trim() + '\' in \'field list\'';
    }
    if (/^no such function:\s*(.+)$/i.test(msg)) {
      m = /^no such function:\s*(.+)$/i.exec(msg);
      return 'ERROR 1305 (42000): FUNCTION ' + (ctx.db || '') + '.' + m[1].trim() + ' does not exist';
    }
    if (/^table\s+(.+?)\s+already exists$/i.test(msg)) {
      m = /^table\s+(.+?)\s+already exists$/i.exec(msg);
      return 'ERROR 1050 (42S01): Table \'' + m[1] + '\' already exists';
    }
    if (/^index\s+(.+?)\s+already exists$/i.test(msg)) {
      m = /^index\s+(.+?)\s+already exists$/i.exec(msg);
      return 'ERROR 1061 (42000): Duplicate key name \'' + m[1] + '\'';
    }
    if (/^UNIQUE constraint failed:\s*(.+)$/i.test(msg)) {
      m = /^UNIQUE constraint failed:\s*(.+)$/i.exec(msg);
      return 'ERROR 1062 (23000): Duplicate entry ' + (ctx.dupValue ? '\'' + ctx.dupValue + '\'' : '\'...\'') + ' for key \'' + m[1].trim() + '\'';
    }
    if (/^NOT NULL constraint failed:\s*(.+)$/i.test(msg)) {
      m = /^NOT NULL constraint failed:\s*(.+)$/i.exec(msg);
      var parts = m[1].trim().split('.');
      return 'ERROR 1048 (23000): Column \'' + parts[parts.length - 1] + '\' cannot be null';
    }
    if (/^FOREIGN KEY constraint failed$/i.test(msg)) {
      // 底层不区分"子表插入失败"与"父表被引用无法删除"，按语句类型区分（与 MySQL 的 1452/1451 一致）
      if (/^\s*(?:DELETE|UPDATE)\b/i.test(ctx.stmt || '')) {
        return 'ERROR 1451 (23000): Cannot delete or update a parent row: a foreign key constraint fails';
      }
      return 'ERROR 1452 (23000): Cannot add or update a child row: a foreign key constraint fails';
    }
    if (/^CHECK constraint failed:\s*(.+)$/i.test(msg)) {
      m = /^CHECK constraint failed:\s*(.+)$/i.exec(msg);
      return 'ERROR 3819 (HY000): Check constraint \'' + m[1].trim() + '\' is violated.';
    }
    if (/^datatype mismatch$/i.test(msg)) {
      return 'ERROR 1366 (HY000): Incorrect integer value: datatype mismatch';
    }
    if (/^unknown system variable:\s*(.+)$/i.test(msg)) {
      m = /^unknown system variable:\s*(.+)$/i.exec(msg);
      return 'ERROR 1193 (HY000): Unknown system variable \'' + m[1].trim() + '\'';
    }
    if (/^no such savepoint:\s*(.+)$/i.test(msg)) {
      m = /^no such savepoint:\s*(.+)$/i.exec(msg);
      return 'ERROR 1305 (42000): SAVEPOINT ' + m[1].trim() + ' does not exist';
    }
    if (/^no such index:\s*(.+)$/i.test(msg)) {
      m = /^no such index:\s*(.+)$/i.exec(msg);
      return 'ERROR 1091 (42000): Can\'t DROP \'' + m[1].trim() + '\'; check that column/key exists';
    }
    // 视图相关：底层的措辞与 MySQL 完全不同，需要改写
    if (/cannot modify\s+(.+?)\s+because it is a view/i.test(msg)) {
      m = /cannot modify\s+(.+?)\s+because it is a view/i.exec(msg);
      var vName2 = m[1].trim().split('.').pop();
      var verb = /^\s*INSERT|^\s*REPLACE/i.test(ctx.stmt || '') ? 'INSERT'
        : /^\s*UPDATE/i.test(ctx.stmt || '') ? 'UPDATE'
          : /^\s*DELETE/i.test(ctx.stmt || '') ? 'DELETE' : 'INSERT';
      return 'ERROR 1288 (HY000): The target table ' + vName2 + ' of the ' + verb + ' is not updatable';
    }
    if (/use DROP VIEW to delete view\s+(.+)$/i.test(msg)) {
      m = /use DROP VIEW to delete view\s+(.+)$/i.exec(msg);
      return 'ERROR 1347 (HY000): \'' + (ctx.db ? ctx.db + '.' : '') + m[1].trim() + '\' is not BASE TABLE';
    }
    if (/^near\s+"([^"]*)":\s*syntax error/i.test(msg)) {
      m = /^near\s+"([^"]*)":\s*syntax error/i.exec(msg);
      return 'ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near \'' + m[1] + '\' at line 1';
    }
    if (/incomplete input/i.test(msg)) {
      return 'ERROR 1064 (42000): You have an error in your SQL syntax; the statement appears incomplete';
    }
    if (/^\s*(no such|unrecognized|unexpected)/i.test(msg)) {
      return 'ERROR 1064 (42000): You have an error in your SQL syntax; ' + msg;
    }
    if (/attempt to write a readonly database/i.test(msg)) {
      return 'ERROR 1290 (HY000): The MySQL server is running with the --read-only option';
    }
    return 'ERROR 1105 (HY000): ' + msg;
  }

  /* ======================= 7. MySQL 函数注册 ======================= */

  function fmtLocalDate(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtLocalTime(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtLocalDT(d) { return fmtLocalDate(d) + ' ' + fmtLocalTime(d); }

  var DATE_FORMAT_MAP = {
    'Y': '%Y', 'y': '%y', 'm': '%m', 'c': '%m', 'd': '%d', 'e': '%d',
    'H': '%H', 'h': '%I', 'I': '%I', 'i': '%M', 's': '%S', 'S': '%S',
    'p': '%p', 'W': '%A', 'a': '%a', 'M': '%B', 'b': '%b', 'T': '%H:%M:%S',
    'r': '%I:%M:%S %p', 'j': '%j', 'w': '%w', 'u': '%W', 'U': '%W', 'V': '%W',
    'D': '%d', 'f': '%f', 'X': '%Y', 'x': '%Y', 'v': '%j'
  };

  function mysqlDateToStrftime(fmt) {
    var out = '', i = 0;
    while (i < fmt.length) {
      if (fmt[i] === '%' && i + 1 < fmt.length) {
        var k = fmt[i + 1];
        out += DATE_FORMAT_MAP[k] !== undefined ? DATE_FORMAT_MAP[k] : k;
        i += 2;
        continue;
      }
      out += fmt[i];
      i++;
    }
    return out;
  }

  /** 在 sql.js 的 Database 实例上注册 MySQL 专有函数 */
  /* ======================= 7b. 函数实现用的纯 JS 工具 ======================= */

  /** 解析 'YYYY-MM-DD[ HH:MM[:SS]]'；解析不了返回 null */
  function parseDateTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s).trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }

  /** 按月加，日期溢出时向该月最后一天收敛（MySQL 的 DATE_ADD 语义，SQLite 的 '+1 month' 不是） */
  function addMonthsClamped(d, months) {
    var day = d.getDate();
    var t = new Date(d.getTime());
    t.setDate(1);
    t.setMonth(t.getMonth() + months);
    var lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(day, lastDay));
    d.setTime(t.getTime());
  }

  function monthsBetween(lo, hi) {
    var m = (hi.getFullYear() - lo.getFullYear()) * 12 + (hi.getMonth() - lo.getMonth());
    var probe = new Date(lo.getTime());
    addMonthsClamped(probe, m);
    if (probe > hi) m -= 1;
    return m;
  }

  function daysBetween(lo, hi) {
    var a = Date.UTC(lo.getFullYear(), lo.getMonth(), lo.getDate());
    var b = Date.UTC(hi.getFullYear(), hi.getMonth(), hi.getDate());
    return Math.round((b - a) / 86400000);
  }

  /** ISO-8601 周数（周一为一周起点，含 1 月 4 日的那周为第 1 周） */
  function isoWeek(d) {
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);        // 挪到本周周四
    var first = new Date(t.getFullYear(), 0, 4);
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7) + 3);
    return 1 + Math.round((t - first) / (7 * 86400000));
  }

  function dateAddImpl(dateStr, n, unit, sign) {
    if (dateStr === null || dateStr === undefined) return null;
    var d = parseDateTime(dateStr);
    if (!d) return null;
    var u = String(unit === null || unit === undefined ? 'DAY' : unit).toUpperCase();
    if (u.charAt(u.length - 1) === 'S') u = u.slice(0, -1);
    var amount = Number(n) * sign;
    if (!isFinite(amount)) return null;
    var hasTime = /\d{1,2}:\d{2}/.test(String(dateStr));
    if (u === 'YEAR') d.setFullYear(d.getFullYear() + amount);
    else if (u === 'QUARTER') addMonthsClamped(d, amount * 3);
    else if (u === 'MONTH') addMonthsClamped(d, amount);
    else if (u === 'WEEK') d.setDate(d.getDate() + amount * 7);
    else if (u === 'DAY') d.setDate(d.getDate() + amount);
    else if (u === 'HOUR') d.setHours(d.getHours() + amount);
    else if (u === 'MINUTE') d.setMinutes(d.getMinutes() + amount);
    else if (u === 'SECOND') d.setSeconds(d.getSeconds() + amount);
    else if (u === 'MICROSECOND') d.setMilliseconds(d.getMilliseconds() + amount / 1000);
    else return null;
    return hasTime ? fmtLocalDT(d) : fmtLocalDate(d);
  }

  function timestampDiffImpl(unit, a, b) {
    var da = parseDateTime(a), db = parseDateTime(b);
    if (!da || !db) return null;
    var u = String(unit || '').toUpperCase();
    var sign = db < da ? -1 : 1;
    var lo = sign > 0 ? da : db, hi = sign > 0 ? db : da;
    var r;
    if (u === 'YEAR') r = hi.getFullYear() - lo.getFullYear();
    else if (u === 'QUARTER') r = Math.floor(monthsBetween(lo, hi) / 3);
    else if (u === 'MONTH') r = monthsBetween(lo, hi);
    else if (u === 'WEEK') r = Math.floor(daysBetween(lo, hi) / 7);
    else if (u === 'DAY') r = daysBetween(lo, hi);
    else if (u === 'HOUR') r = Math.floor((hi - lo) / 3600000);
    else if (u === 'MINUTE') r = Math.floor((hi - lo) / 60000);
    else if (u === 'SECOND') { r = Math.floor((hi - lo) / 1000); }
    else if (u === 'MICROSECOND') r = (hi - lo) * 1000;
    else return null;
    // 完整单位的判定：不足一个单位要退位（例如 1 月 31 日 → 3 月 1 日 只有 1 个整月）
    if ((u === 'YEAR' || u === 'QUARTER' || u === 'MONTH' || u === 'WEEK' || u === 'DAY') && r > 0) {
      if (u === 'YEAR' || u === 'QUARTER' || u === 'MONTH') {
        // monthsBetween 已做过退位判断
      }
    }
    return r * sign;
  }

  /** 极简 STR_TO_DATE：把 MySQL 格式串翻成正则逐个字段取值 */
  function strToDateImpl(s, fmt) {
    var MAP = {
      '%Y': ['(\\d{4})', 'Y'], '%y': ['(\\d{2})', 'y'], '%m': ['(\\d{1,2})', 'm'], '%c': ['(\\d{1,2})', 'm'],
      '%d': ['(\\d{1,2})', 'd'], '%e': ['(\\d{1,2})', 'd'],
      '%H': ['(\\d{1,2})', 'H'], '%k': ['(\\d{1,2})', 'H'], '%h': ['(\\d{1,2})', 'H'], '%I': ['(\\d{1,2})', 'H'],
      '%i': ['(\\d{1,2})', 'i'], '%s': ['(\\d{1,2})', 's'], '%S': ['(\\d{1,2})', 's'], '%%': ['%', null]
    };
    var rx = '^', order = [], i = 0;
    while (i < fmt.length) {
      var two = fmt.substr(i, 2);
      if (MAP[two]) { rx += MAP[two][0]; order.push(MAP[two][1]); i += 2; continue; }
      rx += fmt.charAt(i).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
    var m = new RegExp(rx + '$').exec(s.trim());
    if (!m) return null;
    var v = { Y: 1970, m: 1, d: 1, H: 0, i: 0, s: 0 }, hasTime = false;
    order.forEach(function (key, idx) {
      if (!key) return;
      var n = Number(m[idx + 1]);
      if (key === 'Y') v.Y = n;
      else if (key === 'y') v.Y = 2000 + n;
      else if (key === 'm') v.m = n;
      else if (key === 'd') v.d = n;
      else if (key === 'H') { v.H = n; hasTime = true; }
      else if (key === 'i') { v.i = n; hasTime = true; }
      else if (key === 's') { v.s = n; hasTime = true; }
    });
    return { date: new Date(v.Y, v.m - 1, v.d, v.H, v.i, v.s), hasTime: hasTime };
  }

  var DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /* ---- 哈希：浏览器里没有同步的 crypto，这里用标准算法纯 JS 实现 ---- */

  function utf8Bytes(str) {
    var out = [], s = String(str);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function b2h(n) { return ('0' + (n & 0xff).toString(16)).slice(-2); }
  function leHex(words) {
    var out = '';
    words.forEach(function (w) { for (var i = 0; i < 4; i++) out += b2h(w >>> (8 * i)); });
    return out;
  }
  function beHex(words) {
    var out = '';
    words.forEach(function (w) { for (var i = 3; i >= 0; i--) out += b2h(w >>> (8 * i)); });
    return out;
  }
  function padMessage(bytes, bitLen, littleEndian) {
    var msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    var i;
    if (littleEndian) {
      for (i = 0; i < 4; i++) msg.push((lo >>> (8 * i)) & 0xff);
      for (i = 0; i < 4; i++) msg.push((hi >>> (8 * i)) & 0xff);
    } else {
      for (i = 3; i >= 0; i--) msg.push((hi >>> (8 * i)) & 0xff);
      for (i = 3; i >= 0; i--) msg.push((lo >>> (8 * i)) & 0xff);
    }
    return msg;
  }

  function md5Hex(str) {
    var bytes = utf8Bytes(str);
    var msg = padMessage(bytes, bytes.length * 8, true);
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = [];
    for (var k = 0; k < 64; k++) K[k] = Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296) >>> 0;
    var add = function () {
      var s = 0;
      for (var i = 0; i < arguments.length; i++) s = (s + arguments[i]) >>> 0;
      return s;
    };
    var shl = function (x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; };
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var off = 0; off < msg.length; off += 64) {
      var M = [];
      for (var i = 0; i < 16; i++) {
        M[i] = (msg[off + i * 4] | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24)) >>> 0;
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (var r = 0; r < 64; r++) {
        var F, g;
        if (r < 16) { F = (B & C) | (~B & D); g = r; }
        else if (r < 32) { F = (D & B) | (~D & C); g = (5 * r + 1) % 16; }
        else if (r < 48) { F = B ^ C ^ D; g = (3 * r + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * r) % 16; }
        F = add(F >>> 0, A, K[r], M[g]);
        A = D; D = C; C = B;
        B = add(B, shl(F, S[r]));
      }
      a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
    }
    return leHex([a0, b0, c0, d0]);
  }

  function sha1Hex(str) {
    var bytes = utf8Bytes(str);
    var msg = padMessage(bytes, bytes.length * 8, false);
    var h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    var w = new Array(80);
    var rol = function (x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; };
    for (var off = 0; off < msg.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = ((msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3]) >>> 0;
      }
      for (var t = 16; t < 80; t++) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
      for (var r = 0; r < 80; r++) {
        var f, k;
        if (r < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (r < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (r < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        var tmp = (rol(a, 5) + (f >>> 0) + (e >>> 0) + k + w[r]) >>> 0;
        e = d; d = c; c = rol(b, 30); b = a; a = tmp;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
    }
    return beHex(h);
  }

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256Hex(str, truncateBits) {
    var bytes = utf8Bytes(str);
    var msg = padMessage(bytes, bytes.length * 8, false);
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    var rr = function (x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; };
    for (var off = 0; off < msg.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = ((msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3]) >>> 0;
      }
      for (var t = 16; t < 64; t++) {
        var s0 = (rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
        var s1 = (rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (var r = 0; r < 64; r++) {
        var S1 = (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (hh + S1 + ch + SHA256_K[r] + w[r]) >>> 0;
        var S0 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) >>> 0;
        var mj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + mj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var full = beHex(h);
    if (truncateBits === 224) return full.slice(0, 56);
    if (truncateBits === 384) {
      // SHA-384 用另一组初值，这里不实现；调用方会退回 SHA-256
      return null;
    }
    return full;
  }

  function registerMySQLFunctions(db, dbName, state) {
    var fnErrors = [];
    // 会话级信息，供 LAST_INSERT_ID() / ROW_COUNT() / FOUND_ROWS() 读取（由 runOne 维护）
    var infoState = state || { lastInsertId: 0, rowCount: 0, foundRows: 0 };
    var def = function (name, fn) {
      try { db.create_function(name, fn); }
      catch (e) { fnErrors.push(name + ': ' + (e && e.message ? e.message : e)); }
    };

    /**
     * 变参函数注册器。
     *
     * sql.js 的 Database.create_function 用 **JS 函数的形参个数** 当注册的 nArg
     * （见 vendor/sql-wasm.js：`tb(this.db, g, l.length, 1, 0, n, 0, 0, 0)`）。
     * 于是 `function () {...}` 这种变参惯用写法会被注册成 0 元函数，后果分两种：
     *   · SQLite 里有同名内建（concat / concat_ws）→ 静默回落到内建语义，
     *     例如 CONCAT('a', NULL) 返回 'a'，而 MySQL 应该返回 NULL；
     *   · SQLite 里没有同名内建（GREATEST / LEAST）→ 一调用就报
     *     "wrong number of arguments to function GREATEST()"。
     * 修法：按 1..N 逐个元数各注册一次（SQLite 优先匹配精确元数的实现）。
     */
    var ARITY_FACTORY = [
      null,
      function (f) { return function (a) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j, k) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j, k, l) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j, k, l, m) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j, k, l, m, n) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j, k, l, m, n, o) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j, k, l, m, n, o, p) { return f.apply(null, arguments); }; },
      function (f) { return function (a, b, c, d, e, g, h, i, j, k, l, m, n, o, p, q) { return f.apply(null, arguments); }; }
    ];
    var defVariadic = function (name, fn, maxArgs) {
      var top = Math.min(maxArgs || (ARITY_FACTORY.length - 1), ARITY_FACTORY.length - 1);
      for (var n = 1; n <= top; n++) def(name, ARITY_FACTORY[n](fn));
    };
    /** 只接受 0 参、但 MySQL 允许写精度的函数（NOW(6) / CURDATE() 等） */
    var def0or1 = function (name, fn) {
      def(name, function () { return fn(); });
      def(name, function (prec) { return fn(); });
    };

    def('VERSION', function () { return SERVER_VERSION_FULL; });
    def('DATABASE', function () { return dbName; });
    def('SCHEMA', function () { return dbName; });
    def('USER', function () { return CURRENT_USER; });
    def('CURRENT_USER', function () { return CURRENT_USER; });
    def('SESSION_USER', function () { return CURRENT_USER; });
    def('SYSTEM_USER', function () { return CURRENT_USER; });
    def0or1('NOW', function () { return fmtLocalDT(new Date()); });
    def0or1('LOCALTIME', function () { return fmtLocalDT(new Date()); });
    def0or1('LOCALTIMESTAMP', function () { return fmtLocalDT(new Date()); });
    def0or1('SYSDATE', function () { return fmtLocalDT(new Date()); });
    def0or1('CURDATE', function () { return fmtLocalDate(new Date()); });
    def0or1('CURTIME', function () { return fmtLocalTime(new Date()); });
    def('CONNECTION_ID', function () { return CONNECTION_ID; });
    defVariadic('CONCAT', function () {
      var a = Array.prototype.slice.call(arguments);
      // MySQL：只要有一个参数是 NULL，整个结果就是 NULL
      if (a.some(function (x) { return x === null || x === undefined; })) return null;
      return a.join('');
    });
    defVariadic('CONCAT_WS', function () {
      var a = Array.prototype.slice.call(arguments);
      var sep = a.shift();
      if (sep === null || sep === undefined) return null;
      return a.filter(function (x) { return x !== null && x !== undefined; }).join(sep);
    });
    def('IF', function (c, a, b) { return (c && c !== 0 && c !== '0') ? a : b; });
    // MySQL：X REGEXP Y / X RLIKE Y —— SQLite 内部按 regexp(Y, X) 调用，pattern 在前
    def('REGEXP', function (pat, s) {
      if (pat === null || pat === undefined || s === null || s === undefined) return null;
      try { return new RegExp(String(pat), 'i').test(String(s)) ? 1 : 0; } catch (e) { return 0; }
    });
    // MySQL FIELD(): 返回第一个参数在后续参数列表中首次出现的位置（从 1 开始），没有则 0
    // FIELD 主要靠 translateStatement 展开成 CASE；这里再按元数注册一份，
    // 保证在没被改写到的位置（例如嵌套在别的函数里）也能用。
    defVariadic('FIELD', function () {
      var a = Array.prototype.slice.call(arguments);
      var target = a.shift();
      if (target === null || target === undefined) return 0;
      for (var i = 0; i < a.length; i++) {
        if (a[i] !== null && a[i] !== undefined && String(a[i]) === String(target)) return i + 1;
      }
      return 0;
    });
    def('IFNULL', function (a, b) { return (a === null || a === undefined) ? b : a; });
    def('NULLIF', function (a, b) { return a === b ? null : a; });
    def('LEFT', function (s, n) { return s === null || s === undefined ? null : String(s).slice(0, Math.max(0, n | 0)); });
    def('RIGHT', function (s, n) { return s === null || s === undefined ? null : String(s).slice(-Math.max(0, n | 0)); });
    // SUBSTRING / SUBSTR / MID：MySQL 允许 2 参写法（SUBSTRING(s,p)），
    // 旧实现声明成 (s,p,n) → 只注册了 3 元，2 参调用会掉到 SQLite 内建上去。
    var subImpl = function (s, p, n) {
      if (s === null || s === undefined) return null;
      var str = String(s);
      p = p === null || p === undefined ? 1 : (p | 0);
      if (n === undefined || n === null) return p > 0 ? str.slice(p - 1) : str.slice(p);
      return p > 0 ? str.substr(p - 1, n) : str.substr(p, n);
    };
    def('MID', function (s, p) { return subImpl(s, p); });
    def('MID', function (s, p, n) { return subImpl(s, p, n); });
    def('SUBSTRING', function (s, p) { return subImpl(s, p); });
    def('SUBSTRING', function (s, p, n) { return subImpl(s, p, n); });
    def('SUBSTR', function (s, p) { return subImpl(s, p); });
    def('SUBSTR', function (s, p, n) { return subImpl(s, p, n); });

    // LOCATE：两参版 LOCATE(sub, str) 在 MySQL 里合法（旧实现只注册了 3 元）
    var locImpl = function (sub, str, pos) {
      if (sub === null || str === null || sub === undefined || str === undefined) return null;
      var p = String(str).indexOf(String(sub), pos ? pos - 1 : 0);
      return p < 0 ? 0 : p + 1;
    };
    def('LOCATE', function (sub, str) { return locImpl(sub, str); });
    def('LOCATE', function (sub, str, pos) { return locImpl(sub, str, pos); });
    def('UCASE', function (s) { return s === null || s === undefined ? null : String(s).toUpperCase(); });
    def('LCASE', function (s) { return s === null || s === undefined ? null : String(s).toLowerCase(); });
    def('CHAR_LENGTH', function (s) { return s === null || s === undefined ? null : Array.from(String(s)).length; });
    def('CHARACTER_LENGTH', function (s) { return s === null || s === undefined ? null : Array.from(String(s)).length; });
    def('LENGTH', function (s) {
      if (s === null || s === undefined) return null;
      try { return new TextEncoder().encode(String(s)).length; } catch (e) { return String(s).length; }
    });
    def('LPAD', function (s, n, p) {
      if (s === null || s === undefined) return null;
      s = String(s); p = p === undefined || p === '' ? ' ' : String(p); n = n | 0;
      while (dispWidth(s) < n) s = p + s;
      return s.length > n * 2 ? s : s;
    });
    def('RPAD', function (s, n, p) {
      if (s === null || s === undefined) return null;
      s = String(s); p = p === undefined || p === '' ? ' ' : String(p); n = n | 0;
      while (dispWidth(s) < n) s = s + p;
      return s;
    });
    def('RAND', function () { return Math.random(); });
    var extremes = function (which) {
      return function () {
        var a = Array.prototype.slice.call(arguments);
        // MySQL：任一参数为 NULL 就返回 NULL（旧实现是把 NULL 过滤掉，语义不对）
        for (var i = 0; i < a.length; i++) if (a[i] === null || a[i] === undefined) return null;
        if (!a.length) return null;
        var allNum = a.every(function (x) { return String(x).trim() !== '' && isFinite(Number(x)); });
        if (allNum) {
          var nums = a.map(Number);
          return which === 'max' ? Math.max.apply(null, nums) : Math.min.apply(null, nums);
        }
        var strs = a.map(String).sort(function (x, y) {
          var lx = x.toLowerCase(), ly = y.toLowerCase();
          return lx < ly ? -1 : (lx > ly ? 1 : 0);
        });
        return which === 'max' ? strs[strs.length - 1] : strs[0];
      };
    };
    defVariadic('GREATEST', extremes('max'));
    defVariadic('LEAST', extremes('min'));
    def('UUID', function () {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
      });
    });
    def('UNIX_TIMESTAMP', function (d) {
      var t = d ? Date.parse(String(d).replace(' ', 'T')) : Date.now();
      if (isNaN(t)) return null;
      return Math.floor(t / 1000);
    });
    def('FROM_UNIXTIME', function (ts) {
      if (ts === null || ts === undefined) return null;
      return fmtLocalDT(new Date(Number(ts) * 1000));
    });
    def('DATE_FORMAT', function (d, f) {
      if (d === null || d === undefined || f === null || f === undefined) return null;
      var t = Date.parse(String(d).replace(' ', 'T'));
      if (isNaN(t)) return null;
      return sqliteStrftime(mysqlDateToStrftime(String(f)), new Date(t));
    });
    def('YEAR', function (d) { return d ? Number(String(d).slice(0, 4)) : null; });
    def('MONTH', function (d) { return d ? Number(String(d).slice(5, 7)) : null; });
    def('DAY', function (d) { return d ? Number(String(d).slice(8, 10)) : null; });
    def('DAYOFMONTH', function (d) { return d ? Number(String(d).slice(8, 10)) : null; });
    def('HOUR', function (d) { return d ? Number(String(d).slice(11, 13)) : null; });
    def('MINUTE', function (d) { return d ? Number(String(d).slice(14, 16)) : null; });
    def('SECOND', function (d) { return d ? Number(String(d).slice(17, 19)) : null; });
    def('LAST_DAY', function (d) {
      if (!d) return null;
      var t = Date.parse(String(d).replace(' ', 'T'));
      if (isNaN(t)) return null;
      var dt = new Date(t);
      var last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
      return fmtLocalDate(last);
    });

    // MySQL 的 FORMAT(x, d)：四舍五入到 d 位并加千分位（旧实现其实落到了 SQLite 的 printf 上，
    // 原样返回，等于"假装成功"）
    def('FORMAT', function (x, d) {
      if (x === null || x === undefined) return null;
      var n = Number(x);
      if (!isFinite(n)) return '0';
      var dec = (d === null || d === undefined) ? 0 : Math.max(0, Math.min(30, d | 0));
      var neg = n < 0;
      var parts = Math.abs(n).toFixed(dec).split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return (neg ? '-' : '') + parts.join('.');
    });

    /* ---- 日期时间 ---- */
    def('DATEDIFF', function (a, b) {
      var da = parseDateTime(a), db = parseDateTime(b);
      if (!da || !db) return null;
      return daysBetween(db, da);
    });
    def('MYSQL_DATE_ADD', function (d, n, unit) { return dateAddImpl(d, n, unit, 1); });
    def('MYSQL_DATE_SUB', function (d, n, unit) { return dateAddImpl(d, n, unit, -1); });
    def('MYSQL_TSDIFF', function (unit, a, b) { return timestampDiffImpl(unit, a, b); });
    def('DAYNAME', function (d) {
      var x = parseDateTime(d);
      return x ? DAY_NAMES[(x.getDay() + 6) % 7] : null;
    });
    def('MONTHNAME', function (d) {
      var x = parseDateTime(d);
      return x ? MONTH_NAMES[x.getMonth()] : null;
    });
    def('QUARTER', function (d) {
      var x = parseDateTime(d);
      return x ? Math.floor(x.getMonth() / 3) + 1 : null;
    });
    def('DAYOFYEAR', function (d) {
      var x = parseDateTime(d);
      if (!x) return null;
      return Math.floor((Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) - Date.UTC(x.getFullYear(), 0, 1)) / 86400000) + 1;
    });
    def('DAYOFWEEK', function (d) { var x = parseDateTime(d); return x ? x.getDay() + 1 : null; });   // 1=周日
    def('WEEKDAY', function (d) { var x = parseDateTime(d); return x ? (x.getDay() + 6) % 7 : null; }); // 0=周一
    def('DAYOFMONTH', function (d) { var x = parseDateTime(d); return x ? x.getDate() : null; });
    // WEEK(date[,mode])：实现 MySQL 默认的 mode=0（周日为一周起点，第一周从首个周日算起）。
    // 注意要注册 1 元和 2 元两种（sql.js 用 fn.length 当 nArg）。
    var weekImpl = function (d, mode) {
      var x = parseDateTime(d);
      if (!x) return null;
      if (mode === 3) return isoWeek(x);
      var doy = Math.floor((Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) - Date.UTC(x.getFullYear(), 0, 1)) / 86400000) + 1;
      return Math.floor((doy + 6 - (x.getDay() + 1)) / 7);
    };
    def('WEEK', function (d) { return weekImpl(d); });
    def('WEEK', function (d, mode) { return weekImpl(d, mode); });
    def('WEEKOFYEAR', function (d) { var x = parseDateTime(d); return x ? isoWeek(x) : null; });
    def('STR_TO_DATE', function (s, fmt) {
      if (s === null || s === undefined || fmt === null || fmt === undefined) return null;
      var r = strToDateImpl(String(s), String(fmt));
      if (!r) return null;
      return r.hasTime ? fmtLocalDT(r.date) : fmtLocalDate(r.date);
    });
    def('TIME_TO_SEC', function (t) {
      if (t === null || t === undefined) return null;
      var m = /(\d{1,3}):(\d{2}):?(\d{2})?/.exec(String(t));
      return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null;
    });
    def('SEC_TO_TIME', function (s) {
      if (s === null || s === undefined) return null;
      var n = Math.floor(Number(s)), neg = n < 0;
      n = Math.abs(n);
      var p = function (x) { return (x < 10 ? '0' : '') + x; };
      return (neg ? '-' : '') + p(Math.floor(n / 3600)) + ':' + p(Math.floor(n / 60) % 60) + ':' + p(n % 60);
    });

    /* ---- 字符串 ---- */
    def('SUBSTRING_INDEX', function (str, delim, count) {
      if (str === null || str === undefined || delim === null || delim === undefined) return null;
      var s = String(str), d = String(delim), n = Number(count);
      if (!isFinite(n) || n === 0 || d === '') return '';
      var parts = s.split(d);
      return n > 0 ? parts.slice(0, n).join(d) : parts.slice(n).join(d);
    });
    defVariadic('ELT', function () {
      var a = Array.prototype.slice.call(arguments);
      var n = Number(a.shift());
      if (!isFinite(n) || n < 1 || n > a.length) return null;
      return a[n - 1];
    });
    def('FIND_IN_SET', function (x, list) {
      if (x === null || x === undefined || list === null || list === undefined) return null;
      var parts = String(list).split(',');
      for (var i = 0; i < parts.length; i++) if (parts[i] === String(x)) return i + 1;
      return 0;
    });
    def('ASCII', function (s) {
      if (s === null || s === undefined) return null;
      var b = utf8Bytes(String(s));
      return b.length ? b[0] : 0;
    });
    defVariadic('CHAR', function () {
      var a = Array.prototype.slice.call(arguments);
      return a.map(function (n) { return String.fromCharCode(Number(n) & 0xff); }).join('');
    });
    def('HEX', function (v) {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' || /^-?\d+$/.test(String(v))) {
        var n = Math.trunc(Number(v));
        return (n < 0 ? 'FFFFFFFFFFFFFFFF' : '') + (n >>> 0).toString(16).toUpperCase();
      }
      var b = utf8Bytes(String(v));
      return b.map(function (x) { return b2h(x); }).join('').toUpperCase();
    });
    def('UNHEX', function (s) {
      if (s === null || s === undefined) return null;
      var h = String(s);
      if (h.length % 2 || /[^0-9a-f]/i.test(h)) return null;
      var out = '';
      for (var i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
      return out;
    });
    def('MD5', function (s) { return s === null || s === undefined ? null : md5Hex(String(s)); });
    def('SHA1', function (s) { return s === null || s === undefined ? null : sha1Hex(String(s)); });
    def('SHA', function (s) { return s === null || s === undefined ? null : sha1Hex(String(s)); });
    def('SHA2', function (s, bits) {
      if (s === null || s === undefined) return null;
      var b = Number(bits) || 256;
      if (b === 224) return sha256Hex(String(s), 224);
      if (b === 256 || b === 0) return sha256Hex(String(s));
      return null;   // 384 / 512 未实现，返回 NULL 而不是编一个假摘要
    });
    def('CONV', function (n, from, to) {
      if (n === null || n === undefined) return null;
      var f = Number(from) || 10, t = Number(to) || 10;
      var v = parseInt(String(n).replace(/^[-+]/, ''), f);
      if (!isFinite(v)) return '0';
      var neg = /^-/.test(String(n).trim());
      return (neg ? '-' : '') + v.toString(t).toUpperCase();
    });
    def('MYSQL_INSERT', function (str, pos, len, newstr) {
      if (str === null || str === undefined) return null;
      var s = String(str), p = Number(pos) | 0, l = Number(len) | 0;
      if (p < 1 || p > s.length) return s;
      if (l < 0 || p + l - 1 > s.length) l = s.length - p + 1;
      var rep = newstr === null || newstr === undefined ? '' : String(newstr);
      return s.slice(0, p - 1) + rep + s.slice(p - 1 + l);
    });
    def('SPACE', function (n) {
      if (n === null || n === undefined) return null;
      var c = Number(n);
      return c > 0 ? new Array(Math.floor(c) + 1).join(' ') : '';
    });
    def('BIN', function (n) { return n === null || n === undefined ? null : (Math.trunc(Number(n)) >>> 0).toString(2); });
    def('OCT', function (n) { return n === null || n === undefined ? null : (Math.trunc(Number(n)) >>> 0).toString(8); });

    /* ---- 数值 ---- */
    def('MOD', function (a, b) {
      if (a === null || a === undefined || b === null || b === undefined) return null;
      var x = Number(a), y = Number(b);
      if (!isFinite(x) || !isFinite(y) || y === 0) return null;
      return x % y;
    });
    def('POW', function (a, b) { return a === null || b === null ? null : Math.pow(Number(a), Number(b)); });
    def('POWER', function (a, b) { return a === null || b === null ? null : Math.pow(Number(a), Number(b)); });
    def('TRUNCATE', function (x, d) {
      if (x === null || x === undefined) return null;
      var n = Number(x), dec = Number(d) | 0;
      var m = Math.pow(10, dec);
      return Math.trunc(n * m) / m;
    });
    def('SIGN', function (x) { return x === null || x === undefined ? null : (Number(x) > 0 ? 1 : (Number(x) < 0 ? -1 : 0)); });
    def('ISNULL', function (x) { return (x === null || x === undefined) ? 1 : 0; });

    /* ---- 会话信息 ---- */
    def('LAST_INSERT_ID', function () { return infoState.lastInsertId || 0; });
    def('ROW_COUNT', function () { return infoState.rowCount || 0; });
    def('FOUND_ROWS', function () { return infoState.foundRows || 0; });
    def('UUID_SHORT', function () {
      return Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
    });
    def('INET_ATON', function (ip) {
      if (ip === null || ip === undefined) return null;
      var p = String(ip).split('.');
      if (p.length !== 4) return null;
      return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | (+p[3])) >>> 0;
    });
    def('INET_NTOA', function (n) {
      if (n === null || n === undefined) return null;
      var v = Number(n) >>> 0;
      return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
    });
    // BENCHMARK 在 MySQL 里恒返回 0；SLEEP 在真实 MySQL 里会阻塞，浏览器里不能阻塞 UI，
    // 所以两者都"接受语法、返回 MySQL 的返回值"，但不做真实计时（也不假装做了）。
    def('BENCHMARK', function () { return 0; });
    def('SLEEP', function () { return 0; });
    def('GET_LOCK', function () { return 1; });          // 单连接：锁总是能拿到
    def('RELEASE_LOCK', function () { return 1; });
    def('IS_FREE_LOCK', function () { return 1; });
    def('IS_USED_LOCK', function () { return null; });

    /* ---- 统计聚合（Welford 在线算法） ---- */
    var varianceAgg = function (sample) {
      return {
        init: function () { return { n: 0, mean: 0, m2: 0 }; },
        step: function (st, v) {
          if (v === null || v === undefined) return st;
          var x = Number(v);
          if (!isFinite(x)) return st;
          st.n++;
          var d = x - st.mean;
          st.mean += d / st.n;
          st.m2 += d * (x - st.mean);
          return st;
        },
        finalize: function (st) {
          if (!st || st.n === 0) return null;
          if (st.n === 1) return sample ? 0 : 0;
          return sample ? st.m2 / (st.n - 1) : st.m2 / st.n;
        }
      };
    };
    var defAgg = function (name, spec) {
      try { db.create_aggregate(name, spec); }
      catch (e) { fnErrors.push(name + ': ' + (e && e.message ? e.message : e)); }
    };
    var sqrtAgg = function (spec) {
      var fin = spec.finalize;
      return {
        init: spec.init, step: spec.step,
        finalize: function (st) { var v = fin(st); return v === null ? null : Math.sqrt(v); }
      };
    };
    defAgg('VARIANCE', varianceAgg(true));
    defAgg('VAR_SAMP', varianceAgg(true));
    defAgg('VAR_POP', varianceAgg(false));
    defAgg('STDDEV', sqrtAgg(varianceAgg(true)));
    defAgg('STDDEV_SAMP', sqrtAgg(varianceAgg(true)));
    defAgg('STDDEV_POP', sqrtAgg(varianceAgg(false)));

    try { db.__mysqlFnErrors = fnErrors; } catch (e) { /* 仅供测试观察注册失败 */ }
  }

  /** 极简 strftime 实现（不依赖 SQLite 的 strftime，避免依赖注册时机） */
  function sqliteStrftime(fmt, d) {
    function p(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var map = {
      '%Y': String(d.getFullYear()), '%y': p(d.getFullYear() % 100),
      '%m': p(d.getMonth() + 1), '%d': p(d.getDate()), '%e': String(d.getDate()),
      '%H': p(d.getHours()), '%I': p((d.getHours() % 12) || 12), '%M': p(d.getMinutes()),
      '%S': p(d.getSeconds()), '%p': d.getHours() < 12 ? 'AM' : 'PM',
      '%A': DAYS[d.getDay()], '%a': DAYS[d.getDay()].slice(0, 3),
      '%B': MON[d.getMonth()], '%b': MON[d.getMonth()].slice(0, 3),
      '%j': p(Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000), 3),
      '%w': String(d.getDay()), '%W': DAYS[d.getDay()],
      '%H:%M:%S': p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()),
      '%I:%M:%S %p': p((d.getHours() % 12) || 12) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + (d.getHours() < 12 ? 'AM' : 'PM'),
      '%f': p(d.getMilliseconds(), 3), '%%': '%'
    };
    return fmt.replace(/%(?:Y|y|m|d|e|H|I|M|S|p|A|a|B|b|j|w|W|f|H:%M:%S|I:%M:%S %p|%)/g, function (k) {
      return map[k] !== undefined ? map[k] : k;
    });
  }

  /* ======================= 8. 虚拟结果集构造 ======================= */

  function rs(columns, values) { return { columns: columns, values: values }; }

  /* ---- 8.2a SHOW 系列共用的小工具 ---- */

  /** 把 `db`.`tbl` / db.tbl / `tbl` / tbl 拆成 { db, table }（db 为 null 表示未限定库） */
  function splitDbTable(token) {
    var t = stripQuotes(String(token === undefined || token === null ? '' : token).trim());
    var dot = t.indexOf('.');
    if (dot < 0) return { db: null, table: t };
    return { db: stripQuotes(t.slice(0, dot).trim()), table: stripQuotes(t.slice(dot + 1).trim()) };
  }

  /** MySQL 的 LIKE 模式 → 正则：% 匹配任意长，_ 匹配单个字符，其余按字面量 */
  function likeRegex(pattern) {
    return new RegExp('^' + String(pattern)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.') + '$', 'i');
  }

  /** SHOW ... WHERE 里的字面量；无法解析时返回 undefined */
  function showOperand(text) {
    var t = String(text).trim();
    if (/^NULL$/i.test(t)) return null;
    if (/^'(?:[^']|'')*'$/.test(t)) return t.slice(1, -1).split("''").join("'");
    if (/^"(?:[^"]|"")*"$/.test(t)) return t.slice(1, -1).split('""').join('"');
    if (/^[-+]?\d+(?:\.\d+)?$/.test(t)) return Number(t);
    return undefined;
  }

  /** SHOW ... WHERE 的单个比较：能当数字比就按数字比，否则按不区分大小写的字符串比 */
  function showCompare(a, b, op) {
    var na = Number(a), nb = Number(b);
    var numeric = a !== null && a !== undefined && b !== null && b !== undefined &&
      String(a).trim() !== '' && String(b).trim() !== '' && isFinite(na) && isFinite(nb);
    var x = numeric ? na : (a === null || a === undefined ? null : String(a).toLowerCase());
    var y = numeric ? nb : (b === null || b === undefined ? null : String(b).toLowerCase());
    if (op === '=') return x === y;
    if (op === '!=' || op === '<>') return x !== y;
    if (x === null || y === null) return false;
    if (op === '<') return x < y;
    if (op === '<=') return x <= y;
    if (op === '>') return x > y;
    if (op === '>=') return x >= y;
    return true;
  }

  /**
   * 对 SHOW 系列的结果行做 LIKE / WHERE 过滤。
   * 返回 { rows, unsupported }：unsupported 为 true 表示 WHERE 太复杂、没能过滤，
   * 调用方要如实提示，而不是假装过滤过了。
   */
  function filterShowRows(rows, tail, colNames) {
    var t = String(tail || '');
    var mL = /\bLIKE\s+'((?:[^']|'')*)'/i.exec(t);
    if (mL) {
      var rx = likeRegex(mL[1].split("''").join("'"));
      return { rows: rows.filter(function (r) { return rx.test(String(r[0])); }), unsupported: false };
    }
    var mW = /\bWHERE\s+([\s\S]+)$/i.exec(t);
    if (!mW) return { rows: rows, unsupported: false };

    var out = rows, ok = true;
    String(mW[1]).split(/\s+AND\s+/i).forEach(function (cond) {
      if (!ok) return;
      var m = /^\s*`?([A-Za-z0-9_$]+)`?\s*(<=|>=|<>|!=|=|<|>)\s*(.+?)\s*$/.exec(cond);
      if (!m) { ok = false; return; }
      var idx = -1;
      for (var i = 0; i < colNames.length; i++) {
        if (String(colNames[i]).toLowerCase() === m[1].toLowerCase()) idx = i;
      }
      if (idx < 0) { ok = false; return; }
      var want = showOperand(m[3]);
      if (want === undefined) { ok = false; return; }
      var op = m[2];
      out = out.filter(function (r) { return showCompare(r[idx], want, op); });
    });
    return { rows: out, unsupported: !ok };
  }

  /** SHOW ... WHERE 条件超出解析能力时的统一提示（如实说明，而不是假装过滤过了） */
  var SHOW_FILTER_NOTE = '（提示：该 WHERE 条件超出模拟器的解析范围，因此**没有**做过滤。'
    + '支持 LIKE \'模式\'，以及按列名的简单比较（=、!=、<>、<、<=、>、>=，可用 AND 连接）。）';

  /** 判断一段建表原文是不是 MySQL 风格（seed 数据里存的 raw 是 MySQL 原文，直接回显最保真） */
  function isMySQLFlavoredDDL(raw) {
    var s = String(raw || '');
    if (!/^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(s)) return false;
    return /\bENGINE\s*=|DEFAULT\s+CHARSET|AUTO_INCREMENT|\bCOMMENT\s+'/.test(s);
  }

  /**
   * SHOW CREATE TABLE 的输出。
   * seed 数据里存的 raw 本来就是 MySQL 原文（带 ENGINE/CHARSET/COMMENT），直接回显；
   * 用户自己建的表 raw 是 SQLite 措辞（没有 ENGINE、类型名也不对），这类由 catalog 重新生成。
   */
  function showCreateTable(meta, name) {
    if (meta && meta.raw && isMySQLFlavoredDDL(meta.raw)) return meta.raw;
    if (!meta) return 'CREATE TABLE `' + name + '` ()';
    var q = function (c) { return '`' + c + '`'; };
    var lines = (meta.columns || []).map(function (c) {
      var def = q(c.field) + ' ' + (c.type || 'text');
      def += c.nullable ? ' DEFAULT NULL' : ' NOT NULL';
      if (c.hasDefault && c.defaultValue !== null && c.defaultValue !== undefined &&
          !/^CURRENT_TIMESTAMP$/i.test(String(c.defaultValue))) {
        var dv = String(c.defaultValue);
        def += ' DEFAULT ' + (/^-?\d+(?:\.\d+)?$/.test(dv) ? dv : "'" + dv.replace(/'/g, "''") + "'");
      } else if (c.hasDefault && /^CURRENT_TIMESTAMP$/i.test(String(c.defaultValue))) {
        def += ' DEFAULT CURRENT_TIMESTAMP';
      }
      if (c.extra && /auto_increment/i.test(c.extra)) def += ' AUTO_INCREMENT';
      if (c.comment) def += " COMMENT '" + String(c.comment).replace(/'/g, "''") + "'";
      return def;
    });
    var indexes = meta.indexes || [];
    var hasPk = indexes.some(function (ix) { return ix.primary; });
    indexes.forEach(function (ix) {
      var cols = (ix.columns || []).map(q).join(',');
      if (ix.primary) lines.push('PRIMARY KEY (' + cols + ')');
      else if (ix.unique) lines.push('UNIQUE KEY ' + q(ix.name) + ' (' + cols + ')');
      else lines.push('KEY ' + q(ix.name) + ' (' + cols + ')');
    });
    // 列上内联写的主键（如 `id int PRIMARY KEY`）不会进 indexes，这里补回来
    if (!hasPk) {
      var pkCols = (meta.columns || []).filter(function (c) { return c.key === 'PRI'; }).map(function (c) { return q(c.field); });
      if (pkCols.length) lines.push('PRIMARY KEY (' + pkCols.join(',') + ')');
    }
    (meta.foreignKeys || []).forEach(function (fk) {
      lines.push('CONSTRAINT `fk_' + name + '_' + (fk.columns || []).join('_') + '` FOREIGN KEY (' +
        (fk.columns || []).map(q).join(',') + ') REFERENCES `' + fk.refTable + '` (' +
        (fk.refColumns || []).map(q).join(',') + ')');
    });
    return 'CREATE TABLE `' + name + '` (\n  ' + lines.join(',\n  ') + '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
  }

  /** SHOW COLUMNS / DESC 的结果集；full 为 true 时给出 SHOW FULL COLUMNS 的 9 列 */
  function describeResult(meta, tableName, full) {
    var rows = meta.columns.map(function (c) {
      var dflt = c.hasDefault ? (c.defaultValue === null ? 'NULL' : c.defaultValue) : 'NULL';
      if (full) {
        var collation = /char|text|enum|set/i.test(String(c.type)) ? 'utf8mb4_0900_ai_ci' : null;
        return [c.field, c.type, collation, c.nullable ? 'YES' : 'NO', c.key || '', dflt,
          c.extra || '', 'select,insert,update,references', c.comment || ''];
      }
      return [c.field, c.type, c.nullable ? 'YES' : 'NO', c.key || '', dflt, c.extra || ''];
    });
    return full
      ? rs(['Field', 'Type', 'Collation', 'Null', 'Key', 'Default', 'Extra', 'Privileges', 'Comment'], rows)
      : rs(['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'], rows);
  }

  function indexesResult(meta, tableName) {
    var rows = [];
    (meta.indexes || []).forEach(function (ix) {
      (ix.columns || []).forEach(function (c, i) {
        rows.push([tableName, ix.unique ? 0 : 1, ix.name || c, i + 1, c, 'A', 0, null, null, 'BTREE', '']);
      });
    });
    return rs(['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name', 'Collation', 'Cardinality', 'Sub_part', 'Packed', 'Index_type', 'Comment'], rows);
  }

  /* ---- 8.2b 视图：SQLite 的类型名还原成 MySQL 习惯写法 ---- */

  var SQLITE_TO_MYSQL_TYPE = {
    integer: 'int(11)', bigint: 'bigint(20)', smallint: 'smallint(6)', tinyint: 'tinyint(4)',
    real: 'double', 'double precision': 'double', float: 'float', numeric: 'decimal(10,0)',
    boolean: 'tinyint(1)', blob: 'blob', clob: 'text'
  };

  function normalizeViewType(t) {
    var s = String(t).trim();
    var key = s.toLowerCase().replace(/\s+/g, ' ');
    if (SQLITE_TO_MYSQL_TYPE[key]) return SQLITE_TO_MYSQL_TYPE[key];
    return s.toLowerCase().replace(/\s+/g, '');
  }

  /** 取视图 SELECT 列表的项目文本（顶层逗号切分） */
  function viewSelectItems(viewSql) {
    var s = String(viewSql || '');
    var asIdx = topLevelKeywordIndex(s, 'AS');
    if (asIdx < 0) return [];
    s = s.slice(asIdx + 2).replace(/^\s+/, '');
    if (!/^SELECT\b/i.test(s)) return [];
    s = s.replace(/^\s*SELECT\s+/i, '');
    var fromIdx = topLevelKeywordIndex(s, 'FROM');
    if (fromIdx > -1) s = s.slice(0, fromIdx);
    return splitTopLevel(s).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /** 计算列的兜底类型推断：只在 PRAGMA 拿不到声明类型时使用 */
  function inferExprType(expr) {
    var e = String(expr).replace(/\s+AS\s+`?[A-Za-z0-9_$]+`?\s*$/i, '').trim();
    if (/\bCOUNT\s*\(/i.test(e)) return 'bigint(21)';
    if (/\b(AVG|ROUND|ABS|MAX|MIN)\s*\(/i.test(e)) return 'decimal(20,4)';
    if (/\bSUM\s*\(/i.test(e)) return 'decimal(32,0)';
    if (/[+\-*/]|[|]{2}/.test(e)) return 'bigint(21)';
    return 'varchar(255)';
  }

  function viewColumnHints(viewSql) {
    var items = viewSelectItems(viewSql);
    return items.map(inferExprType);
  }

  /** 把 SQLite 风格的 CREATE VIEW 还原成 MySQL 习惯的 SHOW CREATE VIEW 输出 */
  function mysqlViewDDL(name, sqliteSql) {
    var body = String(sqliteSql || '');
    var m = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|[A-Za-z0-9_$]+)\s*(\([^)]*\))?\s+AS\s+([\s\S]*)$/i.exec(body);
    var cols = m && m[2] ? ' ' + m[2] : '';
    var sel = m ? m[3].trim() : body.trim();
    return 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `' +
      name + '`' + cols + ' AS ' + sel + ' WITH CASCADED CHECK OPTION';
  }

  /* ---- 8.3 明确不支持、但要说清原因的语句（避免伪装成 1064 语法错误）---- */

  var UNSUPPORTED_STATEMENTS = [
    [/^\s*ALTER\s+TABLE\s+[\s\S]*\bADD\s+(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\b/i,
      'ALTER TABLE ... ADD PRIMARY KEY', '底层引擎无法为已存在的表追加主键（需要重建整张表）'],
    [/^\s*(?:CREATE(?:\s+OR\s+REPLACE)?|ALTER|DROP)\s+(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i,
      'CREATE / ALTER / DROP PROCEDURE / FUNCTION / TRIGGER / EVENT', '存储过程、自定义函数、触发器、事件均未实现'],
    [/^\s*CALL\b/i,
      'CALL', '存储过程未实现，因此没有可调用的过程'],
    [/^\s*(?:PREPARE|EXECUTE|DEALLOCATE\s+PREPARE)\b/i,
      'PREPARE / EXECUTE / DEALLOCATE', '预处理语句未实现'],
    [/^\s*(?:GRANT|REVOKE)\b/i,
      'GRANT / REVOKE', '模拟器不做权限校验，所有语句都以 root@localhost 执行'],
    [/^\s*(?:CREATE|DROP|ALTER)\s+USER\b|^\s*SET\s+PASSWORD\b/i,
      'CREATE / DROP / ALTER USER、SET PASSWORD', '不实现用户与账号管理'],
    [/^\s*(?:LOAD\s+DATA|LOAD\s+XML)\b/i,
      'LOAD DATA', '浏览器沙箱内无法读取本地文件'],
    [/^\s*SELECT\b[\s\S]*\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i,
      'SELECT ... INTO OUTFILE', '浏览器沙箱内无法写本地文件'],
    [/^\s*(?:UPDATE|DELETE)\b[\s\S]*\bJOIN\b/i,
      '多表写（UPDATE/DELETE ... JOIN）', '底层只支持单表写；可改写成 WHERE EXISTS (SELECT 1 FROM ...) 形式'],
    [/^\s*SELECT\b[\s\S]*\bWITH\s+ROLLUP\b/i,
      'GROUP BY ... WITH ROLLUP', '底层不会自动生成小计行'],
    // ---- 结构级 MySQL 语法：本模拟器没实现，如实报 1235，不要伪装成 1064 ----
    [/^\s*CREATE\s+TABLE\b[\s\S]*\bPARTITION\s+BY\b/i,
      '分区表（PARTITION BY）', '底层引擎不支持表分区'],
    [/^\s*CREATE\s+(?:FULLTEXT|SPATIAL)\s+(?:INDEX|KEY)\b|^\s*ALTER\s+TABLE\b[\s\S]*\bADD\s+(?:FULLTEXT|SPATIAL)\s+(?:INDEX|KEY)\b/i,
      'FULLTEXT / SPATIAL 索引', '底层引擎没有全文索引与空间索引'],
    [/^\s*SELECT\b[\s\S]*\bMATCH\s*\([\s\S]*\)\s*AGAINST\s*\(/i,
      '全文检索 MATCH ... AGAINST', '全文检索需要 FULLTEXT 索引，底层引擎不支持'],
    [/^\s*ALTER\s+TABLE\b[\s\S]*\bDROP\s+PRIMARY\s+KEY\b/i,
      'ALTER TABLE ... DROP PRIMARY KEY', '底层引擎无法安全移除已存在的主键（需要重建整张表）'],
    [/^\s*ALTER\s+TABLE\b[\s\S]*\b(?:DROP\s+FOREIGN\s+KEY|ADD\s+(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY)\b/i,
      'ALTER TABLE ... 外键（ADD / DROP FOREIGN KEY）', '建表时可以声明 FOREIGN KEY，但不支持建表之后增删外键'],
    [/^\s*ALTER\s+TABLE\b[\s\S]*\b(?:ENGINE|ROW_FORMAT|AVG_ROW_LENGTH|KEY_BLOCK_SIZE|PACK_KEYS|STATS_\w+)\s*=/i,
      'ALTER TABLE ... 表选项（ENGINE= / ROW_FORMAT= 等）', '底层引擎的表没有可修改的存储引擎等表属性'],
    // ---- 复制与实例级管理：本模拟器是单连接、无实例概念 ----
    [/^\s*(?:START|STOP)\s+(?:REPLICA|SLAVE)\b|^\s*CHANGE\s+(?:MASTER|REPLICATION\s+SOURCE)\b|^\s*RESET\s+(?:MASTER|REPLICA|SLAVE)\b/i,
      '复制相关语句（START / STOP REPLICA、CHANGE MASTER 等）', '模拟器没有主从复制与二进制日志'],
    [/^\s*PURGE\s+BINARY\s+LOGS\b|^\s*SHOW\s+BINLOG\b/i,
      '二进制日志管理', '模拟器没有二进制日志'],
    [/^\s*(?:INSTALL|UNINSTALL)\s+(?:PLUGIN|COMPONENT)\b/i,
      'INSTALL / UNINSTALL PLUGIN', '模拟器不支持插件机制'],
    [/^\s*HANDLER\b/i,
      'HANDLER', 'HANDLER 是 MyISAM/InnoDB 的存储引擎级接口，模拟器未实现'],
    [/^\s*XA\s+(?:START|BEGIN|END|PREPARE|COMMIT|ROLLBACK|RECOVER)\b/i,
      'XA 分布式事务', '模拟器没有 XA 事务支持'],
    [/^\s*(?:IMPORT\s+TABLE|CLONE)\b/i,
      'IMPORT TABLE / CLONE', '模拟器没有表空间导入与实例克隆能力'],
    // 下面两条不是"本模拟器没做"，而是"MySQL 社区版本身就没有这条 SQL"，所以用 1064 更贴切
    [/^\s*(?:BACKUP|RESTORE)\s+(?:DATABASE|SCHEMA|TABLE|LOG|TABLESPACE|INSTANCE)\b/i,
      'BACKUP / RESTORE',
      'BACKUP DATABASE / RESTORE 是 MySQL 企业版（MySQL Enterprise Backup）的商业组件，社区版里没有这条 SQL 语句。' +
      '社区版的备份与恢复靠操作系统命令行工具 mysqldump / mysql 完成，不是在 mysql 客户端里敲 SQL。', 1064],
    [/^\s*MYSQLDUMP\b|^\s*MYSQL\s+-u\b/i,
      'mysqldump',
      'mysqldump 是操作系统命令行工具，不是 mysql 客户端里的 SQL 语句。备份要在 shell 里执行，例如：' +
      'mysqldump -u root -p 数据库名 > 备份.sql', 1064]
  ];

  /* ======================= 9. 引擎 ======================= */

  var VARIABLES = [
    ['auto_increment_increment', '1'], ['autocommit', 'ON'], ['character_set_client', 'utf8mb4'],
    ['character_set_connection', 'utf8mb4'], ['character_set_database', 'utf8mb4'],
    ['character_set_results', 'utf8mb4'], ['character_set_server', 'utf8mb4'],
    ['collation_connection', 'utf8mb4_0900_ai_ci'], ['collation_database', 'utf8mb4_0900_ai_ci'],
    ['collation_server', 'utf8mb4_0900_ai_ci'], ['have_query_cache', 'NO'],
    ['innodb_buffer_pool_size', '134217728'], ['innodb_version', '8.0.36'],
    ['lower_case_table_names', '0'], ['max_allowed_packet', '67108864'],
    ['max_connections', '151'], ['performance_schema', 'ON'], ['port', '3306'],
    ['protocol_version', '10'], ['sql_mode', 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'],
    ['system_time_zone', 'CST'], ['time_zone', 'SYSTEM'], ['tx_isolation', 'REPEATABLE-READ'],
    ['transaction_isolation', 'REPEATABLE-READ'], ['version', SERVER_VERSION_FULL],
    ['version_comment', 'MySQL Community Server - GPL (Simulator)'], ['version_compile_machine', 'x86_64'],
    ['version_compile_os', 'Linux'], ['wait_timeout', '28800'],
    ['hostname', 'localhost'], ['datadir', '/var/lib/mysql/'], ['basedir', '/usr/'],
    ['socket', '/var/lib/mysql/mysql.sock'], ['license', 'GPL'],
    ['net_buffer_length', '16384'], ['transaction_read_only', 'OFF']
  ];

  function Engine(SQL, seedFn) {
    this.SQL = SQL;
    this.databases = {};
    this.current = null;
    this.counter = 0;
    this.startTime = Date.now();
    this.seedFn = seedFn;
    this.history = [];
    this.userVars = {};      // SET @x = ... 用户变量
    this.sessionVars = {};   // SET xxx = ... 会话变量（覆盖 SHOW VARIABLES 的默认值）
    this.warnings = [];      // SHOW WARNINGS 的内容（由 DML 分支写入）
    this.infoState = { lastInsertId: 0, rowCount: 0, foundRows: 0 };   // LAST_INSERT_ID()/ROW_COUNT()/FOUND_ROWS()
  }

  Engine.prototype.createDatabaseObject = function (name) {
    var db = new this.SQL.Database();
    registerMySQLFunctions(db, name, this.infoState);
    db.run('PRAGMA foreign_keys = ON;');
    this.databases[name] = {
      name: name, db: db, tables: {}, views: {},
      isSystem: SYSTEM_DATABASES.indexOf(name) > -1
    };
    return this.databases[name];
  };

  Engine.prototype.init = function () {
    this.databases = {};
    this.current = null;
    this.userVars = {};
    this.sessionVars = {};
    var self = this;
    SYSTEM_DATABASES.forEach(function (n) { self.createDatabaseObject(n); });
    this.current = 'mysql';
    this.seedFn(this);
    this.current = 'production';
    return this;
  };

  Engine.prototype.databaseNames = function () {
    return Object.keys(this.databases);
  };

  /**
   * 列出某个库里的对象名（type = 'table' | 'view'）。
   * 关键点：SQLite 的 TEMPORARY 表/视图登记在 sqlite_temp_master，不在 sqlite_master，
   * 所以必须两张表一起查 —— 否则 `CREATE TEMPORARY TABLE t` 之后 t 能读能写，
   * 但 SHOW TABLES / DESC / 侧栏全都看不见它，用户会以为表没建成。
   */
  function objectNames(entry, type) {
    var names = [];
    if (!entry) return names;
    try {
      var r = entry.db.exec(
        "SELECT name FROM sqlite_master WHERE type='" + type + "' AND name NOT LIKE 'sqlite_%'" +
        " UNION SELECT name FROM sqlite_temp_master WHERE type='" + type + "' AND name NOT LIKE 'sqlite_%'" +
        " ORDER BY name");
      if (r[0]) names = r[0].values.map(function (v) { return v[0]; });
    } catch (e) {
      // 极老的内核没有 sqlite_temp_master：退回只查主库，不影响功能
      try {
        var r2 = entry.db.exec("SELECT name FROM sqlite_master WHERE type='" + type + "' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        if (r2[0]) names = r2[0].values.map(function (v) { return v[0]; });
      } catch (e2) { /* ignore */ }
    }
    return names;
  }

  Engine.prototype.tableNames = function (dbName) {
    return objectNames(this.databases[dbName || this.current], 'table');
  };

  /** 视图清单（含临时视图，以 sqlite_master / sqlite_temp_master 为准，避免与目录脱节） */
  Engine.prototype.viewNames = function (dbName) {
    return objectNames(this.databases[dbName || this.current], 'view');
  };

  Engine.prototype.viewExists = function (name, dbName) {
    return this.viewNames(dbName).indexOf(name) > -1;
  };

  /** SHOW TABLES / 侧栏用：表与视图混排（与真实 MySQL 一致，按名字排序） */
  Engine.prototype.objectList = function (dbName) {
    var views = this.viewNames(dbName);
    return this.tableNames(dbName)
      .map(function (n) { return { name: n, isView: false }; })
      .concat(views.map(function (n) { return { name: n, isView: true }; }))
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  };

  /** 视图的建库定义（SHOW CREATE VIEW 用） */
  Engine.prototype.viewDef = function (name, dbName) {
    var entry = this.databases[dbName || this.current];
    if (entry && entry.views[name]) return entry.views[name];
    var row = null;
    try {
      var r = entry.db.exec("SELECT sql FROM sqlite_master WHERE type='view' AND name='" + String(name).replace(/'/g, "''") + "'");
      if (r[0] && r[0].values.length) row = r[0].values[0][0];
    } catch (e) { row = null; }
    if (!row) return null;
    return { name: name, sql: row, createSql: mysqlViewDDL(name, row), isView: true, columns: [] };
  };

  /**
   * 由 PRAGMA 推导视图列结构。SQLite 会把底层列的声明类型原样带出来
   * （如 VARCHAR(50)），计算列则为空，此时按 SELECT 表达式做一次轻量推断。
   */
  Engine.prototype.buildViewMeta = function (name, dbName) {
    var entry = this.databases[dbName || this.current];
    if (!entry) return null;
    var def = this.viewDef(name, dbName);
    var cols = [];
    try {
      var r = entry.db.exec('PRAGMA table_info("' + String(name).replace(/"/g, '""') + '")');
      if (r[0]) {
        var hints = viewColumnHints(def ? def.sql : '');
        cols = r[0].values.map(function (row, i) {
          var raw = String(row[2] || '').trim();
          return {
            field: row[1],
            type: raw ? normalizeViewType(raw) : (hints[i] || 'varchar(255)'),
            nullable: true,
            key: '',
            hasDefault: row[4] !== null,
            defaultValue: row[4] === null ? null : row[4],
            extra: '',
            comment: ''
          };
        });
      }
    } catch (e) { /* ignore */ }
    return {
      name: name, columns: cols, indexes: [], foreignKeys: [],
      raw: def ? def.createSql : '', isView: true
    };
  };

  Engine.prototype.meta = function (table, dbName) {
    var entry = this.databases[dbName || this.current];
    if (!entry) return null;
    if (entry.tables[table]) return entry.tables[table];
    if (this.viewExists(table, dbName)) return this.buildViewMeta(table, dbName);
    // 回退：从 PRAGMA 构造
    try {
      var r = entry.db.exec('PRAGMA table_info("' + String(table).replace(/"/g, '""') + '")');
      if (!r[0]) return null;
      var cols = r[0].values.map(function (row) {
        return {
          field: row[1], type: String(row[2] || 'text').toLowerCase(),
          nullable: row[3] === 0, key: row[5] ? 'PRI' : '',
          defaultValue: row[4] === null ? null : row[4], hasDefault: row[4] !== null,
          extra: row[5] && /INT/i.test(String(row[2])) ? 'auto_increment' : '', comment: ''
        };
      });
      return { name: table, columns: cols, indexes: [], foreignKeys: [], raw: '' };
    } catch (e) { return null; }
  };

  Engine.prototype.tableExists = function (table, dbName) {
    return this.tableNames(dbName).indexOf(table) > -1;
  };

  Engine.prototype.resolveDb = function (token) {
    if (!token) return this.current;
    var t = stripQuotes(String(token).replace(/;$/, ''));
    return this.databases[t] ? t : null;
  };

  /* ---- 8.0 变量：用户变量 @x 与系统变量 @@x ---- */

  /** 只替换引号/反引号之外的匹配，避免把 'a@b.com'、`user@host` 里的 @ 当成变量 */
  function replaceOutsideQuotes(str, rx, fn) {
    var out = '', i = 0, state = 'n';
    while (i < str.length) {
      var ch = str[i];
      if (state !== 'n') {
        out += ch;
        var q = state === 's' ? "'" : state === 'd' ? '"' : '`';
        if (ch === '\\' && state !== 'b') { out += str[i + 1] || ''; i += 2; continue; }
        if (ch === q) {
          if (str[i + 1] === q) { out += q; i += 2; continue; }
          state = 'n';
        }
        i++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 's' : ch === '"' ? 'd' : 'b';
        out += ch; i++;
        continue;
      }
      rx.lastIndex = i;
      var m = rx.exec(str);
      if (m && m.index === i) { out += fn.apply(null, m); i += m[0].length; continue; }
      out += ch; i++;
    }
    return out;
  }

  /* ---- 8.0b SQL 规范化：用于「练习题是否答对」的同义写法比较 ---- */

  /**
   * 把一条 SQL 折叠成"写法无关"的规范形。
   * 只处理**书写层面**的等价（大小写、空白、标点两侧空格、反引号、结尾 ; 与 \G），
   * 不改变语义，也不做语义等价判断（那是结果集比较该干的事）。
   * 引号内的内容原样保留，避免把 'a, b' 这种字面量误折叠。
   */
  function canonicalSQL(sql) {
    var s = String(sql === undefined || sql === null ? '' : sql);
    s = s.replace(/\\[gG]\s*$/, '').replace(/;\s*$/, '').trim();
    // 反引号只出现在标识符上，直接去掉。注意不能交给 replaceOutsideQuotes——
    // 它会把 ` 当成"引号起始"原样输出，正则根本没机会命中。
    s = s.replace(/`/g, '');
    // 小写化必须避开引号：'ABC' 与 'abc' 是两个字面量，底层比较还区分大小写
    s = replaceOutsideQuotes(s, /[A-Z]+/g, function (m) { return m.toLowerCase(); });
    s = replaceOutsideQuotes(s, /\s*([,().])\s*/g, function (m, p) { return p; });
    s = replaceOutsideQuotes(s, /\s+/g, function () { return ' '; });
    return s.trim();
  }

  /**
   * 在 canonicalSQL 基础上再抹掉「表别名」这一类纯书写差异：
   *   u.username → username      FROM users u → FROM users
   * 只识别单字母别名，不会误伤 users.id 这种完整限定名。
   */
  function canonicalSQLRelaxed(sql) {
    var s = canonicalSQL(sql);
    s = replaceOutsideQuotes(s, /\b([a-z])\.([a-z_][a-z0-9_]*)\b/g, function (m, a, c) { return c; });
    s = replaceOutsideQuotes(s, /\b(from|join)\s+([a-z_][a-z0-9_]*)\s+([a-z])(?=\s|$)/g,
      function (m, kw, tbl) { return kw + ' ' + tbl; });
    s = replaceOutsideQuotes(s, /\s*([,().])\s*/g, function (m, p) { return p; });
    s = replaceOutsideQuotes(s, /\s+/g, function () { return ' '; });
    return s.trim();
  }

  /**
   * 判断题库里的题是否被这次执行命中，返回命中的题目下标数组。
   * 两档比较（都按「单条语句」逐个比，避免子串误判）：
   *   1) canonicalSQL 完全相等；
   *   2) canonicalSQLRelaxed 相等（再抹掉单字母表别名）。
   * 于是 `select username,email from users;`、`SELECT `username`, `email` FROM users;`、
   * `SELECT u.username, u.email FROM users u;` 都判为同一题的正确答案。
   */
  function matchExercises(text, list) {
    var pool = list || EXERCISES;
    var hits = [];
    var stmts;
    try { stmts = splitStatements(text); } catch (e) { return hits; }
    if (!stmts.length) return hits;
    var strict = stmts.map(function (s) { return canonicalSQL(s.sql); });
    var relaxed = stmts.map(function (s) { return canonicalSQLRelaxed(s.sql); });
    pool.forEach(function (ex, i) {
      if (!ex.answer) return;
      var a = canonicalSQL(ex.answer);
      var b = canonicalSQLRelaxed(ex.answer);
      if ((a && strict.indexOf(a) > -1) || (b && relaxed.indexOf(b) > -1)) hits.push(i);
    });
    return hits;
  }

  /** JS 值 → SQL 字面量 */
  function sqlLiteral(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' && isFinite(v)) return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
  }

  /** 解析 SET 右侧的简单字面量 */
  function evalLiteral(text, engine) {
    var t = String(text).trim();
    if (/^NULL$/i.test(t)) return null;
    if (/^TRUE$/i.test(t)) return 1;
    if (/^FALSE$/i.test(t)) return 0;
    if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (/^'(?:[^']|'')*'$/.test(t)) return t.slice(1, -1).split("''").join("'");
    if (/^"(?:[^"]|"")*"$/.test(t)) return t.slice(1, -1).split('""').join('"');
    if (/^@@?[A-Za-z0-9_$.]+$/.test(t) && engine) return engine.readVar(t);
    if (/^DEFAULT$/i.test(t)) return null;
    return t;   // 表达式原样保留（不展开计算，够用即可）
  }

  Engine.prototype.systemVarMap = function () {
    var map = {};
    VARIABLES.forEach(function (p) { map[p[0].toLowerCase()] = p[1]; });
    var s = this.sessionVars;
    Object.keys(s).forEach(function (k) { map[k] = s[k]; });
    return map;
  };

  /** 读 @x / @@x 的值；未定义的系统变量抛错（与 MySQL 一致） */
  Engine.prototype.readVar = function (token) {
    var m = /^@@?(.+)$/.exec(String(token).trim());
    if (!m) return null;
    var name = m[1];
    if (token.charAt(0) === '@' && token.charAt(1) === '@') {
      var map = this.systemVarMap();
      if (!Object.prototype.hasOwnProperty.call(map, name.toLowerCase())) {
        throw new Error('unknown system variable: ' + name);
      }
      return map[name.toLowerCase()];
    }
    return Object.prototype.hasOwnProperty.call(this.userVars, name) ? this.userVars[name] : null;
  };

  Engine.prototype.substituteVars = function (sql) {
    var self = this;
    return replaceOutsideQuotes(sql, /@(@)?([A-Za-z0-9_$.]+)/g, function (whole, sysFlag, name) {
      if (sysFlag) return sqlLiteral(self.readVar('@@' + name));
      return sqlLiteral(self.readVar('@' + name));   // 未赋值 → NULL，与 MySQL 一致
    });
  };

  /** SET ... —— MySQL 会话设置，这里记录到内存并回 Query OK */
  Engine.prototype.handleSet = function (body) {
    var self = this;
    var b = String(body).replace(/;\s*$/, '').trim();
    var ok = [{ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.001) + ' sec)' }];

    if (/^NAMES\b/i.test(b)) {
      var nm = /^NAMES\s+(?:'([^']+)'|([A-Za-z0-9_]+))/i.exec(b);
      if (nm) {
        var cs = nm[1] || nm[2];
        this.sessionVars['character_set_client'] = cs;
        this.sessionVars['character_set_connection'] = cs;
        this.sessionVars['character_set_results'] = cs;
      }
      return ok;
    }
    if (/^CHARACTER\s+SET\b/i.test(b)) return ok;
    // SET [SESSION|GLOBAL] TRANSACTION ISOLATION LEVEL ... ：模拟器不实现隔离级别，接受并放行
    if (/^(?:SESSION\s+|GLOBAL\s+|LOCAL\s+)?TRANSACTION\b/i.test(b)) return ok;

    splitTopLevel(b).forEach(function (part) {
      // 去掉 SESSION / GLOBAL / LOCAL 作用域前缀，语法接受（不做作用域区分）
      var p = part.replace(/^\s*(?:SESSION|GLOBAL|LOCAL)\s+/i, '').trim();
      var a = /^\s*(@@?)?([A-Za-z_][A-Za-z0-9_$.]*)\s*(?::=|=)\s*([\s\S]+)$/.exec(p);
      if (!a) return;
      var sigil = a[1], name = a[2];
      var val;
      try { val = evalLiteral(a[3], self); } catch (e) { val = null; }
      if (sigil === '@') self.userVars[name] = val;
      else self.sessionVars[name.toLowerCase()] = val;
    });
    return ok;
  };

  /* ---- 8.1 语句级分发 ---- */

  Engine.prototype.run = function (input) {
    var blocks = [];
    var self = this;
    var stmts = splitStatements(input);
    if (!stmts.length) return blocks;

    stmts.forEach(function (st) {
      var r = self.runOne(st.sql, st.vertical);
      r.forEach(function (b) { blocks.push(b); });
    });
    return blocks;
  };

  /* ---- 8.1b EXPLAIN：把底层的查询计划翻译成 MySQL 形态 ---- */

  /** 解析 SQLite 的 EXPLAIN QUERY PLAN 明细行（如 "SEARCH users USING INDEX idx_city (city=?)"） */
  function parsePlanLine(detail) {
    var d = String(detail).trim();
    var m;
    // SQLite 对 "SELECT 1" 这类无表查询给出 "SCAN CONSTANT ROW"，MySQL 会显示 No tables used
    if (/^(?:SCAN|SEARCH)\s+(?:TABLE\s+)?CONSTANT\b/i.test(d)) return { op: 'other', table: null, raw: d };
    var colsM = /\(([^)]*)\)/.exec(d);
    var cols = colsM ? colsM[1].split(/\s+AND\s+/i).map(function (x) {
      return x.trim().replace(/\s*=.*$/, '').replace(/^["'`[]|["'`\]]$/g, '');
    }).filter(Boolean) : [];
    if ((m = /^SCAN\s+(?:TABLE\s+)?([^\s(]+)/i.exec(d))) {
      return { op: 'scan', table: m[1], cols: cols, raw: d };
    }
    if ((m = /^SEARCH\s+(?:TABLE\s+)?([^\s(]+)/i.exec(d))) {
      var ci = /USING\s+COVERING\s+INDEX\s+([^\s(]+)/i.exec(d);
      var ix = /USING\s+INDEX\s+([^\s(]+)/i.exec(d);
      var pk = /USING\s+INTEGER\s+PRIMARY\s+KEY/i.test(d);
      return { op: 'search', table: m[1], index: ci ? ci[1] : (ix ? ix[1] : null), covering: !!ci, pk: pk, cols: cols, raw: d };
    }
    return { op: 'other', table: null, raw: d };
  }

  function unquoteIdent(x) { return String(x).replace(/^["'`[]|["'`\]]$/g, ''); }

  /**
   * EXPLAIN <语句>：输出 MySQL 形态的执行计划。
   * 旧实现是把 SQLite 的 EXPLAIN QUERY PLAN 原样打印（列名是 id/parent/notused/detail，
   * 内容是 "SCAN users"），和 MySQL 的 12 列完全不是一回事，而"索引有没有被用上"
   * 恰恰是教学重点。
   */
  Engine.prototype.explainStatement = function (stmt, format, analyze, vertical) {
    var entry = this.databases[this.current];
    if (!entry) return this.errBlock('ERROR 1046 (3D000): No database selected');
    var self = this;
    var translated;
    try { translated = translateStatement(this.substituteVars(stmt), { db: this.current }); }
    catch (e) { return this.errBlock(mapError(e.message, { db: this.current, stmt: stmt })); }

    var planText = [];
    try {
      var pr = entry.db.exec('EXPLAIN QUERY PLAN ' + translated);
      if (pr.length) planText = pr[0].values.map(function (r) { return String(r[3]); });
    } catch (e) {
      return this.errBlock(mapError(e.message, { db: this.current, stmt: stmt }));
    }

    var steps = planText.map(parsePlanLine);
    var tableSteps = steps.filter(function (s) { return s.op !== 'other'; });
    var extraBits = [];
    steps.forEach(function (s) {
      if (s.op !== 'other') return;
      if (/TEMP B-TREE FOR ORDER BY/i.test(s.raw)) extraBits.push('Using filesort');
      else if (/TEMP B-TREE/i.test(s.raw)) extraBits.push('Using temporary');
      else if (/CO-ROUTINE|MATERIALIZE|UNION/i.test(s.raw)) extraBits.push(s.raw);
    });
    var hasWhere = /\bWHERE\b/i.test(stmt);
    var rowCountOf = function (tname) {
      try {
        var c = entry.db.exec('SELECT COUNT(*) FROM "' + String(tname).replace(/"/g, '""') + '"');
        if (c.length && c[0].values.length) return c[0].values[0][0];
      } catch (e) { /* 视图/子查询表名取不到就报 0 */ }
      return 0;
    };

    var rows = [];
    tableSteps.forEach(function (st, i) {
      var tname = unquoteIdent(st.table);
      var meta = self.meta(tname) || { columns: [], indexes: [] };
      var type = 'ALL', key = null, possible = null;
      var extra = hasWhere ? 'Using where' : '';
      if (st.op === 'scan') {
        possible = (meta.indexes || []).filter(function (ix) {
          if (ix.primary) return false;
          return (ix.columns || []).some(function (c) { return new RegExp('\\b' + c + '\\b', 'i').test(stmt); });
        }).map(function (ix) { return ix.name; }).join(',') || null;
      } else if (st.pk) {
        type = 'const'; key = 'PRIMARY';
      } else if (st.index) {
        type = st.covering ? 'index' : 'ref';
        key = st.index;
      }
      // 唯一约束在底层是自动索引（sqlite_autoindex_users_1），要换回 MySQL 里声明的索引名
      if (key && /^sqlite_autoindex_/i.test(key)) {
        var lcCols = (st.cols || []).map(function (c) { return c.toLowerCase(); });
        var pick = (meta.indexes || []).filter(function (ix) {
          return (ix.columns || []).length && lcCols.indexOf(String(ix.columns[0]).toLowerCase()) > -1;
        })[0] || (meta.indexes || []).filter(function (ix) { return ix.unique; })[0];
        if (pick) key = pick.name;
      }
      rows.push([String(i + 1), 'SIMPLE', tname, null, type, possible, key, null, null,
        rowCountOf(tname), '100.00', extra]);
    });
    if (extraBits.length && rows.length) {
      var seen = {};
      var merged = [rows[rows.length - 1][11]].concat(extraBits).filter(function (x) {
        if (!x || seen[x]) return false;
        seen[x] = 1;
        return true;
      });
      rows[rows.length - 1][11] = merged.join('; ');
    }

    if (format === 'JSON') {
      var tables = tableSteps.map(function (st) {
        var tname = unquoteIdent(st.table);
        var t = {
          table_name: tname,
          access_type: st.op === 'scan' ? 'ALL' : (st.pk ? 'const' : (st.covering ? 'index' : 'ref')),
          rows_examined_per_scan: rowCountOf(tname),
          filtered: '100.00'
        };
        if (st.index) t.possible_keys = [st.index];
        if (st.pk) t.key = 'PRIMARY'; else if (st.index) t.key = st.index;
        return t;
      });
      var qb = { query_block: { select_id: 1, cost_info: { query_cost: '0.00' }, table: tables } };
      return [this.resultBlock(rs(['EXPLAIN'], [[JSON.stringify(qb, null, 2)]]), 1, vertical)];
    }

    if (format === 'TREE' || analyze) {
      var lines = [];
      var actual = 0;
      if (analyze) {
        try {
          var ex = entry.db.exec(translated);
          if (ex.length && ex[0].values.length) actual = ex[0].values.length;
        } catch (e) { actual = 0; }
        lines.push('-> ' + (hasWhere ? 'Filter: ' : '') + 'query  (cost=0.00 rows=' + actual +
          ') (actual time=0.00..0.00 rows=' + actual + ' loops=1)');
      }
      tableSteps.forEach(function (st) {
        var tname = unquoteIdent(st.table);
        var n = rowCountOf(tname);
        var kind = st.op === 'scan' ? 'Table scan' : (st.index ? 'Index lookup' : 'Search');
        var on = st.op === 'scan' ? (' on ' + tname) : (' on ' + tname + ' using ' + (st.index || 'PRIMARY'));
        lines.push('-> ' + kind + on + '  (cost=0.00 rows=' + n +
          ') (actual time=0.00..0.00 rows=' + n + ' loops=1)');
      });
      if (!lines.length) lines.push('-> No tables in query');
      // TREE / ANALYZE 在真实 mysql 客户端里是纯文本输出（不套表格框），这里保持一致
      return [{ kind: 'out', text: lines.join('\n') }];
    }

    if (!rows.length) {
      rows.push(['1', 'SIMPLE', null, null, null, null, null, null, null, null, null, 'No tables used']);
    }
    return [this.resultBlock(rs(['id', 'select_type', 'table', 'partitions', 'type', 'possible_keys',
      'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra'], rows), rows.length, vertical)];
  };

  /* ---- 8.1c CREATE TABLE ... AS SELECT 的列类型推导 ---- */

  /** 从 SELECT 列表推导输出列名与 MySQL 类型（能对上源表列的用源列声明类型） */
  Engine.prototype.ctasColumnTypes = function (selectSql, entry) {
    var order = [], types = {};
    var s = String(selectSql).replace(/;\s*$/, '').trim();
    var fromIdx = topLevelKeywordIndex(s, 'FROM');
    var list = (fromIdx > -1 ? s.slice(0, fromIdx) : s).replace(/^\s*SELECT\s+/i, '');
    if (/^\s*DISTINCT\s+/i.test(list)) list = list.replace(/^\s*DISTINCT\s+/i, '');
    var srcMeta = null;
    if (fromIdx > -1) {
      var tm = /^\s*FROM\s+(`[^`]+`|[A-Za-z0-9_$.]+)/i.exec(s.slice(fromIdx));
      if (tm) {
        var tok = splitDbTable(tm[1]);
        srcMeta = entry.tables[tok.table] || this.meta(tok.table, tok.db || undefined);
      }
    }
    if (/^\s*\*\s*$/.test(list)) {
      if (srcMeta) srcMeta.columns.forEach(function (c) { order.push(c.field); types[c.field] = c.type; });
      return { order: order, types: types };
    }
    splitTopLevel(list).forEach(function (item) {
      var it = item.trim();
      var asM = /\s+AS\s+(`[^`]+`|[A-Za-z0-9_$]+)\s*$/i.exec(it);
      var expr = asM ? it.slice(0, asM.index).trim() : it;
      var outName;
      if (asM) outName = stripQuotes(asM[1]);
      else {
        var bare = /^(?:`?[A-Za-z0-9_$]+`?\.)?(`[^`]+`|[A-Za-z0-9_$]+)$/.exec(expr);
        outName = bare ? stripQuotes(bare[1]) : expr.replace(/[^A-Za-z0-9_$]/g, '_');
      }
      var t = null;
      var colM = /^(?:`?[A-Za-z0-9_$]+`?\.)?`?([A-Za-z0-9_$]+)`?$/.exec(expr);
      if (colM && srcMeta) {
        var hit = (srcMeta.columns || []).filter(function (c) {
          return c.field.toLowerCase() === colM[1].toLowerCase();
        })[0];
        if (hit) t = hit.type;
      }
      order.push(outName);
      types[outName] = t || inferExprType(expr);
    });
    return { order: order, types: types };
  };

  /** 为 CTAS 建出来的表补一份 MySQL 风格的列目录（否则 DESC 会显示 SQLite 的 int/text/num） */
  Engine.prototype.buildCtasMeta = function (name, selectSql) {
    var entry = this.databases[this.current];
    if (!entry) return null;
    var derived = this.ctasColumnTypes(selectSql, entry);
    var cols = [];
    try {
      var info = entry.db.exec('PRAGMA table_info("' + String(name).replace(/"/g, '""') + '")');
      var names = info[0] ? info[0].values.map(function (r) { return r[1]; }) : derived.order;
      cols = names.map(function (n) {
        return {
          field: n, type: derived.types[n] || 'varchar(255)',
          nullable: true, key: '', hasDefault: false, defaultValue: null, extra: '', comment: ''
        };
      });
    } catch (e) { /* ignore */ }
    return { name: name, columns: cols, indexes: [], foreignKeys: [], autoIncrementNext: null, raw: '' };
  };

  /* ---- 8.1d AUTO_INCREMENT 起始值 ---- */

  /**
   * 让 `AUTO_INCREMENT = N` 真正生效。
   * 底层自增是 INTEGER PRIMARY KEY（= rowid 别名），起始值由 SQLite 自己分配、无法直接设置，
   * 所以在 INSERT 时把自增列的显式值补上。只处理最常见的 INSERT ... VALUES 形式，
   * 其余形式（INSERT ... SELECT 等）保持底层行为，并在 DIFFERENCES 里说明。
   */
  Engine.prototype.applyAutoIncrement = function (entry, sql) {
    var m = /^\s*INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(`([^`]+)`|[A-Za-z0-9_$.]+)\s*(?:\(([^)]*)\))?\s*VALUES\s*([\s\S]+)$/i.exec(sql);
    if (!m) return sql;
    var tname = stripQuotes(m[2] || m[1]).split('.').pop();
    var meta = entry.tables[tname];
    if (!meta || !meta.autoIncrementNext) return sql;
    var aiCol = (meta.columns || []).filter(function (c) { return /auto_increment/i.test(c.extra || ''); })[0];
    if (!aiCol) return sql;
    var colList = m[3] ? splitTopLevel(m[3]).map(function (x) { return stripQuotes(x.trim()); }) : null;
    if (colList && colList.some(function (c) { return c.toLowerCase() === aiCol.field.toLowerCase(); })) {
      return sql;   // 用户自己给了自增列的值
    }
    if (!colList) {
      var firstCol = (meta.columns || [])[0];
      if (!firstCol || firstCol.field.toLowerCase() !== aiCol.field.toLowerCase()) return sql;
    }
    var valuesPart = m[4].trim().replace(/;\s*$/, '');
    var rowsRaw = splitTopLevel(valuesPart);
    if (!rowsRaw.length || !rowsRaw.every(function (r) { return /^\s*\([\s\S]*\)\s*$/.test(r); })) return sql;
    var next = meta.autoIncrementNext;
    var newRows = rowsRaw.map(function (r) {
      var vals = splitTopLevel(r.trim().slice(1, -1));
      var outVals = [String(next)].concat(vals.map(function (v) { return v.trim(); }));
      next++;
      return '(' + outVals.join(', ') + ')';
    });
    var newCols = colList ? [aiCol.field].concat(colList) : null;
    this._pendingAutoInc = { meta: meta, next: next };
    return 'INSERT INTO ' + m[1] + (newCols ? ' (' + newCols.join(', ') + ')' : '') +
      ' VALUES ' + newRows.join(', ') + ';';
  };

  Engine.prototype.runOne = function (sql, vertical) {
    var out = [];
    var self = this;
    this._lastVertical = !!vertical;

    // MySQL 的警告列表是"每条语句一份"：新语句开始时清空，
    // 但 SHOW WARNINGS / SHOW COUNT(*) WARNINGS 本身要能看到上一条语句产生的警告。
    if (!/^\s*show\s+(?:warnings|errors|count\s*\(\s*\*\s*\)\s+(?:warnings|errors))/i.test(sql.trim())) {
      this.warnings = [];
    }

    // ---- 客户端元命令 ----
    var lower = sql.trim().toLowerCase().replace(/;\s*$/, '');
    if (lower === 'exit' || lower === 'quit' || lower === '\\q') {
      out.push({ kind: 'note', text: 'Bye' });
      out.push({ kind: 'exit', text: '' });
      return out;
    }
    if (lower === '\\h' || lower === 'help' || lower === '\\?' || /^help\s+\S/.test(lower)) {
      out.push({ kind: 'out', text: HELP_TEXT });
      var helpTopic = lower.replace(/^(?:help|\?)\s*/, '').trim();
      if (helpTopic) {
        out.push({ kind: 'note', text: '（提示：真实 mysql 客户端会针对「' + helpTopic + '」显示该命令的语法帮助；' +
          '本模拟器只提供上面这份常用命令一览。）' });
      }
      return out;
    }
    if (lower === '\\s' || lower === 'status') {
      out.push({ kind: 'out', text: this.statusText() });
      return out;
    }
    if (lower === 'clear') {
      out.push({ kind: 'clear', text: '' });
      return out;
    }

    // ---- SHOW 系列 ----
    var showM = /^SHOW\s+([\s\S]+)$/i.exec(sql.trim());
    if (showM) {
      var r = this.handleShow(showM[1], vertical);
      if (r) return r;
    }
    // ---- USE ----
    var useM = /^USE\s+(.+)$/i.exec(sql.trim());
    if (useM) {
      var name = stripQuotes(useM[1].replace(/;$/, '').trim());
      if (!this.databases[name]) {
        out.push({ kind: 'err', text: 'ERROR 1049 (42000): Unknown database \'' + name + '\'' });
        return out;
      }
      this.current = name;
      out.push({ kind: 'out', text: 'Database changed' });
      if (name !== 'mysql' && SYSTEM_DATABASES.indexOf(name) > -1) {
        out.push({ kind: 'note', text: '（提示：' + name + ' 在本模拟器中仅有库名占位、没有表内容，' +
          '因此 SHOW TABLES 为空、查询其数据字典表会报 1146。mysql 库中的 user 表可正常查询。）' });
      }
      return out;
    }
    // ---- SET：用户变量 @x 与会话变量（autocommit / NAMES / sql_mode ...）----
    var setM = /^SET\s+([\s\S]+)$/i.exec(sql.trim());
    if (setM) {
      try {
        this.handleSet(setM[1]).forEach(function (b) { out.push(b); });
      } catch (e) {
        out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) });
      }
      return out;
    }
    // ---- SELECT @x / @@x（纯变量列表：列名保持 @@xxx，与 MySQL 输出一致）----
    var varSelM = /^SELECT\s+((?:@@?[A-Za-z0-9_$.]+)(?:\s*,\s*@@?[A-Za-z0-9_$.]+)*)\s*$/i.exec(sql.trim());
    if (varSelM) {
      var vEntry = this.databases[this.current] || this.databases.mysql;
      if (vEntry) {
        try {
          var vnames = varSelM[1].split(',').map(function (x) { return x.trim(); });
          var vcols = vnames.map(function (n) {
            return sqlLiteral(self.readVar(n)) + ' AS \'' + n + '\'';
          }).join(', ');
          var t0v = Date.now();
          var vres = vEntry.db.exec('SELECT ' + vcols);
          var secv = (Date.now() - t0v) / 1000;
          if (!vres.length) {
            out.push({ kind: 'out', text: 'Empty set (' + formatDuration(secv) + ' sec)' });
          } else {
            out.push({ kind: 'out', text: this._lastVertical ? formatVertical(vres[0]) : formatTable(vres[0]) });
            out.push({ kind: 'out', text: rowsTail(vres[0].values.length, secv) });
          }
        } catch (e) {
          out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) });
        }
        return out;
      }
    }
    // ---- 事务控制：START TRANSACTION / BEGIN / COMMIT / ROLLBACK / SAVEPOINT ----
    var txM = /^(START\s+TRANSACTION|BEGIN(?:\s+WORK)?|COMMIT(?:\s+WORK)?|ROLLBACK\s+TO\s+(?:SAVEPOINT\s+)?`?[A-Za-z0-9_$]+`?|ROLLBACK(?:\s+WORK)?|SAVEPOINT\s+`?[A-Za-z0-9_$]+`?|RELEASE\s+(?:SAVEPOINT\s+)?`?[A-Za-z0-9_$]+`?)\b[\s\S]*$/i.exec(sql.trim());
    if (txM) {
      var txEntry = this.databases[this.current] || this.databases.mysql;
      var kwPart = txM[1], txKw;
      // 归一化成 SQLite 能听懂的写法：去掉 WORK / READ ONLY 等 MySQL 修饰词
      if (/^START\s+TRANSACTION/i.test(kwPart) || /^BEGIN/i.test(kwPart)) txKw = 'BEGIN';
      else if (/^COMMIT/i.test(kwPart)) txKw = 'COMMIT';
      else if (/^ROLLBACK\s+TO/i.test(kwPart)) txKw = kwPart.replace(/^ROLLBACK\s+TO\s+(?:SAVEPOINT\s+)?/i, 'ROLLBACK TO ');
      else if (/^ROLLBACK/i.test(kwPart)) txKw = 'ROLLBACK';
      else txKw = kwPart;   // SAVEPOINT / RELEASE：保留原样
      var isStart = /^BEGIN$/.test(txKw);
      var t0t = Date.now();
      try { if (txEntry) txEntry.db.run(txKw); } catch (e) { /* 重复 BEGIN、无活动事务时的 COMMIT/ROLLBACK：MySQL 同样不报错 */ }
      out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration((Date.now() - t0t) / 1000) + ' sec)' });
      if (isStart && !this._txNoted) {
        this._txNoted = true;
        out.push({ kind: 'note', text: '（提示：本模拟器的事务是"真"的——INSERT/UPDATE/DELETE 后执行 ROLLBACK 会真的回滚；但没有 MySQL 的隔离级别、行级锁与 MVCC 语义。）' });
      }
      return out;
    }

    // ---- 锁表：单连接、无并发，接受但不产生锁定效果 ----
    if (/^(?:LOCK\s+TABLES|UNLOCK\s+TABLES)\b/i.test(sql.trim())) {
      out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.0005) + ' sec)' });
      if (!this._lockNoted) {
        this._lockNoted = true;
        out.push({ kind: 'note', text: '（提示：模拟器只有一个连接、没有并发，LOCK TABLES 不会产生任何实际锁定。）' });
      }
      return out;
    }
    // ---- 表维护语句：CHECK / OPTIMIZE / REPAIR / ANALYZE TABLE ----
    // MySQL 统一返回 Table / Op / Msg_type / Msg_text 结果集。
    // （旧实现把 OPTIMIZE/REPAIR 转译成 `SELECT 1 WHERE 0`，终端上只打印一句 "Empty set"。）
    var maintM = /^(CHECK|OPTIMIZE|REPAIR|ANALYZE)\s+TABLE\s+([`A-Za-z0-9_$.,\s]+)$/i.exec(sql.trim());
    if (maintM) {
      var mOp = maintM[1].toLowerCase();
      var mtEntry = this.databases[this.current] || this.databases.mysql;
      var mtNames = maintM[2].split(',').map(function (x) { return stripQuotes(x.trim()); }).filter(Boolean);
      var mtMiss = mtNames.filter(function (nm) {
        if (mtEntry && mtEntry.tables[nm]) return false;
        return !self.viewExists(nm);
      });
      if (mtMiss.length) {
        out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + mtMiss[0] + '\' doesn\'t exist' });
        return out;
      }
      var mtRows = [];
      mtNames.forEach(function (nm) {
        if (mOp === 'optimize') {
          mtRows.push([nm, 'optimize', 'note', 'Table does not support optimize, doing recreate + analyze instead']);
        } else if (mOp === 'repair') {
          mtRows.push([nm, 'repair', 'note', 'The storage engine for the table doesn\'t support repair']);
        }
        mtRows.push([nm, mOp, 'status', 'OK']);
      });
      return [this.resultBlock(rs(['Table', 'Op', 'Msg_type', 'Msg_text'], mtRows), mtRows.length)];
    }
    // ---- FLUSH ...：单连接、全内存，没有缓存或日志可刷，如实说明后回 Query OK ----
    if (/^FLUSH\b/i.test(sql.trim())) {
      var flM = /^FLUSH\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?TABLES\s+([`A-Za-z0-9_$.,\s]+)$/i.exec(sql.trim());
      if (flM) {
        var flEntry = this.databases[this.current] || this.databases.mysql;
        var flNames = flM[1].split(',').map(function (x) { return stripQuotes(x.trim()); }).filter(Boolean);
        var flMiss = flNames.filter(function (nm) { return !(flEntry && flEntry.tables[nm]); });
        if (flMiss.length) {
          out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + flMiss[0] + '\' doesn\'t exist' });
          return out;
        }
      }
      out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.0005) + ' sec)' });
      if (!this._flushNoted) {
        this._flushNoted = true;
        out.push({ kind: 'note', text: '（提示：模拟器只有一个连接、数据全在内存里，FLUSH 没有实际的缓存或日志可刷新，语句被接受但不产生效果。）' });
      }
      return out;
    }
    // ---- DELIMITER：客户端命令，本模拟器按整句解析，接受后忽略 ----
    if (/^DELIMITER\s+\S+/i.test(sql.trim())) return out;
    // ---- ALTER DATABASE / SCHEMA：只改字符集等展示属性，放行 ----
    if (/^ALTER\s+(?:DATABASE|SCHEMA)\b/i.test(sql.trim())) {
      out.push({ kind: 'out', text: 'Query OK, 1 row affected (' + formatDuration(0.001) + ' sec)' });
      return out;
    }
    // ---- 明确不支持的高阶语句：给真实原因，而不是伪装成 1064 ----
    var trimmed = sql.trim();
    for (var ui = 0; ui < UNSUPPORTED_STATEMENTS.length; ui++) {
      var us = UNSUPPORTED_STATEMENTS[ui];
      if (!us[0].test(trimmed)) continue;
      if (us[3] === 1064) {
        // MySQL 社区版里本来就没有这条语句 → 报语法错误，但把原因讲清楚
        out.push({ kind: 'err', text: 'ERROR 1064 (42000): You have an error in your SQL syntax; check the manual ' +
          'that corresponds to your MySQL server version for the right syntax to use near \'' +
          trimmed.split(/\s+/)[0].toUpperCase() + '\' at line 1' });
        out.push({ kind: 'note', text: '（说明：' + us[2] + '）' });
      } else {
        out.push({ kind: 'err', text: 'ERROR 1235 (42000): 本模拟器暂不支持 ' + us[1] + '——' + us[2] });
        out.push({ kind: 'note', text: '（这不是你的 SQL 写错了；完整支持范围见右侧「语法差异」面板。）' });
      }
      return out;
    }
    // ---- INSERT / REPLACE ... SET col = val, ...（MySQL 特有写法，转成标准 VALUES 形式）----
    var insSetM = /^(INSERT|REPLACE)\s+(IGNORE\s+)?INTO\s+(`[^`]+`|[A-Za-z0-9_$.]+)\s+SET\s+([\s\S]+)$/i.exec(trimmed);
    if (insSetM) {
      var setPairs = splitTopLevel(insSetM[4]);
      var setCols = [], setVals = [], setBad = false;
      setPairs.forEach(function (p) {
        var pm = /^\s*(`[^`]+`|[A-Za-z0-9_$]+)\s*=\s*([\s\S]+)$/.exec(p);
        if (!pm) { setBad = true; return; }
        setCols.push(pm[1]);
        setVals.push(pm[2].trim());
      });
      if (setBad || !setCols.length) {
        out.push({ kind: 'err', text: 'ERROR 1064 (42000): You have an error in your SQL syntax near \'SET\'' });
        return out;
      }
      return this.runOne(insSetM[1].toUpperCase() + ' ' + (insSetM[2] || '') + 'INTO ' + insSetM[3] +
        ' (' + setCols.join(', ') + ') VALUES (' + setVals.join(', ') + ');', vertical);
    }

    // ---- SELECT ... INTO @var[, @var2]（MySQL 常用写法；一条 SELECT 只取第一行，与 MySQL 一致）----
    var selIntoM = /^SELECT\s+([\s\S]+?)\s+INTO\s+((?:@@?[A-Za-z0-9_$.]+)(?:\s*,\s*@@?[A-Za-z0-9_$.]+)*)\s*(FROM\b[\s\S]*)?$/i.exec(trimmed);
    if (selIntoM) {
      var siEntry = this.databases[this.current];
      if (!siEntry) { out.push({ kind: 'err', text: 'ERROR 1046 (3D000): No database selected' }); return out; }
      var siSql = 'SELECT ' + selIntoM[1].trim() + (selIntoM[3] ? ' ' + selIntoM[3].trim() : '');
      try {
        var siEx = siEntry.db.exec(translateStatement(this.substituteVars(siSql), { db: this.current }));
        var siNames = selIntoM[2].split(',').map(function (x) { return x.trim(); });
        if (siEx.length && siEx[0].values.length) {
          var siRow = siEx[0].values[0];
          siNames.forEach(function (nm, i) {
            var siSys = nm.charAt(0) === '@' && nm.charAt(1) === '@';
            var siKey = nm.replace(/^@@?/, '');
            if (siSys) self.sessionVars[siKey.toLowerCase()] = siRow[i];
            else self.userVars[siKey] = siRow[i];
          });
          out.push({ kind: 'out', text: 'Query OK, 1 row affected (' + formatDuration(0.001) + ' sec)' });
        } else {
          out.push({ kind: 'err', text: 'ERROR 1329 (02000): No data - zero rows fetched, selected, or processed' });
        }
      } catch (e) {
        out.push({ kind: 'err', text: mapError(e.message, { db: this.current, stmt: siSql }) });
      }
      return out;
    }

    // ---- DROP TABLE a, b, c（MySQL 允许一次删多张表）----
    var dtM = /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+(IF\s+EXISTS\s+)?([`A-Za-z0-9_$.,\s]+)$/i.exec(trimmed);
    if (dtM && dtM[2].indexOf(',') > -1) {
      dtM[2].split(',').forEach(function (t) {
        self.runOne('DROP TABLE ' + (dtM[1] || '') + t.trim() + ';').forEach(function (b) { out.push(b); });
      });
      return out;
    }

    // ---- EXPLAIN <语句>：输出 MySQL 形态的执行计划（必须早于下面的 DESC 分支，
    //      否则 "EXPLAIN SELECT 1" 会被当成 DESC 表 SELECT 列 1）----
    var exM = /^EXPLAIN\s+(?:FORMAT\s*=\s*(TRADITIONAL|JSON|TREE)\s+)?(ANALYZE\s+)?([\s\S]+)$/i.exec(trimmed);
    if (exM && /^(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(exM[3].trim())) {
      return this.explainStatement(exM[3].trim(), (exM[1] || 'TRADITIONAL').toUpperCase(), !!exM[2], vertical);
    }
    // ---- DESC / DESCRIBE / EXPLAIN <table> [col | 'pattern'] ----
    // MySQL 里 DESC tbl col 等价于 SHOW COLUMNS FROM tbl LIKE 'col'，DESC tbl 'p%' 同理；
    // 旧实现把尾部的列名/模式整个丢掉，导致过滤条件被静默忽略。
    var descM = /^(?:DESC|DESCRIBE|EXPLAIN)\s+(?:`([^`]+)`|([A-Za-z0-9_$.]+))\s*(?:('(?:[^']|'')*')|(`[^`]+`|[A-Za-z0-9_$]+))?\s*$/i.exec(sql.trim());
    if (descM) {
      var dtTok = splitDbTable(descM[1] || descM[2]);
      var dpRaw = descM[4] || descM[3];
      var dPattern = null;
      if (dpRaw) dPattern = /^'/.test(dpRaw) ? stripQuotes(dpRaw).split("''").join("'") : stripQuotes(dpRaw);
      return this.describeTable(dtTok.table, dtTok.db, dPattern, false);
    }
    // ---- CREATE / DROP DATABASE ----
    var cdM = /^CREATE\s+(?:DATABASE|SCHEMA)\s+(IF\s+NOT\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)/i.exec(sql.trim());
    if (cdM) {
      var dn = stripQuotes(cdM[3] || cdM[2]);
      if (this.databases[dn]) {
        if (cdM[1]) out.push({ kind: 'note', text: 'Query OK, 1 row affected, 1 warning (0.00 sec)' });
        else out.push({ kind: 'err', text: 'ERROR 1007 (HY000): Can\'t create database \'' + dn + '\'; database exists' });
        return out;
      }
      this.createDatabaseObject(dn);
      out.push({ kind: 'out', text: 'Query OK, 1 row affected (' + formatDuration(0.002) + ' sec)' });
      return out;
    }
    var ddM = /^DROP\s+(?:DATABASE|SCHEMA)\s+(IF\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)/i.exec(sql.trim());
    if (ddM) {
      var dn2 = stripQuotes(ddM[3] || ddM[2]);
      if (!this.databases[dn2]) {
        if (ddM[1]) out.push({ kind: 'note', text: 'Query OK, 0 rows affected, 1 warning (0.00 sec)' });
        else out.push({ kind: 'err', text: 'ERROR 1008 (HY000): Can\'t drop database \'' + dn2 + '\'; database doesn\'t exist' });
        return out;
      }
      try { this.databases[dn2].db.close(); } catch (e) { /* ignore */ }
      delete this.databases[dn2];
      if (this.current === dn2) this.current = 'mysql';
      out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.004) + ' sec)' });
      return out;
    }

    // ---- 常规 SQL ----
    var entry = this.databases[this.current];
    if (!entry) {
      out.push({ kind: 'err', text: 'ERROR 1046 (3D000): No database selected' });
      return out;
    }

    // ---- 视图：CREATE [OR REPLACE] VIEW / ALTER VIEW ----
    // IF NOT EXISTS 在 MySQL 里位置比较随意（官方语法图标在 VIEW 之前，官方示例却写成
    // CREATE VIEW IF NOT EXISTS ...），两种写法都收；先摘出来再解析。
    var vAsIdx = topLevelKeywordIndex(trimmed, 'AS');
    var vHead = vAsIdx > -1 ? trimmed.slice(0, vAsIdx) : trimmed;
    var vIfNot = /\bIF\s+NOT\s+EXISTS\b/i.test(vHead);
    var vSrc = vIfNot
      ? vHead.replace(/\bIF\s+NOT\s+EXISTS\b/i, '').replace(/\s+$/, ' ') + (vAsIdx > -1 ? trimmed.slice(vAsIdx) : '')
      : trimmed;
    var cvM = /^CREATE\s+(OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*(?:CURRENT_USER(?:\(\))?|`[^`]+`@`[^`]+`|\S+)\s+)?(?:SQL\s+SECURITY\s+(?:DEFINER|INVOKER)\s+)?VIEW\s+(`([^`]+)`|[A-Za-z0-9_$.]+)\s*(?:\(([^)]*)\))?\s+AS\s+([\s\S]+)$/i.exec(vSrc);
    var avM = cvM ? null : /^ALTER\s+(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*(?:CURRENT_USER(?:\(\))?|`[^`]+`@`[^`]+`|\S+)\s+)?(?:SQL\s+SECURITY\s+(?:DEFINER|INVOKER)\s+)?VIEW\s+(`([^`]+)`|[A-Za-z0-9_$.]+)\s*(?:\(([^)]*)\))?\s+AS\s+([\s\S]+)$/i.exec(vSrc);
    if (cvM || avM) {
      var vSpec = cvM || avM;
      var vReplace = !!cvM && !!vSpec[1];
      // cvM 的捕获组：2=名字 4=列清单 5=定义体；avM 的捕获组：1=名字 3=列清单 4=定义体
      var vName = stripQuotes(cvM ? vSpec[2] : (vSpec[2] || vSpec[1])).split('.').pop();
      var vCols = cvM ? vSpec[4] : vSpec[3];
      var vBody = (cvM ? vSpec[5] : vSpec[4]).trim()
        .replace(/;\s*$/, '')
        .replace(/\s+WITH\s+(?:CASCADED\s+|LOCAL\s+)?CHECK\s+OPTION\s*$/i, '');   // 接受但底层无对应语义

      // MySQL：IF NOT EXISTS 与 OR REPLACE 互斥，同时出现是语法错误
      if (vReplace && vIfNot) {
        out.push({ kind: 'err', text: 'ERROR 1064 (42000): You have an error in your SQL syntax; ' +
          'IF NOT EXISTS and OR REPLACE are mutually exclusive in CREATE VIEW' });
        return out;
      }
      if (avM && !this.viewExists(vName)) {
        out.push({ kind: 'err', text: 'ERROR 1051 (42S02): Unknown table \'' + this.current + '.' + vName + '\'' });
        return out;
      }
      if (entry.tables[vName]) {
        out.push({ kind: 'err', text: 'ERROR 1050 (42S01): Table \'' + vName + '\' already exists' });
        return out;
      }
      var vExists = this.viewExists(vName);
      if (vExists) {
        if (avM || vReplace) {
          try { entry.db.run('DROP VIEW `' + vName + '`'); } catch (e) { /* ignore */ }
          delete entry.views[vName];
        } else if (vIfNot) {
          out.push({ kind: 'out', text: 'Query OK, 0 rows affected, 1 warning (' + formatDuration(0.001) + ' sec)' });
          return out;
        } else {
          out.push({ kind: 'err', text: 'ERROR 1050 (42S01): Table \'' + vName + '\' already exists' });
          return out;
        }
      }
      var vDef = 'CREATE VIEW `' + vName + '`' + (vCols ? ' (' + vCols + ')' : '') + ' AS ' + vBody;
      try {
        entry.db.run(vDef);
      } catch (e2) {
        out.push({ kind: 'err', text: mapError(e2.message, { db: this.current }) });
        return out;
      }
      // 真实 MySQL 建视图时会校验引用的表/列是否存在；底层是惰性的，这里补一次探测
      var vProbeErr = null;
      try { entry.db.exec('SELECT * FROM `' + vName + '` LIMIT 0'); }
      catch (e3) { vProbeErr = String(e3.message || e3).replace(/^no such table:\s*main\./i, 'no such table: '); }
      if (vProbeErr) {
        try { entry.db.run('DROP VIEW `' + vName + '`'); } catch (e4) { /* ignore */ }
        out.push({ kind: 'err', text: mapError(vProbeErr, { db: this.current }) });
        out.push({ kind: 'note', text: '（真实 MySQL 创建视图时会立刻校验引用对象，引用不存在的表会直接失败，而不是建出一个用不了的视图。）' });
        return out;
      }
      var vMeta = this.buildViewMeta(vName);
      entry.views[vName] = {
        name: vName, sql: vDef, createSql: mysqlViewDDL(vName, vDef),
        isView: true, columns: vMeta ? vMeta.columns : []
      };
      out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.003) + ' sec)' });
      if (!this._viewNoted) {
        this._viewNoted = true;
        out.push({ kind: 'note', text: '（提示：视图是可用的——可以 SELECT 查询、DESC 看结构、SHOW CREATE VIEW 看定义；' +
          '但真实 MySQL 允许对「简单可更新视图」直接 INSERT/UPDATE/DELETE，本模拟器不允许。）' });
      }
      return out;
    }

    // ---- DROP VIEW ----
    var dvM = /^DROP\s+VIEW\s+(IF\s+EXISTS\s+)?([`A-Za-z0-9_$.,\s]+)$/i.exec(trimmed);
    if (dvM) {
      if (dvM[2].indexOf(',') > -1) {
        dvM[2].split(',').forEach(function (t) {
          self.runOne('DROP VIEW ' + (dvM[1] || '') + t.trim() + ';').forEach(function (b) { out.push(b); });
        });
        return out;
      }
      var dvName = stripQuotes(dvM[2].trim()).split('.').pop();
      if (entry.tables[dvName]) {
        out.push({ kind: 'err', text: 'ERROR 1347 (HY000): \'' + this.current + '.' + dvName + '\' is not VIEW' });
        return out;
      }
      if (!this.viewExists(dvName)) {
        if (dvM[1]) out.push({ kind: 'note', text: 'Query OK, 0 rows affected, 1 warning (0.00 sec)' });
        else out.push({ kind: 'err', text: 'ERROR 1051 (42S02): Unknown table \'' + this.current + '.' + dvName + '\'' });
        return out;
      }
      try { entry.db.run('DROP VIEW `' + dvName + '`'); } catch (e) { /* ignore */ }
      delete entry.views[dvName];
      out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.002) + ' sec)' });
      return out;
    }

    // ---- DROP TABLE 命中视图：说清是 1347，而不是"表不存在" ----
    var dtViewM = /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s*$/i.exec(trimmed);
    if (dtViewM && !entry.tables[stripQuotes(dtViewM[2] || dtViewM[1])]) {
      var dtvName = stripQuotes(dtViewM[2] || dtViewM[1]);
      if (this.viewExists(dtvName)) {
        out.push({ kind: 'err', text: 'ERROR 1347 (HY000): \'' + this.current + '.' + dtvName + '\' is not BASE TABLE' });
        return out;
      }
    }

    // ---- CREATE TABLE 新表 LIKE 旧表 ----
    var likeM = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s+LIKE\s+(`([^`]+)`|[A-Za-z0-9_$.]+)\s*$/i.exec(trimmed);
    if (likeM) {
      var nwName = stripQuotes(likeM[2] || likeM[1]);
      var srcName = stripQuotes(likeM[4] || likeM[3]).split('.').pop();
      if (likeM[2] && entry.tables[nwName]) {
        out.push({ kind: 'err', text: 'ERROR 1050 (42S01): Table \'' + nwName + '\' already exists' });
        return out;
      }
      var srcMeta = entry.tables[srcName];
      var srcRow = entry.db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='" + srcName.replace(/'/g, "''") + "'");
      if (!srcMeta || !srcRow.length || !srcRow[0].values.length) {
        out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + srcName + '\' doesn\'t exist' });
        return out;
      }
      var newCreateObj = srcRow[0].values[0][0].replace(
        new RegExp('^(\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(`?' + srcName + '`?)', 'i'),
        '$1' + nwName);
      try {
        entry.db.run(newCreateObj);
        var cloned = parseCreateTable(srcMeta.raw.replace(new RegExp('(`?)\\b' + srcName + '\\b(`?)'), '$1' + nwName + '$2'));
        if (cloned) {
          cloned.name = nwName;
          cloned.indexes = (srcMeta.indexes || []).map(function (x) {
            return { name: x.name, unique: x.unique, primary: x.primary, columns: x.columns.slice() };
          });
          entry.tables[nwName] = cloned;
        }
        out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.005) + ' sec)' });
      } catch (e) {
        out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) });
      }
      return out;
    }

    // ---- ALTER TABLE ... AUTO_INCREMENT = N（设置下一次自增的起始值）----
    var aiAlterM = /^ALTER\s+TABLE\s+(`([^`]+)`|[A-Za-z0-9_$.]+)\s+AUTO_INCREMENT\s*=\s*(\d+)\s*$/i.exec(trimmed);
    if (aiAlterM) {
      var aiTbl = stripQuotes(aiAlterM[2] || aiAlterM[1]);
      var aiMeta2 = entry.tables[aiTbl];
      if (!aiMeta2) {
        out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + aiTbl + '\' doesn\'t exist' });
        return out;
      }
      var aiHasCol = (aiMeta2.columns || []).some(function (c) { return /auto_increment/i.test(c.extra || ''); });
      if (!aiHasCol) {
        out.push({ kind: 'err', text: 'ERROR 1075 (42000): Incorrect table definition; there can be only one auto column and it must be defined as a key' });
        return out;
      }
      aiMeta2.autoIncrementNext = Number(aiAlterM[3]);
      out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.004) + ' sec)' });
      if (!this._aiNoted) {
        this._aiNoted = true;
        out.push({ kind: 'note', text: '（提示：AUTO_INCREMENT 起始值对后续 INSERT 生效；' +
          '自增步长（auto_increment_increment）与 INSERT ... SELECT 形式的自动编号仍不支持。）' });
      }
      return out;
    }

    // ---- ALTER TABLE ... MODIFY / CHANGE COLUMN ----
    var modM = /^ALTER\s+TABLE\s+(`([^`]+)`|[A-Za-z0-9_$]+)\s+MODIFY\s+(?:COLUMN\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s+([\s\S]+)$/i.exec(trimmed);
    var chgM = modM ? null : /^ALTER\s+TABLE\s+(`([^`]+)`|[A-Za-z0-9_$]+)\s+CHANGE\s+(?:COLUMN\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s+(`([^`]+)`|[A-Za-z0-9_$]+)\s+([\s\S]+)$/i.exec(trimmed);
    if (modM || chgM) {
      var mSpec = modM || chgM;
      var mtName = stripQuotes(mSpec[2] || mSpec[1]);
      var mOld = stripQuotes(mSpec[4] || mSpec[3]);
      var mNew = modM ? mOld : stripQuotes(mSpec[6] || mSpec[5]);
      var mType = modM ? mSpec[5] : mSpec[7];
      var metaM = entry.tables[mtName];
      if (!metaM) {
        out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + mtName + '\' doesn\'t exist' });
        return out;
      }
      var colM = metaM.columns.filter(function (c) { return c.field.toLowerCase() === mOld.toLowerCase(); })[0];
      if (!colM) {
        out.push({ kind: 'err', text: 'ERROR 1054 (42S22): Unknown column \'' + mOld + '\' in \'' + mtName + '\'' });
        return out;
      }
      try {
        if (mOld !== mNew) {
          entry.db.run('ALTER TABLE ' + mtName + ' RENAME COLUMN ' + mOld + ' TO ' + mNew);
          colM.field = mNew;
          (metaM.indexes || []).forEach(function (ix) {
            ix.columns = ix.columns.map(function (c2) { return c2.toLowerCase() === mOld.toLowerCase() ? mNew : c2; });
          });
        }
        colM.type = String(mType)
          .replace(/\s+CHARACTER\s+SET\s+\w+/gi, '').replace(/\s+COLLATE\s+\w+/gi, '')
          .replace(/\s+COMMENT\s+'(?:[^']|'')*'/gi, '').replace(/\s+AFTER\s+\w+/gi, '')
          .replace(/\s+FIRST\b/gi, '').replace(/\bUNSIGNED\b/gi, '')
          .replace(/\s+/g, ' ').trim();
        if (/^int$/i.test(colM.type)) colM.type = 'int(11)';
        out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.006) + ' sec)' });
        if (!this._colModNoted) {
          this._colModNoted = true;
          out.push({ kind: 'note', text: '（提示：底层引擎是动态类型，MODIFY/CHANGE 会改列名与 DESC 显示的类型，但不会对既有数据做强类型校验。）' });
        }
      } catch (e) {
        out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) });
      }
      return out;
    }

    // ---- ALTER TABLE ... DROP COLUMN（连带摘掉引用该列的二级索引）----
    var dropColM = /^ALTER\s+TABLE\s+(`([^`]+)`|[A-Za-z0-9_$]+)\s+DROP\s+(?:COLUMN\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s*$/i.exec(trimmed);
    if (dropColM) {
      var dcTable = stripQuotes(dropColM[2] || dropColM[1]);
      var dcCol = stripQuotes(dropColM[4] || dropColM[3]);
      var dcMeta = entry.tables[dcTable];
      if (!dcMeta) {
        out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + dcTable + '\' doesn\'t exist' });
        return out;
      }
      var dcHit = dcMeta.columns.filter(function (c) { return c.field.toLowerCase() === dcCol.toLowerCase(); }).length;
      if (!dcHit || dcMeta.columns.length <= 1) {
        out.push({ kind: 'err', text: 'ERROR 1091 (42000): Can\'t DROP \'' + dcCol + '\'; check that column/key exists' });
        return out;
      }
      var dcIdxDropped = [];
      (dcMeta.indexes || []).slice().forEach(function (ix) {
        if (ix.primary) return;
        if (ix.columns.some(function (c) { return c.toLowerCase() === dcCol.toLowerCase(); })) {
          try { entry.db.run('DROP INDEX IF EXISTS ' + ix.name); } catch (e) { /* 忽略 */ }
          dcIdxDropped.push(ix.name);
          dcMeta.indexes = dcMeta.indexes.filter(function (y) { return y !== ix; });
        }
      });
      try {
        entry.db.run('ALTER TABLE ' + dcTable + ' DROP COLUMN ' + dcCol);
        dcMeta.columns = dcMeta.columns.filter(function (c) { return c.field.toLowerCase() !== dcCol.toLowerCase(); });
        out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.006) + ' sec)' });
        if (dcIdxDropped.length) {
          out.push({ kind: 'note', text: '（该列上的索引已随之删除：' + dcIdxDropped.join(', ') + '）' });
        }
      } catch (e) {
        out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) });
      }
      return out;
    }

    // ---- ALTER TABLE ... ADD [COLUMN] col type（同步进列目录，否则 DESC 看不到新列）----
    var addColM = /^ALTER\s+TABLE\s+(`([^`]+)`|[A-Za-z0-9_$]+)\s+ADD\s+(?:COLUMN\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s+([\s\S]+)$/i.exec(trimmed);
    if (addColM && !/^(?:INDEX|KEY|UNIQUE|PRIMARY|FOREIGN|CONSTRAINT|CHECK|FULLTEXT|SPATIAL|PARTITION)$/i.test(stripQuotes(addColM[4] || addColM[3]))) {
      var acTable = stripQuotes(addColM[2] || addColM[1]);
      var acCol = stripQuotes(addColM[4] || addColM[3]);
      var acRest = addColM[5];
      var acMeta = entry.tables[acTable];
      if (!acMeta) {
        out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + acTable + '\' doesn\'t exist' });
        return out;
      }
      if (acMeta.columns.some(function (c) { return c.field.toLowerCase() === acCol.toLowerCase(); })) {
        out.push({ kind: 'err', text: 'ERROR 1060 (42S21): Duplicate column name \'' + acCol + '\'' });
        return out;
      }
      // 借 CREATE TABLE 的转译规则把这一列定义转成 SQLite 写法
      var acWrap = translateCreateTable('CREATE TABLE __ac (' + acCol + ' ' + acRest + ')');
      var acInner = acWrap.slice(acWrap.indexOf('(') + 1, acWrap.lastIndexOf(')')).trim()
        .replace(/\s+(?:FIRST|AFTER\s+`?[A-Za-z0-9_$]+`?)\s*$/i, '');
      try {
        entry.db.run('ALTER TABLE ' + acTable + ' ADD COLUMN ' + acInner);
        var acTypeM = /^([A-Za-z]+(?:\s*\(\s*[\d,\s]+\s*\))?(?:\s+UNSIGNED)?(?:\s+ZEROFILL)?)/i.exec(acRest.trim());
        var acDefM = /DEFAULT\s+('(?:[^']|'')*'|"[^"]*"|[^\s,]+)/i.exec(acRest);
        acMeta.columns.push({
          field: acCol,
          type: (acTypeM ? acTypeM[1].replace(/\s+/g, '') : 'varchar(255)').replace(/^int$/i, 'int(11)'),
          nullable: !/NOT\s+NULL/i.test(acRest),
          key: '',
          hasDefault: !!acDefM,
          defaultValue: acDefM ? stripQuotes(acDefM[1]) : null,
          extra: /AUTO_INCREMENT/i.test(acRest) ? 'auto_increment' : ''
        });
        out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(0.005) + ' sec)' });
      } catch (e) {
        out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) });
      }
      return out;
    }

    var isCreateTable = /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(sql);
    var metaParsed = isCreateTable ? parseCreateTable(sql) : null;
    // CREATE TABLE ... AS SELECT：底层建出来的列声明是 SQLite 的，需要另外补 MySQL 风格目录
    var ctasM = isCreateTable
      ? /^CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$.]+)\s+AS\s+([\s\S]+)$/i.exec(trimmed)
      : null;
    // 行锁语义被丢弃（见 translateStatement 末尾）：执行完要如实提示，不能让用户以为锁生效了
    var hadLockClause = /\s+FOR\s+UPDATE\b|\s+LOCK\s+IN\s+SHARE\s+MODE\b/i.test(sql);
    // 执行前展开 @x / @@x 变量（引号内的 @ 不会被误替换）
    var sqlExec = sql;
    if (!isCreateTable) {
      try { sqlExec = this.substituteVars(sql); }
      catch (e) { out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) }); return out; }
    }
    var tctx = { db: this.current, notes: [] };
    // AUTO_INCREMENT 起始值：把自增列的显式值补进 INSERT（只有设置过起始值的表才需要）
    this._pendingAutoInc = null;
    if (!isCreateTable) {
      var aiRewritten = this.applyAutoIncrement(entry, sqlExec);
      if (aiRewritten !== sqlExec) sqlExec = aiRewritten;
    }
    var translated = translateStatement(sqlExec, tctx);
    var t0 = Date.now();
    var usedMemory = false;
    var execFailed = false;

    try {
      if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN\s+QUERY|VALUES)\b/i.test(translated)) {
        var results = entry.db.exec(translated);
        var sec = (Date.now() - t0) / 1000;
        // ROW_COUNT() 在 MySQL 里对 SELECT 返回 -1；FOUND_ROWS() 只在用了
        // SQL_CALC_FOUND_ROWS 时才有意义（该写法在 MySQL 8.0.17 已废弃，这里如实实现）
        this.infoState.rowCount = -1;
        if (/\bSQL_CALC_FOUND_ROWS\b/i.test(sql)) {
          try {
            var noLim = translated.replace(/\s+LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?\s*$/i, '').replace(/\s+OFFSET\s+\d+\s*$/i, '');
            var allRows = entry.db.exec(noLim);
            this.infoState.foundRows = allRows.length ? allRows[0].values.length : 0;
          } catch (e) { this.infoState.foundRows = 0; }
        } else {
          this.infoState.foundRows = 0;
        }
        // 记下最后一个结果集，供界面导出 CSV / JSON（app.js 读取）
        this.lastResultSet = results.length
          ? { columns: results[0].columns.slice(), values: results[0].values }
          : null;
        if (!results.length) {
          out.push({ kind: 'out', text: 'Empty set (' + formatDuration(sec) + ' sec)' });
        } else {
          results.forEach(function (r) {
            out.push({ kind: 'out', text: vertical ? formatVertical(r) : formatTable(r) });
            out.push({ kind: 'out', text: rowsTail(r.values.length, sec) });
          });
        }
      } else {
        entry.db.run(translated);        var sec2 = (Date.now() - t0) / 1000;
        // 同步 catalog
        if (metaParsed) {
          entry.tables[metaParsed.name] = metaParsed;
          out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(sec2) + ' sec)' });
        } else {
          // sql.js 的 run() 返回的是 db 自身，影响行数要从 getRowsModified() 取，
          // 且只有 DML 才有意义（DDL 不会重置 sqlite3_changes）。
          var isDml = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(translated);
          var cnt = 0;
          if (isDml) { try { cnt = entry.db.getRowsModified(); } catch (e) { cnt = 0; } }
          if (isDml) {
            this.infoState.rowCount = cnt;
            // LAST_INSERT_ID() 只在 INSERT/REPLACE 后更新（MySQL 语义）
            if (/^\s*(INSERT|REPLACE)\b/i.test(translated)) {
              try {
                var li = entry.db.exec('SELECT last_insert_rowid()');
                if (li.length && li[0].values.length) this.infoState.lastInsertId = li[0].values[0][0];
              } catch (e) { /* ignore */ }
            }
            // INSERT IGNORE 被唯一键挡掉时，MySQL 会给一条 1062 警告
            if (/^\s*INSERT\s+OR\s+IGNORE\b/i.test(translated) && cnt === 0) {
              this.addWarning('Warning', 1062, 'Duplicate entry - INSERT IGNORE 跳过了这条记录');
            }
          }
          if (/^\s*TRUNCATE\b/i.test(sql)) {
            // MySQL 的 TRUNCATE 回报 0 rows affected（此处底层是 DELETE），
            // 同时会把 AUTO_INCREMENT 计数器重置回 1
            var trM = /^\s*TRUNCATE\s+(?:TABLE\s+)?`?([A-Za-z0-9_$.]+)`?/i.exec(sql);
            var trMeta = trM ? entry.tables[trM[1].split('.').pop()] : null;
            if (trMeta) trMeta.autoIncrementNext = null;
            out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(sec2) + ' sec)' });
          } else if (/^\s*(COMMIT|BEGIN|START|ROLLBACK|SET|SAVEPOINT|RELEASE)\b/i.test(translated)) {
            out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(sec2) + ' sec)' });
          } else {
            out.push({ kind: 'out', text: 'Query OK, ' + cnt + ' row' + (cnt === 1 ? '' : 's') + ' affected (' + formatDuration(sec2) + ' sec)' });
          }
          // DROP / ALTER / RENAME / CREATE INDEX 后同步 catalog
          this.syncCatalogAfter(entry, translated);
          // INSERT 成功后推进 AUTO_INCREMENT 计数器
          if (this._pendingAutoInc) {
            this._pendingAutoInc.meta.autoIncrementNext = this._pendingAutoInc.next;
            this._pendingAutoInc = null;
          }
          // CREATE TABLE ... AS SELECT：补一份 MySQL 风格的列目录
          if (ctasM) {
            var ctasName = stripQuotes(ctasM[2] || ctasM[1]);
            var ctasMeta = this.buildCtasMeta(ctasName, ctasM[3]);
            if (ctasMeta) entry.tables[ctasName] = ctasMeta;
          }
        }
      }
    } catch (e) {
      var dup = null;
      try { dup = this.findDuplicateValue(entry, translated, e.message); } catch (e2) { dup = null; }
      out.push({ kind: 'err', text: mapError(e.message, { db: this.current, dupValue: dup, stmt: sql }) });
      execFailed = true;
    }
    // 诚实维护警告列表（SHOW WARNINGS 用）：除零是 MySQL 会给警告的典型场景
    if (!execFailed && /\/\s*0(?![.\d])/.test(sql)) this.addWarning('Warning', 1365, 'Division by 0');
    // 转译阶段的诚实提示（例如 GROUP_CONCAT(DISTINCT ... SEPARATOR ...) 的等价实现说明），
    // 每条只在会话里提示一次，避免刷屏
    if (tctx.notes && tctx.notes.length) {
      this._xlateNotes = this._xlateNotes || {};
      tctx.notes.forEach(function (n) {
        if (self._xlateNotes[n]) return;
        self._xlateNotes[n] = 1;
        out.push({ kind: 'note', text: n });
      });
    }
    if (hadLockClause && !this._lockClauseNoted) {
      this._lockClauseNoted = true;
      out.push({ kind: 'note', text: '（提示：FOR UPDATE / LOCK IN SHARE MODE 的加锁语义被忽略——模拟器只有单个连接、没有行级锁，' +
        '不过 SELECT 返回的数据本身是真实的。）' });
    }
    return out;
  };

  /** 从失败的 INSERT 中尽力找出冲突值，让 1062 报错更逼真 */
  Engine.prototype.findDuplicateValue = function (entry, sql, msg) {
    var m = /UNIQUE constraint failed:\s*(.+)$/i.exec(msg || '');
    if (!m) return null;
    var parts = m[1].trim().split('.');
    var table = parts[0], col = parts[parts.length - 1];
    var meta = entry.tables[table];
    if (!meta) return null;
    var idx = -1;
    meta.columns.forEach(function (c, i) { if (c.field === col) idx = i; });
    if (idx < 0) return null;
    var vm = /VALUES\s*\(([\s\S]*?)\)/i.exec(sql);
    if (!vm) return null;
    var vals = splitTopLevel(vm[1]);
    if (idx >= vals.length) return null;
    return stripQuotes(vals[idx].trim());
  };

  Engine.prototype.syncCatalogAfter = function (entry, sql) {
    var m;
    if ((m = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)/i.exec(sql))) {
      delete entry.tables[stripQuotes(m[2] || m[1])];
      return;
    }
    if ((m = /^\s*TRUNCATE\s+(?:TABLE\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)/i.exec(sql))) {
      return;
    }
    if ((m = /^\s*ALTER\s+TABLE\s+(`([^`]+)`|[A-Za-z0-9_$]+)\s+RENAME\s+TO\s+(`([^`]+)`|[A-Za-z0-9_$]+)/i.exec(sql))) {
      var from = stripQuotes(m[2] || m[1]), to = stripQuotes(m[4] || m[3]);
      if (entry.tables[from]) { entry.tables[to] = entry.tables[from]; entry.tables[to].name = to; delete entry.tables[from]; }
      return;
    }
    // CREATE [UNIQUE] INDEX name ON tbl (cols)：把索引补进元数据，让 SHOW INDEX / DESC 保持同步
    if ((m = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s+ON\s+(`([^`]+)`|[A-Za-z0-9_$.]+)\s*\(([^)]*)\)/i.exec(sql))) {
      var ixName = stripQuotes(m[3] || m[2]);
      var ixTable = stripQuotes(m[5] || m[4]).split('.').pop();
      var meta = entry.tables[ixTable];
      if (meta) {
        meta.indexes = meta.indexes || [];
        var cols = m[6].split(',').map(function (c) {
          return stripQuotes(c.trim().replace(/\s+(ASC|DESC)$/i, ''));
        }).filter(Boolean);
        var exist = meta.indexes.filter(function (x) { return x.name === ixName; })[0];
        if (exist) exist.columns = cols;
        else meta.indexes.push({ name: ixName, unique: !!m[1], primary: false, columns: cols });
      }
      return;
    }
    // DROP INDEX name：从所有表里摘掉该索引
    if ((m = /^\s*DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)/i.exec(sql))) {
      var dropName = stripQuotes(m[2] || m[1]);
      Object.keys(entry.tables).forEach(function (t) {
        var md = entry.tables[t];
        if (md.indexes) md.indexes = md.indexes.filter(function (x) { return x.name !== dropName; });
      });
      return;
    }
  };

  /* ---- 8.2 SHOW 系列 ---- */

  Engine.prototype.handleShow = function (rest, vertical) {
    var self = this;
    var out = [];
    var r = rest.trim().replace(/;$/, '');
    var m;

    if ((m = /^(?:DATABASES|SCHEMAS)\b([\s\S]*)$/i.exec(r))) {
      var dbRows = this.databaseNames().sort().map(function (n) { return [n]; });
      var dbF = filterShowRows(dbRows, m[1], ['Database']);
      var dbBlocks = [this.resultBlock(rs(['Database'], dbF.rows), dbF.rows.length, vertical)];
      if (dbF.unsupported) dbBlocks.push({ kind: 'note', text: SHOW_FILTER_NOTE });
      return dbBlocks;
    }
    if ((m = /^TABLES\b([\s\S]*)$/i.exec(r))) {
      var tblDbM = /^\s*(?:FROM|IN)\s+(`([^`]+)`|[A-Za-z0-9_$]+)([\s\S]*)$/i.exec(m[1]);
      var dbName = tblDbM ? stripQuotes(tblDbM[2] || tblDbM[1]) : this.current;
      var tblTail = tblDbM ? tblDbM[3] : m[1];
      if (!this.databases[dbName]) return this.errBlock('ERROR 1049 (42000): Unknown database \'' + dbName + '\'');
      // 真实 MySQL 的 SHOW TABLES 会把视图与临时表一并列出
      var names = this.tableNames(dbName).concat(this.viewNames(dbName)).sort();
      var fT = filterShowRows(names.map(function (n) { return [n]; }), tblTail, ['Tables_in_' + dbName]);
      var tblBlocks = [this.resultBlock(rs(['Tables_in_' + dbName], fT.rows), fT.rows.length)];
      if (fT.unsupported) tblBlocks.push({ kind: 'note', text: SHOW_FILTER_NOTE });
      return tblBlocks;
    }
    if ((m = /^(FULL\s+)?(?:COLUMNS|FIELDS)\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$.]+)(?:\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$]+))?([\s\S]*)$/i.exec(r))) {
      var cTok = splitDbTable(m[2]);
      var cDb = m[3] ? stripQuotes(m[3]) : cTok.db;
      var cTail = m[4] || '';
      var cLikeM = /\bLIKE\s+'((?:[^']|'')*)'/i.exec(cTail);
      var cWhereM = /\bWHERE\s+`?Field`?\s*=\s*'((?:[^']|'')*)'/i.exec(cTail);
      var cPat = cLikeM ? cLikeM[1].split("''").join("'")
        : (cWhereM ? cWhereM[1].split("''").join("'") : null);
      return this.describeTable(cTok.table, cDb, cPat, !!m[1]);
    }
    // SHOW CREATE VIEW —— 视图定义
    if ((m = /^CREATE\s+VIEW\s+(`[^`]+`|[A-Za-z0-9_$.]+)/i.exec(r))) {
      var vTok = splitDbTable(m[1]);
      var vn = vTok.table, vdb = vTok.db || this.current;
      if (this.tableExists(vn, vdb)) return this.errBlock('ERROR 1347 (HY000): \'' + vdb + '.' + vn + '\' is not VIEW');
      var vdef = this.viewDef(vn, vdb);
      if (!vdef) return this.errBlock('ERROR 1051 (42S02): Unknown table \'' + vdb + '.' + vn + '\'');
      return [this.resultBlock(rs(['View', 'Create View', 'character_set_client', 'collation_connection'],
        [[vn, vdef.createSql, 'utf8mb4', 'utf8mb4_0900_ai_ci']]), 1, vertical)];
    }
    if ((m = /^CREATE\s+TABLE\s+(`[^`]+`|[A-Za-z0-9_$.]+)(?:\s+FROM\s+(`[^`]+`|[A-Za-z0-9_$]+))?/i.exec(r))) {
      var tTok = splitDbTable(m[1]);
      var t2 = tTok.table;
      var dbn = m[2] ? stripQuotes(m[2]) : (tTok.db || this.current);
      // SHOW CREATE TABLE 对视图同样可用（MySQL 会返回视图定义）
      if (!this.tableExists(t2, dbn) && this.viewExists(t2, dbn)) {
        var vdef2 = this.viewDef(t2, dbn);
        return [this.resultBlock(rs(['View', 'Create View', 'character_set_client', 'collation_connection'],
          [[t2, vdef2 ? vdef2.createSql : '', 'utf8mb4', 'utf8mb4_0900_ai_ci']]), 1, vertical)];
      }
      if (!this.tableExists(t2, dbn)) return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn + '.' + t2 + '\' doesn\'t exist');
      var meta = this.meta(t2, dbn);
      var createSql = showCreateTable(meta, t2);
      var blocks = [this.resultBlock(rs(['Table', 'Create Table'], [[t2, createSql]]), 1, vertical)];
      if (!vertical && createSql.length > 110) {
        blocks.push({ kind: 'note', text: '（提示：建表语句较长，用 SHOW CREATE TABLE ' + t2 + '\\G 可纵向查看，与真实 MySQL 习惯一致）' });
      }
      return blocks;
    }
    if ((m = /^(?:INDEX|INDEXES|KEYS)\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$.]+)(?:\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$]+))?/i.exec(r))) {
      var iTok = splitDbTable(m[1]);
      var t3 = iTok.table;
      var dbw3 = m[2] ? stripQuotes(m[2]) : null;
      var dbn3 = dbw3 || iTok.db || this.current;
      if (this.viewExists(t3, dbn3)) return this.errBlock('ERROR 1347 (HY000): \'' + dbn3 + '.' + t3 + '\' is not BASE TABLE');
      var meta3 = this.meta(t3, dbn3);
      if (!meta3 || !this.tableExists(t3, dbn3)) {
        return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn3 + '.' + t3 + '\' doesn\'t exist');
      }
      // 表存在但没有二级索引：MySQL 返回空结果集，而不是"表不存在"
      var ixr = indexesResult(meta3, t3);
      return [this.resultBlock(ixr, ixr.values.length, vertical)];
    }
    if (/^(?:(?:SESSION|GLOBAL|LOCAL)\s+)?VARIABLES\b/i.test(r)) {
      var varTail = r.replace(/^(?:(?:SESSION|GLOBAL|LOCAL)\s+)?VARIABLES\b/i, '');
      var fV = filterShowRows(VARIABLES.map(function (v) { return [v[0], v[1]]; }), varTail, ['Variable_name', 'Value']);
      return [this.resultBlock(rs(['Variable_name', 'Value'], fV.rows), fV.rows.length)];
    }
    if (/^STATUS\b/i.test(r)) {
      var st = [['Aborted_clients', '0'], ['Connections', '1'], ['Questions', String(this.counter)],
        ['Threads_connected', '1'], ['Threads_running', '1'], ['Uptime', String(Math.floor((Date.now() - this.startTime) / 1000))],
        ['Com_select', String(this.counter)], ['Ssl_cipher', '']];
      var fS = filterShowRows(st, r.replace(/^STATUS\b/i, ''), ['Variable_name', 'Value']);
      return [this.resultBlock(rs(['Variable_name', 'Value'], fS.rows), fS.rows.length)];
    }
    if ((m = /^ENGINES\b([\s\S]*)$/i.exec(r))) {
      var eng = [
        ['InnoDB', 'DEFAULT', 'Supports transactions, row-level locking, and foreign keys', 'YES', 'YES', 'YES'],
        ['MyISAM', 'YES', 'MyISAM storage engine', 'NO', 'NO', 'NO'],
        ['MEMORY', 'YES', 'Hash based, stored in memory, useful for temporary tables', 'NO', 'NO', 'NO'],
        ['CSV', 'YES', 'CSV storage engine', 'NO', 'NO', 'NO']
      ];
      var fE = filterShowRows(eng, m[1], ['Engine', 'Support', 'Comment', 'Transactions', 'XA', 'Savepoints']);
      return [this.resultBlock(rs(['Engine', 'Support', 'Comment', 'Transactions', 'XA', 'Savepoints'], fE.rows), fE.rows.length)];
    }
    if (/^WARNINGS\b/i.test(r) || /^ERRORS\b/i.test(r)) {
      var wIsErr = /^ERRORS\b/i.test(r);
      var wRows = (this.warnings || []).filter(function (w) { return wIsErr ? /^Error$/i.test(w[0]) : true; });
      return [this.resultBlock(rs(['Level', 'Code', 'Message'], wRows), wRows.length)];
    }
    if (/^CHARSET\b/i.test(r)) {
      var cs = [['utf8mb4', 'UTF-8 Unicode', 'utf8mb4_0900_ai_ci', '4'], ['utf8', 'UTF-8 Unicode', 'utf8_general_ci', '3'], ['latin1', 'cp1252 West European', 'latin1_swedish_ci', '1']];
      return [this.resultBlock(rs(['Charset', 'Description', 'Default collation', 'Maxlen'], cs), cs.length)];
    }
    if (/^COLLATION\b/i.test(r)) {
      var cl = [['utf8mb4_0900_ai_ci', 'utf8mb4', '45', 'Yes', 'Yes', '1'], ['utf8mb4_bin', 'utf8mb4', '46', '', 'Yes', '1'], ['utf8_general_ci', 'utf8', '33', 'Yes', '', '1']];
      return [this.resultBlock(rs(['Collation', 'Charset', 'Id', 'Default', 'Compiled', 'Sortlen'], cl), cl.length)];
    }
    if (/^PROCESSLIST\b/i.test(r)) {
      var pl = [[String(CONNECTION_ID), 'root', 'localhost', this.current || '', 'Query', '0', 'SHOW PROCESSLIST', '']];
      return [this.resultBlock(rs(['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'], pl), pl.length)];
    }
    if (/^GRANTS\b/i.test(r)) {
      return [this.resultBlock(rs(['Grants for root@localhost'], [
        ['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION'],
        ['GRANT PROXY ON \'\'@\'\' TO `root`@`localhost` WITH GRANT OPTION']
      ]), 2, vertical)];
    }
    if (/^FULL\s+TABLES\b/i.test(r)) {
      var ftM = /LIKE\s+'([^']*)'/i.exec(r);
      var ftDb = (/^FULL\s+TABLES\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$]+)/i.exec(r) || [])[1];
      var ftName = ftDb ? stripQuotes(ftDb) : this.current;
      if (!this.databases[ftName]) return this.errBlock('ERROR 1049 (42000): Unknown database \'' + ftName + '\'');
      var ftObjs = this.objectList(ftName);
      if (ftM) {
        var ftRx = new RegExp('^' + ftM[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
        ftObjs = ftObjs.filter(function (o) { return ftRx.test(o.name); });
      }
      return [this.resultBlock(rs(['Tables_in_' + ftName, 'Table_type'],
        ftObjs.map(function (o) { return [o.name, o.isView ? 'VIEW' : 'BASE TABLE']; })), ftObjs.length, vertical)];
    }
    if (/^TABLE\s+STATUS\b/i.test(r)) {
      var tsDb = (/^TABLE\s+STATUS\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$]+)/i.exec(r) || [])[1];
      var tsName = tsDb ? stripQuotes(tsDb) : this.current;
      if (!this.databases[tsName]) return this.errBlock('ERROR 1049 (42000): Unknown database \'' + tsName + '\'');
      // MySQL 的 SHOW TABLE STATUS 会把视图也列出来，视图的 Engine 为 NULL、Comment 为 VIEW
      var tsRows = this.objectList(tsName).map(function (o) {
        if (o.isView) return [o.name, null, null, null, null, null, null, null, null, null, null, null, 'VIEW'];
        var n = o.name;
        var md = self.meta(n, tsName) || { columns: [] };
        var hasAI = md.columns.some(function (c) { return /auto_increment/i.test(c.extra || ''); });
        var cnt = 0;
        try {
          var rr = self.databases[tsName].db.exec('SELECT COUNT(*) FROM "' + n.replace(/"/g, '""') + '"');
          if (rr.length && rr[0].values.length) cnt = rr[0].values[0][0];
        } catch (e) { cnt = 0; }
        return [n, 'InnoDB', 10, 'Dynamic', cnt, hasAI ? cnt + 1 : null,
          '2026-09-01 00:00:00', '2026-09-01 00:00:00', null,
          'utf8mb4_0900_ai_ci', null, '', ''];
      });
      return [this.resultBlock(rs(['Name', 'Engine', 'Version', 'Row_format', 'Rows', 'Auto_increment',
        'Create_time', 'Update_time', 'Check_time', 'Collation', 'Checksum', 'Create_options', 'Comment'],
        tsRows), tsRows.length, vertical)];
    }
    if ((m = /^CREATE\s+(?:DATABASE|SCHEMA)\s+(`[^`]+`|[A-Za-z0-9_$]+)/i.exec(r))) {
      var cdb = stripQuotes(m[1]);
      if (!this.databases[cdb]) return this.errBlock('ERROR 1049 (42000): Unknown database \'' + cdb + '\'');
      return [this.resultBlock(rs(['Database', 'Create Database'],
        [[cdb, 'CREATE DATABASE `' + cdb + '` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ ']]), 1, vertical)];
    }
    // ---- 这些 SHOW 在真实 MySQL 里都是合法语句，只是模拟器里没有对应对象 ----
    //      旧实现一律报 1064，等于把"本模拟器没实现"伪装成"你的语法写错了"。
    var emptyShows = [
      [/^TRIGGERS\b/i, ['Trigger', 'Event', 'Table', 'Statement', 'Timing', 'Created', 'sql_mode', 'Definer', 'character_set_client', 'collation_connection', 'Database Collation']],
      [/^EVENTS\b/i, ['Db', 'Name', 'Definer', 'Time zone', 'Type', 'Execute at', 'Interval value', 'Interval field', 'Starts', 'Ends', 'Status', 'Originator', 'character_set_client', 'collation_connection', 'Database Collation']],
      [/^(?:PROCEDURE|FUNCTION)\s+STATUS\b/i, ['Db', 'Name', 'Type', 'Definer', 'Modified', 'Created', 'Security_type', 'Comment', 'character_set_client', 'collation_connection', 'Database Collation']],
      [/^OPEN\s+TABLES\b/i, ['Database', 'Table', 'In_use', 'Name_locked']],
      [/^(?:BINARY|BINLOG)\s+LOG(?:S|S\s+STATUS)\b/i, ['Log_name', 'File_size', 'Encrypted']],
      [/^(?:REPLICA|SLAVE|MASTER)\s+STATUS\b/i, ['File', 'Position', 'Binlog_Do_DB', 'Binlog_Ignore_DB', 'Executed_Gtid_Set']],
      [/^PROFILES\b/i, ['Query_ID', 'Duration', 'Query']],
      [/^PLUGINS\b/i, ['Name', 'Status', 'Type', 'Library', 'License']],
      [/^RELAYLOG\s+EVENTS\b/i, ['Log_name', 'Pos', 'Event_type', 'Server_id', 'End_log_pos', 'Info']]
    ];
    for (var si = 0; si < emptyShows.length; si++) {
      if (!emptyShows[si][0].test(r)) continue;
      return [this.resultBlock(rs(emptyShows[si][1], []), 0, vertical),
        { kind: 'note', text: '（提示：模拟器里没有真正的 ' + r.split(/\s+/)[0].toUpperCase() +
          ' 对象，所以返回空结果集 —— 这条语句被正确识别了，不是语法错误。）' }];
    }
    if (/^COUNT\s*\(\s*\*\s*\)\s+(WARNINGS|ERRORS)\b/i.test(r)) {
      var cwIsErr = /ERRORS/i.test(r);
      var cwName = cwIsErr ? '@@session.error_count' : '@@session.warning_count';
      return [this.resultBlock(rs([cwName], [[String(cwIsErr ? 0 : (this.warnings || []).length)]]), 1, vertical)];
    }
    if ((m = /^ENGINE\s+(\w+)\s+(STATUS|MUTEX)\b/i.exec(r))) {
      return [this.resultBlock(rs(['Type', 'Name', 'Status'],
        [[m[1], '', '本模拟器未实现 SHOW ENGINE ' + m[1].toUpperCase() + ' ' + m[2].toUpperCase() +
          ' —— 存储引擎的运行时状态属于真实 InnoDB 的内部信息，模拟器没有对应数据可报告。']]), 1, vertical),
        { kind: 'note', text: '（提示：本模拟器底层是 SQLite，SHOW ENGINES 里的 InnoDB 是静态展示，因此没有引擎运行时状态。）' }];
    }
    if ((m = /^(?:FULL\s+)?PROCESSLIST\b/i.exec(r))) {
      var pl = [[String(CONNECTION_ID), 'root', 'localhost', this.current || '', 'Query', '0', 'SHOW PROCESSLIST', '']];
      return [this.resultBlock(rs(['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'], pl), pl.length, vertical)];
    }
    // ---- 仍未实现的 SHOW：语句本身在真实 MySQL 里存在，因此不能说成 1064 语法错误 ----
    return this.errBlock('ERROR 1235 (42000): 本模拟器暂不支持 SHOW ' + r.split(/\s+/).slice(0, 2).join(' ') +
      ' —— 该语句在真实 MySQL 中存在，但本模拟器没有实现');
  };

  Engine.prototype.describeTable = function (table, dbName, likePattern, full) {
    var dbn = dbName || this.current;
    if (dbName && !this.databases[dbn]) {
      return this.errBlock('ERROR 1049 (42000): Unknown database \'' + dbn + '\'');
    }
    var isView = this.viewExists(table, dbn);
    if (!this.tableExists(table, dbn) && !isView) {
      return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn + '.' + table + '\' doesn\'t exist');
    }
    var meta = this.meta(table, dbn);
    if (!meta) return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn + '.' + table + '\' doesn\'t exist');
    var r = describeResult(meta, table, full);
    // SHOW COLUMNS ... LIKE 'x' / DESC tbl col：按列名过滤（MySQL 里 DESC tbl col 等价于 LIKE 'col'）
    if (likePattern) {
      var rx = likeRegex(likePattern);
      r = rs(r.columns, r.values.filter(function (row) { return rx.test(String(row[0])); }));
    }
    var blocks = [this.resultBlock(r, r.values.length)];
    if (isView) {
      blocks.push({ kind: 'note', text: '（' + table + ' 是视图，不是基表：列类型由底层声明推导，计算列可能显示为 varchar(255)。用 SHOW CREATE VIEW ' + table + ' 可看视图定义。）' });
    }
    return blocks;
  };

  Engine.prototype.resultBlock = function (resultSet, count, vertical) {
    if (vertical === undefined) vertical = this._lastVertical;
    return { kind: 'out', text: (vertical ? formatVertical(resultSet) : formatTable(resultSet)) + '\n' + rowsTail(resultSet.values.length, 0.001) };
  };

  Engine.prototype.errBlock = function (text) { return [{ kind: 'err', text: text }]; };

  /** 记一条会话警告（SHOW WARNINGS 用） */
  Engine.prototype.addWarning = function (level, code, message) {
    if (!this.warnings) this.warnings = [];
    this.warnings.push([level, String(code), message]);
    if (this.warnings.length > 64) this.warnings.shift();
  };

  /**
   * 把某个库导出成可重放的 SQL 脚本（建表语句 + 数据 INSERT + 视图定义）。
   * 供界面「导出 SQL 脚本」使用；全程在本地生成 Blob，不联网、不上传。
   */
  Engine.prototype.dumpDatabase = function (dbName) {
    var name = dbName || this.current;
    var entry = this.databases[name];
    if (!entry) return null;
    var self = this;
    var out = [];
    out.push('-- MySQL 终端模拟器 · 数据库导出脚本');
    out.push('-- 数据库：' + name + '　导出时间：' + fmtLocalDT(new Date()));
    out.push('-- 用「工具」面板里的「导入 SQL 脚本」选中本文件即可重放。');
    out.push('');
    out.push('CREATE DATABASE IF NOT EXISTS `' + name + '`;');
    out.push('USE `' + name + '`;');
    out.push('');
    this.objectList(name).forEach(function (o) {
      if (o.isView) {
        var vd = self.viewDef(o.name, name);
        out.push('DROP VIEW IF EXISTS `' + o.name + '`;');
        if (vd && vd.createSql) out.push(vd.createSql + ';');
        out.push('');
        return;
      }
      var meta = self.meta(o.name, name);
      out.push('DROP TABLE IF EXISTS `' + o.name + '`;');
      out.push(showCreateTable(meta, o.name) + ';');
      try {
        var r = entry.db.exec('SELECT * FROM `' + String(o.name).replace(/`/g, '``') + '`');
        if (r.length && r[0].values.length) {
          var cols = r[0].columns;
          var rows = r[0].values.map(function (row) {
            return '(' + row.map(function (v) {
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return String(v);
              if (v instanceof Uint8Array) {
                return "X'" + Array.prototype.map.call(v, function (b) { return b2h(b); }).join('') + "'";
              }
              return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
            }).join(', ') + ')';
          });
          out.push('INSERT INTO `' + o.name + '` (' + cols.map(function (c) { return '`' + c + '`'; }).join(', ') + ') VALUES');
          out.push(rows.join(',\n') + ';');
        }
      } catch (e) {
        out.push('-- （' + o.name + ' 的数据导出失败：' + (e && e.message ? e.message : e) + '）');
      }
      out.push('');
    });
    return out.join('\n');
  };

  Engine.prototype.statusText = function () {
    var up = Math.floor((Date.now() - this.startTime) / 1000);
    return [
      '--------------',
      'mysql  Ver ' + SERVER_VERSION + ' for Linux on x86_64 (MySQL Terminal Simulator)',
      '',
      'Connection id:\t\t' + CONNECTION_ID,
      'Current database:\t' + (this.current || ''),
      'Current user:\t\t' + CURRENT_USER,
      'Server version:\t\t' + SERVER_VERSION_FULL,
      'Protocol version:\t10',
      'Connection:\t\tLocalhost via UNIX socket',
      'Server characterset:\tutf8mb4',
      'Db     characterset:\tutf8mb4',
      'Client characterset:\tutf8mb4',
      'Conn.  characterset:\tutf8mb4',
      'UNIX socket:\t\t' + SOCKET,
      'Uptime:\t\t\t' + up + ' sec',
      '',
      'Threads: 1  Questions: ' + this.counter + '  Slow queries: 0  Opens: 12  Flush tables: 1  Open tables: ' + this.tableNames().length + '  Queries per second avg: 0.000',
      '--------------'
    ].join('\n');
  };

  Engine.prototype.banner = function () {
    return [
      'Welcome to the MySQL monitor.  Commands end with ; or \\g.',
      'Your MySQL connection id is ' + CONNECTION_ID,
      'Server version: ' + SERVER_VERSION_FULL + ' MySQL Community Server - GPL (离线模拟器)',
      '',
      'Copyright (c) 2000, 2026, Oracle and/or its affiliates.',
      '',
      'Oracle is a registered trademark of Oracle Corporation and/or its',
      'affiliates. Other names may be trademarks of their respective',
      'owners.',
      '',
      "Type 'help;' or '\\h' for help. Type '\\c' to clear the current input statement.",
      '',
      '提示：本页为离线教学模拟器，SQL 由浏览器内的 SQLite 引擎执行并做了 MySQL 方言兼容；',
      '      数据只存在于浏览器内存中，刷新页面即恢复初始示例数据。'
    ].join('\n');
  };

  var HELP_TEXT = [
    'mysql> 常用命令一览（本模拟器）',
    '',
    '  数据库操作     SHOW DATABASES;  CREATE DATABASE 名称;  USE 名称;  DROP DATABASE 名称;',
    '  表操作         SHOW TABLES;  DESC 表名;  SHOW CREATE TABLE 表名;  DROP TABLE 表名;',
    '  视图           CREATE VIEW 视图名 AS SELECT ...;   CREATE OR REPLACE VIEW ...;',
    '                 ALTER VIEW 视图名 AS SELECT ...;   DROP VIEW 视图名;',
    '                 SHOW FULL TABLES;（用 Table_type 区分 BASE TABLE / VIEW）',
    '                 SHOW CREATE VIEW 视图名;  DESC 视图名;  SELECT ... FROM 视图名;',
    '  变量与状态     SHOW VARIABLES LIKE \'version\';  SHOW STATUS;  SHOW ENGINES;  status;',
    '  事务与变量     START TRANSACTION; / BEGIN;   COMMIT;   ROLLBACK;   SAVEPOINT 名称;',
    '                 SET @x = 1;   SELECT @x;   SELECT @@version, @@port;   SET NAMES utf8mb4;',
    '  索引维护       ALTER TABLE 表 ADD [UNIQUE] INDEX 名 (列);  DROP INDEX 名 ON 表;',
    '  执行计划       EXPLAIN SELECT ...;   EXPLAIN FORMAT=JSON SELECT ...;   EXPLAIN ANALYZE SELECT ...;',
    '  变量赋值       SET @x = 1;   SELECT @x;   SELECT 列 INTO @x FROM 表 WHERE ...;',
    '  客户端命令     help / \\h      显示本帮助',
    '                 status / \\s    查看连接与服务器状态',
    '                 clear          清屏（等同 Ctrl+L）：只清空可视区域，向上滚动仍可回看历史',
    '                 exit / quit     退出（等同 Ctrl+D）',
    '  导出与导入     右侧「工具」面板：把上一个查询结果导出成 CSV / JSON，',
    '                 把当前库导出成 .sql 脚本，或选择本地 .sql 文件导入执行。',
    '                 全部在本地完成，不联网、不上传。',
    '  书写技巧       语句以 ; 或 \\g 结束；以 \\G 结束则纵向显示结果',
    '                 输入未结束时提示符变为 ->，可继续换行书写',
    '                 Tab 补全 SQL 关键字与表名；↑ ↓ 翻阅历史命令',
    '                 Ctrl+C 放弃当前输入；Ctrl+L 清屏；Ctrl+D 退出',
    '',
    '  语法兼容       MySQL 专有语法（AUTO_INCREMENT、ENGINE=InnoDB、ENUM、反引号、',
    '                 SHOW/DESC、GROUP_CONCAT ... SEPARATOR、LIMIT a,b、CONCAT/IF/NOW 等',
    '                 函数）会被自动转译为底层等价语句，使用方式与真实 MySQL 一致。',
    '                 未实现项见右侧「语法差异」面板。'
  ].join('\n');

  /* ======================= 10. 示例数据 ======================= */

  var SEED = {
    mysql: [
      "CREATE TABLE `user` (" +
      "  `Host` varchar(255) NOT NULL DEFAULT ''," +
      "  `User` varchar(32) NOT NULL DEFAULT ''," +
      "  `Select_priv` enum('N','Y') NOT NULL DEFAULT 'N'," +
      "  `Insert_priv` enum('N','Y') NOT NULL DEFAULT 'N'," +
      "  `authentication_string` text," +
      "  `plugin` varchar(64) DEFAULT 'caching_sha2_password'," +
      "  PRIMARY KEY (`Host`,`User`)," +
      "  KEY `idx_plugin` (`plugin`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统用户表'",
      "INSERT INTO `user` VALUES" +
      " ('localhost','root','Y','Y','*A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0','caching_sha2_password')," +
      " ('%','app_rw','Y','N','*F1E2D3C4B5A69788796A5B4C3D2E1F0A1B2C3D4E','caching_sha2_password')," +
      " ('localhost','reporter','Y','N','','caching_sha2_password')"
    ],
    production: [
      "CREATE TABLE `users` (" +
      "  `id` int(11) NOT NULL AUTO_INCREMENT," +
      "  `username` varchar(50) NOT NULL COMMENT '登录名'," +
      "  `email` varchar(100) NOT NULL," +
      "  `city` varchar(50) DEFAULT NULL," +
      "  `vip_level` tinyint(4) NOT NULL DEFAULT '0'," +
      "  `balance` decimal(10,2) NOT NULL DEFAULT '0.00'," +
      "  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_username` (`username`)," +
      "  KEY `idx_city` (`city`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表'",
      "INSERT INTO `users` (`username`,`email`,`city`,`vip_level`,`balance`,`created_at`) VALUES" +
      " ('zhangsan','zhangsan@example.com','深圳',3,12800.50,'2026-03-12 09:24:11')," +
      " ('lisi','lisi@example.com','深圳',1,3200.00,'2026-04-02 14:05:38')," +
      " ('wangwu','wangwu@example.com','北京',2,8760.25,'2026-04-19 10:41:02')," +
      " ('zhaoliu','zhaoliu@example.com','上海',0,560.00,'2026-05-08 16:22:47')," +
      " ('sunqi','sunqi@example.com','深圳',2,15440.90,'2026-05-23 11:09:15')," +
      " ('zhouba','zhouba@example.com','杭州',1,2330.40,'2026-06-11 08:57:33')," +
      " ('wujiu','wujiu@example.com','北京',0,0.00,'2026-06-30 19:13:26')," +
      " ('zhengshi','zhengshi@example.com','广州',4,38210.80,'2026-07-15 13:48:52')",

      "CREATE TABLE `products` (" +
      "  `id` int(11) NOT NULL AUTO_INCREMENT," +
      "  `name` varchar(100) NOT NULL," +
      "  `category` varchar(30) NOT NULL," +
      "  `price` decimal(10,2) NOT NULL," +
      "  `stock` int(11) NOT NULL DEFAULT '0'," +
      "  `on_sale` tinyint(1) NOT NULL DEFAULT '1'," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_category` (`category`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品表'",
      "INSERT INTO `products` (`name`,`category`,`price`,`stock`,`on_sale`) VALUES" +
      " ('KP100D 信创台式机','整机',5999.00,120,1)," +
      " ('飞腾系列主机','整机',4680.00,86,1)," +
      " ('鲲鹏笔记本','笔记本',7299.00,45,1)," +
      " ('27 英寸 2K 显示器','外设',1099.00,300,1)," +
      " ('机械键盘 87 键','外设',299.00,540,1)," +
      " ('人体工学鼠标','外设',159.00,620,1)," +
      " ('NVMe 固态硬盘 1TB','存储',549.00,210,1)," +
      " ('DDR4 内存条 16G','存储',329.00,180,1)," +
      " ('国产操作系统授权','软件',899.00,999,1)," +
      " ('办公软件套件授权','软件',399.00,0,0)",

      "CREATE TABLE `orders` (" +
      "  `id` int(11) NOT NULL AUTO_INCREMENT," +
      "  `user_id` int(11) NOT NULL," +
      "  `product_id` int(11) NOT NULL," +
      "  `quantity` int(11) NOT NULL DEFAULT '1'," +
      "  `total` decimal(10,2) NOT NULL," +
      "  `status` enum('pending','paid','shipped','done','cancelled') NOT NULL DEFAULT 'pending'," +
      "  `order_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_user` (`user_id`)," +
      "  KEY `idx_status` (`status`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表'",
      "INSERT INTO `orders` (`user_id`,`product_id`,`quantity`,`total`,`status`,`order_date`) VALUES" +
      " (1,1,2,11998.00,'done','2026-07-01 10:12:00')," +
      " (1,4,3,3297.00,'done','2026-07-06 15:31:00')," +
      " (2,5,1,299.00,'done','2026-07-08 09:02:00')," +
      " (3,3,1,7299.00,'shipped','2026-07-14 11:20:00')," +
      " (3,9,2,1798.00,'paid','2026-07-21 17:45:00')," +
      " (4,6,2,318.00,'done','2026-07-23 08:36:00')," +
      " (5,1,5,29995.00,'shipped','2026-08-02 14:09:00')," +
      " (5,7,4,2196.00,'done','2026-08-05 10:55:00')," +
      " (6,2,1,4680.00,'done','2026-08-09 16:41:00')," +
      " (6,8,2,658.00,'cancelled','2026-08-11 12:07:00')," +
      " (8,1,10,59990.00,'done','2026-08-18 09:30:00')," +
      " (8,3,2,14598.00,'paid','2026-08-25 18:22:00')," +
      " (8,10,1,399.00,'pending','2026-09-01 10:03:00')," +
      " (2,4,1,1099.00,'pending','2026-09-09 15:47:00')"
    ],
    school: [
      "CREATE TABLE `students` (" +
      "  `id` int(11) NOT NULL AUTO_INCREMENT," +
      "  `name` varchar(30) NOT NULL," +
      "  `class` varchar(20) NOT NULL," +
      "  `gender` enum('男','女') DEFAULT NULL," +
      "  `enrolled_at` date NOT NULL," +
      "  PRIMARY KEY (`id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生表'",
      "INSERT INTO `students` (`name`,`class`,`gender`,`enrolled_at`) VALUES" +
      " ('李明','高三一班','男','2023-09-01')," +
      " ('王小雨','高三一班','女','2023-09-01')," +
      " ('张昊','高三二班','男','2023-09-01')," +
      " ('陈静','高三二班','女','2023-09-01')," +
      " ('刘洋','高三三班','男','2023-09-01')",
      "CREATE TABLE `scores` (" +
      "  `id` int(11) NOT NULL AUTO_INCREMENT," +
      "  `student_id` int(11) NOT NULL," +
      "  `subject` varchar(20) NOT NULL," +
      "  `score` decimal(5,1) DEFAULT NULL," +
      "  `exam_date` date NOT NULL," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_student` (`student_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='成绩表'",
      "INSERT INTO `scores` (`student_id`,`subject`,`score`,`exam_date`) VALUES" +
      " (1,'数学',138.5,'2026-06-20'),(1,'语文',121.0,'2026-06-20'),(1,'英语',134.5,'2026-06-21')," +
      " (2,'数学',112.0,'2026-06-20'),(2,'语文',139.5,'2026-06-20'),(2,'英语',128.0,'2026-06-21')," +
      " (3,'数学',95.5,'2026-06-20'),(3,'语文',108.0,'2026-06-20'),(3,'英语',87.5,'2026-06-21')," +
      " (4,'数学',146.5,'2026-06-20'),(4,'语文',128.5,'2026-06-20'),(4,'英语',142.0,'2026-06-21')," +
      " (5,'数学',120.0,'2026-06-20'),(5,'语文',115.5,'2026-06-20'),(5,'英语',119.0,'2026-06-21')"
    ],
    test: []
  };

  /** 把示例数据灌进引擎（必要时自动创建目标库） */
  function seedAll(engine) {
    Object.keys(SEED).forEach(function (dbName) {
      if (!engine.databases[dbName]) engine.createDatabaseObject(dbName);
      engine.current = dbName;
      SEED[dbName].forEach(function (sql) {
        var stmts = splitStatements(sql);
        stmts.forEach(function (st) {
          var parsed = /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(st.sql) ? parseCreateTable(st.sql) : null;
          var translated = translateStatement(st.sql, { db: dbName });
          var entry = engine.databases[dbName];
          entry.db.run(translated);
          if (parsed) entry.tables[parsed.name] = parsed;
        });
      });
    });
    engine.current = 'production';
  }

  /* ======================= 11. 练习题 ======================= */

  var EXERCISES = [
    { level: 1, title: '看看有哪些库', prompt: '列出服务器上所有的数据库。', answer: 'SHOW DATABASES;', hint: 'SHOW 系列命令' },
    { level: 1, title: '切换到电商库', prompt: '把当前数据库切换到 production。', answer: 'USE production;', hint: 'USE 库名' },
    { level: 1, title: '看看有哪些表', prompt: '列出 production 库中的所有表。', answer: 'SHOW TABLES;', hint: 'SHOW TABLES' },
    { level: 1, title: '表里有什么字段', prompt: '查看 users 表的结构（字段、类型、是否可空、主键）。', answer: 'DESC users;', hint: 'DESC 表名' },
    { level: 1, title: '查全部用户', prompt: '查询 users 表的所有记录。', answer: 'SELECT * FROM users;', hint: 'SELECT * FROM 表名' },
    { level: 1, title: '只看两列', prompt: '只查询用户名和邮箱两列。', answer: 'SELECT username, email FROM users;', hint: '列名用逗号分隔' },
    { level: 1, title: '筛选 VIP', prompt: '找出 vip_level 大于等于 2 的用户。', answer: 'SELECT * FROM users WHERE vip_level >= 2;', hint: 'WHERE 条件' },
    { level: 1, title: '排序取前五', prompt: '按余额从高到低列出前 5 名用户的用户名和余额（用 LIMIT）。', answer: 'SELECT username, balance FROM users ORDER BY balance DESC LIMIT 5;', hint: 'ORDER BY ... DESC + LIMIT' },
    { level: 1, title: '模糊匹配', prompt: '找出所有城市以「深」开头的用户。', answer: "SELECT * FROM users WHERE city LIKE '深%';", hint: "LIKE '深%'" },
    { level: 2, title: '统计总数', prompt: '统计 users 表一共有多少条记录，结果列名叫 total。', answer: 'SELECT COUNT(*) AS total FROM users;', hint: 'COUNT(*) 配别名 AS' },
    { level: 2, title: '分组计数', prompt: '按商品分类统计每个分类有多少种商品，按数量降序排列。', answer: 'SELECT category, COUNT(*) AS cnt FROM products GROUP BY category ORDER BY cnt DESC;', hint: 'GROUP BY + COUNT' },
    { level: 2, title: '求平均值', prompt: '按分类计算商品的平均价格，保留两位小数，列名 avg_price。', answer: 'SELECT category, ROUND(AVG(price), 2) AS avg_price FROM products GROUP BY category;', hint: 'AVG + ROUND' },
    { level: 2, title: '联表查询订单', prompt: '查询最近 10 条订单，显示订单号、用户名、商品名、数量、金额。', answer: 'SELECT o.id, u.username, p.name, o.quantity, o.total FROM orders o JOIN users u ON u.id = o.user_id JOIN products p ON p.id = o.product_id ORDER BY o.id DESC LIMIT 10;', hint: 'JOIN ... ON' },
    { level: 2, title: '隐藏的 NULL', prompt: '找出从未下过订单的用户（结果只显示用户名）。', answer: 'SELECT u.username FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE o.id IS NULL;', hint: 'LEFT JOIN + WHERE ... IS NULL' },
    { level: 2, title: '消费排行', prompt: '统计每位用户的下单总金额，按金额降序取前 5 名。', answer: 'SELECT u.username, SUM(o.total) AS spent FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.username ORDER BY spent DESC LIMIT 5;', hint: 'SUM + GROUP BY' },
    { level: 2, title: '改数据', prompt: '给所有深圳用户的余额各加 100 元。', answer: "UPDATE users SET balance = balance + 100 WHERE city = '深圳';", hint: 'UPDATE ... SET ... WHERE' },
    { level: 2, title: '插一行', prompt: '往 users 表插入一条新用户：用户名 testuser，邮箱 testuser@example.com，城市 深圳。', answer: "INSERT INTO users (username, email, city) VALUES ('testuser', 'testuser@example.com', '深圳');", hint: 'INSERT INTO 表 (列) VALUES (值)' },
    { level: 3, title: '子查询比均价', prompt: '找出价格高于全站平均价的商品名和价格。', answer: 'SELECT name, price FROM products WHERE price > (SELECT AVG(price) FROM products);', hint: '括号里放子查询' },
    { level: 3, title: 'GROUP_CONCAT 汇总', prompt: '统计每位用户买过的商品名称，用逗号加空格连接成一列。', answer: "SELECT u.username, GROUP_CONCAT(p.name SEPARATOR ', ') AS items FROM users u JOIN orders o ON o.user_id = u.id JOIN products p ON p.id = o.product_id GROUP BY u.id, u.username;", hint: 'GROUP_CONCAT(x SEPARATOR \', \')' },
    { level: 3, title: '窗口函数排名', prompt: '用 RANK() 按余额给用户排名，显示用户名、余额、排名（列名 rk）。', answer: 'SELECT username, balance, RANK() OVER (ORDER BY balance DESC) AS rk FROM users;', hint: 'RANK() OVER (ORDER BY ...)' },
    { level: 3, title: '日期格式化', prompt: "把注册时间格式化成「2026年03月12日」的样子，显示用户名和格式化后的日期（列名 d）。", answer: "SELECT username, DATE_FORMAT(created_at, '%Y年%m月%d日') AS d FROM users LIMIT 5;", hint: 'DATE_FORMAT(列, 格式串)' },
    { level: 3, title: '自己建表', prompt: '建一张 MySQL 风格的表 books：id 自增主键、title 不能为空、author、price 小数、published_at 日期时间默认当前时间。', answer: "CREATE TABLE books (\n  id int(11) NOT NULL AUTO_INCREMENT,\n  title varchar(100) NOT NULL,\n  author varchar(50) DEFAULT NULL,\n  price decimal(8,2) DEFAULT NULL,\n  published_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;", hint: 'AUTO_INCREMENT / ENGINE=InnoDB 都会被自动转译' },
    { level: 3, title: '纵向看一行', prompt: '用 \\G 纵向显示 users 表中 id 为 1 的那条记录。', answer: 'SELECT * FROM users WHERE id = 1\\G', hint: '结尾写 \\G 而不是 ;' },
    { level: 3, title: '制造一个错误', prompt: "故意查询一张不存在的表 t_nothing，观察 MySQL 风格的报错信息（ERROR 1146）。", answer: 'SELECT * FROM t_nothing;', hint: '看看报错码是不是 1146', expectError: true },
    { level: 3, title: '子查询配 IN', prompt: '用 IN 子查询找出下过订单的用户名。', answer: 'SELECT username FROM users WHERE id IN (SELECT user_id FROM orders);', hint: 'WHERE 列 IN (SELECT ...)' },
    { level: 3, title: '区间筛选', prompt: '找出余额在 1000 到 10000 之间的用户名。', answer: 'SELECT username FROM users WHERE balance BETWEEN 1000 AND 10000;', hint: 'BETWEEN ... AND ...' },
    { level: 3, title: '多列排序', prompt: '按城市升序、余额降序列出用户名、城市和余额。', answer: 'SELECT username, city, balance FROM users ORDER BY city ASC, balance DESC;', hint: 'ORDER BY 可以跟多个列' },
    { level: 3, title: '分组后再筛', prompt: '找出用户数不少于 2 的城市及人数（列名 cnt）。', answer: 'SELECT city, COUNT(*) AS cnt FROM users GROUP BY city HAVING cnt >= 2;', hint: 'GROUP BY 之后用 HAVING' },
    { level: 3, title: 'CTE 公共表表达式', prompt: '用 WITH 先取出价格大于 1000 的商品，再统计它们的数量（列名 n）。', answer: 'WITH big AS (SELECT * FROM products WHERE price > 1000) SELECT COUNT(*) AS n FROM big;', hint: 'WITH 名字 AS (SELECT ...)' },
    { level: 3, title: '窗口累计求和', prompt: '按 id 顺序给出每个用户的余额累计和，列名 running。', answer: 'SELECT username, SUM(balance) OVER (ORDER BY id) AS running FROM users;', hint: 'SUM(...) OVER (ORDER BY ...)' },
    { level: 3, title: '分组内排名', prompt: '在每个城市内部按余额降序用 ROW_NUMBER() 编号，显示用户名、城市、编号 rn。', answer: 'SELECT username, city, ROW_NUMBER() OVER (PARTITION BY city ORDER BY balance DESC) AS rn FROM users;', hint: 'OVER (PARTITION BY ... ORDER BY ...)' },
    { level: 3, title: '看上一行的值', prompt: '用 LAG 取出每个用户按 id 排序时上一行的余额，列名 prev。', answer: 'SELECT username, LAG(balance) OVER (ORDER BY id) AS prev FROM users;', hint: 'LAG(列) OVER (ORDER BY ...)' },
    { level: 3, title: '自己跟自己连表', prompt: '找出同城用户的成对组合（同一城市、前者 id 更小），显示两边的用户名。', answer: 'SELECT a.username, b.username FROM users a JOIN users b ON a.city = b.city AND a.id < b.id;', hint: '同一张表起两个别名' },
    { level: 4, title: '建一个视图', prompt: '创建一个名为 v_vip 的视图，包含 vip_level 不小于 2 的用户的用户名与余额。', answer: 'CREATE VIEW v_vip AS SELECT username, balance FROM users WHERE vip_level >= 2;', hint: 'CREATE VIEW 名字 AS SELECT ...' },
    { level: 4, title: '换掉视图定义', prompt: '把视图 v_vip 改成只包含余额大于 10000 的用户（用户名与余额两列）。', answer: 'CREATE OR REPLACE VIEW v_vip AS SELECT username, balance FROM users WHERE balance > 10000;', hint: 'CREATE OR REPLACE VIEW' },
    { level: 4, title: '派生表做聚合', prompt: '先用派生表取出 vip_level 不小于 2 的用户，再统计人数（列名 n）。', answer: 'SELECT COUNT(*) AS n FROM (SELECT id FROM users WHERE vip_level >= 2) AS vip;', hint: 'FROM (SELECT ...) AS 别名' },
    { level: 4, title: '建联合索引', prompt: '在 users 表上建一个名为 idx_vip_balance 的联合索引，列为 vip_level 和 balance。', answer: 'CREATE INDEX idx_vip_balance ON users (vip_level, balance);', hint: 'CREATE INDEX 名 ON 表 (列, 列)' },
    { level: 4, title: '用上索引看看', prompt: '对 SELECT * FROM users WHERE city = \'深圳\' 做一次 EXPLAIN，观察执行计划。', answer: "EXPLAIN SELECT * FROM users WHERE city = '深圳';", hint: 'EXPLAIN 加在 SELECT 前面' },
    { level: 4, title: '设一个保存点', prompt: '在当前事务里建立一个名为 sp_demo 的保存点。', answer: 'SAVEPOINT sp_demo;', hint: 'SAVEPOINT 名字' },
    { level: 4, title: '条件聚合', prompt: '按城市统计 vip_level 不小于 2 的人数，列名 vip_cnt。', answer: 'SELECT city, SUM(CASE WHEN vip_level >= 2 THEN 1 ELSE 0 END) AS vip_cnt FROM users GROUP BY city;', hint: 'SUM(CASE WHEN ... THEN 1 ELSE 0 END)' },
    { level: 4, title: '按状态汇总订单', prompt: '按订单状态统计订单数和总金额（列名 cnt、amt），按总金额降序。', answer: 'SELECT status, COUNT(*) AS cnt, SUM(total) AS amt FROM orders GROUP BY status ORDER BY amt DESC;', hint: 'GROUP BY 状态 + COUNT/SUM' },
    { level: 4, title: '算一个小数', prompt: '把每个用户的余额除以 100 并按两位小数显示，列名 pct，取前 3 名（按 pct 降序）。', answer: 'SELECT username, ROUND(balance / 100, 2) AS pct FROM users ORDER BY pct DESC LIMIT 3;', hint: 'ROUND(表达式, 2)' },
    { level: 4, title: '递归数数', prompt: '用递归 CTE 生成 1 到 10，并求它们的和（列名 total）。', answer: 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 10) SELECT SUM(n) AS total FROM seq;', hint: 'WITH RECURSIVE 名字(列) AS (...)' },
    { level: 4, title: '商品分类排行', prompt: '统计每个分类中价格最高的商品价格（列名 mx），只保留 mx 大于 1000 的分类，按 mx 降序。', answer: 'SELECT category, MAX(price) AS mx FROM products GROUP BY category HAVING mx > 1000 ORDER BY mx DESC;', hint: 'MAX + HAVING + ORDER BY' },
    { level: 4, title: '日期往后推', prompt: '把每个用户的注册时间往后推 30 天，列出用户名和结果（列名 d30），只看前 3 行。', answer: 'SELECT username, DATE_ADD(created_at, INTERVAL 30 DAY) AS d30 FROM users LIMIT 3;', hint: 'DATE_ADD(列, INTERVAL 30 DAY)' },
    { level: 4, title: '造一段 JSON', prompt: '把商品名和价格组成 JSON 对象，列名 j，只看前 3 行。', answer: "SELECT JSON_OBJECT('name', name, 'price', price) AS j FROM products LIMIT 3;", hint: 'JSON_OBJECT(键, 值, ...)' }
  ];

  /* ======================= 12. 与真实 MySQL 的差异（诚实清单） ======================= */

  var DIFFERENCES = [
    { group: '数据与显示', items: [
      'DECIMAL 不补尾随零：底层按数值存储，12800.50 会显示为 12800.5。计算类函数（ROUND/AVG）行为一致。',
      '除法结果不补小数位：`7/2` 的**值**与 MySQL 一致（3.5），但真实 MySQL 的 `/` 返回 DECIMAL，会显示成 3.5000；模拟器按数值显示。',
      '不写 ORDER BY 时不保证行序：底层可能走覆盖索引，结果可能按索引顺序而非插入顺序返回。显式写 ORDER BY 才是可靠做法。',
      '数据仅存于浏览器内存，刷新页面即恢复初始示例数据，不做任何持久化。',
      '字符集与排序规则（utf8mb4_0900_ai_ci 等）只作展示；实际字符串比较遵循底层规则，默认区分大小写（WHERE username = \'ABC\' 匹配不到 \'abc\'），而 MySQL 默认排序规则不区分大小写。',
      '类型比较不完全按 MySQL 的隐式转换：SELECT 5 = \'5\' 得到 0，真实 MySQL 得到 1（有一方是列时会按列类型转换，行为一致）。建议显式写 CAST。'
    ] },
    { group: 'SQL 语法', items: [
      '已自动转译：AUTO_INCREMENT（含 AUTO_INCREMENT=N 起始值）、ENGINE=/DEFAULT CHARSET=/COLLATE=/COMMENT=、ENUM/SET/JSON 类型、UNSIGNED/ZEROFILL、反引号、SHOW/DESC/DESCRIBE、GROUP_CONCAT ... SEPARATOR（含 DISTINCT / ORDER BY 组合）、"LIMIT a, b"、CONCAT/IF/IFNULL/NOW/DATE_FORMAT 等函数、TRUNCATE TABLE、INSERT IGNORE、INSERT ... ON DUPLICATE KEY UPDATE、REPLACE INTO、INSERT ... SET、SELECT ... INTO @变量、RENAME TABLE、START TRANSACTION / BEGIN / COMMIT / ROLLBACK / SAVEPOINT、ALTER TABLE 的 ADD|DROP|MODIFY|CHANGE|RENAME COLUMN 与 ADD|DROP INDEX|KEY、CREATE TABLE ... LIKE / ... AS SELECT、DROP TABLE 多表、DROP INDEX ... ON、UPDATE/DELETE ... LIMIT、FIELD()、RLIKE、a DIV b、a <=> b、CONVERT(expr, type)、TRIM(... FROM ...)、POSITION(x IN y)、ISNULL(x)、EXTRACT(unit FROM x)、DATE_ADD/DATE_SUB/ADDDATE/SUBDATE(..., INTERVAL n unit)、TIMESTAMPDIFF / TIMESTAMPADD、INSERT() 字符串函数、SET（变量）。',
      '变量：支持用户变量 SET @x = 1 / SELECT @x（未赋值时返回 NULL，与 MySQL 一致）以及系统变量查询（@@version、@@autocommit 等）；未知系统变量报 1193。SELECT ... INTO @x 已支持（只取第一行，取不到行时报 1329）。SET GLOBAL 会被接受但只作用于当前会话。',
      '视图：CREATE VIEW / CREATE OR REPLACE VIEW / ALTER VIEW / DROP VIEW 均可用，SHOW TABLES、SHOW FULL TABLES、DESC、SHOW CREATE VIEW、SHOW CREATE TABLE 都能正确识别视图。',
      '日期函数按 MySQL 语义实现：DATE_ADD(\'2026-01-31\', INTERVAL 1 MONTH) 得 2026-02-28（向月末收敛），而不是底层 +1 month 的 3 月 3 日。但 INTERVAL 的复合单位（HOUR_MINUTE、YEAR_MONTH 等）未实现，WEEK() 的 mode 参数只实现了 0 与 3。',
      '哈希与字符串函数：MD5 / SHA1 / SHA2(x, 224|256) 已实现（标准测试向量已回归）；SHA2 的 384 / 512 位未实现，返回 NULL 而不是编一个假摘要。STR_TO_DATE 只支持 %Y %y %m %c %d %e %H %k %h %I %i %s %S 这些常见占位符。',
      '"||" 语义不同：MySQL 默认把它当逻辑 OR，此处底层把它当字符串连接。建议统一用 OR / CONCAT()。',
      'CONCAT() 已按 MySQL 语义实现（任一参数为 NULL 则整体返回 NULL）；CONCAT_WS 的"跳过 NULL"与 MySQL 一致。FIELD() 在转译阶段展开为等价的 CASE 表达式，行为与 MySQL 相同。',
      '双引号：这里的 "abc" 与 MySQL 默认 sql_mode 一样被当作字符串。若你在真实环境开启了 ANSI_QUOTES，双引号含义会变成标识符。',
      '未支持：存储过程、触发器、事件（报 1235）、PREPARE / EXECUTE、INTERVAL 复合单位、分区表、FULLTEXT / SPATIAL 索引与全文检索 MATCH ... AGAINST、用户与权限管理（GRANT/REVOKE/CREATE USER）、复制与二进制日志、XA、HANDLER、IMPORT TABLE / CLONE；备份类语句（BACKUP/RESTORE）在 MySQL 社区版里本身就不存在（那是企业版组件或 mysqldump 工具的职责）。',
      'BENCHMARK() 与 SLEEP() 只返回 MySQL 的返回值（都是 0），不会真的计时或阻塞——在浏览器里阻塞界面是不可接受的。GET_LOCK / RELEASE_LOCK 在单连接下恒为成功。'
    ] },
    { group: '存储与执行', items: [
      '索引：DESC / SHOW INDEX 展示的是建表语句中声明的索引（元数据真实），但底层只保留唯一约束、不额外创建二级索引。因此 EXPLAIN 里会同时出现「possible_keys 列出了索引」和「type=ALL 没走索引」——这正是底层确实没有该索引的真实反映，不是显示错误。',
      'EXPLAIN 的输出形态按 MySQL 的 12 列组织（也支持 FORMAT=JSON / TREE / ANALYZE），但数据来源是底层引擎的查询计划，而不是 InnoDB 优化器的成本估算，因此 type / rows 等字段只作示意。',
      '外键：建表时声明的 FOREIGN KEY 会真实生效——插入不存在的父行报 1452，删除被引用的父行报 1451。',
      '事务：START TRANSACTION / BEGIN / COMMIT / ROLLBACK / SAVEPOINT / ROLLBACK TO 都可用，并且回滚是真实生效的——插入后 ROLLBACK，数据真的会消失。但没有 MySQL 的隔离级别、行级锁与 MVCC：并发场景不可模拟，FOR UPDATE / LOCK IN SHARE MODE 会被忽略并给出提示，SET TRANSACTION ISOLATION LEVEL 只被接受、不产生任何效果。',
      '视图：底层是真实视图，可查询、可与其他表 JOIN、可再被其他视图引用。但真实 MySQL 允许对「简单可更新视图」（单表、不含聚合/去重/子查询）直接 INSERT/UPDATE/DELETE 并写回基表，本模拟器一律报 ERROR 1288，不支持透过视图写数据。',
      '视图列信息：DESC 视图时，列类型由底层声明推导（如 varchar(50)、decimal(10,2) 能原样带出）；计算列（如 id*2、UPPER(name)）拿不到声明类型时统一显示 varchar(255)，且 Nullable 一律显示 YES。SHOW CREATE VIEW 的输出按 MySQL 习惯格式（含 ALGORITHM / DEFINER / SQL SECURITY）重新排版，与实际存储的定义文字不逐字相同。',
      'CREATE TABLE ... AS SELECT：列类型会从源查询推导（能对上源表列的用源列声明类型，计算列按表达式推断），但不会复制索引与约束。',
      'SHOW CREATE TABLE：示例数据的建表原文原样回显；用户自己建的表会按目录重新生成 MySQL 风格 DDL（带 ENGINE=InnoDB DEFAULT CHARSET=utf8mb4），而不是把底层 SQLite 的措辞倒出来。',
      '系统库：information_schema、performance_schema、sys 仅有库名占位、没有数据字典内容（mysql 库中的 user 表可正常查询，但要先 USE mysql）。',
      '跨库限定名 db.table 暂不支持：每个库在底层是各自独立的连接，所以 SELECT ... FROM mysql.user 这类写法会报 1146，请先 USE 到目标库再写裸表名。这是已知的架构级限制。',
      'TEMPORARY TABLE 会真实创建，且 SHOW TABLES / DESC / 侧栏都能看到它（与真实会话内的行为一致）；重连后消失。',
      'SHOW 系列里与"本模拟器没有建模的对象"相关的语句（SHOW TRIGGERS / EVENTS / PROCEDURE STATUS / OPEN TABLES / BINARY LOGS / REPLICA STATUS / PLUGINS 等）返回空结果集；SHOW ENGINE INNODB STATUS 会明确说明未实现，而不是伪装成语法错误。',
      'AUTO_INCREMENT：支持列自增，也支持 CREATE TABLE ... AUTO_INCREMENT=N 与 ALTER TABLE ... AUTO_INCREMENT=N 指定起始值（对 INSERT ... VALUES 生效），TRUNCATE 会把计数器重置回 1；但不支持步长（auto_increment_increment）与 INSERT ... SELECT 形式的自动编号。',
      '权限：所有语句都以 root@localhost 身份执行，不做权限校验与访问控制。',
      '时间：NOW()/CURDATE() 取本机本地时间；真实 MySQL 的行为取决于服务器时区与 time_zone 设置。'
    ] }
  ];

  /* ======================= 13. 导出 ======================= */

  return {
    SERVER_VERSION: SERVER_VERSION,
    SERVER_VERSION_FULL: SERVER_VERSION_FULL,
    SYSTEM_DATABASES: SYSTEM_DATABASES,
    splitStatements: splitStatements,
    translateStatement: translateStatement,
    parseCreateTable: parseCreateTable,
    canonicalSQL: canonicalSQL,
    canonicalSQLRelaxed: canonicalSQLRelaxed,
    matchExercises: matchExercises,
    registerMySQLFunctions: registerMySQLFunctions,
    formatTable: formatTable,
    formatVertical: formatVertical,
    formatDuration: formatDuration,
    rowsTail: rowsTail,
    mapError: mapError,
    dispWidth: dispWidth,
    padRight: padRight,
    Engine: Engine,
    seedAll: seedAll,
    SEED: SEED,
    EXERCISES: EXERCISES,
    DIFFERENCES: DIFFERENCES,
    HELP_TEXT: HELP_TEXT,
    VARIABLES: VARIABLES
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = MySQLCore; }
