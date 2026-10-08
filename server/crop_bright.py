"""Isolate bright cream/gold/white journey numbers from dark UI."""
import sys
import os
import numpy as np
from PIL import Image, ImageOps

src = sys.argv[1]
out_dir = sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

img = Image.open(src).convert('RGB')
arr = np.asarray(img)
H, W = arr.shape[:2]
r = arr[:, :, 0].astype(np.int16)
g = arr[:, :, 1].astype(np.int16)
b = arr[:, :, 2].astype(np.int16)
bright = (r + g + b) / 3.0

# cream/gold/white text
mask = (bright > 165) & (r >= b - 10)
mask_img = Image.fromarray((mask * 255).astype(np.uint8), mode='L')
ocr_img = ImageOps.invert(mask_img)

bbox = ocr_img.getbbox()
print('bbox', bbox, 'text_pixels', int(mask.sum()))
if bbox:
    pad = 30
    box = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(W, bbox[2] + pad), min(H, bbox[3] + pad))
    ocr_img = ocr_img.crop(box)

if ocr_img.width < 2000:
    s = min(1.8, 2200 / max(ocr_img.width, 1))
    ocr_img = ocr_img.resize((int(ocr_img.width * s), int(ocr_img.height * s)), Image.LANCZOS)

full_path = os.path.join(out_dir, 'bright-full.png')
ocr_img.save(full_path)
print('bright-full', full_path, ocr_img.size)

regions = {
    'kills':    (0.02, 0.26, 0.32, 0.62),
    'land':     (0.20, 0.46, 0.50, 0.80),
    'demolish': (0.38, 0.26, 0.66, 0.62),
    'war':      (0.58, 0.46, 0.88, 0.80),
    'city':     (0.74, 0.26, 1.00, 0.62),
    'footer':   (0.00, 0.90, 0.55, 1.00),
    # name is usually after 「|」 near the right of footer text
    'footer_name': (0.08, 0.91, 0.35, 1.00),
    # 战报中部：【我方战败】武勋 +937  /  玩家名
    'battle_center': (0.40, 0.22, 0.60, 0.42),
    'battle_name': (0.20, 0.04, 0.45, 0.18),
    # 双方顶栏：我方名/兵力 · 敌方名/兵力
    'battle_left_name': (0.22, 0.04, 0.48, 0.18),
    'battle_left_troops': (0.10, 0.04, 0.30, 0.18),
    'battle_right_name': (0.52, 0.04, 0.80, 0.18),
    'battle_right_troops': (0.72, 0.04, 0.95, 0.18),
    # 双方武将卡（底部文字条）
    'battle_left_gens': (0.10, 0.62, 0.42, 0.88),
    'battle_right_gens': (0.54, 0.62, 0.90, 0.88),
    # 同盟条
    'battle_left_ally': (0.18, 0.14, 0.40, 0.24),
    'battle_right_ally': (0.54, 0.14, 0.78, 0.24),
}
for name, (x0, y0, x1, y1) in regions.items():
    box = (int(W * x0), int(H * y0), int(W * x1), int(H * y1))
    crop = ImageOps.invert(mask_img.crop(box))
    bb = crop.getbbox()
    if bb:
        crop = crop.crop((max(0, bb[0] - 12), max(0, bb[1] - 12), min(crop.width, bb[2] + 12), min(crop.height, bb[3] + 12)))
    if crop.width < 900:
        s = min(2.0, 1200 / max(crop.width, 1))
        crop = crop.resize((int(crop.width * s), int(crop.height * s)), Image.LANCZOS)
    p = os.path.join(out_dir, f'b-{name}.png')
    crop.save(p)
    print(f'b-{name}', p, crop.size, 'bbox', bb)
