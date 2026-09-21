/* 覆盖度普查：批量跑常见 MySQL 语句，列出仍会报 1064（语法错误）的那些 */
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
  "SHOW GLOBAL VARIABLES LIKE 'port';", "SHOW STATUS;", "SHOW ENGINES;", "SHOW PROCESSLIST;",
  "SHOW WARNINGS;", "SHOW ERRORS;", "SHOW GRANTS;", "SHOW GRANTS FOR 'root'@'localhost';",
  "DESC users;", "DESCRIBE users;", "EXPLAIN users;", "SELECT DATABASE();", "SELECT VERSION();",
  "status;", "\\s",
  // --- DDL ---
  "CREATE DATABASE IF NOT EXISTS probe_db;", "ALTER DATABASE probe_db CHARACTER SET utf8mb4;",
  "USE probe_db;",
  "CREATE TABLE IF NOT EXISTS p1 (id int(11) NOT NULL AUTO_INCREMENT, v varchar(10), PRIMARY KEY(id));",
  "CREATE TABLE p2 LIKE p1;",
  "CREATE TABLE p3 AS SELECT * FROM p1;",
  "CREATE TABLE p4 (id int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;",
  "ALTER TABLE p1 ADD COLUMN note varchar(20) NOT NULL DEFAULT '';",
  "ALTER TABLE p1 MODIFY COLUMN v varchar(50) NOT NULL;",
  "ALTER TABLE p1 CHANGE COLUMN v v2 varchar(50);",
  "ALTER TABLE p1 ADD INDEX idx_v (v2);",
  "ALTER TABLE p1 ADD UNIQUE KEY uk_x (note);",
  "ALTER TABLE p1 ADD PRIMARY KEY (id);",
  "ALTER TABLE p1 DROP INDEX idx_v;",
  "ALTER TABLE p1 DROP COLUMN note;",
  "ALTER TABLE p1 RENAME TO p1_new;",
  "ALTER TABLE p1_new RENAME COLUMN v2 TO v3;",
  "CREATE INDEX idx_p ON p1_new (v3);",
  "CREATE UNIQUE INDEX uk_p ON p1_new (v3);",
  "DROP INDEX idx_p ON p1_new;",
  "SHOW INDEX FROM p1_new;",
  "RENAME TABLE p1_new TO p1;",
  "CHECK TABLE p1;", "OPTIMIZE TABLE p1;", "ANALYZE TABLE p1;", "REPAIR TABLE p1;",
  "LOCK TABLES p1 READ;", "UNLOCK TABLES;",
  "DROP TABLE IF EXISTS p1, p2, p3, p4;", "DROP DATABASE IF EXISTS probe_db;",
  // --- DML ---
  "USE production;",
  "INSERT INTO users (username,email) VALUES ('probe','probe@x.com');",
  "INSERT IGNORE INTO users (username,email) VALUES ('probe','probe@x.com');",
  "INSERT INTO users (username,email) SELECT username,email FROM users WHERE id=1;",
  "INSERT INTO users (username,email) VALUES ('dup','dup@x.com') ON DUPLICATE KEY UPDATE email='dup@x.com';",
  "REPLACE INTO users (id,username,email) VALUES (999,'rep','rep@x.com');",
  "UPDATE users SET balance = balance WHERE id = 1 LIMIT 1;",
  "UPDATE users u JOIN orders o ON o.user_id=u.id SET u.balance = u.balance WHERE o.id=1;",
  "DELETE FROM users WHERE username='probe' LIMIT 1;",
  "DELETE u FROM users u JOIN orders o ON o.user_id=u.id WHERE o.id = -1;",
  // --- 查询 ---
  "SELECT 1;", "SELECT 1 AS a, 2 AS b;", "SELECT * FROM users LIMIT 2 OFFSET 1;",
  "SELECT DISTINCT city FROM users;", "SELECT city, COUNT(*) c FROM users GROUP BY city HAVING c > 1;",
  "SELECT city, COUNT(*) c FROM users GROUP BY city WITH ROLLUP;",
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
  "SELECT * FROM users WHERE id = 1 FOR UPDATE;",
  "SELECT * FROM users LIMIT 1\\G",
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
  // --- 备份：MySQL 社区版本身没有，用 1064 + 说明（预期报错，属于诚实清单） ---
  "BACKUP DATABASE production TO DISK='x.bak';",
  "MYSQLDUMP production;",
  // --- 明确不支持（预期报错，属于诚实清单） ---
  "CREATE PROCEDURE pp() BEGIN SELECT 1; END;",
  "CREATE TRIGGER tg AFTER INSERT ON users FOR EACH ROW SET @a=1;",
  "GRANT SELECT ON *.* TO 'u'@'%';",
  "PREPARE s FROM 'SELECT 1';",
  "LOCK TABLES users WRITE;",
  "SELECT * INTO OUTFILE '/tmp/a.csv' FROM users;",
  "LOAD DATA INFILE '/tmp/a.csv' INTO TABLE users;"
];

const EXPECTED_UNSUPPORTED = [
  'BACKUP DATABASE', 'MYSQLDUMP',
  'CREATE PROCEDURE', 'CREATE TRIGGER', 'GRANT SELECT',
  'PREPARE s FROM', 'SELECT * INTO OUTFILE', 'LOAD DATA INFILE',
  'ON DUPLICATE KEY UPDATE', 'LOCK TABLES users WRITE'
];

(async () => {
  const S = await SQL({ wasmBinary: wasm });
  const eng = new Core.Engine(S, Core.seedAll);
  eng.init();
  const syntax = [], other = [], ok = [];
  for (const c of CASES) {
    let blocks;
    try { blocks = eng.run(c); }
    catch (e) { syntax.push([c, '未捕获异常: ' + e.message]); continue; }
    const errs = blocks.filter(b => b.kind === 'err').map(b => b.text);
    if (!errs.length) { ok.push(c); continue; }
    const isSyntax = errs.some(t => /ERROR 1064/.test(t));
    const expected = EXPECTED_UNSUPPORTED.some(k => c.startsWith(k));
    (isSyntax && !expected ? syntax : other).push([c, errs.join(' | ')]);
  }
  const lines = [];
  lines.push('通过 ' + ok.length + ' / 构造错误（预期不支持）' + other.length + ' / 意外语法错 ' + syntax.length);
  lines.push('');
  lines.push('=== 意外报 1064 的语句（需要补） ===');
  if (!syntax.length) lines.push('  无');
  syntax.forEach(([c, m]) => lines.push('  ✗ ' + c + '\n      ' + m));
  lines.push('');
  lines.push('=== 其他报错（可能是预期不支持，请人工确认） ===');
  other.forEach(([c, m]) => lines.push('  · ' + c + '\n      ' + m));
  const out = lines.join('\n');
  fs.writeFileSync(path.join(__dirname, '_gap_report.txt'), out, 'utf8');
  console.log(out);
})();
