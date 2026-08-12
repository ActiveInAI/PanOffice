#!/usr/bin/env python
"""OFD → PDF conversion child for the WOPI host's /ofd/<id>/pdf route.

Usage: ofd2pdf.py <input.ofd> <output.pdf>

Runs inside the host's AI virtualenv (easyofd + pymupdf preinstalled). The
conversion is read-only: the source OFD is never modified; the PDF is a
faithful rendering for the PanOffice PDF editor (viewing + annotation).
"""
import base64
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: ofd2pdf.py <input.ofd> <output.pdf>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    from easyofd import OFD  # deferred: import cost only when converting

    with open(src, "rb") as handle:
        ofd_bytes = handle.read()
    ofd = OFD()
    ofd.read(base64.b64encode(ofd_bytes).decode(), fmt="b64", save_xml=False)
    pdf_bytes = ofd.to_pdf()
    if not isinstance(pdf_bytes, (bytes, bytearray)) or not pdf_bytes.startswith(b"%PDF"):
        print("conversion produced no PDF", file=sys.stderr)
        return 1
    with open(dst, "wb") as handle:
        handle.write(pdf_bytes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
