"""Read-only OOXML extraction. No Excel automation, formulas, or dependencies."""
import hashlib
import io
import json
import pathlib
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_document(file):
    raw = file.read_bytes()
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("document_too_large")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if sum(x.file_size for x in archive.infolist()) > 64 * 1024 * 1024:
            raise ValueError("expanded_document_too_large")
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        body = ET.fromstring(archive.read("word/document.xml"))
        hook_rows = []
        found_hook_header = False
        for table in body.findall(".//w:tbl", ns):
            records = [
                ["".join(t.text or "" for t in cell.findall(".//w:t", ns)).strip()
                 for cell in row.findall("w:tc", ns)]
                for row in table.findall("w:tr", ns)
            ]
            if records and records[0] == ["#", "方向", "Hook", "文案（CTA）"]:
                found_hook_header = True
                records = records[1:]
            if found_hook_header:
                hook_rows.extend({"row": int(row[0]), "cells": {"A": row[2]}}
                                 for row in records if len(row) == 4 and row[0].isdigit())
        if found_hook_header:
            return {"filename": file.name, "sha256": hashlib.sha256(raw).hexdigest(),
                    "sheets": [{"name": "Hook", "rows": [
                        {"row": 0, "cells": {"A": "英文 Hook"}}, *hook_rows]}]}
        if file.name == "护士通用hook与文案.docx":
            raise ValueError("unrecognized_hook_table")
        rows = [{"row": 0, "cells": {"A": "英文 Hook"}}]
        for number, paragraph in enumerate(body.findall('.//w:p', ns), 1):
            text = ''.join(t.text or '' for t in paragraph.findall('.//w:t', ns)).strip()
            # The maintained document ends with recommendations and purchase CTAs.
            # Only standalone English Hook paragraphs preceding that commentary are data.
            if text.startswith('我特别建议'):
                break
            text = re.sub(r'^\d+[.、]\s*', '', text)
            if re.fullmatch(r"[\x20-\x7e\u2010-\u2026]+", text or '') and re.search(r'[A-Za-z]', text) and text != '英文 Hook':
                rows.append({"row": number, "cells": {"A": text}})
        return {"filename": file.name, "sha256": hashlib.sha256(raw).hexdigest(),
                "sheets": [{"name": "document", "rows": rows}]}


def read_workbook(file):
    raw = file.read_bytes()
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("workbook_too_large")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if sum(x.file_size for x in archive.infolist()) > 64 * 1024 * 1024:
            raise ValueError("expanded_workbook_too_large")
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(t.text or "" for t in item.iter("{" + NS["s"] + "}t"))
                       for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        relationships = {x.attrib["Id"]: x.attrib["Target"] for x in
                         ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        sheets = []
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        for sheet in workbook.find("s:sheets", NS):
            if sheet.attrib.get("state", "visible") != "visible":
                continue
            target = relationships[sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
            target = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            if not target.startswith("xl/"):
                continue
            rows = []
            # Deliberately ignore stale worksheet <dimension ref="A1">.
            for row in ET.fromstring(archive.read(target)).findall("s:sheetData/s:row", NS):
                values = {}
                for cell in row.findall("s:c", NS):
                    if cell.find("s:f", NS) is not None:
                        continue
                    value = cell.find("s:v", NS)
                    value = value.text if value is not None else ""
                    if cell.attrib.get("t") == "s":
                        value = strings[int(value)] if value else ""
                    elif cell.attrib.get("t") == "inlineStr":
                        value = "".join(t.text or "" for t in cell.findall(".//s:t", NS))
                    if value:
                        values["".join(c for c in cell.attrib["r"] if c.isalpha())] = value
                if values:
                    rows.append({"row": int(row.attrib["r"]), "cells": values})
            sheets.append({"name": sheet.attrib["name"], "rows": rows})
        return {"filename": file.name, "sha256": hashlib.sha256(raw).hexdigest(), "sheets": sheets}


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    request = json.load(sys.stdin)
    directory = pathlib.Path(request["directory"])
    results = []
    for name in request["files"]:
        try:
            if pathlib.Path(name).name != name or not name.lower().endswith((".xlsx", ".docx")):
                raise ValueError("invalid_filename")
            results.append((read_document if name.lower().endswith('.docx') else read_workbook)(directory / name))
        except Exception as error:
            results.append({"filename": name, "error": type(error).__name__})
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
