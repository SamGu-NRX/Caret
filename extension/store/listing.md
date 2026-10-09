# Caret for Chrome: Web Store listing

Text for each dashboard field, ready to paste. Where a claim rests on code, the file and line are given so a reviewer's question can be answered from the source.

## Name

Caret for Chrome

The store reads the name from the package's manifest.

## Summary (132 characters at most)

Fills the form you are in from the Caret app on your Mac, when you accept. Talks only to that app, never to a server.

117 characters. The store also reads this from the manifest's `description`, so the two must stay the same.

## Description

Caret for Chrome connects web pages to Caret, a Mac app that fills in forms for you. It does nothing on its own. Without the Caret app running on the same Mac, it walks no page and sends nothing.

What it does

- When you are in a form, it reads the form's fields (their labels, current values and choices) and hands them to the Caret app on your Mac.
- Caret works out what belongs in each field from what you have open and what you have told it, then shows you every value and where it came from.
- When you press Tab to accept, the extension types those values into the page. Caret never presses a page's buttons, so submitting is always your click.
- If you click or type on the page while Caret is filling it, Caret stops at once.

What it never reads

- The contents of password, one-time-code and card fields, including a password shown as text and a field labelled "Verification code" or "Card number".
- Hidden fields, and questions about gender, race, ethnicity, disability, veteran status or sexual orientation, and consent checkboxes. Those are yours to answer.
- Any page on a site you have switched Caret off for, and anything on password managers and account pages such as passwords.google.com and appleid.apple.com.

Where the data goes

The extension talks only to the Caret app, through Chrome's native messaging. It makes no network requests of its own. To decide what to fill, the Caret app sends short pieces of what is on your screen to its cloud model, Jev, run by TypeSafe. The privacy policy quotes Caret's full privacy promise and says exactly what is sent and who receives it.

Install the Caret app for Mac first. This extension does nothing without it.

## Category

Productivity (Workflow & planning)

## Language

English

## Single purpose

Caret for Chrome lets the Caret app on the same Mac read the fields of the web form you are in and fill them with values you accept.

## Permission justifications

| Permission | Justification for the dashboard | Where the code uses it |
|---|---|---|
| nativeMessaging | The extension's only connection is to the Caret app on the same computer, through the native messaging host "ai.caret.bridge". Every form it reads goes to that app, and every value it fills comes from it. | `src/worker.ts:131` (`connectNative`), host name at `src/worker.ts:39` |
| scripting | When the extension is installed, it adds its content script to tabs that were already open, so a form in one of those tabs can be read without reloading it. | `src/worker.ts:688-700` (`chrome.scripting.executeScript` at 695-696) |
| webNavigation | Before it writes into a page, the extension checks that the frame still holds the same document Caret read. A form that navigated, reloaded or changed its history entry since then is refused, so a value can never land on a different page than the one you approved. It also lists a tab's frames, so forms inside iframes are found. | `src/worker.ts:219`, `351`, `379`, `388`, `439-446` (checks before an act), `487-490` and `634` (navigation events), `526`, `646`, `677` |
| storage | Keeps one random ID for this browser profile, so the Caret app can tell two profiles apart. Nothing else is stored. | `src/worker.ts:71-77` |
| Host permission http://\*/\* and https://\*/\* | Forms can be on any site, so the content script runs on every http and https page. It stays dormant until the Caret app asks for the form you are in, and it reads nothing on a site you have switched Caret off for or on a password manager or account page. The same permission lets the extension read the title of the tab whose form it reads, and add its content script to http and https tabs that were open before install. | `manifest.json` `content_scripts` and `host_permissions`; `src/content.ts`; tab title at `src/worker.ts:292` and `397`; open tabs at `src/worker.ts:689`; pages never read at `src/worker.ts:221-224` and `235-242` |

The extension does not request `tabs`: the host permissions already give it the title and address of http and https tabs, which is all it reads. It does not request `debugger`.

Remote code: No. Every script is bundled into the package (`build.mjs`); the extension loads no code from anywhere else and makes no network requests.

## Privacy practices form

Data the extension handles (tick these):

- Personally identifiable information. Form fields hold names, email addresses, phone numbers and addresses.
- Health information. A form can ask about allergies or medical history; the extension reads such fields' labels and answers like any other field. Only self-identification questions are left out (`src/content/walker.ts` `SELF_IDENTIFICATION`).
- Financial and payment information. Card number, CVC and expiry fields are never read (`src/content/secret.ts`), but other money fields, such as salary or a bank account number, are read like any other field.
- Authentication information. Password and one-time-code fields are never read (`src/content/secret.ts`), but a username or login field is read like any other field.
- Personal communications. The text around the cursor of the field you are typing in, which can be an email you are writing.
- Website content. Field labels, page headings, and the visible text of the tab you just left when a fill needs it as a source.
- Web history. The title and address of the page whose form is being filled, and of the tab you just left.
- User activity. That focus moved into a field, and that you clicked or pressed a key while Caret was filling the page. Which key, and what was clicked, are not recorded.

Leave unticked: location. The extension has no geolocation permission and reads no device location; an address typed into a form is declared under personally identifiable information.

All eight ticked types are handled locally as well as passed to the Caret app; the store counts local handling too ([User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), question 3).

Certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

The Caret app sending snippets to TypeSafe's Jev to decide what to fill is part of the single purpose, which the approved use cases allow, and the privacy policy discloses it.

Privacy policy URL: https://github.com/SamGu-NRX/Caret/blob/main/docs/privacy/chrome-extension.md
