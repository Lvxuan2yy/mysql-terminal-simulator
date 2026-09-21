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

    return { name: name, columns: columns, indexes: indexes, foreignKeys: foreignKeys, raw: sql.replace(/\s*\n\s*/g, '\n').trim() };
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

  function translateStatement(sql, ctx) {
    var s = sql;
    var inDdl = /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(s);
    if (inDdl) return translateCreateTable(s);
    if (/FIELD\s*\(/i.test(s)) s = rewriteField(s);

    // TRUNCATE TABLE / TRUNCATE
    s = s.replace(/^\s*TRUNCATE\s+(?:TABLE\s+)?/i, 'DELETE FROM ');
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
    // GROUP_CONCAT(x SEPARATOR 'y') → GROUP_CONCAT(x, 'y')
    s = s.replace(/GROUP_CONCAT\s*\(([\s\S]*?)\s+SEPARATOR\s+('[^']*'|"[^"]*")\s*\)/gi, 'GROUP_CONCAT($1, $2)');
    // LIMIT a, b → LIMIT b OFFSET a
    s = s.replace(/\bLIMIT\s+(\d+)\s*,\s*(\d+)\b/gi, 'LIMIT $2 OFFSET $1');

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
    // ANALYZE TABLE t → ANALYZE t
    s = s.replace(/^\s*ANALYZE\s+TABLE\s+/i, 'ANALYZE ');
    // 无对应能力的表维护语句 → 交由上层当无操作处理
    if (/^\s*(OPTIMIZE|REPAIR|FLUSH)\s+/i.test(s)) return 'SELECT 1 WHERE 0';

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
  function registerMySQLFunctions(db, dbName) {
    var def = function (name, fn) { try { db.create_function(name, fn); } catch (e) { /* 忽略重复注册 */ } };

    def('VERSION', function () { return SERVER_VERSION_FULL; });
    def('DATABASE', function () { return dbName; });
    def('SCHEMA', function () { return dbName; });
    def('USER', function () { return CURRENT_USER; });
    def('CURRENT_USER', function () { return CURRENT_USER; });
    def('SESSION_USER', function () { return CURRENT_USER; });
    def('SYSTEM_USER', function () { return CURRENT_USER; });
    def('NOW', function () { return fmtLocalDT(new Date()); });
    def('LOCALTIME', function () { return fmtLocalDT(new Date()); });
    def('LOCALTIMESTAMP', function () { return fmtLocalDT(new Date()); });
    def('SYSDATE', function () { return fmtLocalDT(new Date()); });
    def('CURDATE', function () { return fmtLocalDate(new Date()); });
    def('CURTIME', function () { return fmtLocalTime(new Date()); });
    def('CONNECTION_ID', function () { return CONNECTION_ID; });
    def('CONCAT', function () {
      var a = Array.prototype.slice.call(arguments);
      if (a.some(function (x) { return x === null || x === undefined; })) return null;
      return a.join('');
    });
    def('CONCAT_WS', function () {
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
    def('FIELD', function () {
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
    def('MID', function (s, p, n) { return s === null || s === undefined ? null : String(s).substr(p - 1, n); });
    def('SUBSTRING', function (s, p, n) {
      if (s === null || s === undefined) return null;
      var str = String(s);
      p = p | 0;
      if (n === undefined) return p > 0 ? str.slice(p - 1) : str.slice(p);
      return p > 0 ? str.substr(p - 1, n) : str.substr(p, n);
    });
    def('LOCATE', function (sub, str, pos) {
      if (sub === null || str === null || sub === undefined || str === undefined) return null;
      var p = str.indexOf(sub, pos ? pos - 1 : 0);
      return p < 0 ? 0 : p + 1;
    });
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
    def('GREATEST', function () {
      var a = Array.prototype.slice.call(arguments).filter(function (x) { return x !== null && x !== undefined; });
      return a.length ? Math.max.apply(null, a.map(Number)) : null;
    });
    def('LEAST', function () {
      var a = Array.prototype.slice.call(arguments).filter(function (x) { return x !== null && x !== undefined; });
      return a.length ? Math.min.apply(null, a.map(Number)) : null;
    });
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

  function describeResult(meta, tableName) {
    return rs(
      ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'],
      meta.columns.map(function (c) {
        return [c.field, c.type, c.nullable ? 'YES' : 'NO', c.key || '', c.hasDefault ? (c.defaultValue === null ? 'NULL' : c.defaultValue) : 'NULL', c.extra || ''];
      })
    );
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
    [/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i,
      'CREATE PROCEDURE / FUNCTION / TRIGGER / EVENT', '存储过程、自定义函数、触发器、事件均未实现'],
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
  }

  Engine.prototype.createDatabaseObject = function (name) {
    var db = new this.SQL.Database();
    registerMySQLFunctions(db, name);
    db.run('PRAGMA foreign_keys = OFF;');
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

  Engine.prototype.tableNames = function (dbName) {
    var entry = this.databases[dbName || this.current];
    if (!entry) return [];
    var names = [];
    try {
      var r = entry.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      if (r[0]) names = r[0].values.map(function (v) { return v[0]; });
    } catch (e) { /* ignore */ }
    return names;
  };

  /** 视图清单（以 sqlite_master 为准，避免与目录脱节） */
  Engine.prototype.viewNames = function (dbName) {
    var entry = this.databases[dbName || this.current];
    if (!entry) return [];
    var names = [];
    try {
      var r = entry.db.exec("SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      if (r[0]) names = r[0].values.map(function (v) { return v[0]; });
    } catch (e) { /* ignore */ }
    return names;
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

  Engine.prototype.runOne = function (sql, vertical) {
    var out = [];
    var self = this;
    this._lastVertical = !!vertical;

    // ---- 客户端元命令 ----
    var lower = sql.trim().toLowerCase().replace(/;\s*$/, '');
    if (lower === 'exit' || lower === 'quit' || lower === '\\q') {
      out.push({ kind: 'note', text: 'Bye' });
      out.push({ kind: 'exit', text: '' });
      return out;
    }
    if (lower === '\\h' || lower === 'help' || lower === '\\?') {
      out.push({ kind: 'out', text: HELP_TEXT });
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
    // ---- CHECK TABLE：做真实的存在性检查并回报 status ----
    var ckM = /^CHECK\s+TABLE\s+([`A-Za-z0-9_$.,\s]+)$/i.exec(sql.trim());
    if (ckM) {
      var ckEntry = this.databases[this.current] || this.databases.mysql;
      var ckNames = ckM[1].split(',').map(function (x) { return x.trim().replace(/^`|`$/g, ''); }).filter(Boolean);
      var ckMiss = ckNames.filter(function (nm) { return !(ckEntry && ckEntry.tables[nm]); });
      if (ckMiss.length) {
        out.push({ kind: 'err', text: 'ERROR 1146 (42S02): Table \'' + this.current + '.' + ckMiss[0] + '\' doesn\'t exist' });
        return out;
      }
      var ckRows = ckNames.map(function (nm) { return [nm, 'check', 'status', 'OK']; });
      return [this.resultBlock(rs(['Table', 'Op', 'Msg_type', 'Msg_text'], ckRows), ckRows.length)];
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
    // ---- DROP TABLE a, b, c（MySQL 允许一次删多张表）----
    var dtM = /^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?([`A-Za-z0-9_$.,\s]+)$/i.exec(trimmed);
    if (dtM && dtM[2].indexOf(',') > -1) {
      dtM[2].split(',').forEach(function (t) {
        self.runOne('DROP TABLE ' + (dtM[1] || '') + t.trim() + ';').forEach(function (b) { out.push(b); });
      });
      return out;
    }

    // ---- DESC / DESCRIBE / EXPLAIN <table> ----
    var descM = /^(?:DESC|DESCRIBE|EXPLAIN)\s+(?:`([^`]+)`|([A-Za-z0-9_$.]+))\s*(?:(`[^`]+`|\S+))?\s*$/i.exec(sql.trim());
    if (descM) {
      var tname = descM[1] || descM[2];
      return this.describeTable(tname);
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
    var dtViewM = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(`([^`]+)`|[A-Za-z0-9_$]+)\s*$/i.exec(trimmed);
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
    // 执行前展开 @x / @@x 变量（引号内的 @ 不会被误替换）
    var sqlExec = sql;
    if (!isCreateTable) {
      try { sqlExec = this.substituteVars(sql); }
      catch (e) { out.push({ kind: 'err', text: mapError(e.message, { db: this.current }) }); return out; }
    }
    var translated = translateStatement(sqlExec, { db: this.current });
    var t0 = Date.now();
    var usedMemory = false;

    try {
      if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN\s+QUERY|VALUES)\b/i.test(translated)) {
        var results = entry.db.exec(translated);
        var sec = (Date.now() - t0) / 1000;
        if (!results.length) {
          out.push({ kind: 'out', text: 'Empty set (' + formatDuration(sec) + ' sec)' });
        } else {
          results.forEach(function (r) {
            out.push({ kind: 'out', text: vertical ? formatVertical(r) : formatTable(r) });
            out.push({ kind: 'out', text: rowsTail(r.values.length, sec) });
          });
        }
      } else {
        entry.db.run(translated);
        var sec2 = (Date.now() - t0) / 1000;
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
          if (/^\s*TRUNCATE\b/i.test(sql)) {
            // MySQL 的 TRUNCATE 回报 0 rows affected（此处底层是 DELETE）
            out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(sec2) + ' sec)' });
          } else if (/^\s*(COMMIT|BEGIN|START|ROLLBACK|SET|SAVEPOINT|RELEASE)\b/i.test(translated)) {
            out.push({ kind: 'out', text: 'Query OK, 0 rows affected (' + formatDuration(sec2) + ' sec)' });
          } else {
            out.push({ kind: 'out', text: 'Query OK, ' + cnt + ' row' + (cnt === 1 ? '' : 's') + ' affected (' + formatDuration(sec2) + ' sec)' });
          }
          // DROP / ALTER / RENAME / CREATE INDEX 后同步 catalog
          this.syncCatalogAfter(entry, translated);
        }
      }
    } catch (e) {
      var dup = null;
      try { dup = this.findDuplicateValue(entry, translated, e.message); } catch (e2) { dup = null; }
      out.push({ kind: 'err', text: mapError(e.message, { db: this.current, dupValue: dup, stmt: sql }) });
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

    if (/^DATABASES\b/i.test(r) || /^SCHEMAS\b/i.test(r)) {
      var dbList = this.databaseNames().sort();
      return [this.resultBlock(rs(['Database'], dbList.map(function (n) { return [n]; })), dbList.length, vertical)];
    }
    if ((m = /^TABLES\s*(?:FROM|IN)\s+(`([^`]+)`|[A-Za-z0-9_$]+)(?:\s+LIKE\s+'([^']*)')?/i.exec(r)) || /^TABLES(?:\s+LIKE\s+'([^']*)')?$/i.test(r)) {
      var dbName = m ? stripQuotes(m[2] || m[1]) : this.current;
      var like = m ? m[3] : (/^TABLES\s+LIKE\s+'([^']*)'$/i.exec(r) || [])[1];
      if (!this.databases[dbName]) return this.errBlock('ERROR 1049 (42000): Unknown database \'' + dbName + '\'');
      // 真实 MySQL 的 SHOW TABLES 会把视图一并列出
      var names = this.tableNames(dbName).concat(this.viewNames(dbName)).sort();
      if (like) {
        var rx = new RegExp('^' + like.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
        names = names.filter(function (n) { return rx.test(n); });
      }
      return [this.resultBlock(rs(['Tables_in_' + dbName], names.map(function (n) { return [n]; })), names.length)];
    }
    if ((m = /^(?:FULL\s+)?COLUMNS\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$.]+)(?:\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$]+))?/i.exec(r)) ||
        (m = /^(?:FULL\s+)?FIELDS\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$.]+)(?:\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$]+))?/i.exec(r))) {
      var t = stripQuotes(m[1]), dbw = m[2] ? stripQuotes(m[2]) : null;
      return this.describeTable(t, dbw);
    }
    // SHOW CREATE VIEW —— 视图定义
    if ((m = /^CREATE\s+VIEW\s+(`[^`]+`|[A-Za-z0-9_$.]+)/i.exec(r))) {
      var vn = stripQuotes(m[1]).split('.').pop();
      if (this.tableExists(vn)) return this.errBlock('ERROR 1347 (HY000): \'' + this.current + '.' + vn + '\' is not VIEW');
      var vdef = this.viewDef(vn);
      if (!vdef) return this.errBlock('ERROR 1051 (42S02): Unknown table \'' + this.current + '.' + vn + '\'');
      return [this.resultBlock(rs(['View', 'Create View', 'character_set_client', 'collation_connection'],
        [[vn, vdef.createSql, 'utf8mb4', 'utf8mb4_0900_ai_ci']]), 1, vertical)];
    }
    if ((m = /^CREATE\s+TABLE\s+(`[^`]+`|[A-Za-z0-9_$.]+)(?:\s+FROM\s+(`[^`]+`|[A-Za-z0-9_$]+))?/i.exec(r))) {
      var t2 = stripQuotes(m[1]), dbw2 = m[2] ? stripQuotes(m[2]) : null;
      var dbn = dbw2 || this.current;
      // SHOW CREATE TABLE 对视图同样可用（MySQL 会返回视图定义）
      if (!this.tableExists(t2, dbn) && this.viewExists(t2, dbn)) {
        var vdef2 = this.viewDef(t2, dbn);
        return [this.resultBlock(rs(['View', 'Create View', 'character_set_client', 'collation_connection'],
          [[t2, vdef2 ? vdef2.createSql : '', 'utf8mb4', 'utf8mb4_0900_ai_ci']]), 1, vertical)];
      }
      if (!this.tableExists(t2, dbn)) return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn + '.' + t2 + '\' doesn\'t exist');
      var meta = this.meta(t2, dbn);
      var createSql = meta && meta.raw ? meta.raw : ('CREATE TABLE `' + t2 + '` (' + (meta ? meta.columns.map(function (c) { return '`' + c.field + '` ' + c.type; }).join(', ') : '') + ')');
      var blocks = [this.resultBlock(rs(['Table', 'Create Table'], [[t2, createSql]]), 1, vertical)];
      if (!vertical && createSql.length > 110) {
        blocks.push({ kind: 'note', text: '（提示：建表语句较长，用 SHOW CREATE TABLE ' + t2 + '\\G 可纵向查看，与真实 MySQL 习惯一致）' });
      }
      return blocks;
    }
    if ((m = /^(?:INDEX|INDEXES|KEYS)\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$.]+)(?:\s+(?:FROM|IN)\s+(`[^`]+`|[A-Za-z0-9_$]+))?/i.exec(r))) {
      var t3 = stripQuotes(m[1]), dbw3 = m[2] ? stripQuotes(m[2]) : null;
      var dbn3 = dbw3 || this.current;
      if (this.viewExists(t3, dbn3)) return this.errBlock('ERROR 1347 (HY000): \'' + dbn3 + '.' + t3 + '\' is not BASE TABLE');
      var meta3 = this.meta(t3, dbn3);
      if (!meta3) return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn3 + '.' + t3 + '\' doesn\'t exist');
      if (!(meta3.indexes || []).length) return this.errBlock('ERROR 1146 (42S02): Table \'' + t3 + '\' doesn\'t exist');
      var ixr = indexesResult(meta3, t3);
      return [this.resultBlock(ixr, ixr.values.length, vertical)];
    }
    if (/^VARIABLES\b/i.test(r) || /^SESSION\s+VARIABLES\b/i.test(r) || /^GLOBAL\s+VARIABLES\b/i.test(r)) {
      var likeV = /LIKE\s+'([^']*)'/i.exec(r);
      var vars = VARIABLES.slice();
      if (likeV) {
        var rxV = new RegExp('^' + likeV[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
        vars = vars.filter(function (v) { return rxV.test(v[0]); });
      }
      return [this.resultBlock(rs(['Variable_name', 'Value'], vars), vars.length)];
    }
    if (/^STATUS\b/i.test(r)) {
      var st = [['Aborted_clients', '0'], ['Connections', '1'], ['Questions', String(this.counter)],
        ['Threads_connected', '1'], ['Threads_running', '1'], ['Uptime', String(Math.floor((Date.now() - this.startTime) / 1000))],
        ['Com_select', String(this.counter)], ['Ssl_cipher', '']];
      return [this.resultBlock(rs(['Variable_name', 'Value'], st), st.length)];
    }
    if (/^ENGINES\b/i.test(r)) {
      var eng = [
        ['InnoDB', 'DEFAULT', 'Supports transactions, row-level locking, and foreign keys', 'YES', 'YES', 'YES'],
        ['MyISAM', 'YES', 'MyISAM storage engine', 'NO', 'NO', 'NO'],
        ['MEMORY', 'YES', 'Hash based, stored in memory, useful for temporary tables', 'NO', 'NO', 'NO'],
        ['CSV', 'YES', 'CSV storage engine', 'NO', 'NO', 'NO']
      ];
      return [this.resultBlock(rs(['Engine', 'Support', 'Comment', 'Transactions', 'XA', 'Savepoints'], eng), eng.length)];
    }
    if (/^WARNINGS\b/i.test(r) || /^ERRORS\b/i.test(r)) {
      return [this.resultBlock(rs(['Level', 'Code', 'Message'], []), 0)];
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
    return this.errBlock('ERROR 1064 (42000): You have an error in your SQL syntax; 本模拟器未实现的 SHOW 语句：' + r.split(/\s+/).slice(0, 2).join(' '));
  };

  Engine.prototype.describeTable = function (table, dbName) {
    var dbn = dbName || this.current;
    var isView = this.viewExists(table, dbn);
    if (!this.tableExists(table, dbn) && !isView) {
      return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn + '.' + table + '\' doesn\'t exist');
    }
    var meta = this.meta(table, dbn);
    if (!meta) return this.errBlock('ERROR 1146 (42S02): Table \'' + dbn + '.' + table + '\' doesn\'t exist');
    var r = describeResult(meta, table);
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
    '  索引维护       ALTER TABLE 表 ADD [UNIQUE] INDEX 名 (列);  DROP INDEX 名 ON 表;  EXPLAIN SELECT ...;',
    '  客户端命令     help / \\h      显示本帮助',
    '                 status / \\s    查看连接与服务器状态',
    '                 clear          清屏（等同 Ctrl+L）：只清空可视区域，向上滚动仍可回看历史',
    '                 exit / quit     退出（等同 Ctrl+D）',
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
    { level: 3, title: '制造一个错误', prompt: "故意查询一张不存在的表 t_nothing，观察 MySQL 风格的报错信息（ERROR 1146）。", answer: 'SELECT * FROM t_nothing;', hint: '看看报错码是不是 1146', expectError: true }
  ];

  /* ======================= 12. 与真实 MySQL 的差异（诚实清单） ======================= */

  var DIFFERENCES = [
    { group: '数据与显示', items: [
      'DECIMAL 不补尾随零：底层按数值存储，12800.50 会显示为 12800.5。计算类函数（ROUND/AVG）行为一致。',
      '不写 ORDER BY 时不保证行序：底层可能走覆盖索引（例如只查询加了唯一约束的列），结果可能按索引顺序而非插入顺序返回。真实 MySQL 也只是"通常"按主键顺序返回，显式写 ORDER BY 才是可靠做法。',
      '数据仅存于浏览器内存，刷新页面即恢复初始示例数据，不做任何持久化。',
      '字符集与排序规则（utf8mb4_0900_ai_ci 等）只作展示；实际字符串比较遵循底层规则，默认区分大小写，而 MySQL 默认排序规则不区分大小写。'
    ] },
    { group: 'SQL 语法', items: [
      '已自动转译：AUTO_INCREMENT、ENGINE=/DEFAULT CHARSET=/COLLATE=/COMMENT=、ENUM/SET/JSON 类型、UNSIGNED/ZEROFILL、反引号、SHOW/DESC/DESCRIBE、GROUP_CONCAT ... SEPARATOR、"LIMIT a, b" 写法、CONCAT/IF/IFNULL/NOW/DATE_FORMAT 等函数、TRUNCATE TABLE、INSERT IGNORE、INSERT ... ON DUPLICATE KEY UPDATE、RENAME TABLE、START TRANSACTION / BEGIN / COMMIT / ROLLBACK / SAVEPOINT、ALTER TABLE 的 ADD|DROP|MODIFY|CHANGE|RENAME COLUMN 与 ADD|DROP INDEX|KEY、CREATE TABLE ... LIKE、DROP TABLE 多表、DROP INDEX ... ON、EXPLAIN、UPDATE/DELETE ... LIMIT、FIELD()、RLIKE、SET（变量）。',
      '变量：支持用户变量 SET @x = 1 / SELECT @x（未赋值时返回 NULL，与 MySQL 一致）以及 @ 号前的系统变量查询（@@version、@@autocommit 等）；未知系统变量报 1193。SET GLOBAL 会被接受但只作用于当前会话。',
      '视图：CREATE VIEW / CREATE OR REPLACE VIEW / ALTER VIEW / DROP VIEW 均可用，SHOW TABLES、SHOW FULL TABLES、DESC、SHOW CREATE VIEW、SHOW CREATE TABLE 都能正确识别视图。',
      '未支持：存储过程、触发器、事件、ON DUPLICATE KEY UPDATE、INTERVAL 日期运算、分区表、全文检索 MATCH ... AGAINST、用户与权限管理（GRANT/REVOKE/CREATE USER）、复制与日志；备份类语句（BACKUP/RESTORE）在 MySQL 社区版里本身就不存在（那是企业版组件或 mysqldump 工具的职责）。',
      '"||" 语义不同：MySQL 默认把它当逻辑 OR，此处底层把它当字符串连接。建议统一用 OR / CONCAT()。',
      '函数差异：CONCAT() 的 NULL 处理与 MySQL 不同——MySQL 只要有一个参数为 NULL 就返回 NULL，这里的底层实现会跳过 NULL 继续拼接（CONCAT_WS 的"跳过 NULL"语义与 MySQL 一致）。FIELD() 已在转译阶段展开为等价的 CASE 表达式，行为与 MySQL 相同。',
      '双引号：这里的 "abc" 与 MySQL 默认 sql_mode 一样被当作字符串。若你在真实环境开启了 ANSI_QUOTES，双引号含义会变成标识符。'
    ] },
    { group: '存储与执行', items: [
      '索引：DESC / SHOW INDEX 展示的是建表语句中声明的索引（元数据真实），但底层只保留唯一约束、不额外创建二级索引，因此查询执行计划与真实 MySQL 不同。',
      '事务：START TRANSACTION / BEGIN / COMMIT / ROLLBACK / SAVEPOINT / ROLLBACK TO 都可用，并且回滚是真实生效的——插入后 ROLLBACK，数据真的会消失。但没有 MySQL 的隔离级别、行级锁与 MVCC：并发场景不可模拟，SET TRANSACTION ISOLATION LEVEL 只被接受、不产生任何效果；SHOW ENGINES 里的 InnoDB 信息为静态展示。',
      '视图：底层是真实视图，可查询、可与其他表 JOIN、可再被其他视图引用。但真实 MySQL 允许对「简单可更新视图」（单表、不含聚合/去重/子查询）直接 INSERT/UPDATE/DELETE 并写回基表，本模拟器一律报 ERROR 1288，不支持透过视图写数据。',
      '视图列信息：DESC 视图时，列类型由底层声明推导（如 varchar(50)、decimal(10,2) 能原样带出）；计算列（如 id*2、UPPER(name)）拿不到声明类型时统一显示 varchar(255)，且 Nullable 一律显示 YES。',
      '视图定义：SHOW CREATE VIEW 的输出按 MySQL 习惯格式（含 ALGORITHM / DEFINER / SQL SECURITY）重新排版，与实际存储的定义文字不逐字相同。',
      '系统库：information_schema、performance_schema、sys 仅有库名占位、没有数据字典内容（mysql 库中的 user 表可正常查询）。',
      'AUTO_INCREMENT：通过 INTEGER PRIMARY KEY 实现，能正确自增；但不支持指定起始值/步长，且 TRUNCATE（转译为 DELETE）不会重置计数器。',
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
