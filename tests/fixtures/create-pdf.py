from pathlib import Path
import argparse
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.colors import HexColor

parser = argparse.ArgumentParser(description="Regenerate the deterministic PDF_FIXTURE for byte comparison.")
parser.add_argument("output_directory", type=Path, help="Existing temporary output directory")
args = parser.parse_args()
if not args.output_directory.is_dir():
    parser.error("output_directory must be an existing temporary directory")
destination = args.output_directory / "basic.pdf"
if destination.exists():
    parser.error("basic.pdf already exists; use a fresh temporary directory")
canvas = Canvas(str(destination), pagesize=(420, 560), invariant=1)
canvas.setTitle("Intrica PDF evidence fixture")
canvas.setFillColor(HexColor("#243451"))
canvas.setFont("Helvetica-Bold", 22)
canvas.drawString(36, 506, "Intrica PDF evidence")
canvas.setFont("Helvetica", 12)
canvas.drawString(36, 466, "Page 1: searchable source evidence.")
canvas.drawString(36, 442, "Invoice reference: INTRICA-PDF-042")
canvas.drawString(36, 418, "Total: 128.50")
canvas.setStrokeColor(HexColor("#556781"))
canvas.line(36, 396, 384, 396)
canvas.setFont("Helvetica", 10)
canvas.drawString(36, 46, "Page 1 / 2 - text layer")
canvas.showPage()
canvas.setFillColor(HexColor("#eff3fb"))
canvas.rect(24, 24, 372, 512, fill=1, stroke=0)
canvas.setFillColor(HexColor("#4455dd"))
canvas.rect(64, 80, 64, 160, fill=1, stroke=0)
canvas.rect(172, 80, 64, 260, fill=1, stroke=0)
canvas.rect(280, 80, 64, 380, fill=1, stroke=0)
canvas.setStrokeColor(HexColor("#243451"))
canvas.line(48, 80, 360, 80)
canvas.showPage()
canvas.save()
print(destination)
