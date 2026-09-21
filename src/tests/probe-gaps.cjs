/* ============================================================================
 * 覆盖度普查：批量跑常见 MySQL 语句，把结果分成四类
 *   1) 通过             —— 没有报错
 *   2) 诚实不支持       —— 报 1235（本模拟器没实现）且带解释性 note
 *   3) 其它报错         —— 需要人工确认（例如数据相关的 1062）
 *   4) 意外语法错       —— 报 1064，但这在真实 MySQL 里是合法语句（最该修的）
 * 关键不变量：第 4 类必须为 0。真实 MySQL 里合法的语句不允许伪装成"语法错误"。
 *
 * 跑法：node probe-gaps.cjs   → 报告写到 _gap_report.txt
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const SQL = require(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.js'));
const wasm = fs.readFileSync(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.wasm'));
const Core = require('../mysql-core.js');

const CASES = [
  // --- 会话 / 信息 ---
  "SHOW DATABASES;", "SHOW SCHEMAS;", "SHOW TABLES;", "SHOW FULL TABLES;", "SHOW TABLE STATUS;",
  "SHOW TABLES FROM production;", "SHOW FULL COLUMNS FROM users;", "SHOW COLUMNS FROM users;",
  "SHOW INDEX FROM users;", "SHOW KEYS FROM users;", "SHOW CREATE TABLE users;", "SHOW CREATE DATABASE production;",
  "SHOW VARIABLES;", "SHOW VARIABLES LIKE 'ver%';", "SHOW SESSION VARIABLES LIKE 'autocommit';",
  "SHOW GLOBAL VARIABLES LIKE 'port';", "SHOW STATUS;", "SHOW STATUS LIKE 'Threads%';", "SHOW ENGINES;", "SHOW PROCESSLIST;",
  "SHOW FULL PROCESSLIST;", "SHOW WARNINGS;", "SHOW ERRORS;", "SHOW GRANTS;", "SHOW GRANTS FOR 'root'@'localhost';",
  "DESC users;", "DESCRIBE users;", "EXPLAIN users;", "SELECT DATABASE();", "SELECT VERSION();",
  "status;", "\\s",
  // --- 过滤条件必须生效（曾经被静默忽略） ---
  "SHOW DATABASES LIKE 'prod%';", "SHOW COLUMNS FROM users LIKE 'id';", "DESC users username;",
  "SHOW TABLES WHERE `Tables_in_production` = 'users';",
  // --- EXPLAIN 的四种形态 ---
  "EXPLAIN SELECT * FROM users WHERE id = 1;",
  "EXPLAIN FORMAT=TREE SELECT * FROM users;",
  "EXPLAIN FORMAT=JSON SELECT * FROM users;",
  "EXPLAIN ANALYZE SELECT * FROM users LIMIT 2;",
  // --- 真实存在的 SHOW（本模拟器没有对应对象）→ 应返回空结果集而不是 1064 ---
  "SHOW TRIGGERS;", "SHOW EVENTS;", "SHOW PROCEDURE STATUS;", "SHOW FUNCTION STATUS;",
  "SHOW OPEN TABLES;", "SHOW BINARY LOGS;", "SHOW REPLICA STATUS;", "SHOW PLUGINS;",
  "SHOW COUNT(*) WARNINGS;", "SHOW ENGINE INNODB STATUS;",
  // --- DDL ---
  "CREATE DATABASE IF NOT EXISTS probe_db;", "ALTER DATABASE probe_db CHARACTER SET utf8mb4;",
  "USE probe_db;",
  "CREATE TABLE IF NOT EXISTS p1 (id int(11) NOT NULL AUTO_INCREMENT, v varchar(10), PRIMARY KEY(id));",
  "CREATE TABLE p2 LIKE p1;",
  "CREATE TABLE p3 AS SELECT * FROM p1;",
  "CREATE TABLE p4 (id int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;",
  "CREATE TABLE p5 (id int(11) NOT NULL AUTO_INCREMENT, v int, PRIMARY KEY(id)) AUTO_INCREMENT=500;",
  "ALTER TABLE p1 ADD COLUMN note varchar(20) NOT NULL DEFAULT '';",
  "ALTER TABLE p1 MODIFY COLUMN v varchar(50) NOT NULL;",
  "ALTER TABLE p1 CHANGE COLUMN v v2 varchar(50);",
  "ALTER TABLE p1 ADD INDEX idx_v (v2);",
  "ALTER TABLE p1 ADD UNIQUE KEY uk_x (note);",
  "ALTER TABLE p1 DROP INDEX idx_v;",
  "ALTER TABLE p1 DROP COLUMN note;",
  "ALTER TABLE p1 RENAME TO p1_new;",
  "ALTER TABLE p1_new RENAME COLUMN v2 TO v3;",
  "CREATE INDEX idx_p ON p1_new (v3);",
  "CREATE UNIQUE INDEX uk_p ON p1_new (v3);",
  "DROP INDEX idx_p ON p1_new;",
  "SHOW INDEX FROM p1_new;",
  "RENAME TABLE p1_new TO p1;",
  "ALTER TABLE p5 AUTO_INCREMENT = 900;",
  "CHECK TABLE p1;", "OPTIMIZE TABLE p1;", "ANALYZE TABLE p1;", "REPAIR TABLE p1;",
  "FLUSH TABLES;", "FLUSH PRIVILEGES;",
  "LOCK TABLES p1 READ;", "UNLOCK TABLES;",
  "CREATE TEMPORARY TABLE p_tmp (id int);", "DESC p_tmp;", "SHOW TABLES LIKE 'p_tmp%';", "DROP TEMPORARY TABLE p_tmp;",
  "DROP TABLE IF EXISTS p1, p2, p3, p4, p5;", "DROP DATABASE IF EXISTS probe_db;",
  // --- DML ---
  "USE production;",
  "INSERT INTO users (username,email) VALUES ('probe','probe@x.com');",
  "INSERT IGNORE INTO users (username,email) VALUES ('probe','probe@x.com');",
  "INSERT INTO users (username,email) SELECT username,email FROM users WHERE id=1;",
  "INSERT INTO users SET username='setform', email='setform@x.com';",
  "INSERT INTO users (username,email) VALUES ('dup','dup@x.com') ON DUPLICATE KEY UPDATE email='dup@x.com';",
  "REPLACE INTO users (id,username,email) VALUES (999,'rep','rep@x.com');",
  "UPDATE users SET balance = balance WHERE id = 1 LIMIT 1;",
  "DELETE FROM users WHERE username='probe' LIMIT 1;",
  "SELECT username INTO @probe_name FROM users WHERE id = 1;",
  "SELECT @probe_name;",
  // --- 查询 ---
  "SELECT 1;", "SELECT 1 AS a, 2 AS b;", "SELECT * FROM users LIMIT 2 OFFSET 1;",
  "SELECT DISTINCT city FROM users;", "SELECT city, COUNT(*) c FROM users GROUP BY city HAVING c > 1;",
  "SELECT * FROM users WHERE balance BETWEEN 100 AND 1000;",
  "SELECT * FROM users WHERE username IN ('a','b');",
  "SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id);",
  "SELECT * FROM users WHERE city LIKE '深%';",
  "SELECT * FROM users WHERE city REGEXP '^深';",
  "SELECT username, CASE WHEN balance > 10000 THEN '高' ELSE '低' END AS lv FROM users;",
  "SELECT COALESCE(NULL, 1) AS c, NULLIF(1,1) AS n;",
  "SELECT (SELECT COUNT(*) FROM orders) AS oc;",
  "SELECT u.username FROM users u WHERE u.id IN (SELECT user_id FROM orders);",
  "SELECT id FROM users UNION SELECT id FROM orders;",
  "SELECT FIELD('b','a','b') AS f;",
  "SELECT * FROM users ORDER BY FIELD(city,'深圳','上海') ;",
  "SELECT @@version, @@port, @undefined_var;",
  "SELECT ROW_NUMBER() OVER (PARTITION BY city ORDER BY balance DESC) rn, username FROM users;",
  "SELECT username, LAG(balance) OVER (ORDER BY id) AS prev FROM users;",
  "WITH big AS (SELECT * FROM products WHERE price > 1000) SELECT COUNT(*) AS n FROM big;",
  "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT SUM(n) AS t FROM seq;",
  "SELECT * FROM users WHERE id = 1 FOR UPDATE;",
  "SELECT * FROM users LIMIT 1\\G",
  // --- 运算符与函数语法糖（曾经全是假 1064） ---
  "SELECT 7 DIV 2 AS a;",
  "SELECT NULL <=> NULL AS a;",
  "SELECT DATE_ADD('2026-01-31', INTERVAL 1 MONTH) AS a;",
  "SELECT DATE_SUB(NOW(), INTERVAL 7 DAY) AS a;",
  "SELECT EXTRACT(YEAR FROM '2026-05-06') AS a;",
  "SELECT TIMESTAMPDIFF(DAY,'2026-02-01','2026-03-01') AS a;",
  "SELECT DATEDIFF('2026-03-01','2026-02-01') AS a;",
  "SELECT STR_TO_DATE('2026/03/12','%Y/%m/%d') AS a;",
  "SELECT TRIM(LEADING 'x' FROM 'xxabc') AS a;",
  "SELECT POSITION('b' IN 'abc') AS a;",
  "SELECT LOCATE('b','abc') AS a;",
  "SELECT CONVERT('123', SIGNED) AS a;",
  "SELECT ISNULL(NULL) AS a;",
  "SELECT INSERT('abcdef',2,3,'XY') AS a;",
  "SELECT GREATEST(1,9,5) AS g, LEAST(1,9,5) AS l;",
  "SELECT CONCAT('a', NULL) AS c;",
  "SELECT GROUP_CONCAT(DISTINCT city SEPARATOR '|') AS a FROM users;",
  "SELECT SUBSTRING_INDEX('a.b.c','.',2) AS a;",
  "SELECT ELT(2,'a','b','c') AS a, FIND_IN_SET('b','a,b,c') AS b;",
  "SELECT MD5('abc') AS a, SHA1('abc') AS b, SHA2('abc',256) AS c;",
  "SELECT FORMAT(1234567.891, 2) AS a;",
  "SELECT JSON_EXTRACT('{\"a\":1}','$.a') AS a;",
  "SELECT STDDEV(balance) AS a, VARIANCE(balance) AS b FROM users;",
  "SELECT LAST_INSERT_ID() AS a, ROW_COUNT() AS b;",
  "SELECT SQL_CALC_FOUND_ROWS * FROM users LIMIT 2;",
  // --- 变量 / 事务 ---
  "SET @x = 1;", "SET @x := 2;", "SET NAMES utf8mb4;", "SET CHARACTER SET utf8mb4;",
  "SET autocommit = 0;", "SET SESSION sql_mode = 'STRICT_TRANS_TABLES';",
  "SET GLOBAL max_connections = 200;", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED;",
  "START TRANSACTION;", "BEGIN;", "COMMIT;", "ROLLBACK;",
  "SAVEPOINT sp_a;", "ROLLBACK TO SAVEPOINT sp_a;", "RELEASE SAVEPOINT sp_a;",
  // --- 视图 ---
  "CREATE VIEW v1 AS SELECT 1 AS one;",
  "CREATE OR REPLACE VIEW v1 AS SELECT id, username FROM users LIMIT 3;",
  "SELECT * FROM v1;",
  "DESC v1;",
  "SHOW CREATE VIEW v1;",
  "SHOW FULL TABLES;",
  "SHOW TABLE STATUS;",
  "ALTER VIEW v1 AS SELECT id FROM users;",
  "DROP VIEW IF EXISTS v1;",
  // --- 客户端命令 ---
  "HELP SELECT;",
  // --- 备份：MySQL 社区版本身没有，用 1064 + 说明（属于诚实清单） ---
  "BACKUP DATABASE production TO DISK='x.bak';",
  "MYSQLDUMP production;",
  // --- 明确不支持（预期 1235 + 解释） ---
  "CREATE PROCEDURE pp() BEGIN SELECT 1; END;",
  "DROP PROCEDURE pp;",
  "CREATE TRIGGER tg AFTER INSERT ON users FOR EACH ROW SET @a=1;",
  "CALL pp();",
  "GRANT SELECT ON *.* TO 'u'@'%';",
  "PREPARE s FROM 'SELECT 1';",
  "SELECT * INTO OUTFILE '/tmp/a.csv' FROM users;",
  "LOAD DATA INFILE '/tmp/a.csv' INTO TABLE users;",
  "ALTER TABLE users ADD PRIMARY KEY (id);",
  "ALTER TABLE users DROP PRIMARY KEY;",
  "ALTER TABLE users ENGINE=MyISAM;",
  "ALTER TABLE users ADD CONSTRAINT c FOREIGN KEY (vip_level) REFERENCES users(id);",
  "ALTER TABLE users DROP FOREIGN KEY c;",
  "ALTER TABLE users ADD FULLTEXT INDEX ft (email);",
  "CREATE TABLE part1 (id int, d date) PARTITION BY RANGE (YEAR(d)) (PARTITION p0 VALUES LESS THAN (2020));",
  "SELECT * FROM users WHERE MATCH(email) AGAINST('x');",
  "UPDATE users u JOIN orders o ON o.user_id=u.id SET u.balance = u.balance WHERE o.id=1;",
  "DELETE u FROM users u JOIN orders o ON o.user_id=u.id WHERE o.id = -1;",
  "SELECT city, COUNT(*) c FROM users GROUP BY city WITH ROLLUP;",
  "XA START 'x';",
  "INSTALL PLUGIN p SONAME 'x.so';",
  "HANDLER users OPEN;"
];

/** 这些在真实 MySQL 里就不是合法 SQL（或社区版没有），因此报 1064 是正确的 */
const EXPECTED_1064 = ['BACKUP DATABASE', 'MYSQLDUMP'];
/** 这些在真实 MySQL 里合法、但本模拟器没实现，应当报 1235 且带解释 */
const EXPECTED_1235 = [
  'CREATE PROCEDURE', 'DROP PROCEDURE', 'CREATE TRIGGER', 'CALL pp', 'GRANT SELECT',
  'PREPARE s FROM', 'SELECT * INTO OUTFILE', 'LOAD DATA INFILE',
  'ALTER TABLE users ADD PRIMARY KEY', 'ALTER TABLE users DROP PRIMARY KEY',
  'ALTER TABLE users ENGINE=', 'ALTER TABLE users ADD CONSTRAINT', 'ALTER TABLE users DROP FOREIGN KEY',
  'ALTER TABLE users ADD FULLTEXT', 'CREATE TABLE part1', "SELECT * FROM users WHERE MATCH",
  'UPDATE users u JOIN', 'DELETE u FROM', 'SELECT city, COUNT(*) c FROM users GROUP BY city WITH ROLLUP',
  "XA START", 'INSTALL PLUGIN', 'HANDLER users OPEN'
];

function prefixHit(list, c) { return list.some(k => c.startsWith(k)); }

(async () => {
  const S = await SQL({ wasmBinary: wasm });
  const eng = new Core.Engine(S, Core.seedAll);
  eng.init();
  const ok = [], honest = [], other = [], syntax = [], noNote = [];
  for (const c of CASES) {
    let blocks;
    try { blocks = eng.run(c); }
    catch (e) { syntax.push([c, '未捕获异常: ' + e.message]); continue; }
    const errs = blocks.filter(b => b.kind === 'err').map(b => b.text);
    if (!errs.length) { ok.push(c); continue; }
    const hasNote = blocks.some(b => b.kind === 'note');
    const is1064 = errs.some(t => /ERROR 1064/.test(t));
    const is1235 = errs.some(t => /ERROR 1235/.test(t));
    if (is1064) {
      (prefixHit(EXPECTED_1064, c) ? honest : syntax).push([c, errs.join(' | ')]);
      continue;
    }
    if (is1235) {
      honest.push([c, errs[0]]);
      // 1235 必须带解释性 note，否则等于只说了"不支持"却不说为什么
      if (!hasNote || !prefixHit(EXPECTED_1235, c)) noNote.push([c, hasNote ? '（不在预期清单里）' : '缺少解释性 note']);
      continue;
    }
    other.push([c, errs.join(' | ')]);
  }

  const lines = [];
  lines.push('通过 ' + ok.length + ' / 诚实不支持(1235) ' + honest.length +
    ' / 预期 1064 ' + honest.filter(h => /1064/.test(h[1])).length +
    ' / 其它报错 ' + other.length + ' / 意外语法错 ' + syntax.length);
  lines.push('');
  lines.push('=== 意外报 1064 的语句（真实 MySQL 里合法 → 必须修）===');
  if (!syntax.length) lines.push('  无 ✅');
  syntax.forEach(([c, m]) => lines.push('  ✗ ' + c + '\n      ' + m));
  lines.push('');
  lines.push('=== 1235 但缺解释性 note / 不在预期清单（诚实性检查）===');
  if (!noNote.length) lines.push('  无 ✅');
  noNote.forEach(([c, m]) => lines.push('  ! ' + c + '\n      ' + m));
  lines.push('');
  lines.push('=== 其它报错（数据相关或需人工确认）===');
  if (!other.length) lines.push('  无');
  other.forEach(([c, m]) => lines.push('  · ' + c + '\n      ' + m));
  lines.push('');
  lines.push('=== 诚实不支持的语句（报错码正确且有说明）===');
  honest.forEach(([c, m]) => lines.push('  · ' + c));

  const out = lines.join('\n');
  fs.writeFileSync(path.join(__dirname, '_gap_report.txt'), out, 'utf8');
  console.log(out.split('\n').slice(0, 4).join('\n'));
  if (syntax.length || noNote.length) process.exitCode = 1;
})();
