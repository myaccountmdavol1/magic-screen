#!/usr/bin/env python3
"""Generate fake-greenscreen.y4m: a synthetic "child in front of a green screen" clip.

Used by the e2e tests as Chromium's fake webcam:
    --use-fake-device-for-media-stream
    --use-file-for-fake-video-capture=e2e/fixtures/fake-greenscreen.y4m

Why synthetic: the tests need a deterministic chroma-green backdrop (with realistic
vignette + sensor noise so the auto key sampler is exercised) and a non-green figure
that moves, without shipping a real child's video. Stdlib only, so it runs anywhere.

Output: 640x360, 30 fps, 90 frames (3 s loop), YUV 4:2:0 (C420jpeg, full-range BT.601).
"""

from __future__ import annotations

import math
import os
import random
import sys

W, H = 640, 360
CW, CH = W // 2, H // 2
FPS = 30
FRAMES = 90

Color = tuple[int, int, int]


def rgb_to_yuv(c: Color) -> tuple[int, int, int]:
    """Full-range BT.601 (JFIF), matching the C420jpeg tag."""
    r, g, b = c
    y = 0.299 * r + 0.587 * g + 0.114 * b
    u = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    v = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    clamp = lambda x: max(0, min(255, int(round(x))))  # noqa: E731
    return clamp(y), clamp(u), clamp(v)


SCREEN: Color = (43, 179, 74)  # #2bb34a, a typical chroma-key green
SKIN: Color = (241, 194, 150)
HAIR: Color = (70, 42, 28)
SHIRT: Color = (232, 85, 63)  # warm red-orange: nothing green on the subject
SHIRT_DARK: Color = (190, 60, 45)
EYE: Color = (40, 30, 40)
MOUTH: Color = (170, 50, 60)


class Frame:
    """Three planes as bytearrays; shapes are filled with per-row slice assignment,
    which keeps pure-Python generation to a couple of seconds."""

    def __init__(self, y: bytearray, u: bytearray, v: bytearray) -> None:
        self.y, self.u, self.v = y, u, v

    def _span(self, plane: bytearray, pw: int, ph: int, row: int, x0: float, x1: float, val: int) -> None:
        if row < 0 or row >= ph:
            return
        a, b = max(0, int(math.ceil(x0))), min(pw - 1, int(math.floor(x1)))
        if b >= a:
            plane[row * pw + a : row * pw + b + 1] = bytes([val]) * (b - a + 1)

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, col: Color) -> None:
        yy, uu, vv = rgb_to_yuv(col)
        # Luma at full res, chroma at half res; same shape, scaled coordinates.
        for plane, pw, ph, s, val in ((self.y, W, H, 1.0, yy), (self.u, CW, CH, 0.5, uu), (self.v, CW, CH, 0.5, vv)):
            ecx, ecy, erx, ery = cx * s, cy * s, rx * s, ry * s
            for row in range(int(ecy - ery), int(ecy + ery) + 2):
                d = (row + 0.5 - ecy) / ery
                if abs(d) > 1:
                    continue
                half = erx * math.sqrt(1 - d * d)
                self._span(plane, pw, ph, row, ecx - half, ecx + half, val)

    def circle(self, cx: float, cy: float, r: float, col: Color) -> None:
        self.ellipse(cx, cy, r, r, col)

    def rrect(self, x0: float, y0: float, x1: float, y1: float, rad: float, col: Color) -> None:
        """Rounded rectangle (top corners rounded; bottom runs off-frame like a webcam crop)."""
        yy, uu, vv = rgb_to_yuv(col)
        for plane, pw, ph, s, val in ((self.y, W, H, 1.0, yy), (self.u, CW, CH, 0.5, uu), (self.v, CW, CH, 0.5, vv)):
            ax0, ay0, ax1, ay1, ar = x0 * s, y0 * s, x1 * s, y1 * s, rad * s
            for row in range(int(ay0), int(ay1) + 1):
                inset = 0.0
                dy = ay0 + ar - (row + 0.5)
                if dy > 0:
                    inset = ar - math.sqrt(max(0.0, ar * ar - dy * dy))
                self._span(plane, pw, ph, row, ax0 + inset, ax1 - inset, val)

    def capsule(self, x0: float, y0: float, x1: float, y1: float, r: float, col: Color) -> None:
        """Thick round-capped line, stamped as overlapping discs (simple and robust)."""
        steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / 3))
        for i in range(steps + 1):
            t = i / steps
            self.circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, col)


def make_backdrop(seed: int) -> tuple[bytearray, bytearray, bytearray]:
    """Green screen with a soft vignette (uneven lighting) and per-pixel noise."""
    rnd = random.Random(seed)
    y = bytearray(W * H)
    u = bytearray(CW * CH)
    v = bytearray(CW * CH)
    for row in range(H):
        ny = (row - H / 2) / (H / 2)
        for col in range(W):
            nx = (col - W / 2) / (W / 2)
            light = 1.0 - 0.22 * (nx * nx * 0.6 + ny * ny)  # darker toward the corners
            r, g, b = (c * light for c in SCREEN)
            n = rnd.gauss(0, 3.0)
            y[row * W + col] = max(0, min(255, int(0.299 * r + 0.587 * g + 0.114 * b + n)))
    _, u0, v0 = rgb_to_yuv(SCREEN)
    for i in range(CW * CH):
        u[i] = max(0, min(255, u0 + int(rnd.gauss(0, 1.5))))
        v[i] = max(0, min(255, v0 + int(rnd.gauss(0, 1.5))))
    return y, u, v


def draw_child(f: Frame, t: float) -> None:
    """A friendly figure: dark hair, round face, shirt, one arm waving. t in [0, 1)."""
    cx = W / 2 + 150 * math.sin(2 * math.pi * t)  # sways side to side, one loop per clip
    bob = 4 * math.sin(4 * math.pi * t)
    head_y = 150 + bob

    # Body (drawn first so the head overlaps the neckline).
    f.rrect(cx - 70, 240 + bob, cx + 70, H + 10, 40, SHIRT)
    f.rrect(cx - 18, 214 + bob, cx + 18, 250 + bob, 6, SKIN)  # neck

    # Resting arm on the left.
    f.capsule(cx - 62, 262 + bob, cx - 86, 340 + bob, 15, SHIRT_DARK)
    f.circle(cx - 88, 346 + bob, 14, SKIN)

    # Waving arm: upper arm out to the side, forearm swinging +/- 25 degrees.
    sx, sy = cx + 62, 262 + bob
    ex, ey = sx + 40, sy - 34
    swing = math.radians(25 * math.sin(2 * math.pi * t * 6))  # 6 waves per loop
    hx, hy = ex + 62 * math.sin(swing), ey - 62 * math.cos(swing)
    f.capsule(sx, sy, ex, ey, 15, SHIRT_DARK)
    f.capsule(ex, ey, hx, hy, 12, SKIN)
    f.circle(hx, hy, 16, SKIN)

    # Head: hair cap behind, then the face, then a fringe across the top.
    f.circle(cx, head_y - 6, 62, HAIR)
    f.ellipse(cx, head_y + 8, 52, 56, SKIN)
    f.ellipse(cx, head_y - 40, 50, 18, HAIR)
    f.circle(cx - 54, head_y + 10, 10, SKIN)  # ears
    f.circle(cx + 54, head_y + 10, 10, SKIN)
    f.circle(cx - 19, head_y + 4, 6, EYE)
    f.circle(cx + 19, head_y + 4, 6, EYE)
    f.ellipse(cx, head_y + 30, 16, 8, MOUTH)
    f.ellipse(cx, head_y + 26, 18, 5, SKIN)  # turns the oval into a smile


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake-greenscreen.y4m")
    # A few noise variants cycled through, so the noise "moves" like a real sensor.
    backdrops = [make_backdrop(seed) for seed in range(4)]
    with open(out, "wb") as fh:
        fh.write(f"YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg XYSCSS=420JPEG\n".encode("ascii"))
        for i in range(FRAMES):
            by, bu, bv = backdrops[i % len(backdrops)]
            frame = Frame(bytearray(by), bytearray(bu), bytearray(bv))
            draw_child(frame, i / FRAMES)
            fh.write(b"FRAME\n")
            fh.write(frame.y)
            fh.write(frame.u)
            fh.write(frame.v)
    print(f"wrote {out} ({FRAMES} frames, {W}x{H} @ {FPS} fps)")


if __name__ == "__main__":
    main()
