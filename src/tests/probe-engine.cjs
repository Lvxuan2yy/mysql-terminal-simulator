/* 引擎能力探针：验证 (1) wasmBinary 离线加载 (2) 浏览器 <script> 场景下的全局暴露 (3) SQLite 特性支持度 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VENDOR = path.join(__dirname, '..', '..', 'vendor');
const glue = fs.readFileSync(path.join(VENDOR, 'sql-wasm.js'), 'utf8');
const wasm = fs.readFileSync(path.join(VENDOR, 'sql-wasm.wasm'));

const out = [];
const log = (...a) => out.push(a.join(' '));

(async () => {
  // --- 探针 1: 浏览器 <script> 场景（无 module/exports/define 的裸上下文） ---
  const sandbox = { console, TextDecoder, TextEncoder, WebAssembly, Promise, ArrayBuffer,
                    Uint8Array, Int8Array, Int16Array, Uint16Array, Int32Array, Uint32Array,
                    Float32Array, Float64Array, Math, Date, JSON, Object, String, Number,
                    Error, TypeError, setTimeout, clearTimeout, URL, Blob, performance };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  try {
    vm.createContext(sandbox);
    vm.runInContext(glue, sandbox, { filename: 'sql-wasm.js' });
    const g = Object.keys(sandbox).filter(k => /initSqlJs|SQL/i.test(k));
    log('[探针1] 裸 script 上下文暴露的全局:', JSON.stringify(g));
  } catch (e) {
    log('[探针1] 失败:', e.message);
  }

  // --- 探针 2: Node CommonJS + wasmBinary，禁用网络，确认不走 fetch ---
  const origFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (...a) => { fetchCalled = true; throw new Error('fetch 被调用: ' + a[0]); };
  let SQL;
  try {
    const initSqlJs = require(path.join(VENDOR, 'sql-wasm.js'));
    SQL = await initSqlJs({ wasmBinary: wasm });
    log('[探针2] wasmBinary 离线初始化: OK; 是否触发 fetch:', fetchCalled);
  } catch (e) {
    log('[探针2] 失败:', e.message);
  } finally {
    global.fetch = origFetch;
  }
  if (!SQL) { console.log(out.join('\n')); return; }

  const db = new SQL.Database();
  const q = (sql) => { try { return db.exec(sql); } catch (e) { return 'ERR: ' + e.message; } };
  const scalar = (sql) => { try { return db.exec(sql)[0].values[0][0]; } catch (e) { return 'ERR: ' + e.message; } };

  log('[引擎] sqlite 版本:', scalar('select sqlite_version()'));

  // --- 探针 3: 关键 SQL 特性 ---
  log('[特性] INT AUTO_INCREMENT 转 INTEGER PRIMARY KEY 后自增:',
      JSON.stringify(q('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')) === '[]' &&
      JSON.stringify(q("INSERT INTO t(v) VALUES ('a'),('b')")) === '[]' ? scalar('select max(id) from t') : 'n/a');
  log('[特性] 表级 PRIMARY KEY(id) 且 id 为 INTEGER 是否仍是 rowid 别名(自增):', (() => {
    q('CREATE TABLE t2(id INTEGER, v TEXT, PRIMARY KEY(id))');
    q("INSERT INTO t2(v) VALUES('x')");
    q("INSERT INTO t2(v) VALUES('y')");
    const r = q('select id from t2');
    return JSON.stringify(r);
  })());
  log('[特性] 反引号标识符:', JSON.stringify(scalar("select `sqlite_version` from (select sqlite_version() as `sqlite_version`)")));
  log('[特性] 双引号字符串(MySQL 兼容性风险):', JSON.stringify(scalar('select "hello"')));
  log('[特性] create_function 注册 MySQL 函数 CONCAT:', (() => {
    try { db.create_function('CONCAT', (...a) => a.filter(x => x !== null && x !== undefined).join('')); return JSON.stringify(scalar("select CONCAT('a','b','c')")); }
    catch (e) { return 'ERR: ' + e.message; }
  })());
  log('[特性] create_function 注册 IF:', (() => {
    try { db.create_function('IF', (c, a, b) => (c ? a : b)); return JSON.stringify(scalar("select IF(1=1,'yes','no')")); }
    catch (e) { return 'ERR: ' + e.message; }
  })());
  log('[特性] 注册名为 LEFT 的函数是否与 JOIN 语法冲突:', (() => {
    try { db.create_function('LEFT', (s, n) => String(s).slice(0, n)); return JSON.stringify(scalar("select LEFT('abcdef',3)")); }
    catch (e) { return 'ERR: ' + e.message; }
  })());
  log('[特性] IFNULL / NOW 原生支持:', JSON.stringify(scalar('select ifnull(null,1)')));
  log('[特性] sqlite_master 查表清单:', JSON.stringify(q("select name from sqlite_master where type='table' order by name").map(r => r.values.map(v => v[0])).flat()));
  log('[特性] PRAGMA table_info:', JSON.stringify(q('pragma table_info(t)').map(r => r.columns.join(','))));
  log('[特性] 返回多结果集(分号多语句)是否会报错:', (() => {
    try { const r = db.exec('select 1; select 2;'); return 'OK, 结果集数=' + r.length; } catch (e) { return 'ERR: ' + e.message; }
  })());
  log('[特性] 查询耗时测量 api: db.exec 可用, 语句级 prepare:', (() => {
    try { const st = db.prepare('select 1'); st.step(); const c = st.getColumnNames(); st.free(); return JSON.stringify(c); } catch (e) { return 'ERR: ' + e.message; }
  })());
  log('[特性] 数值列类型识别 —— typeof 返回:', JSON.stringify(q('select 1 as n, 1.5 as f, \'x\' as s, null as z')[0].values[0].map(v => typeof v)));
  log('[特性] db.export 导出字节可复用于新建库:', (() => {
    try { const bytes = db.export(); const db2 = new SQL.Database(bytes); return JSON.stringify(db2.exec('select count(*) from t')[0].values[0][0]); } catch (e) { return 'ERR: ' + e.message; }
  })());
  log('[特性] 错误消息样本 no such table:', (() => { try { db.exec('select * from nope'); } catch (e) { return JSON.stringify(e.message); } })());
  log('[特性] 错误消息样本 syntax error:', (() => { try { db.exec('selec 1'); } catch (e) { return JSON.stringify(e.message); } })());
  log('[特性] 错误消息样本 no such column:', (() => { try { db.exec('select zzz from t'); } catch (e) { return JSON.stringify(e.message); } })());
  log('[特性] 错误消息样本 UNIQUE:', (() => { db.exec('create table u(a integer primary key, b text unique)'); db.exec("insert into u values(1,'x')"); try { db.exec("insert into u values(2,'x')"); } catch (e) { return JSON.stringify(e.message); } })());
  log('[特性] 错误消息样本 NOT NULL:', (() => { try { db.exec('insert into u(a) values(9)'); return 'no err on null b'; } catch (e) { return JSON.stringify(e.message); } })());

  console.log(out.join('\n'));
})();
