"""RapidOCR wrapper for Chinese game UI screenshots."""
import sys
import json

from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()

path = sys.argv[1]
result, elapse = engine(path)
items = []
if result:
    for row in result:
        try:
            box, text, score = row[0], row[1], row[2]
        except Exception:
            continue
        try:
            sc = float(score)
        except Exception:
            sc = 0.0
        t = (text or '').strip()
        if sc > 0.5 and t:
            y = float(box[0][1]) if box else 0
            items.append({'text': t, 'score': sc, 'y': y})
items.sort(key=lambda x: x['y'])
print(json.dumps({'items': items}, ensure_ascii=False))
