import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter


def font(path, size):
    return ImageFont.truetype(path, size)


def centered(draw, xy, text, face, fill, stroke_width=0, stroke_fill=None):
    box = draw.textbbox((0, 0), text, font=face, stroke_width=stroke_width)
    x = xy[0] - (box[2] - box[0]) / 2
    draw.text((x, xy[1]), text, font=face, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)


def scaled(value, actual, reference):
    return max(1, int(round(value * actual / reference)))


def rgba(value, alpha=255):
    if isinstance(value, (tuple, list)):
        return tuple(value)
    text = str(value or "#FFFFFF").lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) == 6:
        return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4)) + (alpha,)
    if len(text) == 8:
        return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4, 6))
    return (255, 255, 255, alpha)


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
    pointer_width = pointer_height * float(spec.get("pointer_width_ratio", 0.46))
    left = cx - pointer_width / 2
    points = [
        (left + pointer_width * 0.28, top),
        (left + pointer_width * 0.72, top),
        (left + pointer_width * 0.72, top + pointer_height * 0.48),
        (left + pointer_width * 0.93, top + pointer_height * 0.48),
        (left + pointer_width * 0.50, bottom),
        (left + pointer_width * 0.07, top + pointer_height * 0.48),
        (left + pointer_width * 0.28, top + pointer_height * 0.48),
    ]
    outline = points + [points[0]]
    stroke = scaled(spec.get("pointer_stroke_width_at_1080", 14), width, 1080)
    inner_stroke = scaled(spec.get("pointer_inner_stroke_width_at_1080", 5), width, 1080)
    glow_stroke = scaled(spec.get("pointer_glow_width_at_1080", 34), width, 1080)
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.line(outline, fill=rgba(spec.get("pointer_glow", "#FF3B30")), width=glow_stroke, joint="curve")
    glow = glow.filter(ImageFilter.GaussianBlur(radius=scaled(spec.get("pointer_glow_blur_at_1080", 18), width, 1080)))
    draw._image.alpha_composite(glow)
    draw.line(outline, fill=spec.get("pointer_stroke", "#FF3B30"), width=stroke, joint="curve")
    draw.line(outline, fill=spec.get("pointer_inner_stroke", "#FFFFFF"), width=inner_stroke, joint="curve")


def make_cvr(width, height, text, secondary_text, output, bold_font, italic_font, layout, overrides=None):
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    allowed = set(layout["cvr"].keys())
    spec = {**layout["cvr"], **{key: value for key, value in (overrides or {}).items() if key in allowed}}
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
    # Pointer graphics are opt-in. Existing profiles may still carry legacy
    # pointer coordinates, but the default Cutflow layout must remain text-only.
    if spec.get("pointer_enabled", False):
        draw_pointer(draw, width, height, spec)
    bbox = image.getchannel("A").getbbox()
    bottom_safe_percent = float(layout.get("safe_zone", {}).get("bottom_percent", 8))
    minimum_bottom_clearance = int(round(height * bottom_safe_percent / 100))
    actual_bottom_clearance = height - bbox[3] if bbox else height
    if actual_bottom_clearance < minimum_bottom_clearance:
        raise ValueError(
            f"CVR overlay violates bottom safe zone: {actual_bottom_clearance}px < {minimum_bottom_clearance}px"
        )
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
    make_cvr(width, height, cvr.get("text", "One of our best sellers."), cvr.get("secondary_text", ""), output / "cvr.png", args.font, args.italic_font, layout, cvr)


if __name__ == "__main__":
    main()
