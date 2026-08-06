import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def font(path, size):
    return ImageFont.truetype(path, size)


def centered(draw, xy, text, face, fill, stroke_width=0, stroke_fill=None):
    box = draw.textbbox((0, 0), text, font=face, stroke_width=stroke_width)
    x = xy[0] - (box[2] - box[0]) / 2
    draw.text((x, xy[1]), text, font=face, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)


def scaled(value, actual, reference):
    return max(1, int(round(value * actual / reference)))


def fit_face(draw, text, font_path, preferred, minimum, max_width, stroke_width):
    size = preferred
    while size > minimum:
        face = font(font_path, size)
        box = draw.textbbox((0, 0), text, font=face, stroke_width=stroke_width)
        if box[2] - box[0] <= max_width:
            return face
        size -= 2
    return font(font_path, minimum)


def wrap_text(draw, text, font_path, preferred, minimum, max_width, stroke_width, max_lines=2):
    text = " ".join(text.split())
    face = fit_face(draw, text, font_path, preferred, minimum, max_width, stroke_width)
    if draw.textbbox((0, 0), text, font=face, stroke_width=stroke_width)[2] <= max_width:
        return [text], face
    words = text.split()
    lines, line = [], ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=face, stroke_width=stroke_width)[2] <= max_width:
            line = candidate
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    if len(lines) <= max_lines:
        return lines, face
    return [text], fit_face(draw, text, font_path, preferred, minimum, max_width, stroke_width)


def make_hook(width, height, text, output, bold_font, layout):
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    spec = layout["hook"]
    preferred = scaled(spec["font_size_at_1080"], width, 1080)
    minimum = scaled(spec["minimum_font_size_at_1080"], width, 1080)
    stroke_width = scaled(spec["stroke_width_at_1080"], width, 1080)
    max_width = int(width * spec["max_width_percent"] / 100)
    text = "".join(ch for ch in text if ord(ch) < 0x2600).strip()
    lines, face = wrap_text(draw, text, bold_font, preferred, minimum, max_width, stroke_width, spec["max_lines"])
    y = int(height * spec["top_y_percent"] / 100)
    center_x = width * spec["center_x_percent"] / 100
    line_gap = scaled(spec["line_gap_at_1920"], height, 1920)
    for value in lines:
        box = draw.textbbox((0, 0), value, font=face, stroke_width=stroke_width)
        centered(draw, (center_x, y), value, face, spec["fill"], stroke_width, spec["stroke"])
        y += box[3] - box[1] + line_gap
    image.save(output)


def draw_pointer(draw, width, height, spec):
    cx = width * spec["pointer_center_x_percent"] / 100
    top = height * spec["pointer_top_y_percent"] / 100
    bottom = height * spec["pointer_bottom_y_percent"] / 100
    pointer_height = bottom - top
    pointer_width = pointer_height * 0.40
    left = cx - pointer_width / 2
    points = [
        (left + pointer_width * 0.25, top),
        (left + pointer_width * 0.63, top),
        (left + pointer_width * 0.63, top + pointer_height * 0.52),
        (left + pointer_width * 0.82, top + pointer_height * 0.42),
        (left + pointer_width, top + pointer_height * 0.58),
        (left + pointer_width * 0.48, bottom),
        (left, top + pointer_height * 0.60),
        (left + pointer_width * 0.25, top + pointer_height * 0.50),
    ]
    stroke = scaled(8, width, 1080)
    draw.polygon(points, fill=spec["pointer_fill"])
    draw.line(points + [points[0]], fill=spec["pointer_stroke"], width=stroke, joint="curve")


def make_cvr(width, height, text, secondary_text, output, bold_font, italic_font, layout):
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    spec = layout["cvr"]
    preferred = scaled(spec["primary_font_size_at_1080"], width, 1080)
    minimum = scaled(spec["minimum_font_size_at_1080"], width, 1080)
    stroke_width = scaled(spec["stroke_width_at_1080"], width, 1080)
    max_width = int(width * spec["max_width_percent"] / 100)
    center_x = width * spec["center_x_percent"] / 100
    y = int(height * spec["top_y_percent"] / 100)
    primary_lines, primary_face = wrap_text(draw, text, italic_font, preferred, minimum, max_width, stroke_width, spec["max_lines"])
    for value in primary_lines:
        box = draw.textbbox((0, 0), value, font=primary_face, stroke_width=stroke_width)
        centered(draw, (center_x, y), value, primary_face, spec["primary_fill"], stroke_width, spec["stroke"])
        y += box[3] - box[1] + scaled(4, height, 1920)
    secondary_text = secondary_text.strip() or spec.get("secondary_text_default", "")
    if secondary_text:
        secondary_face = fit_face(draw, secondary_text, bold_font, preferred - scaled(8, width, 1080), minimum, max_width, stroke_width)
        centered(draw, (center_x, y), secondary_text, secondary_face, spec["secondary_fill"], stroke_width, spec["stroke"])
    draw_pointer(draw, width, height, spec)
    image.save(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--edl", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--font", default=r"C:\Windows\Fonts\arialbd.ttf")
    parser.add_argument("--italic-font", default=r"C:\Windows\Fonts\arialbi.ttf")
    parser.add_argument("--layout", default=str(Path(__file__).resolve().parents[1] / "standards" / "text-layout-9x16-v1.json"))
    args = parser.parse_args()
    edl = json.loads(Path(args.edl).read_text(encoding="utf-8-sig"))
    master = edl.get("master", {})
    width, height = int(master.get("width", 1080)), int(master.get("height", 1920))
    layout = json.loads(Path(args.layout).read_text(encoding="utf-8-sig"))
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    make_hook(width, height, master.get("hook", {}).get("text", "Wearing what I believe."), output / "hook.png", args.font, layout)
    cvr = master.get("cvr", {})
    make_cvr(width, height, cvr.get("text", "One of our best sellers."), cvr.get("secondary_text", ""), output / "cvr.png", args.font, args.italic_font, layout)


if __name__ == "__main__":
    main()
