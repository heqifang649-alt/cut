"""Read existing audit frame files; create review sheets outside Batch storage."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

audit_path = Path(sys.argv[1]).resolve()
audit = json.loads(audit_path.read_text(encoding="utf-8"))
out = audit_path.parent / "contact-sheets"
out.mkdir(exist_ok=True)
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 16)
for case in audit["cases"]:
    if not case["shots"]:
        continue
    sheet = Image.new("RGB", (990, 60 + 290 * len(case["shots"])), "white")
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 10), f"Case {case['number']} | {case['batchId'][:8]} | {case['productId']}", font=font, fill="black")
    for row, shot in enumerate(case["shots"]):
        y = 60 + row * 290
        draw.text((8, y), f"{shot['shotId'][:12]}\n{shot['sourceName']}\n{shot['timeRange']}\n{shot['shotType']}\nvisibility={shot['productVisibility']['semantic']}", font=font, fill="black")
        for col, frame in enumerate(shot["frames"]):
            x = 260 + col * 240
            if frame["file"]:
                with Image.open(frame["file"]) as image:
                    image.thumbnail((230, 250))
                    sheet.paste(image, (x, y + 25))
            draw.text((x, y), f"t={frame['position']}s", font=font, fill="black")
    target = out / f"case-{case['number']:02d}.jpg"
    if target.exists():
        raise FileExistsError(target)
    sheet.save(target, quality=90)
    print(str(target))
