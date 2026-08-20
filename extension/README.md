# LLAMASEO Schema Collector

Reads a client site's structured data in your browser and pushes it to LLAMASEO.

Some hosts — SiteGround's Anti-Bot AI, Sucuri, Cloudflare — serve a robot
challenge to servers while letting real browsers through. The scanner cannot
read those sites. Your browser can, so it does the reading.

## Install

1. LLAMASEO → gear icon → **Chrome Extension** → **Generate token**. Copy it.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this `extension/` folder.
3. Open the extension's **Options**, enter your LLAMASEO URL and the token, and
   press **Save & test**. Chrome will ask for access to that one address.

## Use

Open the client's website, click the extension, choose the client, and press
**Collect this site**. It walks the sitemap, reads every page, and sends the
result. Keep the tab open; you can close the popup. Then open the Schema tab in
LLAMASEO.

## Notes

- `collector.js` is the single implementation of the collection logic. LLAMASEO
  serves the same file at `/schema-report.js` with an auto-run call appended, for
  pasting into a console when the extension is not installed.
- The pairing token reaches `/api/ext/*` and nothing else. Revoke it any time
  from the same settings panel.
- Permissions are `activeTab` (the tab you clicked on), `scripting` and
  `storage`, plus access to your LLAMASEO address only.
