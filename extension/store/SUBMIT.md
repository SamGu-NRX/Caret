# Submitting Caret for Chrome (unlisted)

Before you start

- Merge `docs/privacy/chrome-extension.md` into `main` of SamGu-NRX/Caret. The policy URL 404s until then.
- Turn on Issues for SamGu-NRX/Caret (Settings, General, Features). The policy names the issues page as the contact, and Issues is off today.
- Build the package: `cd extension && pnpm install --offline && pnpm build:store`. Upload `extension/dist-store/caret-for-chrome-2.0.0.zip`.

Upload

1. Open https://chrome.google.com/webstore/devconsole, click New item, and choose the zip.
2. Store listing tab. All text is in `listing.md`.
   - Description: the "Description" section.
   - Category: Productivity, Workflow & planning. Language: English.
   - Store icon: `extension/icons/icon-128.png`.
   - Screenshots, in order: `screenshot-2-preview.png`, `screenshot-3-filled.png`. Leave out `screenshot-1-offer.png` for now: its offer covers the next field's label, a placement bug being fixed.
   - Small promo tile: `promo-small-440x280.png`. Leave the marquee tile empty.
   - Name and summary come from the package; check they read "Caret for Chrome" and the 117-character summary.
3. Privacy tab.
   - Single purpose: the "Single purpose" section.
   - Each permission box: the matching row of the permission table (first text column only).
   - Remote code: No.
   - Data usage: tick the five types listed under "Privacy practices form", then the three certifications.
   - Privacy policy: https://github.com/SamGu-NRX/Caret/blob/main/docs/privacy/chrome-extension.md
4. Distribution tab: Visibility **Unlisted**. Free, all regions.
5. Submit for review.

After the first upload (before or after review)

On the item's Package tab, click View public key. Send the lead two things: the item ID (the 32 letters in the dashboard URL) and that public key. The store ID differs from today's unpacked ID (`idbkbnaepbamcdecogahbinlcodkbmmj`). The lead then puts the store's key in the dev manifest and switches every `allowed_origins` and hard-coded ID to the store ID, so the unpacked build and the store build are one extension again.
