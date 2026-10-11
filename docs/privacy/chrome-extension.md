# Caret for Chrome privacy policy

Effective October 9, 2026.

Caret for Chrome is the browser extension for Caret, a Mac app that fills in forms for you. This page says what the extension reads, where it sends it, what the Caret app then sends to the cloud, how long anything is kept, and how to remove it.

## What the extension reads

The extension reads only when the Caret app on your Mac asks. It reads:

- the fields of the form you are in: each field's label, kind, current value and choices, the page's title and headings, and the page's address;
- the text just before and after the cursor in the field you are typing in;
- when a fill needs a source, the visible text of the tab you just left, once, within two minutes of leaving it, and at most 16 KB of it;
- that focus moved into a field or you typed in it, and that you clicked or pressed a key while Caret was filling the page. What you typed, which key and what you clicked are not recorded.

Without the app asking, it notes two things in the page's memory, and neither leaves the page: for each text field you edit, whether its text came from your own typing, so Caret saves an answer as your words only when you typed it; and which fields have been password fields, so they stay secret after a "show password" button shows them as text.

It never reads:

- the contents of password, one-time-code and card fields. A field counts as one when the page marks it as a password, a new or current password, a one-time code or card details, when it was ever a password field, or when its name or label says so, such as "Verification code", "Passcode", "Card number", "CVC" or "Expiry". It reports only that such a field is there and its label, so Caret leaves it alone. It can miss a secret field labelled in other words;
- hidden fields, and questions about gender, race, ethnicity, disability, veteran status or sexual orientation, or consent and signature checkboxes;
- any site you have switched Caret off for;
- anything on password managers and account pages, such as 1Password, Bitwarden, passwords.google.com, accounts.google.com and appleid.apple.com: not the page's title, headings, field labels or values.

Other fields are read as they are, so a form that asks about your health, your bank account or salary, or your username has those answers read and passed to the Caret app.

The extension stores one thing in Chrome: a random ID for your browser profile, so the Caret app can tell two profiles apart.

## Where it goes

The extension sends what it reads only to the Caret app on the same Mac, through Chrome's native messaging. The extension itself makes no network requests and talks to no server.

## What Caret sends to the cloud, and to whom

To decide what to offer, the Caret app sends short pieces of what it read to cloud models. Caret's privacy promise, which the app shows during setup, says:

> To decide what to offer, Caret sends a cloud model what you type to it and short pieces of what's on your screen: a field's label, the values that might go in it, and the lines around them. To decide whose details a value is, Caret may send the whole note it came from, if the note is 2,000 characters or shorter. No request takes more than half of any one conversation. Before anything leaves your Mac, Caret removes password fields, card numbers, one-time codes and keys, and lines it recognizes as secrets, though it can miss a secret written in ordinary words. It sends nothing from an app or website you've switched off.

> Caret's main model is Jev, run by TypeSafe. TypeSafe says Jev isn't trained on customer requests or responses, and its terms say it won't put them in a dataset used to train models without Caret's consent. Its terms set no limit on how long it keeps requests. They let TypeSafe keep using requests, even after you stop using Caret, to monitor for fraud and abuse, and to derive what it calls telemetry: logs, statistics, classifications and "learnings". TypeSafe may use that telemetry without restriction, including to improve its services and other products. We don't know whether TypeSafe staff read requests.

> Inline suggestions, the next few words Caret shows as you type, are written on your Mac by a model that runs there. Nothing goes to Groq.

Caret does not sell your data, does not use it for anything unrelated to what Caret does for you, and does not use it to decide creditworthiness or for lending.

The use of information Caret for Chrome receives will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting_user_privacy), including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements.

## How long it is kept

- The extension's background worker keeps nothing it reads: it passes each read to the Caret app as it arrives.
- In the page's own memory, the extension keeps, for each field it read, the field's label, kind and form and the page's address, so Caret can find the same field when you accept; and, for each text field you edited other than a secret one, its current text, so it can tell your typing from pasted text. Both go when the page does: when you close the tab, reload it, or Chrome discards it after you leave.
- The Caret app holds screen text, including what the extension read, in memory for ten minutes. On disk it keeps counts, timings and keyed hashes of values, not the values.
- What you tell Caret about yourself stays on your Mac, encrypted with a key on your Mac.
- What TypeSafe keeps is set by its terms, quoted above.

## How to remove it

- To remove the extension, open `chrome://extensions`, find Caret for Chrome and click Remove. Chrome deletes the profile ID with it.
- Quitting Caret clears the screen text it holds in memory.
- To remove the Caret app and everything it keeps on your Mac, run `uninstall.sh` from the Caret kit. It removes the app, its login item and the browser connection, and, if you say so, what Caret remembers about you, its settings and its Jev key.

## Contact

Questions and requests go to the Caret project's issues page: https://github.com/SamGu-NRX/Caret/issues

## Changes

If this policy changes, the new version will be on this page with a new effective date.
