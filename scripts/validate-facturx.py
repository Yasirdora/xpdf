#!/usr/bin/env python3
"""External validation of the xpdf Factur-X end-to-end example.

Checks with pypdf + xml.dom (independent of our own TS code):
  1. PDF structure: page count, embedded files, AFRelationship, OutputIntent, XMP
  2. factur-x.xml: well-formed CII, EN 16931 totals, line items, VAT breakdown
  3. document.json: round-trip payload parses and matches totals
  4. Visual layer: page-1 text extraction contains key invoice content
"""
import json
import sys
import xml.dom.minidom
from pathlib import Path

from pypdf import PdfReader

PDF = Path(__file__).resolve().parent.parent / "packages" / "templates" / "examples" / "facturx-invoice.pdf"

r = PdfReader(PDF)

# --- 1. PDF structure -------------------------------------------------------
assert len(r.pages) == 1, f"expected 1 page, got {len(r.pages)}"

root = r.trailer["/Root"]
names = root["/Names"]["/EmbeddedFiles"]["/Names"]
attachments = {}
it = iter(names)
for name, ref in zip(it, it):
    ef = ref.get_object()
    attachments[str(name)] = ef["/EF"]["/F"].get_object().get_data()
assert sorted(attachments) == ["document.json", "factur-x.xml"], sorted(attachments)

for name, ref in zip(iter(names), iter(names)):
    pass  # consumed; re-iterate below for AFRelationship
it = iter(names)
rels = {}
for name, ref in zip(it, it):
    ef = ref.get_object()
    rels[str(name)] = str(ef.get("/AFRelationship"))
assert rels["factur-x.xml"] == "/Alternative", rels
assert rels["document.json"] in ("/Source", "/Data"), rels

oi = root["/OutputIntents"][0].get_object()
assert str(oi["/S"]) == "/GTS_PDFA1", oi["/S"]

xmp = root["/Metadata"].get_object().get_data().decode("utf-8")
for marker in ("<pdfaid:part>3</", "<pdfaid:conformance>B</", "<fx:ConformanceLevel ",
               ">EN 16931</fx:ConformanceLevel>", ">factur-x.xml</fx:DocumentFileName>",
               ">1.0</fx:Version>", ">INVOICE</fx:DocumentType>",
               'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#'):
    assert marker in xmp, f"missing XMP marker: {marker}"

# --- 2. factur-x.xml (CII) --------------------------------------------------
doc = xml.dom.minidom.parseString(attachments["factur-x.xml"])

def texts(tag):
    return [n.firstChild.data for n in doc.getElementsByTagName(tag) if n.firstChild]

# 4 line items (3 @ 20%, 1 @ 5.5%) + 2 header VAT breakdown rows (20, 5.5)
assert sorted(texts("ram:RateApplicablePercent")) == ["20"] * 4 + ["5.5"] * 2, \
    sorted(texts("ram:RateApplicablePercent"))

lines = doc.getElementsByTagName("ram:IncludedSupplyChainTradeLineItem")
assert len(lines) == 4, f"expected 4 line items, got {len(lines)}"

assert "FR12345678901" in texts("ram:ID"), "seller VAT id missing"
assert any("2610.56" == t for t in texts("ram:GrandTotalAmount")), texts("ram:GrandTotalAmount")
# VAT total in TaxTotalAmount; CalculatedAmount holds the per-rate breakdown
assert any("420.59" == t for t in texts("ram:TaxTotalAmount")), texts("ram:TaxTotalAmount")
assert sorted(texts("ram:CalculatedAmount")) == ["413.99", "6.60"], texts("ram:CalculatedAmount")
assert any("2189.97" == t for t in texts("ram:TaxBasisTotalAmount")), texts("ram:TaxBasisTotalAmount")

# --- 3. document.json round-trip --------------------------------------------
payload = json.loads(attachments["document.json"].decode("utf-8"))
assert payload["type"] == "invoice", payload.get("type")
assert payload["version"] == 1, payload.get("version")
d = payload["data"]
assert d["number"] == "INV-2026-0042" and d["currency"] == "EUR", d["number"]
assert len(d["lines"]) == 4, len(d["lines"])
# recompute totals from the source lines and check they match the XML figures
from decimal import Decimal, ROUND_HALF_UP
c = lambda x: Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
net = sum(c(Decimal(str(l["quantity"])) * Decimal(str(l["unitPrice"]))) for l in d["lines"])
vat = Decimal("0")
for rate in {l["vatRate"] for l in d["lines"]}:
    basis = sum(c(Decimal(str(l["quantity"])) * Decimal(str(l["unitPrice"])))
                for l in d["lines"] if l["vatRate"] == rate)
    vat += c(basis * Decimal(str(rate)) / 100)
assert str(net) == "2189.97", net
assert str(vat) == "420.59", vat
assert str(net + vat) == "2610.56", net + vat

# --- 4. Visual layer ---------------------------------------------------------
page_text = r.pages[0].extract_text()
for needle in ("Atelier Lovelace SAS", "INVOICE", "Babbage Instruments Ltd",
               "2,610.56", "Merci pour votre confiance"):
    assert needle in page_text, f"missing on page: {needle!r}"

import os
size = os.path.getsize(PDF)
print(f"ALL CHECKS PASSED  ({size:,} bytes, 1 page, 2 attachments)")
