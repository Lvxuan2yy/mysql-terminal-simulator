/* 练习题判定回归：同义写法必须认；不同题之间绝不能互相串台（防止过宽） */
'use strict';
const fs = require('fs');
const path = require('path');
const SQL = require(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.js'));
const wasm = fs.readFileSync(path.join(__dirname, '..', '..', 'vendor', 'sql-wasm.wasm'));
const Core = require('../mysql-core.js');

const lines = [];
const fails = [];
function head(t) { lines.push('\n' + '='.repeat(76) + '\n## ' + t + '\n' + '='.repeat(76)); }
function chk(label, err) {
  if (err) { fails.push(label + ' → ' + err); lines.push('  ✗ ' + label + '  ' + err); }
  else lines.push('  ✓ ' + label);
}

/** 只在字符串字面量之外应用替换——否则会把 'a, ' 这种字面量改坏，测出假失败 */
function outsideQuotes(str, fn) {
  let out = '', i = 0, buf = '', state = 'n';
  while (i < str.length) {
    const ch = str[i];
    if (state === 'n') {
      if (ch === "'" || ch === '"') { out += fn(buf); buf = ''; state = ch; out += ch; i++; continue; }
      buf += ch; i++; continue;
    }
    out += ch;
    if (ch === '\\') { out += str[i + 1] || ''; i += 2; continue; }
    if (ch === state) {
      if (str[i + 1] === state) { out += state; i += 2; continue; }
      state = 'n';
    }
    i++;
  }
  return out + fn(buf);
}

/** 把答案改写成"同一个查询的另一种常见写法" */
function variants(ans) {
  const out = [];
  const push = (label, s) => { if (s && s !== ans) out.push([label, s]); };
  const multiLine = ans.indexOf('\n') > -1;

  push('全小写', outsideQuotes(ans, t => t.toLowerCase()));
  push('去掉结尾分号', ans.replace(/;[ \t]*$/, ''));
  push('结尾分号前加空格', ans.replace(/;[ \t]*$/, ' ;'));
  push('逗号后不留空格', outsideQuotes(ans, t => t.replace(/,[ \t]+/g, ',')));
  push('逗号前后都留空格', outsideQuotes(ans, t => t.replace(/,[ \t]*/g, ' , ').replace(/[ \t]+/g, ' ')));
  push('括号内侧加空格', outsideQuotes(ans, t => t.replace(/\(/g, '( ').replace(/\)/g, ' )')));
  push('函数名与括号间加空格', outsideQuotes(ans, t => t.replace(/\b([a-z_][a-z0-9_]*)\(/gi, '$1 (')));
  push('给表名/列名加反引号',
    outsideQuotes(ans, t => t.replace(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi, '`$1`.`$2`')
      .replace(/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)\b/gi, '$1 `$2`')));
  push('多空格/换行压缩成单空格', ans.replace(/\s+/g, ' '));
  if (!multiLine) {
    push('换行 + 缩进', ans.replace(/\s+(FROM|WHERE|GROUP|ORDER|LIMIT|JOIN|ON|SET|VALUES)\b/gi, '\n  $1'));
    push('关键字全大写', outsideQuotes(ans, t => t.replace(/\b(select|from|where|group|order|limit|join|on|as|and|or|like|desc|asc|into|values|update|set|insert|create|table|show|use|desc)\b/gi,
      m => m.toUpperCase())));
  }
  return out;
}

(async () => {
  await SQL({ wasmBinary: wasm }).then(S => {
    const e = new Core.Engine(S, Core.seedAll);
    e.init();

    head('1. 本题答案的各种写法都必须被判为答对');
    let totalVariants = 0;
    Core.EXERCISES.forEach((ex, i) => {
      const bad = [];
      for (const [label, s] of variants(ex.answer)) {
        totalVariants++;
        const hits = Core.matchExercises(s);
        if (hits.indexOf(i) < 0) bad.push(label + ' → ' + JSON.stringify(s.slice(0, 70)));
      }
      chk('第 ' + (i + 1) + ' 题「' + ex.title + '」（' + (variants(ex.answer).length) + ' 种写法）',
        bad.length ? bad.slice(0, 3).join(' ; ') : null);
    });
    lines.push('  （共校验 ' + totalVariants + ' 个写法变体）');

    head('2. 不能串台：某题的各种写法不得命中其它题');
    const cross = [];
    Core.EXERCISES.forEach((ex, i) => {
      for (const [label, s] of variants(ex.answer)) {
        const hits = Core.matchExercises(s).filter(j => j !== i);
        if (hits.length) {
          cross.push('第 ' + (i + 1) + ' 题「' + ex.title + '」的「' + label + '」写法' +
            ' 同时命中了 ' + hits.map(j => (j + 1) + '. ' + Core.EXERCISES[j].title).join('、'));
        }
      }
    });
    chk('无任何跨题误判', cross.length ? cross.slice(0, 5).join(' ; ') : null);
    cross.slice(0, 8).forEach(c => lines.push('      · ' + c));

    head('3. 用户实际反馈的场景');
    const cases = [
      ['select username,email from users;', 5, '截图里那条（逗号后没空格、全小写、无别名）'],
      ['SELECT username, email FROM users;', 5, '题干标准答案'],
      ['select username , email from users ;', 5, '逗号前也带空格'],
      ['SELECT `username`, `email` FROM users;', 5, '带反引号'],
      ['SELECT u.username, u.email FROM users u;', 5, '加了表别名 + 列限定'],
      ['SELECT username,email FROM users', 5, '无结尾分号'],
    ];
    cases.forEach(([sql, want, note]) => {
      const hits = Core.matchExercises(sql);
      chk(note + '  ' + JSON.stringify(sql), hits.indexOf(want) >= 0 ? null : '未命中第 ' + (want + 1) + ' 题，实际命中 ' + JSON.stringify(hits));
    });

    head('4. 答错/答不全的不能算过（防止过宽）');
    const negatives = [
      ['SELECT username FROM users;', 5, '只查了一列'],
      ['SELECT * FROM users;', 5, '查了全部列'],
      ['SELECT email FROM users;', 5, '只查了另一列'],
      ['SELECT username, email FROM orders;', 5, '查错表了'],
      ['SELECT username, email, city FROM users;', 5, '多查了一列'],
      ['SELECT * FROM users WHERE vip_level >= 2;', 5, '是另一题的答案'],
      ['SELECT username, email FROM users WHERE 1=1;', 5, '多加了无意义条件'],
      ['SELECT COUNT(*) FROM users;', 9, '少了别名 total'],
      ['SELECT username, balance FROM users ORDER BY balance DESC LIMIT 3;', 7, 'LIMIT 数量不对'],
      ['SELECT * FROM users WHERE city LIKE \'%深%\';', 8, 'LIKE 前后通配'],
      ['SELECT * FROM users WHERE vip_level >= 1;', 6, '阈值不对'],
    ];
    negatives.forEach(([sql, notIdx, note]) => {
      const hits = Core.matchExercises(sql);
      const shown = hits.length ? '实际命中 ' + hits.map(j => (j + 1) + '.' + Core.EXERCISES[j].title).join('、') : '未命中任何题';
      chk(note + '  ' + JSON.stringify(sql), hits.indexOf(notIdx) >= 0 ? '被误判为第 ' + (notIdx + 1) + ' 题答对' : null);
      lines[lines.length - 1] += '    [' + shown + ']';
    });

    head('5. 规范化函数自身的行为（引号内不能被折叠）');
    chk('大小写 + 空白 + 标点空格', Core.canonicalSQL('  SELECT  a , b  FROM  t ; ') === 'select a,b from t' ? null : Core.canonicalSQL('  SELECT  a , b  FROM  t ; '));
    chk('反引号被去掉', Core.canonicalSQL('SELECT `a` FROM `t`;') === 'select a from t' ? null : Core.canonicalSQL('SELECT `a` FROM `t`;'));
    chk('结尾 \\G 被去掉', Core.canonicalSQL('SELECT * FROM t\\G') === 'select * from t' ? null : Core.canonicalSQL('SELECT * FROM t\\G'));
    chk('引号内的逗号/空格原样保留', Core.canonicalSQL("SELECT * FROM t WHERE c = 'a,  b';") === "select * from t where c = 'a,  b'" ? null : Core.canonicalSQL("SELECT * FROM t WHERE c = 'a,  b';"));
    chk('引号内的内容不被小写化', Core.canonicalSQL("SELECT * FROM t WHERE c = 'ABC';") === "select * from t where c = 'ABC'" ? null : Core.canonicalSQL("SELECT * FROM t WHERE c = 'ABC';"));
    // 规范形会把标点两侧的空白一并吃掉（对两侧同等生效），所以 ) 后紧跟 as 是预期结果
    chk('小括号紧贴函数名', Core.canonicalSQL('SELECT COUNT (* ) AS n FROM t;') === 'select count(*)as n from t' ? null : Core.canonicalSQL('SELECT COUNT (* ) AS n FROM t;'));
    chk('(*) AS 与 (*)AS 折叠成同一种', Core.canonicalSQL('SELECT COUNT(*) AS n FROM t;') === Core.canonicalSQL('SELECT COUNT(*)AS n FROM t;') ? null : '不一致');
    chk('单字母别名（列）被抹掉', Core.canonicalSQLRelaxed('SELECT u.name FROM users u;') === 'select name from users' ? null : Core.canonicalSQLRelaxed('SELECT u.name FROM users u;'));
    chk('完整限定名不被误伤', Core.canonicalSQLRelaxed('SELECT users.name FROM users;') === 'select users.name from users' ? null : Core.canonicalSQLRelaxed('SELECT users.name FROM users;'));
    chk('保留字不会被当成别名吞掉', Core.canonicalSQLRelaxed('SELECT a FROM t WHERE a = 1;') === 'select a from t where a = 1' ? null : Core.canonicalSQLRelaxed('SELECT a FROM t WHERE a = 1;'));

    head('6. 多语句输入');
    chk('一次提交多条语句，任一条命中即算过',
      (() => { const h = Core.matchExercises('USE production;\nSELECT username,email FROM users;'); return h.indexOf(1) >= 0 && h.indexOf(5) >= 0 ? null : JSON.stringify(h); })());
    chk('空输入不报错也不命中', (() => { const h = Core.matchExercises('   '); return h.length === 0 ? null : JSON.stringify(h); })());
    chk('超长/畸形输入不抛异常',
      (() => { try { Core.matchExercises("SELECT 'unterminated"); return null; } catch (err) { return err.message; } })());

    lines.push('\n' + '#'.repeat(76));
    if (fails.length) {
      lines.push('❌ 练习题判定失败 ' + fails.length + ' 项：');
      fails.forEach((f, i) => lines.push('  ' + (i + 1) + '. ' + f));
    } else {
      lines.push('✅ 练习题判定全部通过（含 25 题 × 各种写法 + 反例 + 串台检查）');
    }
    const out = lines.join('\n');
    fs.writeFileSync(path.join(__dirname, '_exercise_report.txt'), out, 'utf8');
    console.log(out.split('\n').slice(-(fails.length ? fails.length + 3 : 3)).join('\n'));
    console.log('\n报告: _exercise_report.txt  failures=' + fails.length);
  });
})();
