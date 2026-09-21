# -*- coding: utf-8 -*-
"""跨浏览器 + 跨路径验收：确认 Chromium / Firefox(Gecko) / WebKit(Safari 内核)
   在 ASCII 路径与中文/空格路径下都能离线起来，且核心语句行为一致。"""
import os
import shutil
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, 'mysql-terminal.html')

# 准备一份「中文 + 空格 + 括号」路径下的副本，模拟发给别人后的存放位置
CJK_DIR = os.path.join(ROOT, 'src', 'tests', '_portable', '期末 复习资料 (2026)', 'MySQL 模拟器 测试')
CJK_FILE = os.path.join(CJK_DIR, 'MySQL 终端模拟器.html')
os.makedirs(CJK_DIR, exist_ok=True)
shutil.copy2(TARGET, CJK_FILE)

def url_of(p):
    return 'file:///' + p.replace('\\', '/')

# 覆盖本轮修复项 + 中文排版 + 错误码，尽量压到单次会话里
PROBES = [
    ('SHOW DATABASES;', 'Database'),
    ('USE production;', 'Database changed'),
    ('DESC users;', 'auto_increment'),
    ('SELECT COUNT(*) AS n FROM users;', 'n'),
    ('SELECT * FROM t_nothing;', 'ERROR 1146'),
    ("SELECT '信创整机' AS 公司, 5999.00 AS 价格;", '信创整机'),          # CJK 宽度对齐
    ('SELECT CONCAT(LEFT(username,3),\'…\') AS s FROM users LIMIT 1;', '…'),
    ('START TRANSACTION;', 'Query OK, 0 rows affected'),               # 本轮修复
    ("INSERT INTO users (username,email) VALUES ('x_probe','x@x.com');", '1 row affected'),
    ('ROLLBACK;', 'Query OK'),
    ("SELECT COUNT(*) AS after_rb FROM users WHERE username='x_probe';", 'after_rb'),
    ('SET @n = 41;', 'Query OK'),
    ('SELECT @n + 1 AS answer;', '42'),
    ('SELECT @@version;', '8.0.36'),
    ("SELECT 'abc' REGEXP 'b' AS r, FIELD('b','a','b') AS f;", 'REGEXP'),
    ('GRANT SELECT ON *.* TO \'u\'@\'%\';', 'ERROR 1235'),             # 明确不支持
    ('EXPLAIN SELECT * FROM users WHERE id = 1;', 'SEARCH'),
]

def run_one(p, engine_name, label, path):
    try:
        browser = getattr(p, engine_name).launch()
    except Exception as e:
        return None, '跳过（浏览器未安装）: %s' % str(e)[:70]
    try:
        page = browser.new_page(viewport={'width': 1280, 'height': 820})
        errs = []
        reqs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('request', lambda r: reqs.append(r.url))
        page.goto(url_of(path), wait_until='load')
        page.wait_for_function(
            "document.querySelector('#boot').classList.contains('hide')", timeout=30000)
        fails = []
        for sql, expect in PROBES:
            page.click('#scroll')
            page.fill('#hidden', sql)
            page.keyboard.press('Enter')
            page.wait_for_timeout(180)
            txt = page.inner_text('#scroll')
            if expect not in txt:
                fails.append('%s → 未出现 %r' % (sql[:46], expect))
        ext = [u for u in reqs if not u.startswith('file://')]
        detail = '通过 %d/%d；页面错误 %d；外部请求 %d%s' % (
            len(PROBES) - len(fails), len(PROBES), len(errs), len(ext),
            ('　失败: ' + ' | '.join(fails[:3])) if fails else '')
        return (len(fails) == 0 and len(errs) == 0 and len(ext) == 0), detail
    except Exception as e:
        return False, '❌ 异常: %s' % str(e)[:160]
    finally:
        try:
            browser.close()
        except Exception:
            pass

lines = []
with sync_playwright() as p:
    for engine_name in ('chromium', 'firefox', 'webkit'):
        for label, path in (('ASCII 路径', TARGET), ('中文/空格路径', CJK_FILE)):
            ok, detail = run_one(p, engine_name, label, path)
            tag = '跳过' if ok is None else ('✅ 通过' if ok else '❌ 失败')
            line = '[%-8s] %-14s : %s — %s' % (engine_name, label, tag, detail)
            print(line)
            lines.append(line)

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_crossbrowser_report.txt'),
          'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print('\n报告：_crossbrowser_report.txt')
