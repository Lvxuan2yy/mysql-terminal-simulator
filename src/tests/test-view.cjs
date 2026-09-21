/* 视图 / 备份相关语句的回归测试 */
'use strict';
const fs = require('fs');
const path = require('path');
const SQL = require(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.js'));
const wasm = fs.readFileSync(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.wasm'));
const Core = require('../mysql-core.js');

const lines = [];
const fails = [];
function head(t) { lines.push('\n' + '='.repeat(74) + '\n## ' + t + '\n' + '='.repeat(74)); }

let eng;
function run(sql) { return eng.run(sql); }
function errsOf(sql) { return run(sql).filter(b => b.kind === 'err').map(b => b.text); }
function textOf(sql) { return run(sql).map(b => b.text).join('\n'); }
function ok(sql) { return !errsOf(sql).length; }

function chk(label, fn) {
  let r;
  try { r = fn(); } catch (e) { r = '抛出异常：' + e.message; }
  if (r) { fails.push(label + ' → ' + r); lines.push('  ✗ ' + label + '  ' + r); }
  else lines.push('  ✓ ' + label);
}

(async () => {
  await SQL({ wasmBinary: wasm }).then(S => {
    const e = new Core.Engine(S, Core.seedAll);
    e.init();
    eng = e;

    head('1. 创建视图（各种写法）');
    chk('CREATE VIEW 基础写法', () => ok("CREATE VIEW v_emp AS SELECT id, username, balance FROM users;") ? null : errsOf("CREATE VIEW v_emp AS SELECT id, username, balance FROM users;").join('|'));
    chk('CREATE OR REPLACE VIEW 覆盖已有视图', () => {
      if (!ok("CREATE OR REPLACE VIEW v_emp AS SELECT id, username FROM users;")) return '报错';
      const c = textOf('SHOW CREATE VIEW v_emp;');
      return /AS SELECT id, username FROM users/.test(c) ? null : '定义未更新：' + c;
    });
    chk('CREATE ALGORITHM=... DEFINER=... SQL SECURITY ... 前缀被接受', () =>
      ok("CREATE ALGORITHM=MERGE DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW v_a AS SELECT id FROM users;") ? null : '报错');
    chk('CREATE VIEW v (列名清单) AS ...', () => {
      if (!ok("CREATE VIEW v_c (uid, uname) AS SELECT id, username FROM users;")) return '报错';
      const d = textOf('DESC v_c;');
      return /uid/.test(d) && /uname/.test(d) ? null : '列名未生效：' + d;
    });
    chk('CREATE VIEW IF NOT EXISTS 新建成功', () => ok("CREATE VIEW IF NOT EXISTS v_if AS SELECT id FROM users;") ? null : '报错');
    chk('CREATE VIEW IF NOT EXISTS 已存在 → Query OK + warning', () => {
      const b = run("CREATE VIEW IF NOT EXISTS v_if AS SELECT id FROM users;");
      if (b.some(x => x.kind === 'err')) return '不该报错：' + b.map(x => x.text).join('|');
      return /warning/.test(b.map(x => x.text).join(' ')) ? null : '没有 warning';
    });
    chk('重复建同名视图 → 1050', () => {
      const er = errsOf("CREATE VIEW v_if AS SELECT id FROM users;");
      return /ERROR 1050/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('视图名与已有基表重名 → 1050', () => {
      const er = errsOf("CREATE VIEW users AS SELECT id FROM users;");
      return /ERROR 1050/.test(er[0] || '') ? null : (er[0] || '未报错');
    });

    head('2. 建视图时的引用校验（真实 MySQL 会立刻校验）');
    chk('引用不存在的表 → 1146，且不留下半成品视图', () => {
      const er = errsOf("CREATE VIEW v_bad AS SELECT id FROM nonexist;");
      if (!/ERROR 1146/.test(er[0] || '')) return '错误码不对：' + (er[0] || '未报错');
      return e.viewNames('production').indexOf('v_bad') > -1 ? '残留了坏视图 v_bad' : null;
    });
    chk('引用不存在的列 → 1054', () => {
      const er = errsOf("CREATE VIEW v_bad2 AS SELECT home FROM users;");
      return /ERROR 1054/.test(er[0] || '') ? null : (er[0] || '未报错');
    });

    head('3. 查询与元数据可见性');
    chk('SELECT 视图可查', () => {
      const t = textOf('SELECT * FROM v_emp LIMIT 2;');
      return /username/.test(t) && /rows in set/.test(t) ? null : t;
    });
    chk('视图可与基表 JOIN', () =>
      ok('SELECT u.username, v.id FROM users u JOIN v_emp v ON v.id = u.id LIMIT 2;') ? null : 'JOIN 失败');
    chk('视图可套视图', () =>
      ok('CREATE VIEW v_nest AS SELECT id FROM v_emp;') && ok('SELECT * FROM v_nest LIMIT 1;') ? null : '嵌套视图失败');
    chk('DESC 视图：int 列还原成 int(11)', () => {
      const d = textOf('DESC v_emp;');
      return /id\s*\|\s*int\(11\)/.test(d) ? null : d;
    });
    chk('DESC 视图：varchar 列类型原样带出', () => {
      const d = textOf('DESC v_emp;');
      return /varchar\(/.test(d) ? null : d;
    });
    chk('DESC 计算列给出兜底类型而非空', () => {
      ok("CREATE VIEW v_calc AS SELECT COUNT(*) AS c, UPPER(username) AS un, balance*2 AS dbl FROM users;");
      const d = textOf('DESC v_calc;');
      if (!/bigint/.test(d)) return 'COUNT 未推断成 bigint：' + d;
      if (!/varchar\(255\)/.test(d)) return 'UPPER 未推断成 varchar(255)：' + d;
      return null;
    });
    chk('SHOW TABLES 列出视图', () => /v_emp/.test(textOf('SHOW TABLES;')) ? null : '视图未出现在 SHOW TABLES');
    chk('SHOW FULL TABLES 标出 VIEW / BASE TABLE', () => {
      const t = textOf('SHOW FULL TABLES;');
      if (!/v_emp\s*\|\s*VIEW/.test(t)) return '视图未标记 VIEW：' + t;
      return /users\s*\|\s*BASE TABLE/.test(t) ? null : '基表未标记 BASE TABLE';
    });
    chk('SHOW TABLES LIKE 过滤能命中视图', () => /v_emp/.test(textOf("SHOW TABLES LIKE 'v_em%';")) ? null : '未命中');
    chk('SHOW TABLE STATUS 含视图且 Comment=VIEW', () => {
      const t = textOf('SHOW TABLE STATUS;');
      return /v_emp[\s\S]*?VIEW/.test(t) ? null : '视图未出现';
    });
    chk('SHOW CREATE VIEW 输出 MySQL 习惯格式', () => {
      const t = textOf('SHOW CREATE VIEW v_emp;');
      if (!/ALGORITHM=UNDEFINED/.test(t)) return '缺少 ALGORITHM';
      if (!/DEFINER=`root`@`localhost`/.test(t)) return '缺少 DEFINER';
      if (!/WITH CASCADED CHECK OPTION/.test(t)) return '缺少 CHECK OPTION';
      if (!/SQL SECURITY DEFINER VIEW `v_emp`/.test(t)) return '视图名不对';
      return null;
    });
    chk('SHOW CREATE TABLE 作用在视图上返回视图定义', () => /ALGORITHM=UNDEFINED/.test(textOf('SHOW CREATE TABLE v_emp;')) ? null : '未返回视图定义');
    chk('objectList 表与视图按名字混排', () => {
      const o = e.objectList('production');
      const names = o.map(x => x.name);
      const sorted = names.slice().sort();
      if (names.join() !== sorted.join()) return '未排序：' + names.join();
      return o.filter(x => x.isView).length >= 3 ? null : '视图数量不对';
    });

    head('4. 视图上的错误码');
    chk('INSERT 视图 → 1288 ... not updatable', () => {
      const er = errsOf('INSERT INTO v_emp VALUES (1);');
      return /ERROR 1288[\s\S]*INSERT is not updatable/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('UPDATE 视图 → 1288 ... UPDATE', () => {
      const er = errsOf("UPDATE v_emp SET username='x';");
      return /ERROR 1288[\s\S]*UPDATE is not updatable/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('DELETE 视图 → 1288 ... DELETE', () => {
      const er = errsOf('DELETE FROM v_emp;');
      return /ERROR 1288[\s\S]*DELETE is not updatable/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('DROP TABLE 视图 → 1347 is not BASE TABLE', () => {
      const er = errsOf('DROP TABLE v_emp;');
      return /ERROR 1347[\s\S]*is not BASE TABLE/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('DROP VIEW 基表 → 1347 is not VIEW', () => {
      const er = errsOf('DROP VIEW users;');
      return /ERROR 1347[\s\S]*is not VIEW/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('DROP VIEW 不存在的视图 → 1051', () => {
      const er = errsOf('DROP VIEW v_nope;');
      return /ERROR 1051/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('DROP VIEW IF EXISTS 不存在 → warning 不报错', () => {
      const b = run('DROP VIEW IF EXISTS v_nope;');
      if (b.some(x => x.kind === 'err')) return '不该报错';
      return /warning/.test(b.map(x => x.text).join(' ')) ? null : '没有 warning';
    });
    chk('SHOW INDEX FROM 视图 → 1347', () => {
      const er = errsOf('SHOW INDEX FROM v_emp;');
      return /ERROR 1347/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('DESC 不存在的对象仍是 1146', () => {
      const er = errsOf('DESC nope_xxx;');
      return /ERROR 1146/.test(er[0] || '') ? null : (er[0] || '未报错');
    });

    head('5. ALTER VIEW / DROP VIEW 多表');
    chk('ALTER VIEW 等价于替换定义', () => {
      if (!ok('ALTER VIEW v_emp AS SELECT id FROM users;')) return '报错';
      const t = textOf('SHOW CREATE VIEW v_emp;');
      return /AS SELECT id FROM users/.test(t) ? null : '定义未替换：' + t;
    });
    chk('ALTER VIEW 不存在的视图 → 1051', () => {
      const er = errsOf('ALTER VIEW v_ghost AS SELECT 1;');
      return /ERROR 1051/.test(er[0] || '') ? null : (er[0] || '未报错');
    });
    chk('DROP VIEW a, b 一次删多个', () => {
      ok('CREATE VIEW v_m1 AS SELECT id FROM users;');
      ok('CREATE VIEW v_m2 AS SELECT id FROM users;');
      if (!ok('DROP VIEW v_m1, v_m2;')) return '报错';
      const vn = e.viewNames('production');
      return (vn.indexOf('v_m1') < 0 && vn.indexOf('v_m2') < 0) ? null : '视图没删干净';
    });
    chk('DROP VIEW 后 SHOW TABLES 不再列出', () => {
      ok('CREATE VIEW v_tmp AS SELECT id FROM users;');
      ok('DROP VIEW v_tmp;');
      return /v_tmp/.test(textOf('SHOW TABLES;')) ? '仍在列表里' : null;
    });

    head('6. 备份类语句（MySQL 社区版本身没有）');
    chk('BACKUP DATABASE → 1064 + 说明（不是 1235）', () => {
      const b = run("BACKUP DATABASE production TO DISK='x.bak';");
      const t = b.map(x => x.text).join('\n');
      if (!/ERROR 1064/.test(t)) return '错误码不是 1064：' + t.split('\n')[0];
      return /企业版/.test(t) && /mysqldump/.test(t) ? null : '缺少原因说明';
    });
    chk('RESTORE DATABASE → 1064 + 说明', () => {
      const t = run("RESTORE DATABASE production FROM DISK='x.bak';").map(x => x.text).join('\n');
      return /ERROR 1064/.test(t) && /企业版/.test(t) ? null : t.split('\n')[0];
    });
    chk('mysqldump 作为 SQL 执行 → 1064 + 说明', () => {
      const t = run('MYSQLDUMP production;').map(x => x.text).join('\n');
      return /ERROR 1064/.test(t) && /命令行工具/.test(t) ? null : t.split('\n')[0];
    });
    chk('SELECT ... INTO OUTFILE 仍是 1235（本模拟器沙箱限制）', () => {
      const er = errsOf("SELECT * FROM users INTO OUTFILE '/tmp/a.csv';");
      return /ERROR 1235/.test(er[0] || '') ? null : (er[0] || '未报错');
    });

    head('7. 不影响基表原有行为');
    chk('建/删视图不会动基表', () => {
      const before = textOf('SELECT COUNT(*) AS c FROM users;');
      ok('CREATE VIEW v_x AS SELECT id FROM users;');
      ok('DROP VIEW v_x;');
      return textOf('SELECT COUNT(*) AS c FROM users;') === before ? null : '基表行数变了';
    });
    chk('视图元数据不会污染 SHOW INDEX / DESC 基表', () => {
      const d = textOf('DESC users;');
      return /v_emp/.test(d) ? '视图名混进了 DESC users' : null;
    });
    chk('视图不参与 DROP DATABASE 之外的表目录统计', () => {
      const tn = e.tableNames('production');
      return tn.some(n => /^v_/.test(n)) ? '视图混进了 tableNames' : null;
    });

    lines.push('\n' + '#'.repeat(74));
    if (fails.length) {
      lines.push('❌ 视图测试失败 ' + fails.length + ' 项：');
      fails.forEach((f, i) => lines.push('  ' + (i + 1) + '. ' + f));
    } else {
      lines.push('✅ 视图 / 备份相关用例全部通过');
    }
    const out = lines.join('\n');
    fs.writeFileSync(path.join(__dirname, '_view_report.txt'), out, 'utf8');
    console.log('报告已生成: _view_report.txt  (failures=' + fails.length + ')');
    if (fails.length) { console.log(out.split('\n').slice(-fails.length - 3).join('\n')); }
  });
})();
