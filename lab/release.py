"""发布 GitHub Release：创建 release 并上传 dist 下的 zip/crx 附件。

用法：python release.py [版本号]   例：python release.py 2.0.0
Token 优先取 $GITHUB_TOKEN，否则从 git credential fill（GCM）读取，不落盘、不打印。
"""
import json
import os
import subprocess
import sys
import urllib.request
from urllib.error import HTTPError

OWNER, REPO = "haohaoo3o", "sufe-auto-auth"
# 默认直连；需要时用 SUFE_PROXY=http://127.0.0.1:7890 指定代理
PROXY = os.environ.get("SUFE_PROXY", "").strip()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.environ.get("SUFE_DIST") or next(
    (p for p in (os.path.join(os.path.dirname(ROOT), "dist"), os.path.join(ROOT, "dist"))
     if os.path.isdir(p)), os.path.join(ROOT, "dist"))

BODY = """## 上财自动认证 6.0

**更名：上财自动滑块 → 上财自动认证**（服务端已改用字符验证码，滑块保留为兜底）。本版为体验大改版。

### 亮点

- **流动 ASCII 装饰背景**：canvas 60fps 重写（旧版为 span 逐字符 65ms 定时器，卡顿且昏暗）——全面板极暗字符雨（@!%# 缓慢下落变字）+ 右上角流动字符组成的低明度 SUFE 装饰
- **图标重绘**：蓝色像素风挂锁（16/48/128）
- **像素字体修复**：内容脚本 CSS 的相对 url() 在页面上下文解析不到扩展资源导致像素字体从未生效，现改用 FontFace + chrome.runtime.getURL 注入——英文/数字为 Press Start 2P 像素风，中文保持粗体思源黑
- **3 秒倒计时 + 秒登录**：倒计时期间后台并行「拉验证码图 → CRNN 预识别 → 预取登录配置」（无感进行，浮窗不显示后台过程提示），倒计时结束即刻提交
- **识别失败无间隔自动重试**：识别未通过立即换图再识别（不等待），连试 10 次仍失败才转人工输入；重试页为像素大数字特效（与倒计时同款）
- **浮窗精简**：移除后台预识别/识别过程等技术提示词，保留进度条与装饰性元素（kicker 标签、▰▰▰ 像素条）
- **主题色绿色 → 蓝色**：全套蓝色霓虹（面板/按钮/光效/扫描线），对比度按可读性校准

### 安装

1. 下载下方 `sufe-auto-auth-v6.0.0.zip` 解压
2. Chrome → `chrome://extensions/` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择解压出的 `sufe-auto-auth` 文件夹（或把 `.crx` 拖进扩展页）
3. 点击工具栏扩展图标，填写学号、密码

> 仅供本人账号的个人自动化使用；扩展只向 login.sufe.edu.cn 提交数据，密码仅存本机 `chrome.storage.local`。

### 致谢

- **Yanzhe Lu**（上海财经大学，人工智能专业）：提出并实现了「**卷积 + 池化 CNN 定位缺口**」的整图输入方案（社区 v2.1.0 分支）。本仓库 v3 的整图 CNN 即在这一思路基础上重新实现并重训，特此致谢。
"""


def token():
    t = os.environ.get("GITHUB_TOKEN")
    if t:
        return t
    out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    sys.exit("未找到 GitHub 凭据（GITHUB_TOKEN 或 git credential）")


def api(method, url, data=None, token_=None, ctype="application/json"):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token_)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "sufe-release-script")
    if data is not None:
        req.add_header("Content-Type", ctype)
    op = urllib.request.build_opener(
        urllib.request.ProxyHandler({"https": PROXY, "http": PROXY}) if PROXY else urllib.request.ProxyHandler({}))
    with op.open(req, timeout=120) as r:
        return json.loads(r.read().decode() or "{}")


def main():
    ver = sys.argv[1] if sys.argv[1:] else "6.0.0"
    tag = "v" + ver
    title = os.environ.get("SUFE_RELEASE_TITLE", "上财自动认证").strip()
    tk = token()
    rel = api("POST", f"https://api.github.com/repos/{OWNER}/{REPO}/releases", json.dumps({
        "tag_name": tag, "name": f"{tag} · {title}", "body": BODY,
        "draft": False, "prerelease": False,
    }).encode(), tk)
    print("release:", rel.get("html_url") or rel)
    rid = rel["id"]
    for name in (f"sufe-auto-auth-v{ver}.zip", f"sufe-auto-auth-v{ver}.crx"):
        path = os.path.join(DIST, name)
        if not os.path.exists(path):
            print("!! 缺少附件，跳过：", path)
            continue
        raw = open(path, "rb").read()
        ct = "application/zip" if name.endswith(".zip") else "application/x-chrome-extension"
        try:
            a = api("POST",
                    f"https://uploads.github.com/repos/{OWNER}/{REPO}/releases/{rid}/assets?name={name}",
                    raw, tk, ct)
            print("asset:", a.get("name"), a.get("size"), "bytes")
        except HTTPError as e:
            print("!! 上传失败", name, e.code, e.read()[:300])


if __name__ == "__main__":
    main()
