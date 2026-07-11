#!/usr/bin/env python3
"""Generate BetterBlock extension icons (shield + AI sparkle) as PNGs.

Pure-stdlib PNG writer so it runs anywhere. Output: icons/icon{16,32,48,128}.png
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")

# Palette
SHIELD = (79, 70, 229)      # indigo-600
SHIELD_DARK = (55, 48, 163)  # indigo-800 (bottom shading)
SPARKLE = (255, 255, 255)


def png_chunk(tag, data):
    chunk = tag + data
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk))


def write_png(path, size, pixels):
    """pixels: list of rows, each row list of (r,g,b,a)."""
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBBB", *px) for px in row) for row in pixels
    )
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)))
        f.write(png_chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(png_chunk(b"IEND", b""))


def in_shield(x, y):
    """Shield silhouette in unit coords: x in [-1,1], y in [-1,1] (y down)."""
    if y < -0.92 or y > 0.98:
        return False
    if y <= 0.15:  # upper body: rounded rectangle-ish
        w = 0.88
        # rounded top corners
        if y < -0.72:
            dy = (y + 0.72) / 0.20  # 0 .. -1
            w = 0.88 * (1 - dy * dy) ** 0.5 if dy > -1 else 0
        return abs(x) <= w
    # lower body tapers to a point
    t = (y - 0.15) / 0.83  # 0..1
    w = 0.88 * (1 - t ** 1.6)
    return abs(x) <= w


def in_sparkle(x, y, r=0.52):
    """Four-pointed star (astroid): |x|^(2/3) + |y|^(2/3) <= r^(2/3)."""
    return abs(x) ** (2 / 3) + abs(y) ** (2 / 3) <= r ** (2 / 3)


def render(size, ss=4):
    """Supersampled render."""
    rows = []
    n = size * ss
    for py in range(size):
        row = []
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    fx = ((px * ss + sx) + 0.5) / n * 2 - 1
                    fy = ((py * ss + sy) + 0.5) / n * 2 - 1
                    if in_shield(fx, fy):
                        base = SHIELD if fy < 0.25 else SHIELD_DARK
                        c = SPARKLE if in_sparkle(fx, fy + 0.05) else base
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 255
            k = ss * ss
            a = acc[3] // k
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                # un-premultiply against sample count with coverage alpha
                cov = acc[3] / 255
                row.append((int(acc[0] / cov), int(acc[1] / cov), int(acc[2] / cov), a))
        rows.append(row)
    return rows


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, render(size))
        print("wrote", path)


if __name__ == "__main__":
    main()
