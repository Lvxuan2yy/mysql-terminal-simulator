# -*- coding: utf-8 -*-
"""练习题判定的浏览器端验收：复现用户截图里的场景（逗号后没空格）"""
import os
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, 'mysql-terminal.html')
SHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_shot')
os.makedirs(SHOT, exist_ok=True)
URL = 'file:///' + TARGET.replace('\\', '/')

report, fails = [], []


def log(*a):
    s = ' '.join(str(x) for x in a)
    report.append(s)
    print(s)


def chk(label, cond, extra=''):
    if cond:
        log('  ✓ ' + label)
    else:
        log('  ✗ ' + label + ('  ' + str(extra) if extra else ''))
        fails.append(label + ('  ' + str(extra) if extra else ''))


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1440, 'height': 900})
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(URL, wait_until='load')
    page.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=20000)

    def send(sql):
        page.click('#scroll')
        page.fill('#hidden', sql)
        page.keyboard.press('Enter')
        page.wait_for_timeout(260)

    def done_flags():
        return page.evaluate("() => [...document.querySelectorAll('#ex-list .ex')].map(e => e.classList.contains('done'))")

    def lv_text():
        return page.evaluate("() => [...document.querySelectorAll('#ex-list .exlv')].map(e => e.innerText.replace(/\\n/g, ' '))")

    log('[1] 先做两道基础题')
    send('SHOW DATABASES;')
    send('USE production;')
    f = done_flags()
    chk('第 1 题「看看有哪些库」已打勾', f[0], f)
    chk('第 2 题「切换到电商库」已打勾', f[1], f)

    log('\n[2] 复现截图场景：select username,email from users;（逗号后没空格）')
    before = done_flags()[5]
    chk('执行前第 6 题「只看两列」还没打勾', before is False, before)
    send('select username,email from users;')
    f = done_flags()
    chk('第 6 题「只看两列」执行后已打勾', f[5], f)
    chk('该题卡片上出现 ✓ 标记', page.evaluate(
        "() => !!document.querySelectorAll('#ex-list .ex')[5].querySelector('.chk')"))
    chk('L1 进度计数已增加', '3 / 9' in ' '.join(lv_text()), lv_text())
    log('    L1/L2/L3 进度：%s' % lv_text())
    # 切到「练习」面板截图，确认卡片上有 ✓
    page.click('.tab[data-panel="ex"]')
    page.wait_for_timeout(200)
    page.evaluate("() => document.querySelectorAll('#ex-list .ex')[5].scrollIntoView({block:'center'})")
    page.wait_for_timeout(200)
    page.screenshot(path=os.path.join(SHOT, 'exercise-1-matched.png'))
    page.click('.tab[data-panel="db"]')

    log('\n[3] 其它常见写法也要认')
    for sql, idx, note in [
        ('SELECT `username`, `email` FROM users;', 5, '带反引号'),
        ('select username , email from users ;', 5, '逗号前后都带空格'),
        ('SELECT u.username, u.email FROM users u;', 5, '加表别名 + 列限定'),
        ('SELECT * FROM users WHERE city LIKE \'深%\';', 8, '第 9 题：模糊匹配'),
        ('SELECT COUNT(*) AS total FROM users;', 9, '第 10 题：统计总数'),
    ]:
        send(sql)
        chk(note + '  ' + sql, done_flags()[idx], done_flags())

    log('\n[4] 「重新连接」只重置数据库，不清练习进度（进度存在 localStorage）')
    page.click('#btn-reconnect')
    page.wait_for_timeout(600)
    f = done_flags()
    chk('重连后第 6 题的 ✓ 仍在（不会丢作业）', f[5] is True, f)
    chk('重连后答题数仍为 5 题', sum(1 for x in f if x) == 5, sum(1 for x in f if x))

    log('\n[5] 全新浏览器状态（清 localStorage）里写错答案 → 不能打勾')
    page.evaluate("() => localStorage.clear()")
    page.reload(wait_until='load')
    page.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=20000)
    chk('清掉本地记录后所有题回到未完成', not any(done_flags()), done_flags())
    send('SELECT username FROM users;')
    f = done_flags()
    chk('只查一列时第 6 题不打勾', f[5] is False, f)
    send('SELECT username, email, city FROM users;')
    f = done_flags()
    chk('多查一列时第 6 题不打勾', f[5] is False, f)
    send('select username,email from users;')
    f = done_flags()
    chk('写对之后第 6 题才打勾', f[5] is True, f)
    chk('这一步只勾了第 6 题（没有顺带勾到别题）', sum(1 for x in f if x) == 1, f)
    page.screenshot(path=os.path.join(SHOT, 'exercise-2-after-fix.png'))

    log('\n[6] 无 JS 异常')
    chk('页面无 JS 错误', not errs, errs)

    b.close()

log('\n' + '=' * 70)
log(('❌ 练习题判定 UI 验收失败 %d 项' % len(fails)) if fails else '✅ 练习题判定 UI 验收全部通过')
for i, x in enumerate(fails, 1):
    log('  %d. %s' % (i, x))
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_exercise_ui_report.txt'), 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(report))
sys.exit(1 if fails else 0)
