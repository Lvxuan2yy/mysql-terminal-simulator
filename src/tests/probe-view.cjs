/* 探测：当前引擎对 VIEW / BACKUP 类语句的真实反应 */
'use strict';
const path = require('path');
const Core = require(path.join(__dirname, '..', 'mysql-core.js'));
const initSqlJs = require(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.js'));

const PROBES = [
  "CREATE VIEW v_emp AS SELECT id, username, balance FROM users;",
  "CREATE OR REPLACE VIEW v_emp AS SELECT id, username FROM users;",
  "CREATE VIEW IF NOT EXISTS v2 AS SELECT id FROM users;",
  "CREATE VIEW v2 AS SELECT id FROM users;",
  "CREATE ALGORITHM=MERGE VIEW v3 AS SELECT id FROM users;",
  "CREATE VIEW v4 (a, b) AS SELECT id, balance FROM users;",
  "CREATE VIEW v5 AS SELECT COUNT(*) AS c, UPPER(username) AS un, balance*2 AS dbl FROM users;",
  "SELECT * FROM v_emp LIMIT 3;",
  "DESC v_emp;",
  "SHOW COLUMNS FROM v_emp;",
  "SHOW CREATE VIEW v_emp;",
  "SHOW CREATE TABLE v_emp;",
  "SHOW FULL TABLES;",
  "SHOW TABLES;",
  "SHOW TABLES LIKE 'v%';",
  "SHOW TABLE STATUS;",
  "SHOW INDEX FROM v_emp;",
  "ALTER VIEW v_emp AS SELECT id FROM users;",
  "SELECT * FROM v_emp LIMIT 2;",
  "CREATE VIEW v_bad AS SELECT id FROM nonexist;",
  "CREATE VIEW v_bad AS SELECT home FROM users;",
  "INSERT INTO v_emp VALUES (1);",
  "UPDATE v_emp SET username='x';",
  "DELETE FROM v_emp;",
  "DROP TABLE v_emp;",
  "DROP VIEW users;",
  "DROP VIEW v_emp;",
  "DROP VIEW IF EXISTS v_emp;",
  "DROP VIEW v_emp;",
  "DROP VIEW v3, v4;",
  "BACKUP DATABASE production TO DISK = 'x.bak';",
  "MYSQLDUMP production;",
  "RESTORE DATABASE production FROM DISK='x.bak';",
  "SHOW TABLES;"
];

initSqlJs().then(SQL => {
  const e = new Core.Engine(SQL, Core.seedAll);
  e.init();
  for (const p of PROBES) {
    let out;
    try {
      const blocks = e.run(p);
      out = blocks.map(b => b.kind + ': ' + String(b.text).split('\n').slice(0, 4).join(' | ')).join('  ///  ');
    } catch (err) { out = 'THROW: ' + err.message; }
    console.log('--- ' + p + '\n    ' + (out || '(无输出)'));
  }
  const entry = e.databases.production;
  console.log('\n=== sqlite_master ===');
  console.log('tableNames:', e.tableNames('production'));
  console.log('viewNames :', e.viewNames('production'));
  console.log('objectList:', JSON.stringify(e.objectList('production')));
  const sm = entry.db.exec("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  console.log('master    :', JSON.stringify(sm.length ? sm[0].values : []));
});
