#!/usr/bin/env python3
"""Regenerate the PanOffice Tauri icon kit from the master logo rasters.

Usage:
    ~/.venvs/ai/bin/python branding/make-icons.py

Reads  branding/logo-{32,128,256,512}.png and branding/icon.ico,
writes the full kit into desktop-tauri/src-tauri/icons/.
All output keeps the transparent background of the source logo.
"""
from pathlib import Path

from PIL import Image

BRANDING = Path(__file__).resolve().parent
ICONS = BRANDING.parent / "desktop-tauri" / "src-tauri" / "icons"

# target filename -> pixel size (square)
TARGETS = {
    "icon.png": 512,
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    # Windows (MSIX/Store) tile assets
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    master = Image.open(BRANDING / "logo-512.png")
    if master.mode != "RGBA":
        master = master.convert("RGBA")
    for name, size in TARGETS.items():
        # downscale from the 512 master with LANCZOS for best quality
        img = master.resize((size, size), Image.LANCZOS)
        out = ICONS / name
        img.save(out)
        print(f"{out.relative_to(ICONS.parents[2])}  {size}x{size}")
    # multi-size .ico is pre-rendered next to the master
    ico = (BRANDING / "icon.ico").read_bytes()
    (ICONS / "icon.ico").write_bytes(ico)
    print(f"{'icon.ico'}  copied from branding/icon.ico")


if __name__ == "__main__":
    main()
