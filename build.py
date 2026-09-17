#!/usr/bin/env python3
"""Собирает app/app.html в самостоятельную страницу dist/index.html для хостинга.

Файл app/app.html — фрагмент: платформа артефактов сама оборачивает его в документ.
Для собственного хостинга нужен полный документ с манифестом и регистрацией
service worker, чем и занимается этот скрипт.
"""
import pathlib
import shutil

ROOT = pathlib.Path(__file__).parent
APP = ROOT / "app"
DIST = ROOT / "dist"

HEAD = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#04060A">
<meta name="description" content="Личное рабочее пространство: работа, финансы, развитие и ежедневные дела">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icon.svg" type="image/svg+xml">
<link rel="icon" href="./icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="./icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  :root{color-scheme:dark; padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px);}
  img{max-width:100%} [hidden]{display:none!important}
</style>
"""

TAIL = """
<script>
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  });
}
</script>
</body>
</html>
"""


def main() -> None:
    fragment = (APP / "app.html").read_text(encoding="utf-8")
    # Заголовок, шрифты и стили уходят в head, разметка и скрипт — в body.
    split = fragment.index("</style>") + len("</style>")
    head_part, body_part = fragment[:split], fragment[split:]

    DIST.mkdir(exist_ok=True)
    (DIST / "index.html").write_text(HEAD + head_part + "\n</head>\n<body>\n" + body_part + TAIL, encoding="utf-8")

    for name in ("manifest.webmanifest", "sw.js", "icon.svg", "icon-maskable.svg",
                 "icon-192.png", "icon-512.png", "icon-maskable-512.png"):
        shutil.copy(APP / name, DIST / name)

    print("dist/index.html собран")


if __name__ == "__main__":
    main()
