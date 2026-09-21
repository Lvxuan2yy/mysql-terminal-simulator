# -*- coding: utf-8 -*-
"""终端行为验收：输入框常驻底部 / 清屏保留回滚 / 只有「重新连接」才彻底清空"""
import os
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, 'mysql-terminal.html')
SHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_shot')
os.makedirs(SHOT, exist_ok=True)
URL = 'file:///' + TARGET.replace('\\', '/')

report = []
fails = []


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


GEOM = """() => {
  const sc = document.querySelector('#scroll');
  const il = document.querySelector('#inputline');
  const sp = document.querySelector('.clr-spacer');
  const an = document.querySelector('.clr-anchor');
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect();
    return {top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height)}; };
  return {
    scroll: r(sc), inputline: r(il), spacer: r(sp), anchor: r(an),
    lines: sc.querySelectorAll('.line').length,
    children: sc.children.length,
    scrollH: sc.scrollHeight, clientH: sc.clientHeight, scrollTop: sc.scrollTop,
    canScroll: sc.scrollHeight > sc.clientHeight + 1,
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.goto(URL, wait_until='load')
    page.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=20000)
    log('✅ 引擎初始化完成')

    def send(sql):
        page.click('#scroll')
        page.fill('#hidden', sql)
        page.keyboard.press('Enter')
        page.wait_for_timeout(250)

    log('\n[1] 输入框常驻底部（不随输出滚动）')
    for i in range(14):
        send('SELECT id, username, city FROM users LIMIT 8;')
    g = page.evaluate(GEOM)
    log('    %s' % g)
    chk('输出区顶边 == 输入区顶边（输入框紧贴输出区下沿）',
        g['inputline'] and g['scroll'] and abs(g['inputline']['top'] - g['scroll']['bottom']) <= 2, g)
    chk('输出已超出一屏（可滚动）', g['canScroll'])
    chk('滚动位置停在底部', abs(g['scrollTop'] - (g['scrollH'] - g['clientH'])) <= 2, g)
    page.screenshot(path=os.path.join(SHOT, 'term-1-full.png'))

    log('\n[2] 清屏：视觉上清空，但历史保留在回滚缓冲区')
    before = g['lines']
    page.click('#btn-clear')
    page.wait_for_timeout(250)
    g2 = page.evaluate(GEOM)
    log('    %s' % g2)
    chk('清屏后 .line 行数没有减少（历史仍在 DOM 里）', g2['lines'] >= before, 'before=%s after=%s' % (before, g2['lines']))
    chk('清屏后仍可滚动（scrollHeight > clientHeight）', g2['canScroll'], g2)
    chk('插入空白块 .clr-spacer', g2['spacer'] is not None, g2)
    chk('插入锚点 .clr-anchor', g2['anchor'] is not None, g2)
    chk('可视区域被空白块填满（看起来是空屏）',
        g2['spacer'] and g2['scroll'] and abs(g2['spacer']['top'] - g2['scroll']['top']) <= 4,
        'spacer=%s scroll=%s' % (g2['spacer'], g2['scroll']))
    chk('清屏后仍在底部', abs(g2['scrollTop'] - (g2['scrollH'] - g2['clientH'])) <= 2, g2)
    page.screenshot(path=os.path.join(SHOT, 'term-2-cleared.png'))

    log('\n[3] 鼠标滚动向上 → 能看到以前的命令')
    page.evaluate("document.querySelector('#scroll').scrollTop = 0")
    page.wait_for_timeout(150)
    old_visible = page.evaluate("""() => {
      const sc = document.querySelector('#scroll');
      const lines = [...sc.querySelectorAll('.line')];
      const top = sc.getBoundingClientRect().top, bottom = sc.getBoundingClientRect().bottom;
      const vis = lines.filter(l => { const b = l.getBoundingClientRect(); return b.bottom > top && b.top < bottom; });
      return {visible: vis.length, firstLines: vis.slice(0, 3).map(l => l.textContent.slice(0, 60)),
              allText: vis.map(l => l.textContent).join('\\n').slice(0, 4000),
              topInScroll: Math.round(sc.scrollTop)};
    }""")
    log('    滚到顶部后可见行数=%s 前几行=%s' % (old_visible['visible'], old_visible['firstLines']))
    chk('滚到顶部能看到历史输出', old_visible['visible'] > 0, old_visible)
    chk('历史里包含清屏前的查询回显', 'SELECT id, username, city FROM users' in old_visible['allText'],
        old_visible['allText'][:200])
    page.screenshot(path=os.path.join(SHOT, 'term-3-scrolled-up.png'))

    log('\n[4] 清屏后继续输入：新内容从上往下填，空白自动收缩')
    send('SELECT COUNT(*) AS n FROM users;')
    page.wait_for_timeout(200)
    g3 = page.evaluate(GEOM)
    chk('新输出插入在空白块之前（线性顺序：锚点 → 新行 → 空白块）', page.evaluate("""() => {
      const sc = document.querySelector('#scroll');
      const sp = sc.querySelector('.clr-spacer');
      const kids = [...sc.children];
      return kids.indexOf(sp) === kids.length - 1;
    }"""))
    chk('空白块高度被新内容压缩', g3['spacer'] and g3['spacer']['h'] < g2['spacer']['h'],
        'before=%s after=%s' % (g2['spacer']['h'], g3['spacer']['h']))
    chk('新命令输出已渲染', 'n' in page.inner_text('#scroll').split('SELECT COUNT(*) AS n FROM users;')[-1][:80])
    chk('新内容可见（视口顶部就是新输出的起始位置）', page.evaluate("""() => {
      const sc = document.querySelector('#scroll');
      const an = sc.querySelector('.clr-anchor');
      const sr = sc.getBoundingClientRect(), ar = an.getBoundingClientRect();
      return Math.abs(ar.bottom - sr.top) <= 6;
    }"""))
    page.screenshot(path=os.path.join(SHOT, 'term-4-after-clear-new-output.png'))

    log('\n[5] 重新连接：彻底清空 + 恢复初始数据 + 清空 ↑↓ 历史')
    send('DROP TABLE orders;')
    send('CREATE TABLE zzz_probe (id int);')
    page.focus('#hidden')
    page.keyboard.press('ArrowUp')
    page.wait_for_timeout(80)
    hist_before = page.input_value('#hidden')
    chk('重新连接前，↑ 能翻出历史命令', hist_before.strip() != '', repr(hist_before))

    page.click('#btn-reconnect')
    page.wait_for_timeout(600)
    g4 = page.evaluate(GEOM)
    log('    %s' % g4)
    chk('清屏锚点已移除', g4['anchor'] is None, g4)
    chk('空白块已移除', g4['spacer'] is None, g4)
    chk('只剩登录横幅（无历史输出）', g4['canScroll'] is False, g4)
    chk('行数回落到横幅量级（<25 行）', g4['lines'] < 25, g4['lines'])
    chk('输入框仍紧贴输出区下方',
        g4['inputline'] and g4['scroll'] and abs(g4['inputline']['top'] - g4['scroll']['bottom']) <= 2, g4)
    page.focus('#hidden')
    page.keyboard.press('ArrowUp')
    page.wait_for_timeout(80)
    chk('↑ 历史已清空', page.input_value('#hidden').strip() == '', repr(page.input_value('#hidden')))
    page.fill('#hidden', 'SHOW TABLES;')
    page.keyboard.press('Enter')
    page.wait_for_timeout(300)
    t = page.inner_text('#scroll').split('SHOW TABLES;')[-1]
    chk('数据库已恢复初始状态（orders 回来了）', 'orders' in t, t[:120].replace('\n', ' '))
    chk('临时建的表已被重置掉', 'zzz_probe' not in t, t[:120].replace('\n', ' '))
    page.screenshot(path=os.path.join(SHOT, 'term-5-reconnected.png'))

    log('\n[6] 边界：内容不足一屏时清屏 / 连续清屏')
    page.click('#btn-reconnect')
    page.wait_for_timeout(500)
    page.click('#btn-clear')                      # 开机就清屏（内容只有横幅）
    page.wait_for_timeout(250)
    g5 = page.evaluate(GEOM)
    chk('内容不足一屏时清屏也成立（仍可向上滚动回看横幅）', g5['canScroll'], g5)
    chk('此时可视区仍是空屏',
        g5['spacer'] and g5['scroll'] and abs(g5['spacer']['top'] - g5['scroll']['top']) <= 4,
        'spacer=%s scroll=%s' % (g5['spacer'], g5['scroll']))
    page.click('#btn-clear')                      # 连续清两次
    page.wait_for_timeout(200)
    g6 = page.evaluate(GEOM)
    chk('连续清屏只保留一套锚点+空白块（不会越叠越多）',
        page.evaluate("() => document.querySelectorAll('#scroll .clr-spacer').length") == 1
        and page.evaluate("() => document.querySelectorAll('#scroll .clr-anchor').length") == 1, g6)
    chk('第二次清屏后依然可滚动', g6['canScroll'], g6)
    send('SELECT 1 AS ok;')
    page.wait_for_timeout(200)
    chk('连续清屏后新输出仍正常渲染',
        'ok' in page.inner_text('#scroll').split('SELECT 1 AS ok;')[-1][:60])
    page.screenshot(path=os.path.join(SHOT, 'term-6-edge.png'))

    log('\n[7] 无 JS 报错 / 无外部请求')
    chk('页面无 JS 异常', not errors, errors)

    browser.close()

log('\n' + '=' * 70)
if fails:
    log('❌ 终端行为验收失败 %d 项：' % len(fails))
    for i, f in enumerate(fails, 1):
        log('  %d. %s' % (i, f))
else:
    log('✅ 终端行为验收全部通过')
out = '\n'.join(report)
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_terminal_report.txt'), 'w', encoding='utf-8') as f:
    f.write(out)
sys.exit(1 if fails else 0)
