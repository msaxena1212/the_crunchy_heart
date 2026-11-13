"""
Generates illustrated product and category images for the dry fruits and spices catalogue.

These are procedurally drawn illustrations (no photography). Replace any of them with a real photo
by uploading a file to client/src/assets/products/ and updating the image path in Admin > Products.

Usage (from the repo root):  python database/catalogue/build_images.py [slug ...]
Output: client/src/assets/products/<slug>.webp  and  client/src/assets/categories/<slug>.webp
"""
import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from catalogue_data import PRODUCTS  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_PRODUCTS = os.path.join(ROOT, "client", "src", "assets", "products")
OUT_CATEGORIES = os.path.join(ROOT, "client", "src", "assets", "categories")

SIZE = 1000
SS = 3  # sprite supersampling

FONT_BOLD = "C:/Windows/Fonts/georgiab.ttf"
FONT_REG = "C:/Windows/Fonts/georgia.ttf"
FONT_SANS = "C:/Windows/Fonts/segoeui.ttf"


# --------------------------------------------------------------------------- colour helpers
def lighten(c, f):
    return tuple(int(min(255, v + (255 - v) * f)) for v in c)


def darken(c, f):
    return tuple(int(max(0, v * (1 - f))) for v in c)


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def jitter(c, rng, amount=0.08):
    f = 1 + rng.uniform(-amount, amount)
    return tuple(int(max(0, min(255, v * f))) for v in c)


# --------------------------------------------------------------------------- sprites
def gradient_rgb(w, h, base, light=0.30, dark=0.34):
    """Top-left light to bottom-right dark gradient, returned as an RGB array."""
    ys, xs = np.mgrid[0:h, 0:w]
    t = np.clip((xs / max(w - 1, 1)) * 0.42 + (ys / max(h - 1, 1)) * 0.58, 0, 1)
    lo = np.array(lighten(base, light), dtype=np.float32)
    hi = np.array(darken(base, dark), dtype=np.float32)
    t = t[..., None]
    mid = np.array(base, dtype=np.float32)
    first = lo + (mid - lo) * np.clip(t * 2, 0, 1)
    second = mid + (hi - mid) * np.clip(t * 2 - 1, 0, 1)
    return np.where(t < 0.5, first, second).astype(np.uint8)


def make_sprite(w, h, shape_fn, base, texture_fn=None, light=0.30, dark=0.34, shine=True, rng=None):
    """Draws a shaded RGBA sprite of size (w, h). shape_fn(draw, W, H) fills the silhouette with 255."""
    W, H = int(w * SS), int(h * SS)
    mask = Image.new("L", (W, H), 0)
    shape_fn(ImageDraw.Draw(mask), W, H)

    rgb = Image.fromarray(gradient_rgb(W, H, base, light, dark))
    if texture_fn:
        texture_fn(ImageDraw.Draw(rgb), W, H, mask)

    # darker rim for volume
    eroded = mask.filter(ImageFilter.MinFilter(max(3, (SS * 3) | 1)))
    rim = Image.fromarray(np.clip(np.asarray(mask, dtype=np.int16) - np.asarray(eroded, dtype=np.int16), 0, 255).astype(np.uint8))
    rim = rim.filter(ImageFilter.GaussianBlur(SS))
    rgb = Image.composite(Image.new("RGB", (W, H), darken(base, 0.55)), rgb, rim.point(lambda v: int(v * 0.35)))

    if shine:
        glint = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(glint)
        d.ellipse([W * 0.14, H * 0.12, W * 0.52, H * 0.40], fill=120)
        glint = glint.filter(ImageFilter.GaussianBlur(max(2, W // 14)))
        rgb = Image.composite(Image.new("RGB", (W, H), lighten(base, 0.7)), rgb, Image.fromarray((np.asarray(glint) * (np.asarray(mask) / 255.0)).astype(np.uint8)))

    sprite = rgb.convert("RGBA")
    sprite.putalpha(mask)
    return sprite.resize((int(w), int(h)), Image.LANCZOS)


def shadow_of(sprite, blur=5, alpha=95):
    a = sprite.split()[3].point(lambda v: int(v * alpha / 255))
    pad = blur * 3
    big = Image.new("L", (sprite.width + pad * 2, sprite.height + pad * 2), 0)
    big.paste(a, (pad, pad))
    big = big.filter(ImageFilter.GaussianBlur(blur))
    out = Image.new("RGBA", big.size, (35, 20, 8, 0))
    out.putalpha(big)
    return out, pad


# --------------------------------------------------------------------------- silhouettes
def sil_ellipse(d, W, H, pad=0.04):
    d.ellipse([W * pad, H * pad, W * (1 - pad), H * (1 - pad)], fill=255)


def sil_almond(d, W, H):
    pts_top, pts_bot = [], []
    a, b = W / 2 * 0.96, H / 2 * 0.94
    for i in range(61):
        x = -a + 2 * a * i / 60
        u = x / a
        h = b * math.sqrt(max(0, 1 - u * u)) * (0.80 + 0.20 * (-u))
        if u > 0.6:
            h *= 1 - 0.30 * (u - 0.6) / 0.4
        pts_top.append((W / 2 + x, H / 2 - h))
        pts_bot.append((W / 2 + x, H / 2 + h))
    d.polygon(pts_top + pts_bot[::-1], fill=255)


def sil_cashew(d, W, H):
    # kidney shape: a thick arc, fat at the head and tapering to the tail
    cx, cy = W * 0.46, H * 0.04
    R = H * 0.70
    a0, a1 = math.radians(-50), math.radians(54)
    outer, inner = [], []
    n = 60
    for i in range(n + 1):
        s_ = i / n
        ang = a0 + (a1 - a0) * s_
        thick = H * (0.34 + 0.30 * (1 - s_) ** 0.7)
        px, py = cx + R * math.sin(ang) * 0.80, cy + R * math.cos(ang)
        nx, ny = math.sin(ang), math.cos(ang)
        outer.append((px + nx * thick * 0.5 + W * 0.08, py + ny * thick * 0.5))
        inner.append((px - nx * thick * 0.5 + W * 0.08, py - ny * thick * 0.5))
    d.polygon(outer + inner[::-1], fill=255)


def sil_wavy(phase, amp=0.09, lobes=5):
    def fn(d, W, H):
        pts = []
        for i in range(120):
            t = 2 * math.pi * i / 120
            r = 1 + amp * math.sin(lobes * t + phase) + 0.04 * math.sin(9 * t + phase * 2)
            pts.append((W / 2 + math.cos(t) * W / 2 * 0.92 * r / (1 + amp), H / 2 + math.sin(t) * H / 2 * 0.92 * r / (1 + amp)))
        d.polygon(pts, fill=255)
    return fn


def sil_teardrop(d, W, H):
    pts = []
    for i in range(100):
        t = 2 * math.pi * i / 100
        x = math.cos(t)
        y = math.sin(t) * (0.55 + 0.45 * (1 - x) / 2) * (1 - 0.35 * max(0, x - 0.2))
        pts.append((W / 2 + x * W / 2 * 0.95, H / 2 + y * H / 2 * 0.95))
    d.polygon(pts, fill=255)


def sil_lens(d, W, H):
    pts = []
    for i in range(80):
        t = 2 * math.pi * i / 80
        x = math.cos(t)
        y = math.sin(t) * (1 - 0.55 * abs(x) ** 2.2)
        pts.append((W / 2 + x * W / 2 * 0.97, H / 2 + y * H / 2 * 0.95))
    d.polygon(pts, fill=255)


def sil_fig(d, W, H):
    pts = []
    for i in range(100):
        t = 2 * math.pi * i / 100
        x, y = math.cos(t), math.sin(t)
        if y < 0:
            y *= 0.9
            x *= 1 - 0.55 * (-y) ** 1.5
        pts.append((W / 2 + x * W / 2 * 0.95, H / 2 + y * H / 2 * 0.95))
    d.polygon(pts, fill=255)


def sil_star(points=8, inner=0.52):
    def fn(d, W, H):
        pts = []
        for i in range(points * 2):
            r = 1.0 if i % 2 == 0 else inner
            ang = math.pi * i / points - math.pi / 2
            pts.append((W / 2 + math.cos(ang) * W / 2 * 0.96 * r, H / 2 + math.sin(ang) * H / 2 * 0.96 * r))
        d.polygon(pts, fill=255)
    return fn


def sil_clove(d, W, H):
    # tapered stem with a round head and four small sepals
    d.polygon([(W * 0.18, H * 0.38), (W * 0.9, H * 0.46), (W * 0.9, H * 0.54), (W * 0.18, H * 0.62)], fill=255)
    d.ellipse([W * 0.02, H * 0.22, W * 0.26, H * 0.78], fill=255)
    for dy in (-0.26, 0.26):
        d.ellipse([W * 0.15, H * (0.5 + dy) - H * 0.12, W * 0.38, H * (0.5 + dy) + H * 0.12], fill=255)


def sil_leaf(d, W, H):
    pts = []
    for i in range(80):
        t = 2 * math.pi * i / 80
        x = math.cos(t)
        y = math.sin(t) * (1 - abs(x) ** 2.4 * 0.85)
        pts.append((W / 2 + x * W / 2 * 0.97, H / 2 + y * H / 2 * 0.95))
    d.polygon(pts, fill=255)


def sil_round_rect(radius=0.45):
    def fn(d, W, H):
        d.rounded_rectangle([W * 0.04, H * 0.04, W * 0.96, H * 0.96], radius=min(W, H) * radius, fill=255)
    return fn


# --------------------------------------------------------------------------- textures
def tex_lines(color, n=6, vertical=False, wobble=0.1, rng=None):
    rng = rng or random.Random(1)

    def fn(d, W, H, mask):
        for i in range(n):
            f = (i + 1) / (n + 1)
            wob = rng.uniform(-wobble, wobble)
            if vertical:
                d.line([(W * (f + wob), H * 0.1), (W * (f - wob), H * 0.9)], fill=color, width=max(2, SS))
            else:
                d.line([(W * 0.08, H * (f + wob)), (W * 0.92, H * (f - wob))], fill=color, width=max(2, SS))
    return fn


def tex_wrinkles(color, n=14, rng=None):
    rng = rng or random.Random(2)

    def fn(d, W, H, mask):
        for _ in range(n):
            x, y = rng.uniform(0.15, 0.85) * W, rng.uniform(0.15, 0.85) * H
            ln = rng.uniform(0.1, 0.28) * W
            ang = rng.uniform(-0.6, 0.6)
            d.line([(x, y), (x + math.cos(ang) * ln, y + math.sin(ang) * ln * 0.6)], fill=color, width=max(2, int(SS * 1.2)))
    return fn


def tex_dots(color, n=40, r=1.4, rng=None):
    rng = rng or random.Random(3)

    def fn(d, W, H, mask):
        for _ in range(n):
            x, y = rng.uniform(0.1, 0.9) * W, rng.uniform(0.1, 0.9) * H
            rr = r * SS * rng.uniform(0.6, 1.3)
            d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=color)
    return fn


def combine(*fns):
    def fn(d, W, H, mask):
        for f in fns:
            f(d, W, H, mask)
    return fn


# --------------------------------------------------------------------------- scene
class Scene:
    def __init__(self, size=(SIZE, SIZE), palette="dry", seed=0):
        self.w, self.h = size
        self.rng = random.Random(seed)
        self.img = self._backdrop(palette)

    def _backdrop(self, palette):
        w, h = self.w, self.h
        if palette == "dry":
            top, bot, wood_a, wood_b = (247, 233, 208), (236, 211, 172), (205, 160, 108), (166, 118, 72)
        else:
            top, bot, wood_a, wood_b = (246, 222, 190), (229, 184, 138), (186, 130, 84), (142, 92, 56)
        ys, xs = np.mgrid[0:h, 0:w]
        horizon = h * 0.40
        t = np.clip(ys / horizon, 0, 1)[..., None]
        wall = np.array(top, np.float32) + (np.array(bot, np.float32) - np.array(top, np.float32)) * t
        tt = np.clip((ys - horizon) / (h - horizon), 0, 1)[..., None]
        wood = np.array(wood_a, np.float32) + (np.array(wood_b, np.float32) - np.array(wood_a, np.float32)) * tt
        # wood grain: horizontal sin streaks
        grain = (np.sin(ys / 5.5 + np.sin(xs / 90.0) * 2.2) * 5 + np.sin(ys / 2.3) * 2)[..., None]
        canvas = np.where(ys[..., None] < horizon, wall, wood + grain)
        # warm light from top-left, vignette
        light = np.clip(1.14 - np.hypot((xs - w * 0.3) / w, (ys - h * 0.18) / h) * 0.85, 0.82, 1.12)[..., None]
        canvas = canvas * light
        noise = np.random.RandomState(7).normal(0, 2.0, (h, w, 1))
        canvas = np.clip(canvas + noise, 0, 255).astype(np.uint8)
        img = Image.fromarray(canvas).convert("RGBA")
        # contact line between wall and table
        d = ImageDraw.Draw(img)
        d.line([(0, horizon), (w, horizon)], fill=(120, 80, 40, 70), width=3)
        return img

    def paste(self, sprite, x, y, angle=0, flip=False, shadow=True, shadow_off=(7, 11)):
        s = sprite.transpose(Image.FLIP_LEFT_RIGHT) if flip else sprite
        if angle:
            s = s.rotate(angle, resample=Image.BICUBIC, expand=True)
        if shadow:
            sh, pad = shadow_of(s, blur=max(3, s.width // 18), alpha=105)
            self.img.alpha_composite(sh, (int(x - s.width / 2 - pad + shadow_off[0]), int(y - s.height / 2 - pad + shadow_off[1])))
        self.img.alpha_composite(s, (int(x - s.width / 2), int(y - s.height / 2)))

    def pile(self, make, count, cx, cy, rx, ry, mound=120, size_range=(0.9, 1.1), variants=6, shadow=True, spin=360, order="y", scale=1.32):
        sprites = [make(self.rng) for _ in range(variants)]
        pts = []
        for _ in range(count):
            u = self.rng.random() ** 0.62
            a = self.rng.uniform(0, 2 * math.pi)
            dx, dy = math.cos(a) * u * rx, math.sin(a) * u * ry
            lift = (1 - u ** 1.8) * mound
            pts.append((dx, dy, lift))
        pts.sort(key=lambda p: (p[1] - p[2]) if order == "y" else p[1])
        for dx, dy, lift in pts:
            spr = self.rng.choice(sprites)
            k = self.rng.uniform(*size_range) * scale
            s = spr.resize((max(2, int(spr.width * k)), max(2, int(spr.height * k))), Image.LANCZOS)
            self.paste(s, cx + dx, cy + dy - lift, angle=self.rng.uniform(0, spin), flip=self.rng.random() < 0.5, shadow=shadow)

    def ground_shadow(self, cx, cy, rx, ry, alpha=90):
        sh = Image.new("L", (self.w, self.h), 0)
        ImageDraw.Draw(sh).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=alpha)
        sh = sh.filter(ImageFilter.GaussianBlur(26))
        layer = Image.new("RGBA", (self.w, self.h), (40, 22, 8, 0))
        layer.putalpha(sh)
        self.img.alpha_composite(layer)


# --------------------------------------------------------------------------- item sprite makers
def almond_maker(size, tone):
    base = {"light": (196, 140, 86), "dark": (150, 96, 56), "mamra": (170, 108, 60)}[tone]

    def make(rng):
        w, h = 98 * size, 58 * size * (1.12 if tone == "mamra" else 1.0)
        tex = combine(tex_lines(darken(base, 0.42), n=5, vertical=False, wobble=0.08, rng=rng),
                      tex_dots(darken(base, 0.3), n=26, r=1.2, rng=rng))
        return make_sprite(w, h, sil_almond, jitter(base, rng), tex)
    return make


def cashew_maker(size):
    base = (232, 192, 120)

    def make(rng):
        w, h = 104 * size, 84 * size
        return make_sprite(w, h, sil_cashew, jitter(base, rng, 0.05), tex_dots(darken(base, 0.18), n=14, r=1.0, rng=rng))
    return make


def walnut_kernel_maker(tone):
    base = (226, 184, 120) if tone == "light" else (168, 116, 62)

    def make(rng):
        w = h = 118
        ph = rng.uniform(0, 6)

        def groove(d, W, H, mask):
            col = darken(base, 0.45)
            d.line([(W * 0.5, H * 0.1), (W * 0.5, H * 0.92)], fill=col, width=int(SS * 3))
            for i in range(5):
                y = H * (0.2 + i * 0.15)
                d.arc([W * 0.14, y - H * 0.1, W * 0.5, y + H * 0.14], 200, 340, fill=col, width=int(SS * 2.4))
                d.arc([W * 0.5, y - H * 0.1, W * 0.86, y + H * 0.14], 200, 340, fill=col, width=int(SS * 2.4))
        return make_sprite(w, h, sil_wavy(ph, 0.10, 6), jitter(base, rng, 0.06), groove)
    return make


def raisin_maker(tone, elong):
    base = {"green": (170, 178, 70), "amber": (176, 112, 40), "gold": (196, 160, 52)}[tone]

    def make(rng):
        w, h = 46 * elong, 28
        return make_sprite(w, h, sil_ellipse, jitter(base, rng, 0.1), tex_wrinkles(darken(base, 0.42), n=9, rng=rng))
    return make


def pistachio_shell_maker():
    def make(rng):
        w, h = 70, 46
        shell = (222, 200, 150)

        def tex(d, W, H, mask):
            d.line([(W * 0.08, H * 0.5), (W * 0.92, H * 0.5)], fill=(120, 96, 56), width=int(SS * 2.5))
            d.ellipse([W * 0.2, H * 0.32, W * 0.8, H * 0.68], fill=(136, 170, 70))
            d.ellipse([W * 0.26, H * 0.38, W * 0.62, H * 0.5], fill=(176, 206, 104))
            for _ in range(22):
                x, y = rng.uniform(0.1, 0.9) * W, rng.uniform(0.1, 0.9) * H
                d.ellipse([x - SS, y - SS, x + SS, y + SS], fill=(250, 246, 232))
        return make_sprite(w, h, sil_ellipse, jitter(shell, rng, 0.05), tex)
    return make


def pistachio_kernel_maker():
    def make(rng):
        w, h = 50, 32
        base = (132, 168, 66)

        def tex(d, W, H, mask):
            d.ellipse([W * 0.62, H * 0.1, W * 0.98, H * 0.9], fill=(164, 92, 106))
            d.line([(W * 0.15, H * 0.5), (W * 0.7, H * 0.5)], fill=darken(base, 0.35), width=int(SS * 1.6))
        return make_sprite(w, h, sil_ellipse, jitter(base, rng, 0.07), tex)
    return make


def fig_maker():
    def make(rng):
        w, h = 110, 96
        base = (150, 108, 76)

        def tex(d, W, H, mask):
            for _ in range(46):
                x, y = rng.uniform(0.2, 0.85) * W, rng.uniform(0.2, 0.85) * H
                d.ellipse([x - SS, y - SS, x + SS * 1.4, y + SS * 1.4], fill=(222, 196, 140))
            tex_wrinkles(darken(base, 0.4), n=10, rng=rng)(d, W, H, mask)
            d.ellipse([W * 0.02, H * 0.38, W * 0.14, H * 0.6], fill=(70, 46, 30))
        return make_sprite(w, h, sil_fig, jitter(base, rng, 0.08), tex)
    return make


def date_maker(size, tone):
    base = {"medjool": (112, 58, 26), "kimia": (150, 82, 38)}[tone]

    def make(rng):
        w, h = 104 * size, 60 * size
        return make_sprite(w, h, sil_ellipse, jitter(base, rng, 0.07),
                           tex_wrinkles(darken(base, 0.4) if tone == "medjool" else lighten(base, 0.25), n=12, rng=rng), light=0.36, dark=0.3)
    return make


def apricot_maker():
    def make(rng):
        w, h = 84, 70
        base = (232, 150, 52)

        def tex(d, W, H, mask):
            d.arc([W * 0.30, H * 0.04, W * 0.78, H * 0.96], 100, 260, fill=darken(base, 0.45), width=int(SS * 3))
            tex_dots(darken(base, 0.2), n=40, r=1.1, rng=rng)(d, W, H, mask)
        return make_sprite(w, h, sil_wavy(rng.uniform(0, 6), 0.05, 3), jitter(base, rng, 0.08), tex)
    return make


def prune_maker():
    def make(rng):
        w, h = 84, 66
        base = (62, 34, 58)
        return make_sprite(w, h, sil_ellipse, jitter(base, rng, 0.1), tex_wrinkles(lighten(base, 0.18), n=10, rng=rng), light=0.5, dark=0.25)
    return make


def cranberry_maker():
    def make(rng):
        w, h = 38, 30
        base = (194, 32, 62)
        return make_sprite(w, h, sil_ellipse, jitter(base, rng, 0.1),
                           combine(tex_wrinkles(darken(base, 0.35), n=5, rng=rng), tex_dots((250, 236, 236), n=9, r=0.9, rng=rng)))
    return make


def pumpkin_seed_maker():
    def make(rng):
        w, h = 58, 34

        def sil(d, W, H):
            sil_lens(d, W, H)

        def tex(d, W, H, mask):
            inner = Image.new("L", (W, H), 0)
            sil_lens(ImageDraw.Draw(inner), int(W * 0.8), int(H * 0.72))
            d.bitmap((W * 0.1, H * 0.14), inner, fill=(98, 138, 62))
            d.line([(W * 0.15, H * 0.5), (W * 0.85, H * 0.5)], fill=(70, 104, 44), width=int(SS * 1.4))
        return make_sprite(w, h, sil, (232, 226, 198), tex, shine=False)
    return make


def sunflower_seed_maker():
    def make(rng):
        w, h = 46, 24
        base = (66, 62, 58)

        def tex(d, W, H, mask):
            for f in (0.3, 0.5, 0.7):
                d.line([(W * 0.12, H * f), (W * 0.9, H * (0.5 + (f - 0.5) * 0.4))], fill=(222, 218, 206), width=int(SS * 1.6))
        return make_sprite(w, h, sil_teardrop, jitter(base, rng, 0.08), tex)
    return make


def pepper_maker():
    def make(rng):
        d_ = 30
        base = (52, 42, 36)
        return make_sprite(d_, d_, sil_ellipse, jitter(base, rng, 0.12), tex_dots(lighten(base, 0.25), n=14, r=1.3, rng=rng), light=0.45, dark=0.2)
    return make


def cardamom_maker(tone):
    base = (150, 172, 92) if tone == "green" else (84, 58, 40)
    w, h = (64, 32) if tone == "green" else (78, 46)

    def make(rng):
        tex = combine(tex_lines(darken(base, 0.35), n=6, rng=rng), tex_wrinkles(darken(base, 0.3), n=8, rng=rng) if tone == "black" else (lambda *a: None))
        return make_sprite(w, h, sil_lens, jitter(base, rng, 0.08), tex)
    return make


def clove_maker():
    def make(rng):
        return make_sprite(60, 26, sil_clove, jitter((88, 50, 30), rng, 0.1), None, light=0.35, dark=0.3)
    return make


def star_anise_maker():
    def make(rng):
        w = h = 96
        base = (112, 62, 34)

        def tex(d, W, H, mask):
            for i in range(8):
                ang = math.pi * 2 * i / 8 - math.pi / 2 + math.pi / 8
                x, y = W / 2 + math.cos(ang) * W * 0.3, H / 2 + math.sin(ang) * H * 0.3
                d.ellipse([x - W * 0.07, y - H * 0.05, x + W * 0.07, y + H * 0.05], fill=darken(base, 0.55))
            d.ellipse([W * 0.42, H * 0.42, W * 0.58, H * 0.58], fill=darken(base, 0.5))
        return make_sprite(w, h, sil_star(8, 0.55), jitter(base, rng, 0.08), tex)
    return make


def seed_long_maker(color, size):
    def make(rng):
        w, h = 22 * size, 9 * size
        return make_sprite(max(8, w), max(4, h), sil_ellipse, jitter(color, rng, 0.1), tex_lines(darken(color, 0.4), n=2, rng=rng), shine=False)
    return make


def seed_round_maker(color, square):
    def make(rng):
        if square:
            return make_sprite(16, 12, sil_round_rect(0.4), jitter(color, rng, 0.08), tex_lines(darken(color, 0.3), n=1, rng=rng), shine=False)
        return make_sprite(11, 11, sil_ellipse, jitter(color, rng, 0.1), None, light=0.35, dark=0.3)
    return make


def bay_leaf_maker():
    def make(rng):
        w, h = 168, 70
        base = (132, 144, 72)

        def tex(d, W, H, mask):
            d.line([(W * 0.05, H * 0.5), (W * 0.95, H * 0.5)], fill=lighten(base, 0.35), width=int(SS * 2.6))
            for i in range(1, 8):
                x = W * i / 8.5
                d.line([(x, H * 0.5), (x + W * 0.1, H * 0.18)], fill=lighten(base, 0.2), width=int(SS * 1.2))
                d.line([(x, H * 0.5), (x + W * 0.1, H * 0.82)], fill=lighten(base, 0.2), width=int(SS * 1.2))
        return make_sprite(w, h, sil_leaf, jitter(base, rng, 0.1), tex, shine=False)
    return make


def cinnamon_maker():
    def make(rng):
        w, h = 330, 50
        base = (176, 108, 54)

        def tex(d, W, H, mask):
            tex_lines(darken(base, 0.35), n=3, wobble=0.04, rng=rng)(d, W, H, mask)
            d.ellipse([W * 0.9, H * 0.08, W * 0.99, H * 0.92], fill=darken(base, 0.45))
            d.ellipse([W * 0.925, H * 0.28, W * 0.965, H * 0.72], fill=lighten(base, 0.2))
        return make_sprite(w, h, sil_round_rect(0.48), jitter(base, rng, 0.08), tex)
    return make


# --------------------------------------------------------------------------- label
def draw_label(img, name, caption):
    w, h = img.size
    d = ImageDraw.Draw(img)
    size = 66
    font = ImageFont.truetype(FONT_BOLD, size)
    max_w = w * 0.78
    while d.textlength(name, font=font) > max_w and size > 34:
        size -= 2
        font = ImageFont.truetype(FONT_BOLD, size)
    tw = d.textlength(name, font=font)
    cap_font = ImageFont.truetype(FONT_SANS, 22)
    cap = "   ".join(caption.upper())
    cw = d.textlength(cap, font=cap_font)
    bw = max(tw, cw) + 110
    bh = size + 78
    x0, y0 = (w - bw) / 2, h - bh - 46

    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x0, y0 + 10, x0 + bw, y0 + bh + 10], radius=28, fill=(40, 22, 8, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    img.alpha_composite(shadow)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=28, fill=(255, 251, 241), outline=(196, 161, 90), width=4)
    d.rounded_rectangle([x0 + 10, y0 + 10, x0 + bw - 10, y0 + bh - 10], radius=20, outline=(226, 205, 160), width=2)
    d.text((w / 2, y0 + 24 + size / 2), name, font=font, fill=(20, 86, 60), anchor="mm")
    d.text((w / 2, y0 + bh - 26), cap, font=cap_font, fill=(146, 116, 58), anchor="mm")


# --------------------------------------------------------------------------- product scenes
def build_product(p):
    kind, prm = p["art"]
    palette = "dry" if p["category"] == "dry-fruits" else "spice"
    seed = sum(ord(c) for c in p["slug"])
    sc = Scene(palette=palette, seed=seed)
    cx, cy = 500, 575

    def pile(make, count, rx=290, ry=120, mound=130, sizes=(0.92, 1.1), spin=360):
        rx, ry, mound = rx * 1.12, ry * 1.12, mound * 1.1
        sc.ground_shadow(cx, cy + 30, rx * 1.05, ry * 0.9)
        sc.pile(make, count, cx, cy, rx, ry, mound=mound, size_range=sizes, spin=spin)

    if kind == "almond":
        pile(almond_maker(prm["size"], prm["tone"]), prm["count"], mound=150)
    elif kind == "cashew":
        pile(cashew_maker(prm["size"]), prm["count"], mound=140)
    elif kind == "walnut_kernel":
        pile(walnut_kernel_maker(prm["tone"]), prm["count"], rx=250, ry=100, mound=120)
    elif kind == "raisin":
        pile(raisin_maker(prm["tone"], prm["elong"]), prm["count"], rx=270, ry=110, mound=140)
    elif kind == "pistachio_shell":
        pile(pistachio_shell_maker(), prm["count"], mound=130)
    elif kind == "pistachio_kernel":
        pile(pistachio_kernel_maker(), prm["count"], rx=270, ry=110, mound=140)
    elif kind == "fig":
        pile(fig_maker(), prm["count"], rx=250, ry=90, mound=110, spin=40)
    elif kind == "date":
        pile(date_maker(prm["size"], prm["tone"]), prm["count"], rx=270, ry=100, mound=120)
    elif kind == "apricot":
        pile(apricot_maker(), prm["count"], rx=270, ry=100, mound=130)
    elif kind == "prune":
        pile(prune_maker(), prm["count"], rx=270, ry=100, mound=130)
    elif kind == "cranberry":
        pile(cranberry_maker(), prm["count"], rx=270, ry=110, mound=140)
    elif kind == "pumpkin_seed":
        pile(pumpkin_seed_maker(), prm["count"], rx=270, ry=110, mound=120)
    elif kind == "sunflower_seed":
        pile(sunflower_seed_maker(), prm["count"], rx=270, ry=110, mound=120)
    elif kind == "pepper":
        pile(pepper_maker(), prm["count"], rx=250, ry=100, mound=150)
    elif kind == "cardamom":
        pile(cardamom_maker(prm["tone"]), prm["count"], rx=270, ry=100, mound=130)
    elif kind == "clove":
        pile(clove_maker(), prm["count"], rx=270, ry=105, mound=120)
    elif kind == "star_anise":
        pile(star_anise_maker(), prm["count"], rx=280, ry=100, mound=100, sizes=(0.85, 1.05))
    elif kind == "seed_long":
        pile(seed_long_maker(prm["color"], prm["size"]), prm["count"], rx=270, ry=105, mound=150, sizes=(0.9, 1.15))
    elif kind == "seed_round":
        pile(seed_round_maker(prm["color"], prm.get("square", False)), prm["count"], rx=270, ry=105, mound=150, sizes=(0.9, 1.2))
    elif kind == "bay_leaf":
        sc.ground_shadow(cx, cy + 30, 340, 100)
        sc.pile(bay_leaf_maker(), prm["count"], cx, cy, 200, 70, mound=70, size_range=(0.85, 1.05), spin=50, scale=1.25)
    elif kind == "cinnamon":
        sc.ground_shadow(cx, cy + 40, 360, 110)
        sprites = [cinnamon_maker()(sc.rng) for _ in range(4)]
        for i in range(prm["count"]):
            ang = sc.rng.uniform(-12, 12) + (i % 3 - 1) * 5
            row = i // 3
            spr = sc.rng.choice(sprites)
            spr = spr.resize((int(spr.width * 1.25), int(spr.height * 1.25)), Image.LANCZOS)
            sc.paste(spr, cx + sc.rng.uniform(-30, 30), cy - 70 + row * 74 + (i % 3) * 10, angle=ang)
    elif kind == "powder":
        draw_powder_bowl(sc, prm["color"], cx, cy - 40, scale=1.12)
    else:
        raise ValueError(kind)

    caption = "Premium dry fruits" if p["category"] == "dry-fruits" else "Freshly packed spices"
    draw_label(sc.img, p["name"], caption)
    return sc.img.convert("RGB")


def draw_powder_bowl(sc, color, cx, cy, scale=1.0, label=True):
    rng = sc.rng
    rx, ry = 270 * scale, 78 * scale
    body_h = 150 * scale
    top = cy + 10 * scale

    # drop shadow on table
    sc.ground_shadow(cx, top + body_h * 0.95, rx * 1.1, ry * 0.9, alpha=110)

    ceramic = (240, 228, 208)
    # bowl body: straight upper wall + half-ellipse bottom, shaded left-light to right-dark
    cyb = top + body_h * 0.30
    hh = body_h * 0.78
    body_pts = [(cx - rx, top)]
    for i in range(0, 61):
        a_ = math.pi * i / 60
        body_pts.append((cx - rx * math.cos(a_), cyb + hh * math.sin(a_) * (1 - 0.0)))
    body_pts.append((cx + rx, top))
    mask = Image.new("L", sc.img.size, 0)
    ImageDraw.Draw(mask).polygon(body_pts, fill=255)
    ys, xs = np.mgrid[0:sc.h, 0:sc.w]
    t = np.clip((xs - (cx - rx)) / (2 * rx), 0, 1)
    shade_arr = (np.array(lighten(ceramic, 0.05), np.float32)[None, None, :] * (1 - t[..., None])
                 + np.array(darken(ceramic, 0.34), np.float32)[None, None, :] * t[..., None])
    body = Image.fromarray(np.clip(shade_arr, 0, 255).astype(np.uint8)).convert("RGBA")
    body.putalpha(mask)
    sc.img.alpha_composite(body)
    d = ImageDraw.Draw(sc.img)
    # decorative band
    d.arc([cx - rx, cyb - hh * 0.05, cx + rx, cyb + hh * 1.0], 8, 172, fill=(196, 161, 90), width=5)
    # inner opening
    d.ellipse([cx - rx, top - ry, cx + rx, top + ry], fill=ceramic, outline=darken(ceramic, 0.35), width=5)
    d.ellipse([cx - rx * 0.93, top - ry * 0.9, cx + rx * 0.93, top + ry * 0.86], fill=darken(ceramic, 0.32))

    # powder mound: layered ellipses + granular dots
    mound_h = 120 * scale
    layers = 26
    for i in range(layers):
        f = i / (layers - 1)
        rr = rx * 0.9 * (1 - f * 0.86)
        yy = top - ry * 0.05 - mound_h * f
        col = mix(darken(color, 0.28), lighten(color, 0.16), f)
        d.ellipse([cx - rr, yy - ry * (1 - f * 0.5) * 0.82, cx + rr, yy + ry * (1 - f * 0.5) * 0.78], fill=col)
    # grain
    for _ in range(2600):
        a = rng.uniform(0, 2 * math.pi)
        u = rng.random() ** 0.55
        x = cx + math.cos(a) * u * rx * 0.86
        y = top - ry * 0.05 + math.sin(a) * u * ry * 0.8 - mound_h * (1 - u) * 0.95
        r = rng.uniform(1.0, 2.6)
        col = jitter(color, rng, 0.16)
        d.ellipse([x - r, y - r, x + r, y + r], fill=lighten(col, rng.uniform(0, 0.22)))
    # pinch on the table
    for _ in range(500):
        a = rng.uniform(0, 2 * math.pi)
        u = rng.random() ** 0.7
        x = cx + 330 * scale + math.cos(a) * u * 70 * scale
        y = top + body_h * 0.95 + math.sin(a) * u * 22 * scale
        r = rng.uniform(1.0, 2.4)
        d.ellipse([x - r, y - r, x + r, y + r], fill=jitter(color, rng, 0.14))


# --------------------------------------------------------------------------- category banners
def build_banner_dry():
    sc = Scene(size=(1400, 900), palette="dry", seed=11)
    cx = 700
    sc.ground_shadow(300, 520, 230, 80)
    sc.pile(almond_maker(1.0, "light"), 30, 300, 520, 190, 80, mound=110)
    sc.ground_shadow(700, 560, 250, 80)
    sc.pile(cashew_maker(1.1), 26, 700, 560, 200, 80, mound=110)
    sc.ground_shadow(1090, 520, 230, 80)
    sc.pile(raisin_maker("amber", 1.35), 70, 1090, 520, 190, 70, mound=110)
    sc.pile(walnut_kernel_maker("light"), 8, 520, 740, 150, 40, mound=40, scale=1.1)
    sc.pile(pistachio_shell_maker(), 14, 880, 750, 150, 40, mound=40, scale=1.1)
    return sc.img.convert("RGB")


def build_banner_spices():
    sc = Scene(size=(1400, 900), palette="spice", seed=12)
    draw_powder_bowl(sc, (226, 160, 18), 330, 520, scale=0.74)
    draw_powder_bowl(sc, (178, 28, 24), 720, 470, scale=0.74)
    draw_powder_bowl(sc, (120, 72, 38), 1090, 520, scale=0.74)
    sc.pile(pepper_maker(), 70, 520, 760, 170, 40, mound=30, scale=1.1)
    sc.pile(cardamom_maker("green"), 18, 900, 770, 150, 38, mound=30, scale=1.1)
    return sc.img.convert("RGB")


def main():
    os.makedirs(OUT_PRODUCTS, exist_ok=True)
    os.makedirs(OUT_CATEGORIES, exist_ok=True)
    wanted = set(sys.argv[1:])

    for p in PRODUCTS:
        if wanted and p["slug"] not in wanted:
            continue
        img = build_product(p).resize((900, 900), Image.LANCZOS)
        path = os.path.join(OUT_PRODUCTS, p["slug"] + ".webp")
        img.save(path, "WEBP", quality=82, method=6)
        print(f"{p['slug']:<30} {os.path.getsize(path) // 1024:>4} KB", flush=True)

    if not wanted or "dry-fruits" in wanted:
        build_banner_dry().save(os.path.join(OUT_CATEGORIES, "dry-fruits.webp"), "WEBP", quality=82, method=6)
        print("category dry-fruits", flush=True)
    if not wanted or "spices" in wanted:
        build_banner_spices().save(os.path.join(OUT_CATEGORIES, "spices.webp"), "WEBP", quality=82, method=6)
        print("category spices", flush=True)


if __name__ == "__main__":
    main()
