# -*- coding: utf-8 -*-
"""便携性验收：验证单文件成品换电脑/换路径/断网/环境受限时是否仍可用"""
import os, shutil, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'mysql-terminal.html')
TMP = os.path.join(ROOT, 'src', 'tests', '_portable')
if os.path.isdir(TMP):
    shutil.rmtree(TMP)
os.makedirs(TMP)

# 场景 1：拷到「带中文、带空格、带括号」的目录，并改名
DEST_DIR = os.path.join(TMP, '期末 复习资料 (2026)', 'MySQL 模拟器 测试')
os.makedirs(DEST_DIR)
DEST = os.path.join(DEST_DIR, 'MySQL 终端模拟器.html')
shutil.copy2(SRC, DEST)

report = []
def log(*a):
    s = ' '.join(str(x) for x in a)
    report.append(s)
    print(s)

def url_of(path):
    return 'file:///' + path.replace('\\', '/')

def probe(page, label):
    """等引擎起来并跑一条查询，返回是否可用"""
    try:
        page.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=20000)
    except Exception:
        txt = page.inner_text('#boot')[:200].replace('\n', ' ')
        return False, '初始化失败/超时 → ' + txt
    page.click('#scroll')
    page.fill('#hidden', 'SELECT COUNT(*) AS n FROM users;')
    page.keyboard.press('Enter')
    page.wait_for_timeout(400)
    t = page.inner_text('#scroll')
    if '8' in t.split('SELECT COUNT(*) AS n FROM users;')[-1][:120]:
        return True, '查询返回正常'
    return False, '终端输出异常: ' + t[-200:].replace('\n', ' ')

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- 场景 1：中性路径（原始位置）作对照 ----
    page = browser.new_page(viewport={'width': 1280, 'height': 860})
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url_of(SRC), wait_until='load')
    ok, msg = probe(page, '原始路径')
    log('[1] 原始路径（ASCII）              : %s — %s' % ('✅ 可用' if ok else '❌ 失败', msg))
    page.close()

    # ---- 场景 2：中文+空格+括号路径 + 改名 ----
    page = browser.new_page(viewport={'width': 1280, 'height': 860})
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url_of(DEST), wait_until='load')
    ok, msg = probe(page, '中文路径')
    log('[2] 中文/空格/括号路径 + 中文改名   : %s — %s' % ('✅ 可用' if ok else '❌ 失败', msg))
    page.close()

    # ---- 场景 3：完全断网（模拟内网/飞行模式电脑）----
    ctx = browser.new_context(offline=True, viewport={'width': 1280, 'height': 860})
    page = ctx.new_page()
    reqs = []
    page.on('request', lambda r: reqs.append(r.url))
    page.goto(url_of(SRC), wait_until='load')
    ok, msg = probe(page, '断网')
    ext = [u for u in reqs if not u.startswith('file://')]
    log('[3] 完全断网运行                    : %s — %s（外部请求 %d 条）'
        % ('✅ 可用' if ok else '❌ 失败', msg, len(ext)))
    ctx.close()

    # ---- 场景 4：浏览器禁用 localStorage（隐私模式/企业策略）----
    ctx = browser.new_context(viewport={'width': 1280, 'height': 860})
    ctx.add_init_script("""
      Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('localStorage is disabled', 'SecurityError'); }
      });
    """)
    page = ctx.new_page()
    perr = []
    page.on('pageerror', lambda e: perr.append(str(e)))
    page.goto(url_of(SRC), wait_until='load')
    ok, msg = probe(page, '禁用 localStorage')
    log('[4] 浏览器禁用 localStorage         : %s — %s%s'
        % ('✅ 可用' if ok else '❌ 失败', msg,
           ('（有未捕获异常：%s）' % perr[0][:80]) if perr else ''))
    ctx.close()

    # ---- 场景 5：浏览器不支持 WebAssembly（模拟老内核/IE 模式）----
    ctx = browser.new_context(viewport={'width': 1280, 'height': 860})
    ctx.add_init_script("""
      delete window.WebAssembly;
      Object.defineProperty(window, 'WebAssembly', { get() { return undefined; } });
    """)
    page = ctx.new_page()
    page.goto(url_of(SRC), wait_until='load')
    page.wait_for_timeout(3000)
    boot_visible = page.locator('#boot').is_visible()
    boot_txt = ''
    try:
        boot_txt = page.inner_text('#boot')[:220].replace('\n', ' ')
    except Exception:
        pass
    log('[5] 不支持 WebAssembly 的老内核      : %s'
        % ('✅ 有友好提示，不会白屏' if boot_visible else '⚠️ 遮罩被隐藏了，需人工确认'))
    log('      提示文案：%s' % boot_txt)
    ctx.close()

    browser.close()

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_portable_report.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(report))
print('\n报告：_portable_report.txt')
