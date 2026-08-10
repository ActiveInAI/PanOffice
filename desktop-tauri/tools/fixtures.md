# Fixture provenance

- `public/fixtures/hello.pdf` — generated here: `npm run fixture:pdf` (tools/make-fixture.mjs).
- `public/fixtures/simple.docx`, `public/fixtures/kitchen-sink.docx` — **copies** of
  `desktop/fixtures/generated/{simple,kitchen-sink}.docx` (byte-identical). The source
  fixtures live upstream; regenerate them there with the docx-engine fixture script
  (`cd desktop/packages/docx-engine && npm run fixtures`, needs `tsx`), then re-copy:
  `cp desktop/fixtures/generated/{simple,kitchen-sink}.docx desktop-tauri/public/fixtures/`.
  `simple.docx` holds three short Chinese paragraphs (Heading1「标题」+ 第一段/第二段);
  the docs e2e (e2e/docs.spec.ts) types an ASCII marker into it and asserts it survives
  a save → reload round-trip through the byte-store overlay.
