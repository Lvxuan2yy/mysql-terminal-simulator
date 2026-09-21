# 第三方组件声明 · Third-Party Notices

本项目（MySQL 终端模拟器）自身代码之外，`vendor/` 目录下的引擎来自第三方开源项目。
按各许可证要求，将其声明与许可原文保留如下。

---

## 1. sql.js

- **用途**：`vendor/sql-wasm.js`、`vendor/sql-wasm.wasm` 即 sql.js 的发行产物，本项目用它提供引擎层
- **上游仓库**：<https://github.com/sql-js/sql.js>
- **官网**：<https://sql.js.org>
- **许可证**：MIT License

```
MIT license
===========

Copyright (c) 2017 sql.js authors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 上述许可原文取自上游仓库的 `LICENSE` 文件：
> <https://raw.githubusercontent.com/sql-js/sql.js/master/LICENSE>

---

## 2. SQLite

- **用途**：sql.js 是 SQLite C 源码经 Emscripten 编译出的 WebAssembly 产物，本项目的 SQL 执行能力最终由 SQLite 提供
- **官网**：<https://www.sqlite.org>
- **版权说明**：<https://www.sqlite.org/copyright.html>
- **许可证**：Public Domain（公有领域）

SQLite 官方版权页面原文声明：

> SQLite is in the **Public Domain**.
> All of the code and documentation in SQLite has been dedicated to the public domain by the authors.
> All code authors, and representatives of the companies they work for, have signed affidavits dedicating their contributions to the public domain and originals of those signed affidavits are stored in a firesafe at the main offices of Hwaci.
> Anyone is free to copy, modify, publish, use, compile, sell, or distribute the original SQLite code, either in source code form or as a compiled binary, for any purpose, commercial or non-commercial, and by any means.

---

## 3. 关于本项目自身代码

本项目自己编写的代码位于 `src/`（`template.html`、`app.css`、`app.js`、`mysql-core.js`、`build.py`）、`pack-dist.py`，以及生成产物 `mysql-terminal.html`。

这些代码采用 **MIT License**，完整许可原文见仓库根目录的 [`LICENSE`](LICENSE) 文件。

---

## 免责声明

本项目是学习用途的仿真工具，与 Oracle / MySQL 官方无任何关系，也不代表其立场。
项目内出现的 "MySQL" 字样仅用于说明语法兼容目标。
