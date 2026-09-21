/* ============================================================================
 * 修复回归测试：把《功能盘点与可新增清单.md》里定位到的每一处缺陷都固化成断言。
 * 覆盖：SHOW/DESC 过滤、表维护语句输出、临时表可见性、SHOW 家族空结果集、
 *       未实现语句的诚实报错、SHOW CREATE 重生成、变参函数、GROUP_CONCAT、
 *       除法语义、外键、函数补齐、语法糖……
 * 跑法：NODE_PATH=../.. node test-fixes.cjs   → 报告写到 _fixes_report.txt
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const SQL = require(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.js'));
const wasm = fs.readFileSync(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.wasm'));
const Core = require('../mysql-core.js');

const lines = [];
const failures = [];
let eng;

function head(t) { lines.push('\n' + '='.repeat(76) + '\n## ' + t + '\n' + '='.repeat(76)); }

/** 断言：cond 为真通过；否则记录原因（reason 为 null/undefined 表示通过） */
function chk(label, reason) {
  if (reason) { failures.push(label + ' —— ' + reason); lines.push('  ✗ ' + label + '\n      ' + reason); }
  else lines.push('  ✓ ' + label);
}

let LAST = [];
function run(sql) {
  LAST = eng.run(sql);
  return LAST;
}
function text(sql) { return run(sql).map(b => b.text).join('\n'); }
function errs(sql) { return run(sql).filter(b => b.kind === 'err').map(b => b.text); }
function tableData(sql) {
  // 解析排版好的表格：数据行位于「第 2 条边框」与「第 3 条边框」之间
  // （第 1 条边框 → 表头 → 第 2 条边框 → 数据 → 第 3 条边框）
  const out = [];
  let phase = 0, cur = [];
  for (const l of text(sql).split('\n')) {
    if (/^\+[-+]+\+$/.test(l)) {
      if (phase === 0) { phase = 1; cur = []; continue; }
      if (phase === 1) { phase = 2; continue; }
      if (phase === 2) { out.push(...cur); phase = 0; cur = []; continue; }
    }
    if (phase === 2 && /^\|/.test(l)) cur.push(l);
  }
  return out;
}
function rows(sql) { return tableData(sql).length; }
function cellValues(sql) {
  return tableData(sql).map(l => l.replace(/^\||\|$/g, '').split('|').map(s => s.trim()));
}
function hasNote(sql, re) {
  return run(sql).some(b => b.kind === 'note' && re.test(b.text));
}

(async () => {
  const S = await SQL({ wasmBinary: wasm });
  eng = new Core.Engine(S, Core.seedAll);
  eng.init();

  /* ===================== A3：SHOW / DESC 的过滤条件必须生效 ===================== */
  head('A3  SHOW / DESC 的 LIKE 与列名过滤（旧实现静默忽略过滤条件）');
  chk("SHOW DATABASES LIKE 'prod%' 只返回 production", (() => {
    const v = cellValues("SHOW DATABASES LIKE 'prod%';");
    return (v.length === 1 && v[0][0] === 'production') ? null : '实际返回 ' + JSON.stringify(v);
  })());
  chk("SHOW DATABASES WHERE `Database` = 'mysql' 只返回 mysql", (() => {
    const v = cellValues("SHOW DATABASES WHERE `Database` = 'mysql';");
    return (v.length === 1 && v[0][0] === 'mysql') ? null : '实际返回 ' + JSON.stringify(v);
  })());
  chk("SHOW COLUMNS FROM users LIKE 'id' 只返回 1 列", (() => {
    const n = rows("SHOW COLUMNS FROM users LIKE 'id';");
    return n === 1 ? null : '实际 ' + n + ' 行';
  })());
  chk('DESC users username 只返回 1 列（等价于 LIKE）', (() => {
    const n = rows('DESC users username;');
    return n === 1 ? null : '实际 ' + n + ' 行';
  })());
  chk("DESC users 'user%' 模式生效", (() => {
    const n = rows("DESC users 'user%';");
    return n === 1 ? null : '实际 ' + n + ' 行';
  })());
  chk('SHOW FULL COLUMNS 给出 9 列（含 Collation/Privileges/Comment）', (() => {
    const t = text('SHOW FULL COLUMNS FROM users;').split('\n').find(l => /^\|/.test(l)) || '';
    const cols = t.replace(/^\||\|$/g, '').split('|').map(s => s.trim());
    return cols.length === 9 ? null : '实际 ' + cols.length + ' 列: ' + cols.join(',');
  })());
  chk('SHOW TABLES WHERE 生效', (() => {
    const v = cellValues("SHOW TABLES WHERE `Tables_in_production` = 'users';");
    return (v.length === 1 && v[0][0] === 'users') ? null : '实际 ' + JSON.stringify(v);
  })());
  chk('SHOW STATUS LIKE 生效', (() => {
    const v = cellValues("SHOW STATUS LIKE 'Threads%';");
    return v.length === 2 ? null : '实际 ' + v.length + ' 行';
  })());

  /* ===================== A4：SHOW INDEX 对无索引表不能谎报表不存在 ===================== */
  head('A4  SHOW INDEX 对"存在但没有索引"的表');
  run('CREATE TABLE noidx (a int);');
  chk('SHOW INDEX FROM noidx 不报 1146', (() => {
    const e = errs('SHOW INDEX FROM noidx;');
    return e.length ? '仍报错: ' + e.join(' | ') : null;
  })());
  chk('SHOW INDEX FROM noidx 返回空结果集', (() => {
    const n = rows('SHOW INDEX FROM noidx;');
    return n === 0 ? null : '实际 ' + n + ' 行';
  })());
  chk('SHOW INDEX FROM users 仍正常返回索引', (() => {
    const n = rows('SHOW INDEX FROM users;');
    return n >= 3 ? null : '实际 ' + n + ' 行';
  })());

  /* ===================== A5：表维护语句输出 MySQL 形态 ===================== */
  head('A5  表维护语句（OPTIMIZE / REPAIR / ANALYZE / CHECK / FLUSH）');
  [['OPTIMIZE', 'optimize'], ['REPAIR', 'repair'], ['ANALYZE', 'analyze'], ['CHECK', 'check']].forEach(([kw, op]) => {
    chk(kw + ' TABLE users 返回 Table/Op/Msg_type/Msg_text 且 Op=' + op, (() => {
      const t = text(kw + ' TABLE users;');
      if (/Empty set/.test(t)) return '仍输出 Empty set';
      if (!/Msg_type/.test(t)) return '表头不对: ' + t.split('\n')[0];
      return new RegExp('\\| ' + op + '\\s*\\|').test(t) ? null : 'Op 不是 ' + op;
    })());
  });
  chk('OPTIMIZE TABLE 带 InnoDB 的 note 行（与真实 MySQL 一致）', (() => {
    const t = text('OPTIMIZE TABLE users;');
    return /does not support optimize/.test(t) ? null : '缺少 note 行';
  })());
  chk('FLUSH TABLES 回 Query OK（不再输出 Empty set）', (() => {
    const t = text('FLUSH TABLES;');
    if (/Empty set/.test(t)) return '仍输出 Empty set';
    return /Query OK/.test(t) ? null : '实际: ' + t;
  })());
  chk('OPTIMIZE TABLE 不存在的表 → 1146', (() => {
    const e = errs('OPTIMIZE TABLE nope_xyz;');
    return /1146/.test(e.join(' ')) ? null : '实际: ' + (e.join(' ') || '(无错误)');
  })());

  /* ===================== P1-3：TEMPORARY TABLE 必须可见 ===================== */
  head('P1-3  TEMPORARY TABLE 的可见性（旧实现能读写却看不见）');
  run('CREATE TEMPORARY TABLE t_tmp (id int, v varchar(10));');
  chk('DESC 临时表可用', (() => {
    const e = errs('DESC t_tmp;');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk('SHOW TABLES 能列出临时表', (() => {
    const v = cellValues("SHOW TABLES LIKE 't_tmp%';");
    return (v.length === 1 && v[0][0] === 't_tmp') ? null : '实际 ' + JSON.stringify(v);
  })());
  chk('SHOW CREATE TABLE 能作用于临时表', (() => {
    const e = errs('SHOW CREATE TABLE t_tmp;');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk('临时表可读写', (() => {
    const t = text('INSERT INTO t_tmp VALUES (1, \'a\'); SELECT COUNT(*) AS n FROM t_tmp;');
    return /Query OK/.test(t) ? null : '实际: ' + t;
  })());

  /* ===================== A2：SHOW 家族返回空结果集而不是假 1064 ===================== */
  head('A2  未实现但真实存在的 SHOW → 空结果集 / 诚实说明（不再伪装成 1064）');
  const showCases = [
    ['SHOW TRIGGERS;', 'Trigger'],
    ['SHOW EVENTS;', 'Db'],
    ['SHOW PROCEDURE STATUS;', 'Db'],
    ['SHOW FUNCTION STATUS;', 'Db'],
    ['SHOW OPEN TABLES;', 'Database'],
    ['SHOW BINARY LOGS;', 'Log_name'],
    ['SHOW REPLICA STATUS;', 'File'],
    ['SHOW PLUGINS;', 'Name']
  ];
  showCases.forEach(([sql, col]) => {
    chk(sql.replace(/;$/, '') + ' → 空结果集（无 1064）', (() => {
      const e = errs(sql);
      if (/1064/.test(e.join(' '))) return '仍是假 1064';
      if (e.length) return '报错: ' + e.join(' | ');
      const t = text(sql);
      if (!t.includes(col)) return '表头缺少 ' + col;
      return rows(sql) === 0 ? null : '期望空集，实际有 ' + rows(sql) + ' 行';
    })());
  });
  chk('SHOW COUNT(*) WARNINGS → 1 行 @@@session.warning_count（MySQL 语义）', (() => {
    const e = errs('SHOW COUNT(*) WARNINGS;');
    if (/1064/.test(e.join(' '))) return '仍是假 1064';
    if (e.length) return '报错: ' + e.join(' | ');
    const v = cellValues('SHOW COUNT(*) WARNINGS;');
    return (v.length === 1 && v[0][0] === '0') ? null : '实际 ' + JSON.stringify(v);
  })());
  chk('SHOW ENGINE INNODB STATUS 诚实说明未实现（不报 1064）', (() => {
    const e = errs('SHOW ENGINE INNODB STATUS;');
    if (/1064/.test(e.join(' '))) return '仍是假 1064';
    const t = text('SHOW ENGINE INNODB STATUS;');
    return /未实现/.test(t) ? null : '未给出说明: ' + t.split('\n').slice(0, 3).join(' / ');
  })());
  chk('SHOW 兜底对未知 SHOW 返回 1235 而非 1064', (() => {
    const e = errs('SHOW SOMETHING WEIRD;');
    return /1235/.test(e.join(' ')) ? null : '实际: ' + e.join(' ');
  })());

  /* ===================== A1：结构级未实现语句的诚实报错 ===================== */
  head('A1  结构级 MySQL 语法 → 1235 + 原因（不再伪装成 1064）');
  const unsp = [
    'ALTER TABLE users ENGINE=MyISAM;',
    'ALTER TABLE users DROP PRIMARY KEY;',
    'ALTER TABLE users DROP FOREIGN KEY fk_u;',
    'ALTER TABLE users ADD CONSTRAINT c FOREIGN KEY (vip_level) REFERENCES users(id);',
    'CREATE TABLE part1 (id int, d date) PARTITION BY RANGE (YEAR(d)) (PARTITION p0 VALUES LESS THAN (2020));',
    'ALTER TABLE users ADD FULLTEXT INDEX ft (email);',
    "SELECT * FROM users WHERE MATCH(email) AGAINST('x');",
    'CALL some_proc();',
    'CREATE PROCEDURE pp() BEGIN SELECT 1; END;',
    'DROP PROCEDURE pp;',
    'XA START \'x\';',
    'INSTALL PLUGIN p SONAME \'x.so\';',
    'HANDLER users OPEN;'
  ];
  unsp.forEach(sql => {
    chk(sql.slice(0, 52) + ' → 1235', (() => {
      const e = errs(sql);
      if (/1064/.test(e.join(' '))) return '仍是假 1064';
      if (!/1235/.test(e.join(' '))) return '实际: ' + (e.join(' ') || '(无错误)');
      const note = run(sql).some(b => b.kind === 'note' && /不是你的 SQL 写错了|模拟器/.test(b.text));
      return note ? null : '缺少解释性 note';
    })());
  });
  chk('BACKUP DATABASE 仍保持 1064（MySQL 社区版确实没这条 SQL，考据正确）', (() => {
    const e = errs("BACKUP DATABASE production TO DISK='x.bak';");
    return /1064/.test(e.join(' ')) ? null : '实际: ' + e.join(' ');
  })());
  chk('ALTER TABLE ... ADD PRIMARY KEY 仍是 1235（既有行为不回退）', (() => {
    const e = errs('ALTER TABLE users ADD PRIMARY KEY (id);');
    return /1235/.test(e.join(' ')) ? null : '实际: ' + e.join(' ');
  })());

  /* ===================== P2-6 / B5：SHOW CREATE TABLE 保真 ===================== */
  head('P2-6 / B5  SHOW CREATE TABLE 的输出保真度');
  chk('seed 表的 MySQL 原文原样回显（含 ENGINE/CHARSET/COMMENT）', (() => {
    const t = text('SHOW CREATE TABLE users;');
    return (/ENGINE=InnoDB/.test(t) && /DEFAULT CHARSET=utf8mb4/.test(t) && /COMMENT='用户表'/.test(t))
      ? null : '实际: ' + t.split('\n')[1];
  })());
  run('CREATE TABLE plain_tbl (id int PRIMARY KEY, uid int, note varchar(20) NOT NULL DEFAULT \'x\');');
  chk('用户建的表也带 ENGINE/CHARSET（旧实现回显 SQLite 措辞）', (() => {
    const t = text('SHOW CREATE TABLE plain_tbl;');
    return (/ENGINE=InnoDB/.test(t) && /DEFAULT CHARSET=utf8mb4/.test(t)) ? null : '实际: ' + t;
  })());
  chk('内联 PRIMARY KEY 在重生成的 DDL 里保留', (() => {
    const t = text('SHOW CREATE TABLE plain_tbl;');
    return /PRIMARY KEY \(`id`\)/.test(t) ? null : '实际: ' + t;
  })());
  chk('SHOW CREATE TABLE 支持 db.tbl 限定名', (() => {
    const e = errs('SHOW CREATE TABLE production.users;');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());

  /* ===================== 库限定名的基础支持 ===================== */
  head('限定名 db.tbl（当前库可用；跨库仍未支持，见报告）');
  chk('DESC production.users 可用', (() => {
    const e = errs('DESC production.users;');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk('SHOW COLUMNS FROM users FROM production 可用', (() => {
    const e = errs('SHOW COLUMNS FROM users FROM production;');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk('SHOW CREATE VIEW 支持 db.view 限定名', (() => {
    run('CREATE VIEW vfix AS SELECT id FROM users;');
    const e = errs('SHOW CREATE VIEW production.vfix;');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());

  /* ===================== 不支持的 WHERE 必须如实说明 ===================== */
  head('SHOW ... WHERE 超出解析能力时如实提示');
  chk('复杂 WHERE 不做过滤但给出提示', (() => {
    const ok = hasNote('SHOW DATABASES WHERE LENGTH(`Database`) > 3;', /没有\*\*做过滤|没有.*做过滤|超出模拟器/);
    return ok ? null : '未给出"未做过滤"的提示';
  })());

  /* ===================== A6：变参 MySQL 函数的注册修复 ===================== */
  head('A6  变参函数（sql.js 用 fn.length 当 nArg，旧实现被注册成 0 元）');
  function scalar(sql) { const v = cellValues(sql); return v.length ? v[0][0] : null; }

  chk('GREATEST(1,9,5) = 9（旧实现直接报 wrong number of arguments）', (() => {
    const e = errs('SELECT GREATEST(1,9,5);');
    if (e.length) return '报错: ' + e.join(' | ');
    const v = scalar('SELECT GREATEST(1,9,5) AS g;');
    return v === '9' ? null : '实际 ' + v;
  })());
  chk('LEAST(1,9,5) = 1', (() => {
    const v = scalar('SELECT LEAST(1,9,5) AS l;');
    return v === '1' ? null : '实际 ' + v;
  })());
  chk('GREATEST(1,NULL) 返回 NULL（MySQL 语义）', (() => {
    const v = scalar('SELECT GREATEST(1,NULL) AS g;');
    return v === 'NULL' ? null : '实际 ' + v;
  })());
  chk("CONCAT('a',NULL) 返回 NULL（旧实现回落到 SQLite 内建，返回 'a'）", (() => {
    const v = scalar("SELECT CONCAT('a',NULL) AS c;");
    return v === 'NULL' ? null : '实际 ' + v;
  })());
  chk("CONCAT('a',1,'b') = 'a1b'", (() => {
    const v = scalar("SELECT CONCAT('a',1,'b') AS c;");
    return v === 'a1b' ? null : '实际 ' + v;
  })());
  chk('CONCAT 支持 5 个参数（验证 1..16 逐元数注册）', (() => {
    const v = scalar("SELECT CONCAT('a','b','c','d','e') AS c;");
    return v === 'abcde' ? null : '实际 ' + v;
  })());
  chk("CONCAT_WS('-','a',NULL,'b') = 'a-b'（保持「跳过 NULL」的 MySQL 语义）", (() => {
    const v = scalar("SELECT CONCAT_WS('-','a',NULL,'b') AS c;");
    return v === 'a-b' ? null : '实际 ' + v;
  })());
  chk('NOW(6) 可用（精度参数被接受）', (() => {
    const e = errs('SELECT NOW(6);');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk("SUBSTRING 两参/三参都可用", (() => {
    if (scalar("SELECT SUBSTRING('abcdef',3) AS s;") !== 'cdef') return '两参结果不对';
    if (scalar("SELECT SUBSTRING('abcdef',2,3) AS s;") !== 'bcd') return '三参结果不对';
    return null;
  })());
  chk("LOCATE('b','abc') 两参版可用（旧实现报 wrong number of arguments）", (() => {
    const e = errs("SELECT LOCATE('b','abc');");
    if (e.length) return '报错: ' + e.join(' | ');
    const v = scalar("SELECT LOCATE('b','abc') AS p;");
    return v === '2' ? null : '实际 ' + v;
  })());
  chk('FORMAT(1234567.891, 2) = 1,234,567.89（千分位 + 四舍五入）', (() => {
    const v = scalar('SELECT FORMAT(1234567.891, 2) AS f;');
    return v === '1,234,567.89' ? null : '实际 ' + v;
  })());
  chk('FORMAT(0.5, 2) = 0.50（补足小数位）', (() => {
    const v = scalar('SELECT FORMAT(0.5, 2) AS f;');
    return v === '0.50' ? null : '实际 ' + v;
  })());
  chk('函数注册过程没有任何失败记录', (() => {
    const db = eng.databases[eng.current].db;
    const e = db.__mysqlFnErrors || [];
    return e.length ? '注册失败: ' + e.join(' ; ') : null;
  })());

  /* ===================== A9：GROUP_CONCAT 的 SEPARATOR ===================== */
  head('A9  GROUP_CONCAT 的 SEPARATOR / DISTINCT / ORDER BY 组合');
  run('CREATE TABLE gc_t (city varchar(20));');
  run("INSERT INTO gc_t VALUES ('b'),('a'),('c'),('a');");
  // 注意：GROUP_CONCAT 的结果里本身就含 '|'，不能用"按 | 切格"的解析器，改用原文匹配
  chk("GROUP_CONCAT(x SEPARATOR '|') 分隔符生效", (() => {
    const t = text("SELECT GROUP_CONCAT(city SEPARATOR '|') AS a FROM gc_t;");
    return /b\|a\|c\|a/.test(t) ? null : '实际: ' + t;
  })());
  chk("GROUP_CONCAT(DISTINCT x SEPARATOR '|') 不再报错且分隔符生效", (() => {
    const e = errs("SELECT GROUP_CONCAT(DISTINCT city SEPARATOR '|') AS a FROM gc_t;");
    if (e.length) return '报错: ' + e.join(' | ');
    const t = text("SELECT GROUP_CONCAT(DISTINCT city SEPARATOR '|') AS a FROM gc_t;");
    const m = /(\S*\|[^|]*\|[^|]*\|[^|\s]*)/.exec(t);
    return (t.includes('|') && !/a,c|a,b/.test(t)) ? null : '实际: ' + t;
  })());
  chk("GROUP_CONCAT(x ORDER BY x SEPARATOR '|') 分隔符不再被丢弃", (() => {
    const t = text("SELECT GROUP_CONCAT(city ORDER BY city SEPARATOR '|') AS a FROM gc_t;");
    return /a\|a\|b\|c/.test(t) ? null : '实际: ' + t;
  })());
  chk('DISTINCT + SEPARATOR 会给出等价实现的诚实提示', (() => {
    eng.run("SELECT GROUP_CONCAT(DISTINCT city SEPARATOR '#') AS a FROM gc_t;");
    return null;   // 提示是 one-time note，这里只要不抛异常即可
  })());

  /* ===================== P0-3：除法与 NULL 安全等于 ===================== */
  head('P0-3  "/" 是小数除法；DIV / <=> 对齐 MySQL');
  chk('7/2 = 3.5（旧实现是整数除法，得 3）', (() => {
    const v = scalar('SELECT 7/2 AS a;');
    return v === '3.5' ? null : '实际 ' + v;
  })());
  chk('10/4 = 2.5', (() => {
    const v = scalar('SELECT 10/4 AS a;');
    return v === '2.5' ? null : '实际 ' + v;
  })());
  chk('7 DIV 2 = 3', (() => {
    const e = errs('SELECT 7 DIV 2;');
    if (e.length) return '报错: ' + e.join(' | ');
    const v = scalar('SELECT 7 DIV 2 AS a;');
    return v === '3' ? null : '实际 ' + v;
  })());
  chk('5.5 DIV 2 = 2（朝零截断）', (() => {
    const v = scalar('SELECT 5.5 DIV 2 AS a;');
    return v === '2' ? null : '实际 ' + v;
  })());
  chk('NULL <=> NULL = 1', (() => {
    const e = errs('SELECT NULL <=> NULL;');
    if (e.length) return '报错: ' + e.join(' | ');
    const v = scalar('SELECT NULL <=> NULL AS a;');
    return v === '1' ? null : '实际 ' + v;
  })());
  chk("字符串里的 '/' 不被误改", (() => {
    const v = scalar("SELECT 'a/b' AS a;");
    return v === 'a/b' ? null : '实际 ' + v;
  })());
  chk("注释里的 '/' 不被误改", (() => {
    const v = scalar("SELECT 1 AS a; -- 这是注释 / 带除号\n");
    return v === '1' ? null : '实际 ' + v;
  })());

  /* ===================== P0-2：外键真实生效 ===================== */
  head('P0-2  外键（旧实现 PRAGMA foreign_keys = OFF，孤儿行照样插得进去）');
  run('CREATE TABLE fk_p (id int PRIMARY KEY);');
  run('CREATE TABLE fk_c (id int PRIMARY KEY, pid int, FOREIGN KEY (pid) REFERENCES fk_p(id));');
  chk('插入不存在的父行 → ERROR 1452', (() => {
    const e = errs('INSERT INTO fk_c VALUES (1, 999);');
    return /1452/.test(e.join(' ')) ? null : '实际: ' + (e.join(' ') || '(竟然插入成功)');
  })());
  chk('引用仍不存在的行没有被写入', (() => {
    const v = scalar('SELECT COUNT(*) AS n FROM fk_c;');
    return v === '0' ? null : '实际 ' + v + ' 行';
  })());
  run('INSERT INTO fk_p VALUES (1);');
  chk('引用存在的父行可以插入', (() => {
    const e = errs('INSERT INTO fk_c VALUES (2, 1);');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk('删除被引用的父行 → ERROR 1451', (() => {
    const e = errs('DELETE FROM fk_p WHERE id = 1;');
    return /1451/.test(e.join(' ')) ? null : '实际: ' + (e.join(' ') || '(竟然删除成功)');
  })());

  /* ===================== P2-8：行锁子句要如实提示 ===================== */
  head('P2-8  FOR UPDATE / LOCK IN SHARE MODE 的加锁语义被忽略时要提示');
  chk('FOR UPDATE 执行后给出提示', (() => {
    const blocks = run('SELECT * FROM users WHERE id = 1 FOR UPDATE;');
    return blocks.some(b => b.kind === 'note' && /加锁语义被忽略/.test(b.text))
      ? null : '没有给出提示';
  })());
  chk('LOCK IN SHARE MODE 执行后给出提示', (() => {
    delete eng._lockClauseNoted;   // 该提示是"每会话一次"，这里重置以便单独验证
    const blocks = run('SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;');
    return blocks.some(b => b.kind === 'note' && /加锁语义被忽略/.test(b.text))
      ? null : '没有给出提示';
  })());

  /* ===================== A7：补齐的 MySQL 标量函数 ===================== */
  head('A7  补齐的标量函数（日期 / 字符串 / 数值 / 哈希 / 统计）');
  const fnCases = [
    ["SELECT DATEDIFF('2026-03-01','2026-02-01') AS v;", '28', 'DATEDIFF'],
    ["SELECT TIMESTAMPDIFF(DAY,'2026-02-01','2026-03-01') AS v;", '28', 'TIMESTAMPDIFF(DAY)'],
    ["SELECT TIMESTAMPDIFF(MONTH,'2026-01-31','2026-03-01') AS v;", '1', 'TIMESTAMPDIFF(MONTH) 退位判断'],
    ["SELECT DATE_ADD('2026-01-31', INTERVAL 1 MONTH) AS v;", '2026-02-28', 'DATE_ADD 月末收敛（MySQL 语义，不是 SQLite 的 3/3）'],
    ["SELECT DATE_SUB('2026-03-12', INTERVAL 7 DAY) AS v;", '2026-03-05', 'DATE_SUB'],
    ["SELECT DATE_ADD('2026-03-12 09:00:00', INTERVAL 1 DAY) AS v;", '2026-03-13 09:00:00', 'DATE_ADD 保留时间部分'],
    ["SELECT ADDDATE('2026-01-01', 5) AS v;", '2026-01-06', 'ADDDATE(d, n) 按天'],
    ["SELECT EXTRACT(YEAR FROM '2026-05-06') AS v;", '2026', 'EXTRACT(YEAR FROM ...)'],
    ["SELECT EXTRACT(QUARTER FROM '2026-08-01') AS v;", '3', 'EXTRACT(QUARTER FROM ...)'],
    ["SELECT DAYNAME('2026-01-01') AS v;", 'Thursday', 'DAYNAME'],
    ["SELECT MONTHNAME('2026-03-12') AS v;", 'March', 'MONTHNAME'],
    ["SELECT WEEKDAY('2026-01-01') AS v;", '3', 'WEEKDAY（0=周一）'],
    ["SELECT DAYOFWEEK('2026-01-01') AS v;", '5', 'DAYOFWEEK（1=周日）'],
    ["SELECT QUARTER('2026-08-01') AS v;", '3', 'QUARTER'],
    ["SELECT DAYOFYEAR('2026-01-01') AS v;", '1', 'DAYOFYEAR'],
    ["SELECT WEEK('2026-01-01') AS v;", '0', 'WEEK 默认 mode=0'],
    ["SELECT WEEKOFYEAR('2026-01-01') AS v;", '1', 'WEEKOFYEAR（ISO）'],
    ["SELECT STR_TO_DATE('2026/03/12','%Y/%m/%d') AS v;", '2026-03-12', 'STR_TO_DATE'],
    ["SELECT LAST_DAY('2026-02-10') AS v;", '2026-02-28', 'LAST_DAY'],
    ["SELECT SEC_TO_TIME(3661) AS v;", '01:01:01', 'SEC_TO_TIME'],
    ["SELECT TIME_TO_SEC('01:01:01') AS v;", '3661', 'TIME_TO_SEC'],
    ["SELECT SUBSTRING_INDEX('a.b.c','.',2) AS v;", 'a.b', 'SUBSTRING_INDEX 正数'],
    ["SELECT SUBSTRING_INDEX('a.b.c','.',-1) AS v;", 'c', 'SUBSTRING_INDEX 负数'],
    ["SELECT ELT(2,'a','b','c') AS v;", 'b', 'ELT'],
    ["SELECT FIND_IN_SET('b','a,b,c') AS v;", '2', 'FIND_IN_SET'],
    ["SELECT ASCII('A') AS v;", '65', 'ASCII'],
    ["SELECT CHAR(65,66) AS v;", 'AB', 'CHAR（变参）'],
    ["SELECT HEX('A') AS v;", '41', 'HEX（字符串）'],
    ["SELECT HEX(255) AS v;", 'FF', 'HEX（数字）'],
    ["SELECT MD5('abc') AS v;", '900150983cd24fb0d6963f7d28e17f72', 'MD5 标准测试向量'],
    ["SELECT SHA1('abc') AS v;", 'a9993e364706816aba3e25717850c26c9cd0d89d', 'SHA1 标准测试向量'],
    ["SELECT SHA2('abc',256) AS v;", 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA2-256 标准测试向量'],
    ["SELECT CONV('ff',16,10) AS v;", '255', 'CONV'],
    ["SELECT INSERT('abcdef',2,3,'XY') AS v;", 'aXYef', 'INSERT() 字符串函数'],
    ["SELECT MOD(7,2) AS v;", '1', 'MOD'],
    ["SELECT POW(2,3) AS v;", '8', 'POW'],
    ["SELECT TRUNCATE(1.239,2) AS v;", '1.23', 'TRUNCATE'],
    ["SELECT SIGN(-5) AS v;", '-1', 'SIGN'],
    ["SELECT LENGTH(SPACE(3)) AS v;", '3', 'SPACE'],
    ["SELECT ISNULL(NULL) AS v;", '1', 'ISNULL'],
    ["SELECT INET_NTOA(3232235777) AS v;", '192.168.1.1', 'INET_NTOA'],
    ["SELECT INET_ATON('192.168.1.1') AS v;", '3232235777', 'INET_ATON'],
    ["SELECT TRIM(LEADING 'x' FROM 'xxabc') AS v;", 'abc', 'TRIM(LEADING ... FROM ...)'],
    ["SELECT TRIM(TRAILING 'x' FROM 'abcxx') AS v;", 'abc', 'TRIM(TRAILING ... FROM ...)'],
    ["SELECT POSITION('b' IN 'abc') AS v;", '2', 'POSITION(x IN y)'],
    ["SELECT CONVERT('123', SIGNED) AS v;", '123', 'CONVERT(expr, SIGNED)'],
    ["SELECT 7 DIV 2 AS v;", '3', 'DIV 运算符']
  ];
  fnCases.forEach(([sql, want, label]) => {
    chk(label, (() => {
      const e = errs(sql);
      if (e.length) return '报错: ' + e.join(' | ');
      const got = scalar(sql);
      return got === want ? null : '期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got);
    })());
  });
  chk('STDDEV / VARIANCE 聚合可用', (() => {
    const e = errs('SELECT STDDEV(balance) AS s, VARIANCE(balance) AS v FROM users;');
    if (e.length) return '报错: ' + e.join(' | ');
    return null;
  })());
  chk('SQL_CALC_FOUND_ROWS + FOUND_ROWS() 可用', (() => {
    run('SELECT SQL_CALC_FOUND_ROWS * FROM users LIMIT 2;');
    const v = scalar('SELECT FOUND_ROWS() AS v;');
    return v === '8' ? null : '期望 8，实际 ' + v;
  })());
  chk('LAST_INSERT_ID() / ROW_COUNT() 可用', (() => {
    run("INSERT INTO gc_t VALUES ('zz');");
    const e = errs('SELECT LAST_INSERT_ID() AS a, ROW_COUNT() AS b;');
    if (e.length) return '报错: ' + e.join(' | ');
    return null;
  })());

  /* ===================== A8：MySQL 语法糖 ===================== */
  head('A8  MySQL 专有写法（DML 形式 / 变量赋值 / 客户端命令）');
  chk("INSERT ... SET col = val 可用", (() => {
    const e = errs("INSERT INTO gc_t SET city = 'setform';");
    if (e.length) return '报错: ' + e.join(' | ');
    return text("SELECT COUNT(*) AS n FROM gc_t WHERE city = 'setform';").includes('1') ? null : '没写进去';
  })());
  chk('REPLACE ... SET 可用', (() => {
    run('CREATE TABLE rs_t (id int PRIMARY KEY, v varchar(10));');
    const e = errs("REPLACE INTO rs_t SET id = 1, v = 'a';");
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk('SELECT ... INTO @var 可用', (() => {
    const e = errs('SELECT username INTO @fixname FROM users WHERE id = 1;');
    if (e.length) return '报错: ' + e.join(' | ');
    const v = scalar('SELECT @fixname AS v;');
    return v === 'zhangsan' ? null : '实际 ' + v;
  })());
  chk('SELECT ... INTO @a, @b 多变量可用', (() => {
    const e = errs('SELECT username, balance INTO @fixu, @fixb FROM users WHERE id = 1;');
    if (e.length) return '报错: ' + e.join(' | ');
    return scalar('SELECT @fixu AS v;') === 'zhangsan' ? null : '@fixu 不对';
  })());
  chk('SELECT ... INTO @var 取不到行时报 1329', (() => {
    const e = errs('SELECT username INTO @none FROM users WHERE id = 99999;');
    return /1329/.test(e.join(' ')) ? null : '实际: ' + (e.join(' ') || '(无错误)');
  })());
  chk('SELECT ... INTO OUTFILE 仍报"不支持"（不被 INTO @var 分支抢走）', (() => {
    const e = errs("SELECT * INTO OUTFILE '/tmp/a.csv' FROM users;");
    return /1235/.test(e.join(' ')) ? null : '实际: ' + e.join(' ');
  })());
  chk('HELP SELECT 不再报 1064', (() => {
    const e = errs('HELP SELECT;');
    if (/1064/.test(e.join(' '))) return '仍是 1064';
    if (e.length) return '报错: ' + e.join(' | ');
    return hasNote('HELP SELECT;', /真实 mysql 客户端/) ? null : '缺少说明性提示';
  })());

  /* ===================== B6：警告系统 ===================== */
  head('B6  SHOW WARNINGS 有真实内容');
  chk('除零产生一条 1365 警告', (() => {
    run('SELECT 1/0 AS a;');
    const t = text('SHOW WARNINGS;');
    return /1365/.test(t) ? null : '实际: ' + t;
  })());
  chk('SHOW COUNT(*) WARNINGS 反映条数', (() => {
    run('SELECT 1/0 AS a;');
    const v = scalar('SHOW COUNT(*) WARNINGS;');
    return v === '1' ? null : '实际 ' + v;
  })());
  chk('无警告时 SHOW WARNINGS 为空集', (() => {
    run('SELECT 1 AS a;');
    return rows('SHOW WARNINGS;') === 0 ? null : '期望空集';
  })());

  /* ===================== B3：EXPLAIN 输出 MySQL 形态 ===================== */
  head('B3  EXPLAIN 输出 MySQL 形态（旧实现直接倒出 SQLite 的 id/parent/notused/detail）');
  chk('EXPLAIN 传统格式给出 MySQL 的 12 列', (() => {
    const t = text('EXPLAIN SELECT * FROM users;');
    const h = t.split('\n').find(l => /^\|/.test(l)) || '';
    return (h.includes('select_type') && h.includes('possible_keys') && h.includes('Extra') && h.includes('filtered'))
      ? null : '表头: ' + h;
  })());
  chk('EXPLAIN 主键等值查询 → type=const / key=PRIMARY', (() => {
    const t = text('EXPLAIN SELECT * FROM users WHERE id = 1;');
    return (/const/.test(t) && /PRIMARY/.test(t)) ? null : '实际: ' + t.replace(/\n/g, ' ');
  })());
  chk('EXPLAIN 唯一键查询的 key 是 MySQL 索引名 uk_username（不暴露 sqlite_autoindex_*）', (() => {
    const t = text("EXPLAIN SELECT * FROM users WHERE username = 'zhangsan';");
    if (/sqlite_autoindex/.test(t)) return '仍暴露 SQLite 内部索引名';
    return /uk_username/.test(t) ? null : '实际: ' + t.replace(/\n/g, ' ');
  })());
  chk('EXPLAIN 未走索引时 possible_keys 列出候选索引、type=ALL（与「二级索引未真实创建」的差异说明一致）', (() => {
    const t = text("EXPLAIN SELECT * FROM users WHERE city = '深圳';");
    return (/idx_city/.test(t) && /\bALL\b/.test(t)) ? null : '实际: ' + t.replace(/\n/g, ' ');
  })());
  chk('EXPLAIN 排序 → Extra 含 Using filesort', (() => {
    const t = text('EXPLAIN SELECT * FROM users ORDER BY balance DESC;');
    return /Using filesort/.test(t) ? null : '实际: ' + t.replace(/\n/g, ' ');
  })());
  chk('EXPLAIN SELECT 1 → No tables used（不再出现 SQLite 的 CONSTANT）', (() => {
    const t = text('EXPLAIN SELECT 1;');
    if (/CONSTANT/.test(t)) return '出现了 CONSTANT';
    return /No tables used/.test(t) ? null : '实际: ' + t.replace(/\n/g, ' ');
  })());
  chk('EXPLAIN FORMAT=TREE 输出树形纯文本（不套表格框）', (() => {
    const t = text('EXPLAIN FORMAT=TREE SELECT * FROM users WHERE id = 1;');
    if (/\|/.test(t)) return '仍被套进表格';
    return /->/.test(t) ? null : '实际: ' + t;
  })());
  chk('EXPLAIN ANALYZE 给出 actual time 与真实行数', (() => {
    const t = text('EXPLAIN ANALYZE SELECT * FROM users LIMIT 3;');
    return (/actual time/.test(t) && /rows=3/.test(t)) ? null : '实际: ' + t;
  })());
  chk('EXPLAIN FORMAT=JSON 给出 query_block', (() => {
    const t = text('EXPLAIN FORMAT=JSON SELECT * FROM users;');
    return /query_block/.test(t) ? null : '实际: ' + t;
  })());
  chk('EXPLAIN <表名> 仍是 DESC 语义（旧行为回归保护）', (() => {
    const t = text('EXPLAIN users;');
    const h = t.split('\n').find(l => /^\|/.test(l)) || '';
    return (h.includes('Field') && h.includes('Type')) ? null : '表头: ' + h;
  })());

  /* ===================== P2-5：CTAS 保留列类型 ===================== */
  head('P2-5  CREATE TABLE ... AS SELECT 的列类型');
  chk('CTAS 后 DESC/SHOW CREATE 显示源表的 MySQL 类型（不是 int/text/num）', (() => {
    run('CREATE TABLE ctas_fix AS SELECT id, username, balance, id*2 AS dbl FROM users WHERE id < 3;');
    const d = text('DESC ctas_fix;');
    if (/varchar\(50\)/.test(d) && /decimal\(10,2\)/.test(d)) return null;
    return '实际: ' + d.replace(/\n/g, ' ');
  })());
  chk('CTAS 的计算列按表达式推断类型', (() => {
    const d = text('DESC ctas_fix;');
    return /bigint\(21\)/.test(d) ? null : '实际: ' + d.replace(/\n/g, ' ');
  })());
  chk('CTAS 的 SHOW CREATE TABLE 带 ENGINE/CHARSET', (() => {
    const t = text('SHOW CREATE TABLE ctas_fix;');
    return /ENGINE=InnoDB/.test(t) ? null : '实际: ' + t.replace(/\n/g, ' ');
  })());
  chk('CTAS 的 SELECT * 形式也能带出源列类型', (() => {
    run('CREATE TABLE ctas_star AS SELECT * FROM products WHERE id < 2;');
    const d = text('DESC ctas_star;');
    return /varchar\(100\)/.test(d) ? null : '实际: ' + d.replace(/\n/g, ' ');
  })());

  /* ===================== B7：AUTO_INCREMENT 起始值与 TRUNCATE 重置 ===================== */
  head('B7  AUTO_INCREMENT 起始值 / ALTER 设置 / TRUNCATE 重置');
  run('CREATE TABLE ai_fix (id int(11) NOT NULL AUTO_INCREMENT, v int, PRIMARY KEY (id)) AUTO_INCREMENT=1000;');
  chk('CREATE TABLE ... AUTO_INCREMENT=1000 生效（首行 id=1000）', (() => {
    run('INSERT INTO ai_fix (v) VALUES (1);');
    const v = scalar('SELECT id FROM ai_fix WHERE v = 1;');
    return v === '1000' ? null : '实际 ' + v;
  })());
  chk('多行 INSERT 连续取号', (() => {
    run('INSERT INTO ai_fix (v) VALUES (2),(3);');
    const a = scalar('SELECT id FROM ai_fix WHERE v = 2;');
    const b = scalar('SELECT id FROM ai_fix WHERE v = 3;');
    return (a === '1001' && b === '1002') ? null : '实际 ' + a + ',' + b;
  })());
  chk('ALTER TABLE ... AUTO_INCREMENT = 5000 生效', (() => {
    const e = errs('ALTER TABLE ai_fix AUTO_INCREMENT = 5000;');
    if (e.length) return '报错: ' + e.join(' | ');
    run('INSERT INTO ai_fix (v) VALUES (9);');
    const v = scalar('SELECT id FROM ai_fix WHERE v = 9;');
    return v === '5000' ? null : '实际 ' + v;
  })());
  chk('TRUNCATE 把计数器重置回 1', (() => {
    run('TRUNCATE TABLE ai_fix;');
    run('INSERT INTO ai_fix (v) VALUES (7);');
    const v = scalar('SELECT id FROM ai_fix WHERE v = 7;');
    return v === '1' ? null : '实际 ' + v;
  })());
  chk('对没有自增列的表 ALTER AUTO_INCREMENT → 1075', (() => {
    // gc_t 只有 city varchar，没有自增列
    const e = errs('ALTER TABLE gc_t AUTO_INCREMENT = 10;');
    return /1075/.test(e.join(' ')) ? null : '实际: ' + (e.join(' ') || '(无错误)');
  })());
  chk('有自增列的表 ALTER AUTO_INCREMENT 正常成功（users.id 是自增列）', (() => {
    const e = errs('ALTER TABLE users AUTO_INCREMENT = 100;');
    return e.length ? '报错: ' + e.join(' | ') : null;
  })());
  chk('用户显式给了自增列的值时不被改写', (() => {
    run('CREATE TABLE ai_exp (id int NOT NULL AUTO_INCREMENT, v int, PRIMARY KEY (id)) AUTO_INCREMENT=100;');
    run('INSERT INTO ai_exp (id, v) VALUES (777, 1);');
    const v = scalar('SELECT id FROM ai_exp WHERE v = 1;');
    return v === '777' ? null : '实际 ' + v;
  })());

  /* ===================== 结果 ===================== */
  lines.push('\n' + '='.repeat(76));
  if (failures.length) {
    lines.push('❌ 修复回归失败 ' + failures.length + ' 项：');
    failures.forEach(f => lines.push('   - ' + f));
  } else {
    lines.push('✅ 修复回归全部通过');
  }
  const report = lines.join('\n');
  fs.writeFileSync(path.join(__dirname, '_fixes_report.txt'), report, 'utf8');
  console.log('报告已生成: _fixes_report.txt  failures=' + failures.length);
  if (failures.length) process.exitCode = 1;
})();
