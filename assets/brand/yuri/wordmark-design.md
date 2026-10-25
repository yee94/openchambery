# Yuri 独立字标

## 设计来源

采用用户选定的第二轮 **① 雕刻衬线**，由 GPT **image 2.5** 以本目录的 vector-B 展示板为视觉参考生成。完整原稿保留为 `wordmark-source.png`，尺寸 1536×1024。字样固定为 **Yuri**，仅首字母大写。

设计语言：雕刻式衬线、明确的粗细变化、非对称 Y 分叉、圆润的 r 肩部和紧凑的字距。保留原稿 u/r 底部相接的轮廓，i 的圆点呼应人物额前圆点。纯黑白，饱满笔画与收锋呼应人物侧影。

GPT 产出为栅格图，交付 SVG 则是从原稿轮廓提取、平滑和简化后的路径。没有把 PNG 嵌入 SVG，也没有用系统字体替代生成字形。

## 可复用资源

| 文件 | 用途 |
| --- | --- |
| `yuri-wordmark-black.svg` | 透明背景黑色字标 |
| `yuri-wordmark-white.svg` | 透明背景白色字标 |
| `yuri-wordmark-current.svg` | 内联 SVG 时用 `color` 控制颜色 |
| `yuri-lockup-black.svg` / `yuri-lockup-white.svg` | 原 vector-B 人物标志与字标的横向组合 |
| `yuri-lockup-current.svg` | 随内联 `color` 变化的横向组合 |
| `yuri-wordmark-*.png` / `yuri-lockup-*.png` | 1600 像素宽透明 PNG，便于直接使用 |
| `yuri-wordmark-board.png` | 字标及浅深背景组合展示 |

字标按原稿轮廓分为 `letter-Y`、`letter-ur`、`letter-i` 三组，共四条闭合路径；u/r 的底部相接关系保持为同一路径，可在矢量编辑器中编辑节点。所有 SVG 均不依赖字体、外部图片或网络资源。`currentColor` 版应内联使用；通过 HTML `<img>` 加载时不会继承父元素颜色。

## 重建

```sh
python3 build_wordmark.py
```

使用已有 Pillow 与相邻描摹工具，提取原稿上方主字标区域 `(180, 140, 1340, 660)`，生成轮廓 JSON、SVG 和 PNG，不包含下方的缩小展示和反白底板。不重新调用模型。原人物侧影 SVG 的路径直接复用于组合标志。

共享 UI 的 `YuriWordmark` 组件将随色 SVG 作为 CSS mask，使用语义前景色，欢迎页左上角展示这份字标。重建脚本在本仓库运行时同时更新 `packages/ui/src/assets/brand/yuri-wordmark.svg`，保持应用资源与本目录母版一致。
