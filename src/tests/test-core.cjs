/* 核心层回归测试：在 Node 中跑通全部语句、错误码与练习题答案 */
const path = require('path');
const { execSync } = require('child_process');

const SQL = require(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.js'));
const fs = require('fs');
const wasm = fs.readFileSync(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.wasm'));
const Core = require('../mysql-core.js');

const lines = [];
function head(t) { lines.push('\n' + '='.repeat(78) + '\n## ' + t + '\n' + '='.repeat(78)); }
function show(label, input) {
  lines.push('\n--- ' + label + '  ▸ ' + JSON.stringify(input));
  try {
    const blocks = eng.run(input);
    blocks.forEach(b => lines.push('[' + b.kind + '] ' + b.text));
  } catch (e) {
    lines.push('[!! 未捕获异常] ' + e.stack);
    failures.push(label + ' 抛出异常: ' + e.message);
  }
}

const failures = [];
let eng;

(async () => {
  await SQL({ wasmBinary: wasm }).then(S => {
    const engine = new Core.Engine(S, Core.seedAll);
    engine.init();
    eng = engine;

    head('1. 登录横幅');
    lines.push(eng.banner());

    head('2. 数据库与表元数据');
    show('列出数据库', 'SHOW DATABASES;');
    show('切库', 'USE production;');
    show('列出表', 'SHOW TABLES;');
    show('LIKE 过滤表', "SHOW TABLES LIKE 'user%';");
    show('表结构 DESC', 'DESC users;');
    show('DESCRIBE 等价写法', 'describe products;');
    show('SHOW COLUMNS', 'SHOW COLUMNS FROM orders;');
    show('SHOW CREATE TABLE', 'SHOW CREATE TABLE orders;');
    show('SHOW INDEX', 'SHOW INDEX FROM users;');

    head('3. 查询与排版');
    show('星号查询', 'SELECT * FROM users;');
    show('指定列 + 排序 + LIMIT', 'SELECT username, balance, vip_level FROM users ORDER BY balance DESC LIMIT 3;');
    show('MySQL 的 LIMIT a,b 写法', 'SELECT id, username FROM users LIMIT 2, 3;');
    show('聚合与别名', 'SELECT COUNT(*) AS total, ROUND(AVG(balance), 2) AS avg_balance FROM users;');
    show('分组统计', 'SELECT category, COUNT(*) AS cnt, ROUND(AVG(price),2) AS avg_price FROM products GROUP BY category ORDER BY cnt DESC;');
    show('三表 JOIN', 'SELECT o.id, u.username, p.name, o.quantity, o.total, o.status FROM orders o JOIN users u ON u.id = o.user_id JOIN products p ON p.id = o.product_id ORDER BY o.id DESC LIMIT 5;');
    show('LEFT JOIN 找 NULL', 'SELECT u.username FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE o.id IS NULL;');
    show('SUM 排行', 'SELECT u.username, SUM(o.total) AS spent FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.username ORDER BY spent DESC LIMIT 5;');
    show('子查询', 'SELECT name, price FROM products WHERE price > (SELECT AVG(price) FROM products);');
    show('窗口函数 RANK', 'SELECT username, balance, RANK() OVER (ORDER BY balance DESC) AS rk FROM users;');
    show('GROUP_CONCAT + SEPARATOR', "SELECT u.username, GROUP_CONCAT(p.name SEPARATOR ', ') AS items FROM users u JOIN orders o ON o.user_id = u.id JOIN products p ON p.id = o.product_id GROUP BY u.id, u.username LIMIT 3;");
    show('中文列值对齐（CJK 宽度）', "SELECT '信创科技公司' AS 公司, 'KP100D' AS 型号, 5999.00 AS 价格 UNION ALL SELECT '测试','A',1;");
    show('空结果集', 'SELECT * FROM users WHERE id = 9999;');
    show('纵向输出 \\G', 'SELECT * FROM users WHERE id = 1\\G');

    head('4. MySQL 函数兼容');
    show('版本/库/用户', 'SELECT VERSION() AS v, DATABASE() AS db, USER() AS u, CONNECTION_ID() AS cid;');
    show('时间函数', 'SELECT NOW() AS now, CURDATE() AS d, CURTIME() AS t, CURRENT_TIMESTAMP AS ct;');
    show('CONCAT / IF / IFNULL', "SELECT CONCAT('a','b','c') AS cat, IF(1=1,'yes','no') AS i, IFNULL(NULL,'默认') AS ifn;");
    show('CONCAT_WS 自动跳过 NULL', "SELECT CONCAT_WS('-', '深圳', NULL, '南山') AS x;");
    show('LEFT / RIGHT / SUBSTRING / CHAR_LENGTH', "SELECT LEFT('abcdef',3) AS l, RIGHT('abcdef',2) AS r, SUBSTRING('abcdef',2,3) AS sub, CHAR_LENGTH('数据库') AS cl;");
    show('大小写 / LOCATE / LPAD', "SELECT UCASE('abc') AS up, LCASE('ABC') AS lo, LOCATE('ww','数据库') AS p, LPAD('7',3,'0') AS pad;");
    show('日期格式化', "SELECT DATE_FORMAT('2026-03-12 09:24:11','%Y年%m月%d日 %H:%i:%s') AS d, DATE_FORMAT('2026-03-12','%W') AS w;");
    show('时间戳互转', "SELECT UNIX_TIMESTAMP('2026-03-12 09:24:11') AS ts, FROM_UNIXTIME(1773278651) AS back;");
    show('GREATEST / LEAST / UUID', "SELECT GREATEST(1,9,5) AS g, LEAST(1,9,5) AS l, UUID() AS uuid;");
    show('ROUND / 数值格式', 'SELECT ROUND(1234.5678, 2) AS a, ROUND(1234.5678) AS b;');

    head('5. 写操作');
    show('INSERT', "INSERT INTO users (username,email,city,vip_level,balance) VALUES ('ceshi','ceshi@example.com','深圳',1,999.99);");
    show('验证写入', "SELECT id, username, city, balance FROM users WHERE username='ceshi';");
    show('INSERT IGNORE 语义', "INSERT IGNORE INTO users (username,email) VALUES ('zhangsan','dup@example.com');");
    show('UPDATE', "UPDATE users SET balance = balance + 100 WHERE city = '深圳';");
    show('验证 UPDATE 影响行数', "SELECT COUNT(*) AS shenzhen_cnt FROM users WHERE city='深圳';");
    show('DELETE', "DELETE FROM users WHERE username = 'ceshi';");
    show('REPLACE 语义', "REPLACE INTO products (id,name,category,price,stock,on_sale) VALUES (1,'KP100D 信创台式机','整机',6199.00,110,1);");
    show('TRUNCATE 转译', 'CREATE TABLE tmp_trunc (id int(11) NOT NULL AUTO_INCREMENT, v varchar(10), PRIMARY KEY(id));');
    show('插入两行再 TRUNCATE', "INSERT INTO tmp_trunc (v) VALUES ('a'),('b');");

    head('6. 建表（MySQL 语法 → 自动转译）');
    show('建表：自增主键 + ENGINE + CHARSET + 注释 + 索引', "CREATE TABLE books (\n  id int(11) NOT NULL AUTO_INCREMENT COMMENT '主键',\n  title varchar(100) NOT NULL,\n  author varchar(50) DEFAULT NULL,\n  price decimal(8,2) NOT NULL DEFAULT '0.00',\n  stock int(11) UNSIGNED NOT NULL DEFAULT 0,\n  status enum('on','off') NOT NULL DEFAULT 'on',\n  published_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (id),\n  UNIQUE KEY uk_title (title),\n  KEY idx_author (author)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='图书表';");
    show('看转译后的表结构', 'DESC books;');
    show('自增是否生效', "INSERT INTO books (title, author, price) VALUES ('信创之路','吕某',58.00),('国产化实践','佚名',72.50);");
    show('查询验证自增与默认值', 'SELECT id, title, price, status, published_at FROM books;');
    show('唯一键冲突报错', "INSERT INTO books (title) VALUES ('信创之路');");
    show('SHOW CREATE TABLE 回显 MySQL 原句', 'SHOW CREATE TABLE books;');
    show('SHOW INDEX 回显索引', 'SHOW INDEX FROM books;');

    head('7. 错误码映射');
    show('1146 表不存在', 'SELECT * FROM t_nothing;');
    show('1054 列不存在', 'SELECT zzz_col FROM users;');
    show('1064 语法错误', 'SELEC * FROM users;');
    show('1064 语句不完整', 'SELECT * FROM;');
    show('1049 库不存在', 'USE no_such_db;');
    show('1050 表已存在', 'CREATE TABLE users (id int);');
    show('1048 非空约束', 'INSERT INTO products (name,category,price) VALUES (NULL,\'x\',1);');
    show('1046 未选库', 'USE information_schema;');

    head('8. 库管理');
    show('建库', 'CREATE DATABASE shop;');
    show('建库已存在', 'CREATE DATABASE shop;');
    show('IF NOT EXISTS 建库', 'CREATE DATABASE IF NOT EXISTS shop;');
    show('新库是空的', 'SHOW TABLES FROM shop;');
    show('删库', 'DROP DATABASE shop;');
    show('删不存在的库', 'DROP DATABASE shop;');

    head('9. 系统视图与状态');
    show('SHOW VARIABLES LIKE', "SHOW VARIABLES LIKE 'version%';");
    show('SHOW STATUS', 'SHOW STATUS;');
    show('SHOW ENGINES', 'SHOW ENGINES;');
    show('SHOW PROCESSLIST', 'SHOW PROCESSLIST;');
    show('mysql 系统库可读', 'SELECT `Host`, `User`, `plugin` FROM mysql.`user`;');
    show('status 客户端命令', 'status;');
    show('SHOW WARNINGS 空集', 'SHOW WARNINGS;');

    head('10. 注释与多语句');
    show('带注释与多语句混合', "-- 这是注释\nSELECT COUNT(*) AS n FROM users; /* 块注释 */ # 井号注释\nSHOW DATABASES;");
    show('引号内的分号不切分', "SELECT '已结束;仍继续' AS s, 1 AS n;");
    show('反引号标识符', 'SELECT `username`, `balance` FROM `users` LIMIT 2;');
    show('未知数据库的表（带库名前缀）', 'SELECT * FROM mysql.`user` LIMIT 1;');

    head('11. 全部练习题标准答案逐条执行');
    let okCount = 0, badCount = 0;
    Core.EXERCISES.forEach((ex, i) => {
      eng.current = 'production';
      // 每题都从干净库开始，避免前题副作用影响
      eng.init();
      let bad = [];
      try {
        const blocks = eng.run(ex.answer);
        blocks.forEach(b => { if (b.kind === 'err') bad.push(b.text); });
      } catch (e) { bad.push('异常: ' + e.message); }
      if (ex.expectError) {
        // 该题以「观察报错」为目的，出现错误即为通过，但错误码须正确
        if (bad.length === 1 && /ERROR 1146/.test(bad[0])) {
          okCount++;
          lines.push('  ✓ #' + (i + 1) + ' ' + ex.title + '（预期报错）→ ' + bad[0].slice(0, 60));
        } else {
          badCount++;
          failures.push('练习题 #' + (i + 1) + ' 「' + ex.title + '」预期 ERROR 1146 但得到: ' + (bad.join(' | ') || '无报错'));
        }
        return;
      }
      if (bad.length) {
        badCount++;
        failures.push('练习题 #' + (i + 1) + ' 「' + ex.title + '」执行报错: ' + bad.join(' | ') + '\n     答案: ' + JSON.stringify(ex.answer));
        lines.push('  ✗ #' + (i + 1) + ' ' + ex.title + '  → ' + bad.join(' | '));
      } else {
        okCount++;
        const first = (eng.run('SELECT 1;') , '');
      }
    });
    lines.push('\n  练习题执行结果：成功 ' + okCount + ' / 失败 ' + badCount + '（共 ' + Core.EXERCISES.length + ' 题）');

    head('12. 已知限制的诚实记录（供「语法差异」面板使用）');
    show('双引号在 SQLite 下是标识符（MySQL 默认是字符串）', 'SELECT "hello" AS a;');
    show('|| 语义不同：SQLite 是字符串连接，MySQL 默认是 OR', "SELECT 'a' || 'b' AS x;");
    show('ON DUPLICATE KEY UPDATE 不支持', "INSERT INTO products (id,name,category,price) VALUES (1,'x','y',1) ON DUPLICATE KEY UPDATE price=1;");
    show('存储过程 / 触发器暂不支持', 'CREATE PROCEDURE p1() BEGIN SELECT 1; END;');

    head('13. 事务 / 变量 / 索引维护（本轮修复项回归）');
    eng.init();   // 干净状态
    const newFail = [];
    function scalar(sql) {
      const blocks = eng.run(sql);
      const rows = blocks.map(b => b.text).join('\n')
        .split('\n').filter(l => l.trim().startsWith('|'));
      if (!rows.length) return null;
      return rows[rows.length - 1].split('|').slice(1, -1).map(s => s.trim())[0];
    }
    function chk(label, fn) {
      let bad = null;
      try { bad = fn(); } catch (e) { bad = '异常: ' + e.message; }
      if (bad) { newFail.push(label + ' → ' + bad); lines.push('  ✗ ' + label + '  → ' + bad); }
      else lines.push('  ✓ ' + label);
    }
    function run1(sql) {
      const blocks = eng.run(sql);
      const errs = blocks.filter(b => b.kind === 'err').map(b => b.text);
      return { blocks, errs };
    }

    // ---- 事务 ----
    chk('START TRANSACTION 不再报 1064', () => {
      const r = run1('START TRANSACTION;');
      if (r.errs.length) return r.errs.join(' | ');
      if (!/Query OK, 0 rows affected/.test(r.blocks.map(b => b.text).join('\n'))) return '未输出 Query OK';
      eng.run('COMMIT;');   // 收尾，避免影响后续用例
      return null;
    });
    eng.run('DROP TABLE IF EXISTS tx_demo;');
    eng.run('CREATE TABLE tx_demo (id int(11) NOT NULL AUTO_INCREMENT, name varchar(20), PRIMARY KEY (id));');
    eng.run("INSERT INTO tx_demo (name) VALUES ('keep');");
    chk('BEGIN 内插入的行被 ROLLBACK 真的回滚（2 → 1 行）', () => {
      const r0 = run1('BEGIN;');
      if (r0.errs.length) return r0.errs.join(' | ');
      eng.run("INSERT INTO tx_demo (name) VALUES ('temp');");
      if (scalar('SELECT COUNT(*) AS n FROM tx_demo;') !== '2') return '事务内计数应为 2';
      const r = run1('ROLLBACK;');
      if (r.errs.length) return r.errs.join(' | ');
      const after = scalar('SELECT COUNT(*) AS n FROM tx_demo;');
      return after === '1' ? null : '回滚后计数应为 1，实为 ' + after;
    });
    chk('START TRANSACTION ... COMMIT 提交生效', () => {
      eng.run('START TRANSACTION;');
      eng.run("INSERT INTO tx_demo (name) VALUES ('committed');");
      const r = run1('COMMIT;');
      if (r.errs.length) return r.errs.join(' | ');
      const n = scalar('SELECT COUNT(*) AS n FROM tx_demo;');
      return n === '2' ? null : '提交后计数应为 2，实为 ' + n;
    });
    chk('无活动事务时 COMMIT 不报错', () => {
      const r = run1('COMMIT;');
      return r.errs.length ? r.errs.join(' | ') : null;
    });
    chk('BEGIN WORK / COMMIT WORK 写法可用', () => {
      const a = run1('BEGIN WORK;'); if (a.errs.length) return a.errs.join(' | ');
      const b = run1('COMMIT WORK;'); return b.errs.length ? b.errs.join(' | ') : null;
    });
    chk('SAVEPOINT / ROLLBACK TO / RELEASE 可用', () => {
      eng.run('BEGIN;');
      eng.run("INSERT INTO tx_demo (name) VALUES ('sp');");
      const a = run1('SAVEPOINT sp1;'); if (a.errs.length) return 'SAVEPOINT: ' + a.errs.join(' | ');
      eng.run("INSERT INTO tx_demo (name) VALUES ('sp2');");
      const b = run1('ROLLBACK TO SAVEPOINT sp1;'); if (b.errs.length) return 'ROLLBACK TO: ' + b.errs.join(' | ');
      const n = scalar('SELECT COUNT(*) AS n FROM tx_demo;');
      if (n !== '3') return 'ROLLBACK TO 后应为 3 行，实为 ' + n;
      const c = run1('RELEASE SAVEPOINT sp1;'); if (c.errs.length) return 'RELEASE: ' + c.errs.join(' | ');
      const d = run1('COMMIT;'); return d.errs.length ? d.errs.join(' | ') : null;
    });
    chk('START TRANSACTION READ ONLY 可用', () => {
      const r = run1('START TRANSACTION READ ONLY;');
      if (r.errs.length) return r.errs.join(' | ');
      eng.run('COMMIT;');
      return null;
    });

    // ---- SET 与变量 ----
    chk('SET @x = 41 后 SELECT @x 返回 41', () => {
      const r = run1('SET @x = 41;'); if (r.errs.length) return r.errs.join(' | ');
      const v = scalar('SELECT @x;');
      return v === '41' ? null : '得到 ' + JSON.stringify(v);
    });
    chk('变量参与运算（@x + 1 = 42）', () => {
      const v = scalar('SELECT @x + 1 AS n;');
      return v === '42' ? null : '得到 ' + JSON.stringify(v);
    });
    chk('字符串变量与引号内的 @ 不被误替换', () => {
      eng.run("SET @mail = 'a@b.com';");
      const got = scalar('SELECT @mail;');
      if (got !== 'a@b.com') return '变量回读得到 ' + JSON.stringify(got);
      const lit = scalar("SELECT 'x@y.z' AS s;");
      return lit === 'x@y.z' ? null : '字面量被改写成 ' + JSON.stringify(lit);
    });
    chk('未赋值用户变量返回 NULL', () => {
      const v = scalar('SELECT @never_assigned;');
      return v === 'NULL' ? null : '得到 ' + JSON.stringify(v);
    });
    chk('@@version / @@version_comment 可查', () => {
      const v = scalar('SELECT @@version;');
      if (!/8\.0\.36/.test(v || '')) return '@@version = ' + JSON.stringify(v);
      const c = scalar('SELECT @@version_comment;');
      return /Simulator/.test(c || '') ? null : '@@version_comment = ' + JSON.stringify(c);
    });
    chk('@@hostname / @@port / @@autocommit 可查', () => {
      const h = scalar('SELECT @@hostname;');
      const p = scalar('SELECT @@port;');
      const a = scalar('SELECT @@autocommit;');
      if (h !== 'localhost') return '@@hostname = ' + JSON.stringify(h);
      if (p !== '3306') return '@@port = ' + JSON.stringify(p);
      return a === 'ON' ? null : '@@autocommit = ' + JSON.stringify(a);
    });
    chk('未知系统变量报 1193', () => {
      const r = run1('SELECT @@no_such_variable_at_all;');
      if (!r.errs.length) return '未报错';
      return /ERROR 1193/.test(r.errs[0]) ? null : r.errs[0];
    });
    chk('SET NAMES / SET SESSION / SET autocommit 可用', () => {
      for (const s of ['SET NAMES utf8mb4;', 'SET SESSION autocommit = 0;', 'SET autocommit = 1;',
        'SET sql_mode = \'STRICT_TRANS_TABLES\';', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED;']) {
        const r = run1(s);
        if (r.errs.length) return s + ' → ' + r.errs.join(' | ');
      }
      return null;
    });
    chk('SET 修改后的系统变量可回读', () => {
      eng.run("SET sql_mode = 'ONLY_FULL_GROUP_BY';");
      const v = scalar('SELECT @@sql_mode;');
      return v === 'ONLY_FULL_GROUP_BY' ? null : '得到 ' + JSON.stringify(v);
    });

    // ---- 索引维护与 EXPLAIN ----
    chk('ALTER TABLE ADD INDEX 可用', () => {
      const r = run1('ALTER TABLE tx_demo ADD INDEX idx_name (name);');
      return r.errs.length ? r.errs.join(' | ') : null;
    });
    chk('SHOW INDEX 里能看到刚加的索引（元数据同步）', () => {
      const t = eng.run('SHOW INDEX FROM tx_demo;').map(b => b.text).join('\n');
      return /idx_name/.test(t) ? null : 'SHOW INDEX 未包含 idx_name';
    });
    chk('ALTER TABLE ADD UNIQUE INDEX 唯一性生效', () => {
      const r = run1('ALTER TABLE tx_demo ADD UNIQUE KEY uk_name (name);');
      if (r.errs.length) return r.errs.join(' | ');
      const dup = run1("INSERT INTO tx_demo (name) VALUES ('keep');");
      return /ERROR 1062/.test(dup.errs[0] || '') ? null : '唯一约束未生效：' + JSON.stringify(dup.errs);
    });
    chk('DROP INDEX ... ON 与 ALTER TABLE DROP INDEX 可用', () => {
      const a = run1('DROP INDEX idx_name ON tx_demo;');
      if (a.errs.length) return 'DROP INDEX ... ON → ' + a.errs.join(' | ');
      if (/idx_name/.test(eng.run('SHOW INDEX FROM tx_demo;').map(b => b.text).join('\n'))) return 'DROP 后 SHOW INDEX 仍残留 idx_name';
      const b = run1('ALTER TABLE tx_demo DROP INDEX uk_name;');
      return b.errs.length ? 'ALTER TABLE DROP INDEX → ' + b.errs.join(' | ') : null;
    });
    chk('DML 影响行数回显正确（原先恒为 0）', () => {
      const join = r => r.blocks.map(b => b.text).join(' | ');
      const a = run1("INSERT INTO tx_demo (name) VALUES ('m1'),('m2');");
      if (!/Query OK, 2 rows affected/.test(join(a))) return '多行 INSERT：' + join(a);
      const b = run1("UPDATE tx_demo SET name = CONCAT(name,'x');");
      if (!/Query OK, 5 rows affected/.test(join(b))) return 'UPDATE：' + join(b);
      const c = run1('DELETE FROM tx_demo;');
      if (!/Query OK, 5 rows affected/.test(join(c))) return 'DELETE：' + join(c);
      return null;
    });
    chk('EXPLAIN SELECT 可用且有输出', () => {
      const r = run1('EXPLAIN SELECT * FROM tx_demo;');
      if (r.errs.length) return r.errs.join(' | ');
      return /SCAN|SEARCH|explain|id/.test(r.blocks.map(b => b.text).join('\n')) ? null : '无执行计划输出';
    });
    chk('SELECT ... FOR UPDATE 去掉锁语义后仍可执行', () => {
      const r = run1('SELECT * FROM tx_demo FOR UPDATE;');
      return r.errs.length ? r.errs.join(' | ') : null;
    });

    if (newFail.length) newFail.forEach(f => failures.push('[第13节] ' + f));
    lines.push('\n  第 13 节结果：' + (newFail.length ? '失败 ' + newFail.length + ' 项' : '全部通过'));

    head('14. 本轮补齐的语句（覆盖度普查后的回归）');
    eng.init();
    const f14 = [];
    function chk14(label, fn) {
      let bad = null;
      try { bad = fn(); } catch (e) { bad = '异常: ' + e.message; }
      if (bad) { f14.push(label + ' → ' + bad); lines.push('  ✗ ' + label + '  → ' + bad); }
      else lines.push('  ✓ ' + label);
    }
    function errsOf(sql) { return eng.run(sql).filter(b => b.kind === 'err').map(b => b.text); }
    function textOf(sql) { return eng.run(sql).map(b => b.text).join('\n'); }

    eng.run('DROP TABLE IF EXISTS t14;');
    eng.run('CREATE TABLE t14 (id int(11) NOT NULL AUTO_INCREMENT, name varchar(20) NOT NULL, cnt int(11) DEFAULT 0, PRIMARY KEY (id));');

    chk14('INSERT ... ON DUPLICATE KEY UPDATE 生效（先插入再更新）', () => {
      const a = errsOf("INSERT INTO t14 (id,name,cnt) VALUES (1,'a',1);");
      if (a.length) return '首次插入：' + a.join(' | ');
      const b = errsOf("INSERT INTO t14 (id,name,cnt) VALUES (1,'b',5) ON DUPLICATE KEY UPDATE name='b', cnt=cnt+5;");
      if (b.length) return 'upsert：' + b.join(' | ');
      const row = textOf('SELECT name, cnt FROM t14 WHERE id=1;');
      if (!/\bb\b/.test(row)) return 'name 未更新：' + row;
      if (!/\b6\b/.test(row)) return 'cnt 未累加为 6：' + row;
      return null;
    });

    chk14('UPDATE ... LIMIT / DELETE ... LIMIT 生效', () => {
      eng.run("INSERT INTO t14 (id,name,cnt) VALUES (2,'c',0),(3,'d',0),(4,'e',0);");
      const u = errsOf("UPDATE t14 SET cnt = 9 WHERE cnt = 0 LIMIT 1;");
      if (u.length) return 'UPDATE LIMIT：' + u.join(' | ');
      const n1 = textOf('SELECT COUNT(*) AS n FROM t14 WHERE cnt = 9;');
      if (!/|\s*1\s*|/.test(n1)) return 'UPDATE LIMIT 应只影响 1 行：' + n1;
      const d = errsOf('DELETE FROM t14 WHERE cnt = 0 LIMIT 1;');
      if (d.length) return 'DELETE LIMIT：' + d.join(' | ');
      const n2 = textOf('SELECT COUNT(*) AS n FROM t14 WHERE cnt = 0;');
      if (!/|\s*1\s*|/.test(n2)) return 'DELETE LIMIT 应只删 1 行：' + n2;
      return null;
    });

    chk14('CREATE TABLE ... LIKE 复制结构与索引', () => {
      eng.run('DROP TABLE IF EXISTS t14c;');
      const e = errsOf('CREATE TABLE t14c LIKE t14;');
      if (e.length) return e.join(' | ');
      const d = textOf('DESC t14c;');
      if (!/name/.test(d) || !/cnt/.test(d)) return 'DESC 缺列：' + d;
      const ix = textOf('SHOW INDEX FROM t14c;');
      return /PRIMARY/.test(ix) ? null : '索引未复制：' + ix;
    });

    chk14('ALTER TABLE ADD COLUMN 后 DESC 能看到新列', () => {
      const e = errsOf("ALTER TABLE t14c ADD COLUMN note varchar(30) NOT NULL DEFAULT '';");
      if (e.length) return e.join(' | ');
      const d = textOf('DESC t14c;');
      return /note\s+\|\s+varchar\(30\)/.test(d) ? null : 'DESC 未显示 note varchar(30)：' + d;
    });

    chk14('ALTER TABLE MODIFY / CHANGE COLUMN 改名与改类型', () => {
      const a = errsOf('ALTER TABLE t14c MODIFY COLUMN note varchar(80) NOT NULL;');
      if (a.length) return 'MODIFY：' + a.join(' | ');
      let d = textOf('DESC t14c;');
      if (!/varchar\(80\)/.test(d)) return 'MODIFY 未改类型：' + d;
      const b = errsOf('ALTER TABLE t14c CHANGE COLUMN note remark varchar(80);');
      if (b.length) return 'CHANGE：' + b.join(' | ');
      d = textOf('DESC t14c;');
      if (!/remark/.test(d) || /note/.test(d)) return 'CHANGE 未改名：' + d;
      // 改名后真实可写
      const w = errsOf("INSERT INTO t14c (id,name,cnt,remark) VALUES (1,'x',0,'hello');");
      if (w.length) return '改名后写入失败：' + w.join(' | ');
      const r = textOf("SELECT remark FROM t14c WHERE id=1;");
      return /hello/.test(r) ? null : '读取新列失败：' + r;
    });

    chk14('ALTER TABLE DROP COLUMN 连带摘掉该列上的索引', () => {
      const a = errsOf('ALTER TABLE t14c ADD INDEX idx_remark (remark);');
      if (a.length) return 'ADD INDEX：' + a.join(' | ');
      const b = errsOf('ALTER TABLE t14c DROP COLUMN remark;');
      if (b.length) return 'DROP COLUMN：' + b.join(' | ');
      const d = textOf('DESC t14c;');
      if (/remark/.test(d)) return 'DESC 仍显示 remark：' + d;
      const ix = textOf('SHOW INDEX FROM t14c;');
      return /idx_remark/.test(ix) ? '索引未随之删除：' + ix : null;
    });

    chk14('DROP TABLE a, b, c 一次删多张表', () => {
      eng.run('CREATE TABLE d1 (a int);');
      eng.run('CREATE TABLE d2 (a int);');
      const e = errsOf('DROP TABLE d1, d2;');
      if (e.length) return e.join(' | ');
      const t = textOf('SHOW TABLES;');
      return /\bd1\b|\bd2\b/.test(t) ? '仍有残留：' + t : null;
    });

    chk14('SHOW FULL TABLES / TABLE STATUS / CREATE DATABASE / GRANTS', () => {
      const a = textOf('SHOW FULL TABLES;');
      if (!/Table_type/.test(a) || !/BASE TABLE/.test(a)) return 'FULL TABLES：' + a;
      const b = textOf('SHOW TABLE STATUS;');
      if (!/Row_format/.test(b) || !/InnoDB/.test(b)) return 'TABLE STATUS：' + b;
      const c = textOf('SHOW CREATE DATABASE production;');
      if (!/Create Database/.test(c)) return 'CREATE DATABASE：' + c;
      const d = textOf('SHOW GRANTS;');
      return /GRANT ALL PRIVILEGES/.test(d) ? null : 'GRANTS：' + d;
    });

    chk14('CHECK TABLE 回报 status OK，不存在的表报 1146', () => {
      const a = textOf('CHECK TABLE t14;');
      if (!/status/.test(a) || !/\bOK\b/.test(a)) return 'CHECK TABLE：' + a;
      const b = errsOf('CHECK TABLE no_such_tbl;');
      return /ERROR 1146/.test(b[0] || '') ? null : '缺表未报 1146：' + b.join(' | ');
    });

    chk14('LOCK / UNLOCK TABLES、ALTER DATABASE 放行不报错', () => {
      for (const s of ['LOCK TABLES t14 READ;', 'UNLOCK TABLES;', 'ALTER DATABASE production CHARACTER SET utf8mb4;']) {
        const e = errsOf(s);
        if (e.length) return s + ' → ' + e.join(' | ');
      }
      return null;
    });

    chk14('REGEXP / RLIKE / FIELD() 可用', () => {
      const a = textOf("SELECT '数据库' REGEXP '数' AS r1, 'abc' RLIKE '^a' AS r2;");
      if (!/|\s*1\s*|\s*1\s*|/.test(a)) return 'REGEXP/RLIKE：' + a;
      const b = textOf("SELECT FIELD('b','a','b') AS f;");
      if (!/|\s*2\s*|/.test(b)) return 'FIELD：' + b;
      const c = textOf("SELECT city FROM users ORDER BY FIELD(city,'深圳','上海') DESC LIMIT 2;");
      return /深圳/.test(c) ? null : 'ORDER BY FIELD：' + c;
    });

    chk14('不支持的语句给出 ERROR 1235 + 原因，而不是伪装的 1064', () => {
      const cases = [
        ['GRANT SELECT ON *.* TO \'u\'@\'%\';', 'GRANT'],
        ['PREPARE s FROM \'SELECT 1\';', 'PREPARE'],
        ['SELECT * FROM users GROUP BY city WITH ROLLUP;', 'ROLLUP'],
        ['CREATE PROCEDURE pp() BEGIN SELECT 1; END;', 'PROCEDURE']
      ];
      for (const [sql, kw] of cases) {
        const e = errsOf(sql);
        if (!e.length) return sql + ' 未报错';
        if (!/ERROR 1235/.test(e[0])) return sql + ' → ' + e[0];
        if (!/模拟器暂不支持/.test(e[0])) return sql + ' → ' + e[0];
      }
      // 存储过程体不应被分号拆成多条
      const blocks = eng.run('CREATE PROCEDURE pp() BEGIN SELECT 1; END;');
      const errsOnly = blocks.filter(b => b.kind === 'err');
      return errsOnly.length === 1 ? null : '例程体被拆句，产生了 ' + errsOnly.length + ' 个错误';
    });

    if (f14.length) f14.forEach(f => failures.push('[第14节] ' + f));
    lines.push('\n  第 14 节结果：' + (f14.length ? '失败 ' + f14.length + ' 项' : '全部通过'));

    lines.push('\n' + '#'.repeat(78));
    lines.push('## 汇总');
    lines.push('#'.repeat(78));
    if (failures.length) {
      lines.push('❌ 发现 ' + failures.length + ' 个问题：');
      failures.forEach((f, i) => lines.push('  ' + (i + 1) + '. ' + f));
    } else {
      lines.push('✅ 全部用例通过，无未捕获异常、无练习题执行失败。');
    }

    fs.writeFileSync(path.join(__dirname, '_test_report.txt'), lines.join('\n'), 'utf8');
    console.log('报告已生成: _test_report.txt  （failures=' + failures.length + '）');
  });
})();
