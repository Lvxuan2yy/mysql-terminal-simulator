#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 src/ 下的模板、样式、逻辑与 vendor/ 下的 sql.js 引擎（含 wasm）全部内联，
产出一个可双击直接打开、全程不联网的单文件 HTML。

用法：
    python build.py
输出：
    ../mysql-terminal.html   （成品，UTF-8，单文件）
"""
import base64
import os
import re
import sys

SRC = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SRC)
VENDOR = os.path.join(ROOT, 'vendor')
OUT = os.path.join(ROOT, 'mysql-terminal.html')


def read_text(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()


def safe_script(js: str) -> str:
    """避免内联脚本被 </script> 提前截断"""
    js = js.replace('</script>', '<\\/script>')
    js = js.replace('<!--', '<\\!--')
    return js


def main():
    required = {
        'template': os.path.join(SRC, 'template.html'),
        'css': os.path.join(SRC, 'app.css'),
        'app': os.path.join(SRC, 'app.js'),
        'core': os.path.join(SRC, 'mysql-core.js'),
        'glue': os.path.join(VENDOR, 'sql-wasm.js'),
        'wasm': os.path.join(VENDOR, 'sql-wasm.wasm'),
    }
    for name, p in required.items():
        if not os.path.exists(p):
            sys.exit('缺少文件：%s (%s)' % (name, p))

    html = read_text(required['template'])
    css = read_text(required['css'])
    app = read_text(required['app'])
    core = read_text(required['core'])
    glue = read_text(required['glue'])
    wasm_b64 = base64.b64encode(read_bytes(required['wasm'])).decode('ascii')

    # 校验占位符齐全
    for ph in ('/*__CSS__*/', '/*__SQLJS__*/', '__WASM__', '/*__CORE__*/', '/*__APP__*/'):
        if ph not in html:
            sys.exit('模板缺少占位符：%s' % ph)

    # 引擎胶水层里已内嵌 wasm（通过 window.__SQLJS_WASM_B64 传入），
    # 但需确保它不会尝试按相对路径去 fetch sql-wasm.wasm
    assert 'wasmBinary' in glue, '检出的 sql.js 胶水层不支持 wasmBinary，无法离线内嵌'

    html = html.replace('/*__CSS__*/', css)
    html = html.replace('/*__SQLJS__*/', safe_script(glue))
    html = html.replace('__WASM__', wasm_b64)
    html = html.replace('/*__CORE__*/', safe_script(core))
    html = html.replace('/*__APP__*/', safe_script(app))

    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print('✅ 已生成：%s' % OUT)
    print('   体积：%.2f MB (%d 字节)' % (size / 1024.0 / 1024.0, size))
    print('   内联：CSS %d 字符 / 核心层 %d 字符 / 交互层 %d 字符 / 引擎胶水 %d 字符 / wasm base64 %d 字符'
          % (len(css), len(core), len(app), len(glue), len(wasm_b64)))

    # 静态检查：确认没有外部资源引用
    externals = re.findall(r'(?:src|href)\s*=\s*["\'](https?:)?//[^"\']+', html)
    prints = re.findall(r'@import\s+url', html)
    if externals or prints:
        print('⚠️  检测到外部资源引用：', externals[:5], prints[:5])
    else:
        print('   ✅ 静态检查通过：无任何 http(s)/协议相对 的外部资源引用')


if __name__ == '__main__':
    main()
