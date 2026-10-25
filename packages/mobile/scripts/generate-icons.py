#!/usr/bin/env python3
"""Derive mobile assets from the approved Yuri B vector and its raster exports."""

import json
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
IOS = ROOT / "ios/App/App"
RES = ROOT / "android/app/src/main/res"
SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)


def main():
    # Approved icon export has a 100px exterior desktop margin; mobile supplies its own mask.
    card = Image.open(ASSETS / "yuri-icon-dark.png").convert("RGB").crop((100, 100, 924, 924))
    source = Image.open(ASSETS / "yuri-mark-white.png").convert("RGBA")
    mark = source.crop(source.getbbox())
    background = card.getpixel((0, 0))
    path = ET.parse(ASSETS / "yuri-mark-white.svg").getroot().find(f"{{{SVG}}}path").attrib["d"]

    def centered(size, extent):
        out = Image.new("RGBA", size)
        glyph = mark.copy()
        glyph.thumbnail((extent, extent), Image.Resampling.LANCZOS)
        out.alpha_composite(glyph, ((size[0] - glyph.width) // 2, (size[1] - glyph.height) // 2))
        return out

    card.save(ASSETS / "icon-only.png")
    centered((1024, 1024), 640).save(ASSETS / "icon-foreground.png")
    Image.new("RGB", (1024, 1024), background).save(ASSETS / "icon-background.png")
    card.resize((1024, 1024), Image.Resampling.LANCZOS).save(IOS / "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
    composer = IOS / "AppIcon.icon"
    # Replace both existing layer rasters, including the hidden alternate appearance.
    for target in (composer / "Assets").glob("*.png"):
        centered((1024, 1024), 640).save(target)
    document = json.loads((composer / "icon.json").read_text())
    for group in document["groups"]:
        for layer in group["layers"]:
            if "position-specializations" in layer:
                layer["position-specializations"] = [{"idiom": "square", "value": {"scale": 1, "translation-in-points": [0, 0]}}]
    (composer / "icon.json").write_text(json.dumps(document, indent=2) + "\n")

    for density, canvas in {"ldpi": 81, "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}.items():
        directory = RES / f"mipmap-{density}"
        centered((canvas, canvas), round(canvas * 56 / 108)).save(directory / "ic_launcher_foreground.png")
        Image.new("RGB", (canvas, canvas), background).save(directory / "ic_launcher_background.png")
        size = round(canvas * 48 / 108)
        for name, circular in [("ic_launcher.png", False), ("ic_launcher_round.png", True)]:
            image = card.convert("RGBA")
            mask = Image.new("L", card.size)
            draw = ImageDraw.Draw(mask)
            bounds = (0, 0, card.width - 1, card.height - 1)
            if circular:
                draw.ellipse(bounds, fill=255)
            else:
                draw.rounded_rectangle(bounds, radius=card.width * 0.225, fill=255)
            image.putalpha(mask)
            image.resize((size, size), Image.Resampling.LANCZOS).save(directory / name)

    # Notification, fallback launcher and Android 13 themed icons share the silhouette.
    vector = f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="100" android:viewportHeight="100">
    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="{path}" />
</vector>
'''
    for target in [RES / "drawable/ic_stat_notify.xml", RES / "drawable-v24/ic_launcher_foreground.xml"]:
        target.write_text(vector)
    color = "#" + "".join(f"{channel:02X}" for channel in background)
    for name in ["ic_launcher_yuri_background.xml", "ic_launcher_background.xml"]:
        (RES / "drawable" / name).write_text(f'<shape xmlns:android="http://schemas.android.com/apk/res/android"><solid android:color="{color}" /></shape>\n')
    (RES / "values/ic_launcher_background.xml").write_text(f'<resources><color name="ic_launcher_background">{color}</color></resources>\n')
    for target in list(RES.glob("drawable*/splash.png")) + list((IOS / "Assets.xcassets/Splash.imageset").glob("*.png")):
        size = Image.open(target).size
        out = Image.new("RGBA", size, background + (255,))
        out.alpha_composite(centered(size, round(min(size) * 0.22)))
        out.convert("RGB").save(target)

    # Keep Apple's symbol-template guides; replace every weight's old artwork.
    target = ROOT / "ios/App/YuriWidget/Assets.xcassets/YuriLogoSymbol.symbolset/yuri-logo-symbol.svg"
    text = target.read_text().split("</svg>")[0] + "</svg>"
    symbol = ET.fromstring(text)
    symbols = next(group for group in symbol if group.attrib.get("id") == "Symbols")
    for group, x in zip(symbols, [215, 415, 615]):
        for child in list(group):
            group.remove(child)
        ET.SubElement(group, f"{{{SVG}}}path", {"d": path, "fill-rule": "evenodd", "transform": f"translate({x}, 61)"})
    ET.ElementTree(symbol).write(target, encoding="unicode", xml_declaration=True)
    print("Generated Yuri iOS, Widget, Android launcher/notification and splash assets")


if __name__ == "__main__":
    main()
