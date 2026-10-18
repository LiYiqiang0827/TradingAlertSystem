#!/usr/bin/env python3
"""Add internal slide jumps to the stock names on KPL theme slides."""
from __future__ import annotations

import json
import posixpath
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
ET.register_namespace("p", P)
ET.register_namespace("a", A)
ET.register_namespace("r", R)
ET.register_namespace("", REL)


def slide_order(parts: dict[str, bytes]) -> list[str]:
    presentation = ET.fromstring(parts["ppt/presentation.xml"])
    rels = ET.fromstring(parts["ppt/_rels/presentation.xml.rels"])
    targets = {r.attrib["Id"]: r.attrib["Target"] for r in rels.findall(f"{{{REL}}}Relationship")}
    result = []
    for item in presentation.findall(f".//{{{P}}}sldId"):
        target = targets[item.attrib[f"{{{R}}}id"]]
        target = target.lstrip("/")
        result.append(posixpath.normpath(target if target.startswith("ppt/") else posixpath.join("ppt", target)))
    return result


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: patch_internal_links.py PRESENTATION.pptx slide_manifest.json")
    pptx, manifest_path = map(Path, sys.argv[1:])
    manifest = json.loads(manifest_path.read_text())
    with zipfile.ZipFile(pptx, "r") as source:
        parts = {item.filename: source.read(item.filename) for item in source.infolist()}
        infos = source.infolist()
    ordered = slide_order(parts)
    if len(ordered) != len(manifest):
        raise RuntimeError(f"slide manifest has {len(manifest)} pages; package has {len(ordered)}")
    code_to_overview = {row["ts_code"]: index + 1 for index, row in enumerate(manifest) if row.get("kind") == "stock-overview"}
    slide_links: dict[int, list[dict]] = {}
    for index, row in enumerate(manifest):
        if row.get("kind") == "theme-recap":
            slide_links[index] = row.get("clickableStocks", [])
    links_added = 0
    for page_index, links in slide_links.items():
        if not links:
            continue
        slide_part = ordered[page_index]
        root = ET.fromstring(parts[slide_part])
        rel_part = str(Path(slide_part).parent / "_rels" / (Path(slide_part).name + ".rels"))
        if rel_part in parts:
            rel_root = ET.fromstring(parts[rel_part])
        else:
            rel_root = ET.Element(f"{{{REL}}}Relationships")
        existing_ids = [int(m.group(1)) for r in rel_root.findall(f"{{{REL}}}Relationship")
                        if (m := re.fullmatch(r"rId(\d+)", r.attrib.get("Id", "")))]
        next_id = max(existing_ids, default=0) + 1
        for item in links:
            target_page = code_to_overview.get(item["ts_code"])
            if target_page is None:
                short = re.sub(r"\.(SH|SZ|BJ)$", "", item["ts_code"])
                target_page = next((p for code, p in code_to_overview.items()
                                    if re.sub(r"\.(SH|SZ|BJ)$", "", code) == short), None)
            if target_page is None:
                raise RuntimeError(f"no individual overview slide for {item['ts_code']}")
            exact = item["text"]
            matches = []
            for shape in root.findall(f".//{{{P}}}sp"):
                body = shape.find(f"{{{P}}}txBody")
                if body is None:
                    continue
                value = "".join(t.text or "" for t in body.findall(f".//{{{A}}}t"))
                if value == exact:
                    matches.append(shape)
            if len(matches) != 1:
                raise RuntimeError(f"expected one shape named {exact!r} on {slide_part}; found {len(matches)}")
            rid = f"rId{next_id}"
            next_id += 1
            target_part = ordered[target_page - 1]
            target_rel = Path(target_part).relative_to(Path(slide_part).parent).as_posix()
            ET.SubElement(rel_root, f"{{{REL}}}Relationship", {
                "Id": rid, "Type": SLIDE_REL, "Target": target_rel,
            })
            for props in matches[0].findall(f".//{{{A}}}rPr"):
                hlink = props.find(f"{{{A}}}hlinkClick")
                if hlink is None:
                    hlink = ET.SubElement(props, f"{{{A}}}hlinkClick")
                hlink.set(f"{{{R}}}id", rid)
                hlink.set("action", "ppaction://hlinksldjump")
            links_added += 1
        parts[slide_part] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        parts[rel_part] = ET.tostring(rel_root, encoding="utf-8", xml_declaration=True)
    if not links_added:
        raise RuntimeError("no internal slide links were added")
    with tempfile.NamedTemporaryFile(dir=pptx.parent, suffix=".pptx", delete=False) as temporary:
        tmp_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as output:
            for info in infos:
                output.writestr(info, parts[info.filename])
            for name, content in parts.items():
                if name not in {i.filename for i in infos}:
                    output.writestr(name, content)
        tmp_path.replace(pptx)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    print(f"Added {links_added} internal slide links")


if __name__ == "__main__":
    main()
