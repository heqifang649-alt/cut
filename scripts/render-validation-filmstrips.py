"""Contact sheets of already-rendered MP4 samples; no changes to source media."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

directory = Path(sys.argv[1]).resolve()
report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 15)
for row in report["rows"]:
    frames = row.get("previewFrames", [])
    if not frames:
        continue
    positions = sorted(set(round(i * (len(frames) - 1) / 7) for i in range(8)))
    canvas = Image.new("RGB", (1120, 1080), "#f3f3f3")
    draw = ImageDraw.Draw(canvas)
    draw.text((12, 12), f"{row['id']} | {row['level']} | {row['productId']} | {row['actualDuration']}s | same-source={len(row['sameSourceReuse'])}", font=font, fill="black")
    for index, position in enumerate(positions):
        x = (index % 4) * 280 + 5
        y = (index // 4) * 510 + 45
        with Image.open(directory / frames[position]) as image:
            image.thumbnail((270, 480))
            canvas.paste(image, (x, y + 20))
        draw.text((x, y), f"~{position / 2:.2f}s", font=font, fill="black")
    target = directory / row["id"] / "filmstrip.jpg"
    canvas.save(target, quality=92)
    print(row["id"])
