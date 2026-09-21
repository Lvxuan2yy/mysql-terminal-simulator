# -*- coding: utf-8 -*-
"""视图功能的浏览器端可视化验收（含侧栏显示）"""
import os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, 'mysql-terminal.html')
SHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_shot')
os.makedirs(SHOT, exist_ok=True)
URL = 'file:///' + TARGET.replace('\\', '/')

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
        page.wait_for_timeout(160)

    for s in [
        "CREATE VIEW v_user_orders AS SELECT u.username, u.city, COUNT(o.id) AS order_cnt, SUM(o.total) AS spent FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.username, u.city;",
        "SELECT * FROM v_user_orders ORDER BY spent DESC LIMIT 5;",
        "SHOW FULL TABLES;",
        "DESC v_user_orders;",
        "SHOW CREATE VIEW v_user_orders\\G",
    ]:
        send(s)

    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOT, 'view-1-overview.png'))
    print('side list:', page.inner_text('#tbllist'))
    print('page errors:', errs)
    b.close()
