# MySQL 终端模拟器 · 离线单文件版

在浏览器里跑的 `mysql` 命令行模拟器。打开一个 HTML 文件就是一个 `mysql>` 提示符，可以照常敲 SQL —— 建库建表、增删改查、多表连接、聚合分组、事务、索引、视图、系统变量、`EXPLAIN`，**行为、报错码、表格排版都按 MySQL 8.0 的风格来**。

底层是编译成 WebAssembly 的 **SQLite 3.49.1**，外面套了一层自己写的 **MySQL 方言兼容层**。整个引擎 + 示例数据 + 界面全部内联在一个 HTML 文件里：

> **双击即用 · 全程不联网 · 不装任何软件 · 不写注册表 · 不上传任何数据**

```
mysql> SELECT city, COUNT(*) AS 人数 FROM users GROUP BY city ORDER BY 人数 DESC;
+--------+--------+
| city   | 人数   |
+--------+--------+
| 深圳   |      5 |
| 上海   |      3 |
| 北京   |      2 |
+--------+--------+
3 rows in set (0.00 sec)
```

---

## 快速开始

1. 下载 [`mysql-terminal.html`](mysql-terminal.html)（约 1 MB）
2. 双击用浏览器打开（推荐 Chrome / Edge / Firefox）
3. 直接敲 SQL，语句以 `;` 结尾回车执行

不需要起服务、不需要 npm install、不需要联网。

### 终端行为（和真实终端一致）

| 操作 | 行为 |
|---|---|
| `clear` / `Ctrl+L` | 只清**当前一屏**，旧输出留在回滚缓冲里，滚轮上滚可回看 |
| `Ctrl+R` / 右上角「重新连接」 | **唯一的彻底重置**：重建数据库 + 清屏 + 清空 ↑↓ 历史 |
| `↑` `↓` | 翻阅历史命令 |
| `Tab` | 补全 SQL 关键字与表名 |
| `Ctrl+C` | 放弃当前输入 |
| `\G` 结尾 | 结果纵向显示 |
| `help` / `status` | 帮助 / 连接状态 |

---

## 已实现的功能

**DDL** — `CREATE/DROP DATABASE`、`CREATE TABLE`（含 `IF NOT EXISTS`、`CREATE TABLE ... LIKE`）、`DROP TABLE`（支持一次删多张）、`ALTER TABLE` 的 `ADD/DROP/MODIFY/CHANGE/RENAME COLUMN`、`ADD/DROP INDEX|KEY`、`RENAME TABLE`、`TRUNCATE TABLE`

**视图** — `CREATE VIEW`、`CREATE OR REPLACE VIEW`、`ALTER VIEW`、`DROP VIEW`。建视图时会像真实 MySQL 一样**立刻校验引用的表和列**，引用错了直接报 `1146`/`1054`，不会留下一个用不了的视图

**DML** — `INSERT`、`INSERT IGNORE`、`INSERT ... SELECT`、`REPLACE INTO`、`UPDATE`（含 `LIMIT`）、`DELETE`（含 `LIMIT`）

**查询** — 多表 `JOIN`（LEFT/RIGHT/INNER/CROSS）、`GROUP BY`/`HAVING`、`ORDER BY`、`LIMIT a,b`、`DISTINCT`、子查询、`UNION`、`CASE WHEN`、`IN`/`BETWEEN`/`LIKE`/`RLIKE`、窗口函数（`RANK`/`ROW_NUMBER`/`DENSE_RANK OVER`）、`EXPLAIN`

**元数据** — `SHOW DATABASES`、`SHOW TABLES [LIKE]`、`SHOW FULL TABLES`（`Table_type` 标 `BASE TABLE`/`VIEW`）、`SHOW COLUMNS/FIELDS`、`SHOW CREATE TABLE`、`SHOW CREATE VIEW`、`SHOW INDEX/KEYS`、`SHOW VARIABLES`、`SHOW STATUS`、`SHOW ENGINES`、`SHOW TABLE STATUS`、`SHOW PROCESSLIST`、`SHOW WARNINGS`、`DESC`/`DESCRIBE`

**事务** — `START TRANSACTION`、`BEGIN`、`COMMIT`、`ROLLBACK`、`SAVEPOINT`、`ROLLBACK TO`（回滚是真实生效的）

**变量** — 用户变量 `SET @x = 1` / `SELECT @x`；系统变量 `@@version`、`@@port`；`SET NAMES`、`SET autocommit`、`SET sql_mode`

**函数** — 48 个 MySQL 专有函数（`CONCAT_WS`、`GROUP_CONCAT ... SEPARATOR`、`DATE_FORMAT`、`IFNULL`、`FIELD`、`LAST_DAY`、`UUID` 等），加上 SQLite 全部内置函数

**语法自动转译** — 写 MySQL 写法即可，无需改写：`AUTO_INCREMENT`、`ENGINE=InnoDB`、`DEFAULT CHARSET`、`COLLATE`、`COMMENT`、`ENUM`/`SET`/`JSON` 类型、`UNSIGNED`/`ZEROFILL`、反引号、`LIMIT a, b`、`INSERT ... ON DUPLICATE KEY UPDATE`

**学习辅助** — 24 道练习题（基础/进阶/挑战三档，判分忽略大小写与多余空格）、20 条与真实 MySQL 的差异说明、「帮助」面板

---

## 明确不做的

不做的事情会**返回真实原因**，而不是伪装成能跑：

| 不做的 | 说明 |
|---|---|
| 存储过程 / 触发器 / 事件 | 未实现，报 `1235` |
| `PREPARE` / `EXECUTE` | 预处理语句未实现 |
| `GRANT` / `REVOKE` / `CREATE USER` | 不做权限校验，一律以 `root@localhost` 执行 |
| `LOAD DATA` / `SELECT ... INTO OUTFILE` | 浏览器沙箱内没有文件系统 |
| `UPDATE/DELETE ... JOIN` | 底层只支持单表写，建议改写成 `WHERE EXISTS (SELECT 1 ...)` |
| 透过视图写数据 | 报 `1288 ... is not updatable` |
| `BACKUP DATABASE` / `RESTORE` | MySQL **社区版本身没有**这条 SQL，是企业版组件；社区版靠 `mysqldump` |
| `mysqldump` | 那是 shell 命令，不是客户端 SQL |

**语义层面的差异**（底层是 SQLite 不是 InnoDB）：没有隔离级别 / 行级锁 / MVCC；`DECIMAL` 不补尾随零；不写 `ORDER BY` 时不保证行序；字符串比较默认区分大小写（MySQL 默认不区分）；`||` 是字符串连接而非逻辑 OR。

完整清单见程序内「差异」面板。

---

## 项目结构

```
.
├── mysql-terminal.html        # 成品（由 src/build.py 生成，勿手改）
├── 交接文档.md                # 技术交接 / 维护说明
├── pack-dist.py               # 打包：HTML + README → dist/*.zip
├── src/                       # 源码
│   ├── template.html          #   HTML 骨架 + 5 个注入占位符
│   ├── app.css                #   样式
│   ├── app.js                 #   交互层：终端渲染 / 键盘 / 历史 / 补全 / 侧栏
│   ├── mysql-core.js          #   核心层：方言转译 / 元数据 / 排版 / 错误码 / 引擎
│   ├── build.py               #   构建：全部内联成单文件 HTML
│   └── tests/                 #   测试
└── vendor/
    ├── sql-wasm.js            #   sql.js 胶水层
    └── sql-wasm.wasm          #   SQLite 3.49.1 编译产物
```

**核心层 `mysql-core.js` 刻意不依赖 DOM**，因此可以直接在 Node 里 `require` 做回归测试 —— 这是整个测试体系能跑起来的前提。

---

## 构建

```bash
cd src
python build.py
# → 输出 ../mysql-terminal.html，并打印体积 + 外部资源静态检查结果
```

`build.py` 把 `template.html`、`app.css`、`app.js`、`mysql-core.js`、`vendor/sql-wasm.js` 内联，并把 `sql-wasm.wasm` 做 base64 编码塞进 `window.__SQLJS_WASM_B64`，从而做到零外部请求。

打包成 zip 交付件：

```bash
python pack-dist.py
# → dist/MySQL终端模拟器-离线单文件版.zip（含 README.txt）
```

---

## 测试

**Node 侧**（核心层逻辑 / 判定逻辑）：

```bash
cd src/tests
NODE_PATH=../.. node test-core.cjs      # 核心层全量
node test-view.cjs                      # 视图全链路
node test-exercise.cjs                  # 24 题 × 各种等价写法 + 反例 + 串台检查
node probe-gaps.cjs                     # 特性缺口普查
```

**Playwright 侧**（真浏览器）：

```bash
cd src/tests
python test-browser.py          # 端到端交互
python test-terminal.py         # 终端行为 26 项
python test-exercise-ui.py      # 练习判分 UI
python test-portable.py         # 中文路径 / 断网 / 禁 localStorage / 老内核
python test-crossbrowser.py     # chromium / firefox / webkit
python test-extreme.py          # 文件截断 / 损坏兜底
```

每个脚本把报告写成 `_*_report.txt`（已在 `.gitignore` 中忽略）。

**当前基线**：核心层 `failures = 0`；视图 35+ 用例全过；缺口普查 112 通过 / 13 条预期不支持 / **0 条伪装成 1064 的假语法错**；终端行为、便携性、跨内核、极端情况全部通过。

**改动后的标准动作**：

```
改 src/*  →  python src/build.py  →  跑测试确认全绿  →  python pack-dist.py
```

---

## 环境要求

需要 2017 年以后发布的浏览器：Chrome 57+ / Edge 16+ / Firefox 52+ / Safari 11+。
用 360、QQ、搜狗等双核浏览器时，请把内核切到「极速模式」。

**会改动我的电脑吗？** 不会。不装东西、不写注册表、不联网、不上传数据。数据只存在浏览器内存里，关掉标签页就没了；唯一的本地记录是「练习题做到第几题」（localStorage，几个字节）。

---

## 许可与第三方声明

本项目自身代码采用 **MIT License**，详见 [`LICENSE`](LICENSE)。

另使用了以下第三方组件，详见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)：

- **sql.js** — MIT License（<https://github.com/sql-js/sql.js>）
- **SQLite** — Public Domain（<https://www.sqlite.org/copyright.html>）

## 免责声明

本项目是**学习用途的仿真工具**，与 Oracle / MySQL 官方无任何关系，也不代表其立场。
底层引擎是 SQLite 而非真正的 MySQL，部分语法与行为存在差异 —— 请以程序内「差异」面板的诚实清单为准。
