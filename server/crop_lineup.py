"""Crop 部队阵容 / 武将统计 / 战法统计 screenshots for OCR."""
import sys
import os
import numpy as np
from PIL import Image, ImageOps, ImageEnhance

src = sys.argv[1]
out_dir = sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

img = Image.open(src).convert('RGB')
arr = np.asarray(img)
H, W = arr.shape[:2]
r, g, b = arr[:, :, 0].astype(np.int16), arr[:, :, 1].astype(np.int16), arr[:, :, 2].astype(np.int16)
bright = (r + g + b) / 3.0

# 阵容/统计页：亮色文字 + 金色
mask = (bright > 150) & (r >= b - 15)
mask_img = Image.fromarray((mask * 255).astype(np.uint8), mode='L')


def save_crop(name, box_frac, invert=True, min_w=1000):
    x0, y0, x1, y1 = box_frac
    box = (int(W * x0), int(H * y0), int(W * x1), int(H * y1))
    crop = mask_img.crop(box)
    if invert:
        crop = ImageOps.invert(crop)
    bb = crop.getbbox()
    if bb:
        crop = crop.crop((max(0, bb[0] - 8), max(0, bb[1] - 8),
                          min(crop.width, bb[2] + 8), min(crop.height, bb[3] + 8)))
    if crop.width < min_w:
        s = min(2.2, min_w / max(crop.width, 1))
        crop = crop.resize((int(crop.width * s), int(crop.height * s)), Image.LANCZOS)
    p = os.path.join(out_dir, f'{name}.png')
    crop.save(p)
    print(f'{name}\t{crop.size[0]}x{crop.size[1]}')


# 部队阵容：标题/页签
save_crop('lineup_title', (0.35, 0.08, 0.70, 0.22))
save_crop('lineup_tabs', (0.12, 0.18, 0.40, 0.30))
# 三行武将：位置+名字+Lv
save_crop('lineup_row1', (0.12, 0.26, 0.85, 0.48))
save_crop('lineup_row2', (0.12, 0.45, 0.85, 0.68))
save_crop('lineup_row3', (0.12, 0.62, 0.85, 0.88))
# 战法/宝物文字区
save_crop('lineup_skills', (0.40, 0.28, 0.85, 0.90))
save_crop('lineup_lv', (0.12, 0.40, 0.40, 0.85))

# 武将统计表：表头 + 六行数据
save_crop('gstat_header', (0.35, 0.02, 0.95, 0.12))
save_crop('gstat_names', (0.15, 0.08, 0.30, 0.98))
save_crop('gstat_nums', (0.30, 0.08, 0.95, 0.98))
save_crop('gstat_full', (0.15, 0.02, 0.95, 0.98))

# 战法统计
save_crop('sstat_full', (0.15, 0.02, 0.95, 0.98))
save_crop('sstat_names', (0.15, 0.08, 0.32, 0.98))
save_crop('sstat_data', (0.30, 0.08, 0.95, 0.98))
# 战法/武将统计：6 行横条（名字+数字）
for i in range(6):
    y0 = 0.08 + i * 0.145
    y1 = min(0.98, y0 + 0.15)
    save_crop(f'stat_r{i}', (0.18, y0, 0.95, y1), min_w=1200)
    save_crop(f'stat_r{i}_name', (0.18, y0, 0.32, y1), min_w=400)

# 也出全图亮色
full = ImageOps.invert(mask_img)
bb = full.getbbox()
if bb:
    full = full.crop(bb)
if full.width < 2000:
    s = min(1.6, 2000 / max(full.width, 1))
    full = full.resize((int(full.width * s), int(full.height * s)), Image.LANCZOS)
full.save(os.path.join(out_dir, 'stat-full.png'))
print('stat-full', full.size)
