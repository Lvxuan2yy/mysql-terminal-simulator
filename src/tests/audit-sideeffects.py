# -*- coding: utf-8 -*-
"""副作用审计：实际使用一轮后，检查浏览器侧到底留下了什么、有没有对外行为"""
import os
import json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URL = 'file:///' + os.path.join(ROOT, 'mysql-terminal.html').replace('\\', '/')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context()
    page = ctx.new_page()
    reqs, errs = [], []
    page.on('request', lambda r: reqs.append(r.url))
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)

    page.goto(URL, wait_until='load')
    page.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=20000)

    # 造点"破坏性"操作：建库、建表、插数据、删库
    for sql in ['CREATE DATABASE hack;', 'USE hack;',
                "CREATE TABLE t (id int(11) NOT NULL AUTO_INCREMENT, v varchar(20), PRIMARY KEY(id)) ENGINE=InnoDB;",
                "INSERT INTO t (v) VALUES ('a'),('b');",
                'SELECT * FROM t;', 'DROP DATABASE hack;', 'SELECT * FROM users;']:
        page.click('#scroll'); page.fill('#hidden', sql); page.keyboard.press('Enter')
        page.wait_for_timeout(150)

    audit = page.evaluate("""() => ({
      localStorageKeys: Object.keys(localStorage),
      localStorageRaw: JSON.parse(JSON.stringify(localStorage)),
      sessionStorageKeys: Object.keys(sessionStorage),
      cookie: document.cookie,
      origin: location.origin,
      protocol: location.protocol,
      serviceWorker: 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'active' : 'none') : 'unsupported',
      caches: typeof caches !== 'undefined',
      indexedDBdbs: 'indexedDB' in window ? 'present-but-unused' : 'absent',
      webAssemblyHeapMB: (performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : 'n/a')
    })""")

    print('协议 / origin        :', audit['protocol'], '/', audit['origin'])
    print('localStorage 键的数量 :', len(audit['localStorageKeys']), audit['localStorageKeys'])
    for k, v in audit['localStorageRaw'].items():
        print('   %s = %s  (%d 字节)' % (k, v, len(str(v))))
    print('sessionStorage       :', audit['sessionStorageKeys'] or '空')
    print('cookie               :', repr(audit['cookie']) or '空')
    print('Service Worker       :', audit['serviceWorker'])
    print('页内 JS 堆占用        :', audit['webAssemblyHeapMB'], 'MB（关掉标签页即释放）')

    ext = [u for u in reqs if not u.startswith('file://')]
    print('非 file:// 请求       :', len(ext), ext[:3])
    print('页面错误              :', len(errs))

    # 再开一个干净上下文，确认"没有残留"（新上下文应该回到初始数据）
    ctx2 = b.new_context()
    p2 = ctx2.new_page()
    p2.goto(URL, wait_until='load')
    p2.wait_for_function("document.querySelector('#boot').classList.contains('hide')", timeout=20000)
    p2.click('#scroll'); p2.fill('#hidden', 'SHOW DATABASES;'); p2.keyboard.press('Enter')
    p2.wait_for_timeout(250)
    txt = p2.inner_text('#scroll')
    print('\n干净上下文里的数据库列表（应无 hack）:', 'hack' in txt and '⚠️ 残留！' or 'hack 不存在 ✅')
    print('干净上下文 localStorage 键数 :', p2.evaluate('Object.keys(localStorage).length'))
    b.close()
