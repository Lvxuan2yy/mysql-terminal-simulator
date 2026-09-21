# -*- coding: utf-8 -*-
"""打包交付件：成品 HTML + 中文使用说明 → 一个 zip，便于分发给使用者"""
import os, zipfile, hashlib

ROOT = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(ROOT, 'mysql-terminal.html')
OUT_DIR = os.path.join(ROOT, 'dist')
os.makedirs(OUT_DIR, exist_ok=True)

data = open(HTML, 'rb').read()
size = len(data)
sha = hashlib.sha256(data).hexdigest()

README = """MySQL 终端模拟器 · 离线单文件版
================================================

【这是什么】
  一个在浏览器里运行的 MySQL 命令行模拟器。打开后就是一个 mysql> 提示符，
  可以照常敲 SQL —— 建库建表、增删改查、多表连接、聚合分组、事务、索引、
  视图、系统变量、EXPLAIN 执行计划……行为、报错信息和表格排版都按 MySQL 8.0 的风格来。

  底层是 SQLite 编译成的 WebAssembly，整个引擎都装在这一个 HTML 文件里。
  所以：不需要联网、不需要装 MySQL、不需要装任何软件、不写注册表。

【怎么用】
  1. 双击 mysql-terminal.html，用浏览器打开即可（推荐 Chrome / Edge / Firefox）。
  2. 打开后直接敲 SQL，语句以 ; 结尾再回车就会执行；不写 ; 会进入续行模式。
  3. 右侧「练习」标签有 24 道题（基础 / 进阶 / 挑战三档），做对会自动打勾。
  4. 「差异」标签写清了哪些 MySQL 特性没实现，先看一眼能少踩坑。
  5. 「帮助」标签有全部可用命令和快捷键。

【终端行为（和真实终端一致）】
  · mysql> 输入行永远固定在终端底部，不会被输出顶走。
  · 清屏（clear / Ctrl+L）只清「当前一屏」，旧输出留在回滚缓冲里 ——
    鼠标滚轮往上滚就能回看以前的命令，清屏后新输出从屏幕顶部往下填。
  · 要彻底清空、并把示例数据恢复到初始状态，请点右上角「重新连接」（Ctrl+R）：
    它会重建数据库、清空屏幕，也会清空 ↑↓ 命令历史。
  · ↑ ↓ 翻阅输入过的命令，Tab 补全关键字与表名，Ctrl+C 放弃当前输入。

【视图（VIEW）】
  已经完整支持，可以放心当真实 MySQL 练：
    CREATE VIEW v AS SELECT ...;              -- 建视图
    CREATE OR REPLACE VIEW v AS SELECT ...;   -- 覆盖已有视图
    ALTER VIEW v AS SELECT ...;               -- 改定义
    DROP VIEW v;   /   DROP VIEW IF EXISTS v;
    SELECT ... FROM v;  /  DESC v;  /  SHOW CREATE VIEW v;
  SHOW TABLES 会把视图一起列出来；SHOW FULL TABLES 的 Table_type 列会标出
  BASE TABLE / VIEW。建视图时会像真实 MySQL 一样立刻校验引用的表和列是否存在，
  引用错了直接报 1146 / 1054，不会留下一个用不了的视图。
  左侧表列表里，视图用 ◇ 标记。

  注意：真实 MySQL 允许对「简单可更新视图」直接 INSERT/UPDATE/DELETE 并写回基表，
  本模拟器不支持这种写法，会报 ERROR 1288。

【关于备份】
  MySQL 社区版本身没有 BACKUP DATABASE 这条 SQL —— 那是企业版
  （MySQL Enterprise Backup）的商业组件；社区版的备份靠操作系统命令行的
  mysqldump 完成，不是在 mysql 客户端里敲 SQL。所以模拟器里如实报语法错误
  并给出说明，没有凭空造一条 MySQL 不存在的命令。

【环境要求】
  需要 2017 年以后发布的浏览器：
  Chrome 57+ / Edge 16+ / Firefox 52+ / Safari 11+
  如果你用的是 360、QQ、搜狗等双核浏览器，请把地址栏右侧的内核开关
  切到「极速模式」再刷新。

【常见问题】
  Q: 双击后没反应，或者弹出"选择打开方式"？
  A: 右键文件 → 打开方式 → 选浏览器（Chrome / Edge）即可。

  Q: 一直停在"正在初始化 MySQL 引擎…"不动？
  A: 多半是文件没传完整（正常大小约 {mb:.2f} MB）。重新获取一份完整文件再试。

  Q: 提示"当前浏览器无法运行本工具"？
  A: 浏览器内核太旧，或者被切到了 IE 兼容模式。按提示换浏览器、或切「极速模式」。

  Q: 会改动我的电脑吗？安全吗？
  A: 不会、安全。不装任何东西、不写注册表、不联网、不上传任何数据。
     所有数据只存在浏览器内存里，关掉标签页就没了。
     唯一的本地记录是"练习题做到第几题"（浏览器 localStorage，几个字节），
     清空浏览器数据即可清除。

  Q: 能拷给别人用吗？
  A: 可以，就直接发这一个 HTML 文件。对方不需要装任何东西。

  Q: 我写的 SQL 感觉跟答案差不多，为什么没打勾？
  A: 判定按「同一条语句的不同写法」来算，下面这些差异都会自动忽略：
       大小写、多余空格、逗号/括号两侧有没有空格、有没有反引号、
       单字母表别名（SELECT u.username ... FROM users u 等同于 SELECT username ... FROM users）
     但列数、条件、表名必须真的对得上。比如第 6 题"只查询用户名和邮箱两列"：
       ✓ select username,email from users;
       ✓ SELECT `username`, `email` FROM users;
       ✓ SELECT u.username, u.email FROM users u;
       ✗ SELECT * FROM users;                    （列数多了）
       ✗ SELECT username FROM users;             （列数少了）

  Q: 点「重新连接」会把我做过的练习清空吗？
  A: 不会。重新连接只重置数据库和屏幕显示；练习进度存在浏览器本地，
     刷新页面、重新连接都还在。清空浏览器数据才会归零。

【文件信息】
  文件名    : mysql-terminal.html
  大小      : {size:,} 字节（约 {mb:.2f} MB）
  SHA-256   : {sha}
  校验方法  : Windows 命令行执行
              certutil -hashfile mysql-terminal.html SHA256
              输出值应与上面一致；不一致说明文件损坏或被改动过。

【声明】
  本项目是学习用途的仿真工具，与 Oracle / MySQL 官方无关。
  底层引擎是 SQLite 而非真正的 MySQL，部分语法与行为存在差异 ——
  程序内「差异」面板里有完整的诚实清单，请以它为准。
""".format(size=size, mb=size / 1024 / 1024, sha=sha)

readme_path = os.path.join(OUT_DIR, 'README.txt')
# 用 UTF-8 with BOM，保证 Windows 记事本打开中文不乱码
with open(readme_path, 'w', encoding='utf-8-sig', newline='\r\n') as f:
    f.write(README)

zip_name = 'MySQL终端模拟器-离线单文件版.zip'
zip_path = os.path.join(OUT_DIR, zip_name)
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.write(HTML, 'mysql-terminal.html')
    z.write(readme_path, 'README.txt')

print('zip 路径 :', zip_path)
print('zip 大小 :', os.path.getsize(zip_path), '字节')
print('内含     :')
with zipfile.ZipFile(zip_path) as z:
    for i in z.infolist():
        print('   %-24s %8d 字节' % (i.filename, i.file_size))
print('HTML SHA-256 :', sha)
