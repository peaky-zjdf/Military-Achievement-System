"""Compress image for vision API (max width 1200, jpeg quality 70)."""
import sys
from PIL import Image

src = sys.argv[1]
dst = sys.argv[2]
img = Image.open(src).convert('RGB')
w, h = img.size
max_w = 1200
if w > max_w:
    img = img.resize((max_w, int(h * max_w / w)), Image.LANCZOS)
img.save(dst, 'JPEG', quality=70, optimize=True)
print(dst, img.size)
