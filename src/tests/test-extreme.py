# -*- coding: utf-8 -*-
"""极端场景验收：进度持久化在各内核下的表现 + 文件损坏时的兜底提示"""
import os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, 'mysql-terminal.html')
TMP = os.path.join(ROOT, 'src', 'tests', '_portable')
os.makedirs(TMP, exist_ok=True)

def url_of(p):
    return 'file:///' + p.replace('\\', '/')

lines = []
def log(s):
    print(s); lines.append(s)

with sync_playwright() as p:
    # ---- A. 各内核下 localStorage（练习进度）可写性与持久化 ----
    log('=== A. 练习进度（localStorage）在各内核下的表现 ===')
    for engine_name in ('chromium', 'firefox', 'webkit'):
        try:
            browser = getattr(p, engine_name).launch()
        except Exception as e:
            log('[%-8s] 跳过: %s' % (engine_name, str(e)[:60])); continue
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(url_of(TARGET), wait_until='load')
        page.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=30000)
        writable = page.evaluate("""() => {
            try { localStorage.setItem('__probe__','1'); const v = localStorage.getItem('__probe__');
                  localStorage.removeItem('__probe__'); return v === '1' ? 'yes' : 'silent-fail'; }
            catch (e) { return 'throws:' + e.name; }
        }""")
        # 真跑一次「做题」流程，看是否落盘
        page.click('#scroll'); page.fill('#hidden', 'SELECT * FROM users;')
        page.keyboard.press('Enter'); page.wait_for_timeout(300)
        keys = page.evaluate("() => { try { return Object.keys(localStorage); } catch(e){ return ['<blocked>']; } }")
        page.reload(wait_until='load')
        page.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=30000)
        page.click('.tab[data-panel="ex"]'); page.wait_for_timeout(300)
        kept = page.locator('.ex.done').count()
        log('[%-8s] localStorage 可写=%s  落盘键=%s  刷新后仍记住的题数=%d'
            % (engine_name, writable, keys, kept))
        ctx.close(); browser.close()

    # ---- B. 文件在传输中损坏/被截断 ----
    log('')
    log('=== B. 文件损坏/被截断时的兜底 ===')
    orig = open(TARGET, 'rb').read()
    cases = [
        ('尾部被截断 10%（约 100 KB）', orig[:int(len(orig) * 0.90)]),
        ('只传了一半',                  orig[:len(orig) // 2]),
        ('头部被杀毒软件改动 1 字节',    b'X' + orig[1:]),
    ]
    browser = p.chromium.launch()
    for label, data in cases:
        bad = os.path.join(TMP, 'broken.html')
        with open(bad, 'wb') as f:
            f.write(data)
        page = browser.new_page(viewport={'width': 1100, 'height': 700})
        page.goto(url_of(bad), wait_until='load')
        page.wait_for_timeout(17000)   # 自检守卫是 15 秒兜底，这里等它触发
        try:
            boot_visible = page.locator('#boot').is_visible()
            boot_txt = page.inner_text('#boot').replace('\n', ' ') if boot_visible else ''
            scroll_len = len(page.inner_text('#scroll') or '')
        except Exception:
            boot_visible, boot_txt, scroll_len = False, '', 0
        if boot_visible and '⚠️' in boot_txt:
            verdict = '✅ 有明确提示，未白屏'
        elif not boot_visible and scroll_len > 50:
            verdict = '✅ 仍能正常启动（截断未伤及运行必需的代码）'
        else:
            verdict = '❌ 白屏且无任何提示'
        log('[%s] %s' % (label, verdict))
        if boot_txt:
            log('      文案：%s' % boot_txt[:170])
        page.close()
    browser.close()

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_extreme_report.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print('\n报告：_extreme_report.txt')
