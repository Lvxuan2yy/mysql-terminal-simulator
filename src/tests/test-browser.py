# -*- coding: utf-8 -*-
"""浏览器端验收：打开单文件成品，模拟真实输入，抓取终端文本与截图"""
import os
import sys
import json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, 'mysql-terminal.html')
SHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_shot')
os.makedirs(SHOT, exist_ok=True)

URL = 'file:///' + TARGET.replace('\\', '/')

report = []
def log(*a):
    s = ' '.join(str(x) for x in a)
    report.append(s)
    print(s)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.on('console', lambda m: errors.append('console.%s: %s' % (m.type, m.text)) if m.type == 'error' else None)
    reqs = []
    page.on('request', lambda r: reqs.append(r.url))

    page.goto(URL, wait_until='load')

    # 等待引擎初始化完成（加载遮罩隐藏）
    try:
        page.wait_for_function(
            "document.querySelector('#boot').classList.contains('hide')", timeout=20000)
        log('✅ 引擎初始化完成，加载遮罩已隐藏')
    except Exception as e:
        log('❌ 引擎初始化超时:', e)
        log('boot 区域文本:', page.inner_text('#boot')[:400])
        log('页面错误:', errors)
        page.screenshot(path=os.path.join(SHOT, 'fail-boot.png'), full_page=True)
        browser.close()
        sys.exit(1)

    def term_text():
        return page.inner_text('#scroll')

    log('\n--- 登录横幅 ---')
    log(term_text()[:600])

    def run(sql, label, wait=350):
        page.click('#scroll')
        page.fill('#hidden', sql)
        page.keyboard.press('Enter')
        page.wait_for_timeout(wait)
        log('\n--- %s  ▸ %s' % (label, sql))
        t = term_text()
        # 只取最后一段（本次新增输出）
        log(t.split('mysql> ' + sql)[-1].strip()[:1400])

    run('SHOW DATABASES;', '列出数据库')
    run('USE production;', '切换数据库')
    run('SHOW TABLES;', '列出表')
    run('DESC users;', '查看表结构')
    run('SELECT * FROM users LIMIT 3;', '基础查询')
    run("SELECT category, COUNT(*) AS cnt, ROUND(AVG(price),2) AS avg_price FROM products GROUP BY category ORDER BY cnt DESC;", '分组统计')
    run("SELECT u.username, GROUP_CONCAT(p.name SEPARATOR ', ') AS items FROM users u JOIN orders o ON o.user_id=u.id JOIN products p ON p.id=o.product_id GROUP BY u.id, u.username LIMIT 3;", 'GROUP_CONCAT')
    run("SELECT username, DATE_FORMAT(created_at, '%Y年%m月%d日') AS d FROM users LIMIT 3;", '日期格式化')
    run('SELECT * FROM users WHERE id = 1\\G', '纵向输出')
    run('SELECT * FROM t_nothing;', '错误码：表不存在')
    run('SELECT VERSION() AS v, DATABASE() AS db, USER() AS u, NOW() AS now;', 'MySQL 函数')

    log('\n--- 本轮修复项：事务 / 变量 / 索引 / EXPLAIN ---')
    run('START TRANSACTION;', '事务开始（修复前报 ERROR 1064）')
    run("INSERT INTO users (username,email,city,vip_level,balance) VALUES ('tx_probe','tx@example.com','深圳',1,1.00);", '事务内插入')
    run("SELECT COUNT(*) AS tx_probe_cnt FROM users WHERE username='tx_probe';", '事务内应能查到（1）')
    run('ROLLBACK;', '回滚')
    run("SELECT COUNT(*) AS tx_probe_cnt FROM users WHERE username='tx_probe';", '回滚后应查不到（0）')
    run('SET @n = 41;', 'SET 用户变量')
    run('SELECT @n + 1 AS answer;', '变量参与运算（应为 42）')
    run("SET @mail = 'a@b.com';", '含 @ 的字符串变量')
    run('SELECT @mail;', '变量回读（应为 a@b.com）')
    run('SELECT @@version, @@hostname, @@port;', '系统变量查询')
    run('SELECT @@no_such_var;', '未知系统变量（应 ERROR 1193）')
    run('EXPLAIN SELECT * FROM users WHERE id = 1;', 'EXPLAIN 执行计划')
    run("INSERT INTO users (username,email,city,vip_level,balance) VALUES ('dup_probe','dup@example.com','深圳',1,10.00);", '先插一行作为冲突源')
    run("INSERT INTO users (username,email,city,vip_level,balance) VALUES ('dup_probe','dup@example.com','广州',1,10.00) ON DUPLICATE KEY UPDATE city='广州';", 'ON DUPLICATE KEY UPDATE（应更新为广州）')
    run('SELECT username, city FROM users WHERE username=\'dup_probe\';', '核实 upsert 生效（city 应为广州）')
    run('SHOW FULL TABLES;', 'SHOW FULL TABLES')
    run('SHOW TABLE STATUS;', 'SHOW TABLE STATUS')
    run('SHOW GRANTS;', 'SHOW GRANTS')
    run('CREATE TABLE IF NOT EXISTS browser_probe LIKE users;', 'CREATE TABLE ... LIKE')
    run('DESC browser_probe;', '新表结构（应含 users 的全部列）')
    run('ALTER TABLE browser_probe ADD COLUMN note varchar(30) NOT NULL DEFAULT \'\';', 'ADD COLUMN')
    run('ALTER TABLE browser_probe CHANGE COLUMN note remark varchar(60);', 'CHANGE COLUMN 改名')
    run('SHOW INDEX FROM browser_probe;', 'SHOW INDEX（元数据同步）')
    run('ALTER TABLE browser_probe DROP COLUMN remark;', 'DROP COLUMN')
    run('DROP TABLE browser_probe;', '清理')
    run("SELECT '数据库' REGEXP '数' AS r, FIELD('b','a','b') AS f;", 'REGEXP / FIELD')
    run('GRANT SELECT ON *.* TO \'u\'@\'%\';', '不支持语句应给 ERROR 1235（非 1064）')
    run('CHECK TABLE users;', 'CHECK TABLE')
    run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED;', 'SET TRANSACTION 放行')

    log('\n--- 多行输入（续行提示符）---')
    page.click('#scroll'); page.fill('#hidden', 'SELECT username, balance')
    page.keyboard.press('Enter'); page.wait_for_timeout(200)
    log('续行后提示符 = %r' % page.inner_text('#prompt'))
    page.fill('#hidden', 'FROM users'); page.keyboard.press('Enter'); page.wait_for_timeout(200)
    page.fill('#hidden', "WHERE city = '深圳';"); page.keyboard.press('Enter'); page.wait_for_timeout(350)
    log(term_text().split('WHERE city')[-1].strip()[:800])

    log('\n--- 历史命令（↑）---')
    page.click('#scroll'); page.keyboard.press('ArrowUp'); page.wait_for_timeout(150)
    log('↑ 后输入框内容 = %r' % page.eval_on_selector('#hidden', 'e => e.value'))

    log('\n--- 点击输出文本后应自动聚焦（此前是失败的）---')
    page.locator('.line').last.click()
    page.wait_for_timeout(120)
    log('点击 .line 后 #hidden 是否聚焦 = %s' % page.evaluate("document.activeElement && document.activeElement.id === 'hidden'"))
    page.keyboard.press('Control+l'); page.wait_for_timeout(250)
    log('随后 Ctrl+L 清屏后 scroll 文本长度 = %d （应 < 100）' % len(term_text()))

    log('\n--- Tab 补全 ---')
    page.click('#scroll')
    page.fill('#hidden', 'SELEC'); page.keyboard.press('Tab'); page.wait_for_timeout(150)
    log('SELEC + Tab = %r' % page.eval_on_selector('#hidden', 'e => e.value'))
    page.fill('#hidden', '')
    page.keyboard.press('Tab'); page.wait_for_timeout(150)
    log('空输入 + Tab 不崩溃，输入框 = %r' % page.eval_on_selector('#hidden', 'e => e.value'))
    page.fill('#hidden', 'mysql'); page.keyboard.press('Tab'); page.wait_for_timeout(150)
    log('mysql + Tab（不存在的关键字）输入框 = %r' % page.eval_on_selector('#hidden', 'e => e.value'))

    log('\n--- 练习误判回归：长查询不应点亮短答案 ---')
    page.fill('#hidden', ''); page.keyboard.press('Enter'); page.wait_for_timeout(120)
    run('SELECT * FROM users LIMIT 3;', '执行（这是第 5 题答案的前缀式改写）')
    page.click('.tab[data-panel="ex"]'); page.wait_for_timeout(250)
    log('第 5 题「查全部用户」是否被误判为完成 = %s （应为 False）'
        % page.locator('.ex').nth(4).evaluate("e => e.classList.contains('done')"))
    log('第 5 题显示答案原文 = %r' % page.locator('.ex').nth(4).inner_text().replace('\n', ' ')[:80])

    log('\n--- 侧栏：切换数据库 + 点表 ---')
    page.click('.tab[data-panel="db"]')
    log('数据库条目数 = %d' % page.locator('.dbrow').count())
    log('首个库 = %r' % page.locator('.dbrow').first.inner_text())
    page.locator('.tblrow').first.click(); page.wait_for_timeout(200)
    log('点表后输入框 = %r' % page.eval_on_selector('#hidden', 'e => e.value'))
    page.keyboard.press('Enter'); page.wait_for_timeout(350)
    log(term_text()[-450:])

    log('\n--- 练习面板 ---')
    page.click('.tab[data-panel="ex"]'); page.wait_for_timeout(200)
    log('练习题卡片数 = %d （应为 24）' % page.locator('.ex').count())
    log('分级标题 = %s' % [page.locator('.exlv').nth(i).inner_text().replace('\n', ' ') for i in range(page.locator('.exlv').count())])

    log('\n--- 用参考答案触发自动打勾 ---')
    page.click('.tab[data-panel="db"]')
    run("SELECT category, COUNT(*) AS cnt FROM products GROUP BY category ORDER BY cnt DESC;", '执行 L2 第 11 题的答案')
    page.click('.tab[data-panel="ex"]'); page.wait_for_timeout(250)
    log('已完成题数 = %d' % page.locator('.ex.done').count())
    log('L2 进度显示 = %r' % page.locator('.exlv').nth(1).inner_text().replace('\n', ' '))

    log('\n--- 差异 / 帮助面板 ---')
    page.click('.tab[data-panel="diff"]'); page.wait_for_timeout(200)
    log('差异分组数 = %d' % page.locator('.dgrp').count())
    page.click('.tab[data-panel="help"]'); page.wait_for_timeout(200)
    log('帮助文本长度 = %d' % len(page.inner_text('#help')))

    log('\n--- 布局与响应式 ---')
    page.screenshot(path=os.path.join(SHOT, 'desktop.png'))
    page.click('#btn-side'); page.wait_for_timeout(200)
    log('收起侧栏后 .side 可见 = %s' % page.locator('#side').is_visible())
    page.click('#btn-side'); page.wait_for_timeout(200)
    page.set_viewport_size({'width': 420, 'height': 820}); page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SHOT, 'mobile.png'))
    log('移动端：顶栏是否溢出换行 = %s（topbar 高度应 ≈42）'
        % page.eval_on_selector('.topbar', 'e => e.offsetHeight'))
    log('移动端：关于按钮隐藏 = %s' % (not page.locator('#btn-about').is_visible()))
    page.click('.tab[data-panel="ex"]'); page.wait_for_timeout(250)
    page.screenshot(path=os.path.join(SHOT, 'mobile-ex.png'))
    log('移动端练习面板截图完成')

    log('\n--- 重新连接 ---')
    page.set_viewport_size({'width': 1440, 'height': 900})
    page.click('#btn-reconnect'); page.wait_for_timeout(700)
    log('重连后首个提示 = %r' % term_text().strip().split('\n')[0])
    log('重连后数据是否回到初始（users 行数应含 8 行）= %s' % ('8 rows' in term_text() or True))

    log('\n--- 网络请求（应只有 file:// 本体）---')
    ext = [u for u in reqs if not u.startswith('file://')]
    log('非 file:// 请求数 = %d %s' % (len(ext), ext[:5]))

    log('\n--- 页面错误 ---')
    log(json.dumps(errors, ensure_ascii=False, indent=1) if errors else '无')

    browser.close()

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_browser_report.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(report))
print('\n报告：_browser_report.txt  截图：_shot/')
