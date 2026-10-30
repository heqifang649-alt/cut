import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("reader", ROOT / "worker/read-hook-workbooks.py")
READER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READER)


class WorkbookExtraction(unittest.TestCase):
    def test_real_rows_ignore_stale_dimensions_and_formulas(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "test.xlsx"
            with zipfile.ZipFile(file, "w") as archive:
                archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hooks" sheetId="1" r:id="r1"/></sheets></workbook>')
                archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
                archive.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>英文 Hook</t></is></c></row><row r="90"><c r="A90" t="inlineStr"><is><t>Keep the original’s words</t></is></c><c r="B90"><f>HYPERLINK("bad")</f><v>cached</v></c></row></sheetData></worksheet>')
            before = file.read_bytes()
            result = READER.read_workbook(file)
            self.assertEqual(result["sheets"][0]["rows"][1], {"row": 90, "cells": {"A": "Keep the original’s words"}})
            self.assertEqual(file.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
