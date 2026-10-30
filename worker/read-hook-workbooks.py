"""Read-only OOXML extraction. No Excel automation, formulas, or dependencies."""
import hashlib
import io
import json
import pathlib
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


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
            if pathlib.Path(name).name != name or not name.lower().endswith(".xlsx"):
                raise ValueError("invalid_filename")
            results.append(read_workbook(directory / name))
        except Exception as error:
            results.append({"filename": name, "error": type(error).__name__})
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
