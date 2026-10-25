# Yuri vector-B 品牌源

用户确认的最终标志为人物侧影 vector-B。本目录取代先前的三瓣概念稿，SVG 与 PNG 保留指定交付稿的几何和颜色。

## 重新生成

在本目录运行（环境需已有 Pillow）：

```sh
python3 build_b.py
```

生成黑白主标、macOS 浅色/深色中性灰底板图标、1024/32/16 像素 PNG 和展示板。生成流程仅依赖本目录，不需要临时目录里的方案 A。展示板优先使用 macOS 系统字体，其他系统使用 Pillow 默认字体；字体差异只影响展示板。

`traced.json` 是已确认的矢量轮廓。需要重新描摹时运行 `python3 trace_b.py`，它从保留的 `source-preview.png` 提取轮廓；日常生成不必重新描摹。

- `yuri-b-mark-black.svg` / `yuri-b-mark-white.svg`：透明底主标，viewBox 100×100。
- `yuri-b-icon-light.svg` / `yuri-b-icon-dark.svg`：1024×1024 图标，含中性渐变底板。
- `yuri-b-mark-*-1024.png`：透明底主标导出。
- `yuri-b-icon-*-{1024,32,16}.png`：图标导出。
- `yuri-b-board.png`：展示板，不作为应用图标。

产品内单色图标使用主标；平台应用图标使用对应底板图，按平台要求生成 ICNS、ICO、AppIcon、adaptive icon 等资源。不要把展示板或源预览当作应用图标。

## 独立字标 Yuri

首字母大写的字标采用用户选定的 **① 雕刻衬线**，由 GPT image 2.5 设计后提取轮廓，提供黑色、白色和 `currentColor` SVG，以及与人物侧影的横向组合。文件、设计来源与重建方式见 [字标说明](wordmark-design.md)。运行 `python3 build_wordmark.py` 可重新生成。
