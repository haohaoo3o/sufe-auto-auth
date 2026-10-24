"""构建发布包：dist/sufe-auto-auth-v<version>.zip 与 .crx（用 keys/*.pem 签名）。

zip 内含顶层目录 sufe-auto-auth/（解压后可直接「加载已解压的扩展程序」）；
crx 通过 chrome --pack-extension 生成（在 ASCII 临时目录中打包，避免中文路径编码问题）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
# 产物目录：优先 $SUFE_DIST；若上一级已有 dist/（本项目在 上财自动认证/ 下的布局）用之；否则仓库内 dist/
DIST = os.environ.get("SUFE_DIST") or next(
    (p for p in (os.path.join(os.path.dirname(ROOT), "dist"), os.path.join(ROOT, "dist"))
     if os.path.isdir(p)), os.path.join(ROOT, "dist"))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
# 签名密钥不进仓库：优先 $SUFE_PEM，其次仓库内 keys/，再次上一级目录 keys/
PEM = os.environ.get("SUFE_PEM") or next(
    (p for p in (os.path.join(ROOT, "keys", "sufe-auto-auth.pem"),
                 os.path.join(os.path.dirname(ROOT), "keys", "sufe-auto-auth.pem"),
                 os.path.join(ROOT, "keys", "sufe-auto-slider.pem"),
                 os.path.join(os.path.dirname(ROOT), "keys", "sufe-auto-slider.pem"))
     if os.path.exists(p)), "")

FILES = [
    "manifest.json", "background.js", "content.js", "content.css",
    "popup.html", "popup.js", "sufe-crypto.js", "sufe-cnn.js",
    "sufe-cnn-weights.js", "sufe-crnn.js", "sufe-fx.js",
    "model.json", "model.bin", "README.md", "LICENSE",
]
DIRS = ["icons", "fonts"]


def main():
    ver = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))["version"]
    name = f"sufe-auto-auth-v{ver}"
    stage = os.path.join(DIST, f"stage-{name}", "sufe-auto-auth")
    if os.path.exists(os.path.join(DIST, f"stage-{name}")):
        shutil.rmtree(os.path.join(DIST, f"stage-{name}"))
    os.makedirs(stage, exist_ok=True)
    for f in FILES:
        shutil.copy2(os.path.join(ROOT, f), os.path.join(stage, f))
    for d in DIRS:
        shutil.copytree(os.path.join(ROOT, d), os.path.join(stage, d))
    print("staged:", stage)

    zip_path = os.path.join(DIST, f"{name}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, fs in os.walk(stage):
            for f in fs:
                full = os.path.join(base, f)
                rel = os.path.relpath(full, os.path.dirname(stage))
                z.write(full, rel)
    print("zip:", zip_path, os.path.getsize(zip_path), "bytes")

    if not os.path.exists(PEM):
        print("!! 缺少签名密钥，跳过 crx：", PEM)
        return
    tmp = os.path.join(tempfile.gettempdir(), "sufe-pack", "sufe-auto-auth")
    if os.path.exists(os.path.dirname(tmp)):
        shutil.rmtree(os.path.dirname(tmp))
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    shutil.copytree(stage, tmp)
    r = subprocess.run([CHROME, f"--pack-extension={tmp}", f"--pack-extension-key={PEM}"],
                       capture_output=True, text=True, timeout=180)
    crx_src = tmp + ".crx"
    if os.path.exists(crx_src):
        crx_dst = os.path.join(DIST, f"{name}.crx")
        shutil.move(crx_src, crx_dst)
        print("crx:", crx_dst, os.path.getsize(crx_dst), "bytes")
    else:
        print("!! crx 打包失败 rc=", r.returncode, (r.stdout or "")[:200], (r.stderr or "")[:200])
        sys.exit(1)


if __name__ == "__main__":
    main()
