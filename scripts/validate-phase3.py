#!/usr/bin/env python3
"""External validation of xpdf Phase 3 template examples (pypdf, independent
of the TS code). Checks text layer, page geometry, attachments, round-trip."""
import json
from pathlib import Path

from pypdf import PdfReader

BASE = Path(__file__).resolve().parent.parent / "packages" / "templates" / "examples"

def load(name):
    r = PdfReader(f"{BASE}/{name}")
    text = "\n".join(p.extract_text() for p in r.pages)
    attachments = []
    root = r.trailer["/Root"]
    if "/Names" in root and "/EmbeddedFiles" in root["/Names"]:
        names = root["/Names"]["/EmbeddedFiles"]["/Names"]
        attachments = [str(n) for n in names[0::2]]
    return r, text, attachments

def check(name, pages=None, must=(), must_not=()):
    r, text, att = load(name)
    if pages is not None:
        assert len(r.pages) == pages, f"{name}: {len(r.pages)} pages != {pages}"
    for needle in must:
        assert needle in text, f"{name}: missing {needle!r}"
    for needle in must_not:
        assert needle not in text, f"{name}: unexpected {needle!r}"
    return r, text, att

# --- CV ----------------------------------------------------------------------
r, text, att = check("cv.pdf", pages=None, must=[
    "Ada Lovelace", "Analytical Engine Programmer", "EXPERIENCE", "Note G",
    "EDUCATION", "SKILLS", "Analytical Engine, Difference Engine",
    "English (native)", "ada@analytical.example",
])
assert att == ["document.json"], att
print(f"cv.pdf          OK  ({len(r.pages)} page(s))")

# --- Report ------------------------------------------------------------------
r, text, att = check("report.pdf", must=[
    "Quarterly Engine Telemetry", "Q3 2026", "A. Lovelace",
    "1.  Scope and method", "2.  Findings", "2.1  Recommendations",
    "Mean wear (mm)", "Page 1 of", "replaced on 2026-08-19",  # footnote
    "The engine seldom lies",
])
print(f"report.pdf      OK  ({len(r.pages)} page(s))")

# --- Letter ------------------------------------------------------------------
r, text, att = check("letter.pdf", pages=1, must=[
    "Atelier Lovelace SAS", "Paris, 2026-08-12", "Babbage Instruments Ltd",
    "Maintenance contract renewal", "Dear Dr. Babbage,", "Sincerely,",
    "Ada Lovelace, Director", "Enclosures: 2",
])
print(f"letter.pdf      OK  (1 page)")

# --- Paper -------------------------------------------------------------------
r, text, att = check("paper.pdf", must=[
    "On the Mechanical Computation of Bernoulli Numbers",
    "A. Lovelace", "C. Babbage", "Abstract", "Keywords",
    "1.  Introduction", "2.  Method", "2.1  Card complexity",
    "Acknowledgements", "References", "[1]", "[2]",
    "complete mechanical description",  # footnote
])
print(f"paper.pdf       OK  ({len(r.pages)} page(s))")

# --- Screenplay --------------------------------------------------------------
r, text, att = check("screenplay.pdf", must=[
    "THE DIFFERENCE", "written by", "A. Lovelace",          # title page
    "INT. BABBAGE'S WORKSHOP - DAY", "(reading a card)",
    "ninth digit.", "CUT TO:", "(sheepish)", "FADE OUT.",
    "Then let us argue about", "music instead.",                    # dual dialogue
])
assert att == ["document.json"], att
payload = json.loads(
    r.trailer["/Root"]["/Names"]["/EmbeddedFiles"]["/Names"][1]
     .get_object()["/EF"]["/F"].get_object().get_data().decode("utf-8"))
assert payload["type"] == "screenplay" and "INT. BABBAGE" in payload["data"]["fountain"]
box = r.pages[0].mediabox
assert float(box.width) == 612 and float(box.height) == 792, box
print(f"screenplay.pdf  OK  ({len(r.pages)} pages, US Letter, fountain round-trip)")

print("\nALL PHASE 3 CHECKS PASSED")
