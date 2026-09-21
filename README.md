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

**DDL** — `CREATE/DROP DATABASE`、`CREATE TABLE`（含 `IF NOT EXISTS`、`CREATE TABLE ... LIKE`、`... AS SELECT`、表级 `AUTO_INCREMENT=N`）、`CREATE/DROP TEMPORARY TABLE`、`DROP TABLE`（支持一次删多张）、`ALTER TABLE` 的 `ADD/DROP/MODIFY/CHANGE/RENAME COLUMN`、`ADD/DROP INDEX|KEY`、`ALTER TABLE ... AUTO_INCREMENT=N`、`RENAME TABLE`、`TRUNCATE TABLE`

**视图** — `CREATE VIEW`、`CREATE OR REPLACE VIEW`、`ALTER VIEW`、`DROP VIEW`。建视图时会像真实 MySQL 一样**立刻校验引用的表和列**，引用错了直接报 `1146`/`1054`，不会留下一个用不了的视图

**DML** — `INSERT`、`INSERT IGNORE`、`INSERT ... SELECT`、`INSERT ... SET`、`REPLACE INTO`、`INSERT ... ON DUPLICATE KEY UPDATE`、`UPDATE`（含 `LIMIT`/`ORDER BY`）、`DELETE`（含 `LIMIT`/`ORDER BY`）

**查询** — 多表 `JOIN`（LEFT/RIGHT/INNER/CROSS）、`GROUP BY`/`HAVING`、`ORDER BY`、`LIMIT a,b`、`DISTINCT`、子查询、派生表、`UNION`、`CASE WHEN`、`IN`/`BETWEEN`/`LIKE`/`RLIKE`、窗口函数（`RANK`/`ROW_NUMBER`/`DENSE_RANK`/`LAG`/`LEAD`/`NTILE` … `OVER`）、CTE（含 `WITH RECURSIVE`）

**执行计划** — `EXPLAIN` 输出 MySQL 的 12 列（`id`/`select_type`/`table`/`type`/`possible_keys`/`key`/`rows`/`Extra` …），另外支持 `EXPLAIN FORMAT=JSON`、`FORMAT=TREE` 与 `EXPLAIN ANALYZE`。`possible_keys` 列出了索引但 `type=ALL` 时，说明底层确实没有建这个二级索引 —— 这是真实反映，不是显示错误

**元数据** — `SHOW DATABASES`（含 `LIKE`/`WHERE`）、`SHOW TABLES [LIKE|WHERE]`、`SHOW FULL TABLES`、`SHOW COLUMNS/FIELDS [LIKE]`（`FULL` 会给出 9 列）、`SHOW CREATE TABLE`、`SHOW CREATE VIEW`、`SHOW INDEX/KEYS`、`SHOW VARIABLES`、`SHOW STATUS`、`SHOW ENGINES`、`SHOW TABLE STATUS`、`SHOW PROCESSLIST`、`SHOW WARNINGS`、`DESC`/`DESCRIBE`（含 `DESC 表 列名` 过滤）

**事务** — `START TRANSACTION`、`BEGIN`、`COMMIT`、`ROLLBACK`、`SAVEPOINT`、`ROLLBACK TO`（回滚是真实生效的）

**变量** — 用户变量 `SET @x = 1` / `SELECT @x`；`SELECT 列 INTO @变量 FROM ...`；系统变量 `@@version`、`@@port`；`SET NAMES`、`SET autocommit`、`SET sql_mode`

**函数** — 99 个 MySQL 函数（`CONCAT_WS`、`GROUP_CONCAT ... SEPARATOR`、`DATE_FORMAT`、`DATE_ADD(... INTERVAL n unit)`、`DATEDIFF`、`TIMESTAMPDIFF`、`STR_TO_DATE`、`SUBSTRING_INDEX`、`ELT`、`FIND_IN_SET`、`MD5`/`SHA1`/`SHA2`、`STDDEV`/`VARIANCE`、`FORMAT`、`IFNULL`、`FIELD`、`LAST_DAY`、`UUID` 等），加上 SQLite 全部内置函数。变参函数（`CONCAT`/`GREATEST`/`LEAST`/`ELT`/`CHAR`…）按元数逐个注册，不会掉到同名内建函数的语义上去；`CONCAT` 遇 NULL 返回 NULL，与 MySQL 一致

**语法自动转译** — 写 MySQL 写法即可，无需改写：`AUTO_INCREMENT`、`ENGINE=InnoDB`、`DEFAULT CHARSET`、`COLLATE`、`COMMENT`、`ENUM`/`SET`/`JSON` 类型、`UNSIGNED`/`ZEROFILL`、反引号、`LIMIT a, b`、`INSERT ... ON DUPLICATE KEY UPDATE`、`a DIV b`、`a <=> b`、`CONVERT(x, SIGNED)`、`TRIM(LEADING x FROM y)`、`POSITION(x IN y)`、`ISNULL(x)`、`EXTRACT(unit FROM x)`、`DATE_ADD/DATE_SUB(..., INTERVAL n unit)`、`INSERT()` 字符串函数

**外键真实生效** — 建表时声明的 `FOREIGN KEY` 会真的拦：插入不存在的父行报 `1452`，删除被引用的父行报 `1451`

**导出与导入（本地，不联网）** — 把上一个查询结果导出成 CSV / JSON，把当前库导出成 `.sql` 脚本，或选择本地 `.sql` 文件导入执行。全程用浏览器内的 Blob / FileReader 完成

**学习辅助** — 46 道练习题（基础 / 进阶 / 挑战 / 实战四档，判分忽略大小写、多余空格、反引号与单字母别名）、与真实 MySQL 的差异说明（「差异」面板）、「帮助」面板；输入行带 SQL 语法高亮

---

## 明确不做的

不做的事情会**返回真实原因**，而不是伪装成能跑。判据很简单：**真实 MySQL 里合法的语句，绝不能报成"语法错误"（1064）**。这条现在是自动化测试守住的（`probe-gaps.cjs` 断言"意外语法错 = 0"）。

| 不做的 | 说明 |
|---|---|
| 存储过程 / 触发器 / 事件 / `CALL` | 未实现，报 `1235` + 原因 |
| `PREPARE` / `EXECUTE` | 预处理语句未实现，报 `1235` |
| `GRANT` / `REVOKE` / `CREATE USER` | 不做权限校验，一律以 `root@localhost` 执行 |
| `LOAD DATA` / `SELECT ... INTO OUTFILE` | 浏览器沙箱内没有文件系统 |
| `UPDATE/DELETE ... JOIN` | 底层只支持单表写，建议改写成 `WHERE EXISTS (SELECT 1 ...)` |
| 透过视图写数据 | 报 `1288 ... is not updatable` |
| 分区表、`FULLTEXT`/`SPATIAL` 索引、`MATCH ... AGAINST` | 报 `1235`（不再伪装成 1064） |
| `ALTER TABLE` 改引擎/删主键/增删外键 | 报 `1235`（只有 `AUTO_INCREMENT=N` 是真的支持的） |
| 复制、二进制日志、`XA`、`HANDLER`、`INSTALL PLUGIN` | 报 `1235` |
| **跨库限定名 `db.table`** | 每个库在底层是各自独立的连接，所以 `SELECT ... FROM mysql.user` 会报 `1146`；请先 `USE` 到目标库。这是已知的架构级限制 |
| `BACKUP DATABASE` / `RESTORE` | MySQL **社区版本身没有**这条 SQL，是企业版组件；社区版靠 `mysqldump`。报 `1064` + 考据 |
| `mysqldump` | 那是 shell 命令，不是客户端 SQL |

**语义层面的差异**（底层是 SQLite 不是 InnoDB）：没有隔离级别 / 行级锁 / MVCC（`FOR UPDATE` 会被忽略并提示）；`DECIMAL` 不补尾随零；`7/2` 的值是 3.5 但真实 MySQL 会显示成 3.5000；不写 `ORDER BY` 时不保证行序；字符串比较默认区分大小写（MySQL 默认不区分）；`||` 是字符串连接而非逻辑 OR；`EXPLAIN` 的形态对但数据来自底层查询计划而非 InnoDB 优化器。

完整清单见程序内「差异」面板（源码里的 `DIFFERENCES` 数组，以它为准）。

---

## 项目结构

```
.
├── mysql-terminal.html        # 成品（由 src/build.py 生成，勿手改）
├── 交接文档.md                # 技术交接 / 维护说明
├── 功能盘点与可新增清单.md     # 能力盘点 + 已修缺陷登记 + 可新增功能路线
├── pack-dist.py               # 打包：HTML + README → dist/*.zip
├── src/                       # 源码
│   ├── template.html          #   HTML 骨架 + 5 个注入占位符
│   ├── app.css                #   样式
│   ├── app.js                 #   交互层：终端渲染 / 键盘 / 高亮 / 导出导入 / 侧栏
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
NODE_PATH=../.. node test-core.cjs      # 核心层全量（含全部练习题标准答案逐条执行）
node test-view.cjs                      # 视图全链路
node test-exercise.cjs                  # 46 题 × 各种等价写法 + 反例 + 串台检查
node test-fixes.cjs                     # 修复回归：167 条断言，覆盖每一处修过的缺陷
node probe-gaps.cjs                     # 特性缺口普查（断言"意外语法错 = 0"）
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

**没装 Playwright 时的兜底**（零依赖，用本机 Edge 的无头模式）：

```bash
node e2e-smoke.cjs              # 注入测试脚本 → 真实键盘事件驱动终端 → 抓 DOM 校验
```

每个脚本把报告写成 `_*_report.txt`（已在 `.gitignore` 中忽略）。

**当前基线**：核心层 `failures = 0`；视图全过；练习题 46/46；**修复回归 167 条断言全过**；缺口普查 **171 通过 / 0 条伪装成 1064 的假语法错**；浏览器兜底 26/26。

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
