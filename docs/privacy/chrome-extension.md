# Caret for Chrome privacy policy

Effective October 9, 2026.

Caret for Chrome is the browser extension for Caret, a Mac app that fills in forms for you. This page says what the extension reads, where it sends it, what the Caret app then sends to the cloud, how long anything is kept, and how to remove it.

## What the extension reads

The extension reads only when the Caret app on your Mac asks. It reads:

- the fields of the form you are in: each field's label, kind, current value and choices, the page's title and headings, and the page's address;
- the text just before and after the cursor in the field you are typing in;
- when a fill needs a source, the visible text of the tab you just left, once, within two minutes of leaving it, and at most 16 KB of it;
- that focus moved into a field, and that you clicked or pressed a key while Caret was filling the page. Which key, and what you clicked, are not recorded.

It never reads:

- the contents of password, card-number and one-time-code fields (it reports only that such a field is there, so Caret leaves it alone);
- hidden fields, and questions about gender, race, ethnicity, disability, veteran status or sexual orientation, or consent and signature checkboxes;
- any site you have switched Caret off for;
- text on password managers and account pages, such as 1Password, Bitwarden, passwords.google.com, accounts.google.com and appleid.apple.com.

The extension stores one thing in Chrome: a random ID for your browser profile, so the Caret app can tell two profiles apart.

## Where it goes

The extension sends what it reads only to the Caret app on the same Mac, through Chrome's native messaging. The extension itself makes no network requests and talks to no server.

## What Caret sends to the cloud, and to whom

To decide what to offer, the Caret app sends short pieces of what it read to cloud models. Caret's privacy promise, which the app shows during setup, says:

> To decide what to offer, Caret sends a cloud model what you type to it and short pieces of what's on your screen: a field's label, the values that might go in it, and the lines around them. To decide whose details a value is, Caret may send the whole note it came from, if the note is 2,000 characters or shorter. No request takes more than half of any one conversation. Before anything leaves your Mac, Caret removes password fields, card numbers, one-time codes and keys, and lines it recognizes as secrets, though it can miss a secret written in ordinary words. It sends nothing from an app or website you've switched off.

> Caret keeps what it reads from your screen for ten minutes after it last reads it, then forgets it.

> Caret's main model is Jev, run by TypeSafe. TypeSafe says Jev isn't trained on customer requests or responses, and its terms say it won't put them in a dataset used to train models without Caret's consent. Its terms set no limit on how long it keeps requests. They let TypeSafe keep using requests, even after you stop using Caret, to monitor for fraud and abuse, and to derive what it calls telemetry: logs, statistics, classifications and "learnings". TypeSafe may use that telemetry without restriction, including to improve its services and other products. We don't know whether TypeSafe staff read requests.

> Inline suggestions come from a model hosted by Groq. Groq says it doesn't keep request data by default, except reliability and abuse logs, which it keeps for up to 30 days. It also says it doesn't use your text to train models unless Caret allows it. Groq has a setting that turns those logs off, and we haven't confirmed it's on for Caret's account. We don't know whether Groq staff read requests.

Caret does not sell your data, does not use it for anything unrelated to what Caret does for you, and does not use it to decide creditworthiness or for lending.

## How long it is kept

- The extension keeps what it reads only while it passes it to the Caret app. It keeps nothing about a page after that.
- The Caret app holds screen text, including what the extension read, in memory for ten minutes. On disk it keeps counts, timings and keyed hashes of values, not the values.
- What you tell Caret about yourself stays on your Mac, encrypted with a key on your Mac.
- What TypeSafe and Groq keep is set by their terms, quoted above.

## How to remove it

- To remove the extension, open `chrome://extensions`, find Caret for Chrome and click Remove. Chrome deletes the profile ID with it.
- Quitting Caret clears the screen text it holds in memory.
- To remove the Caret app and everything it keeps on your Mac, run `uninstall.sh` from the Caret kit. It removes the app, its login item and the browser connection, and, if you say so, what Caret remembers about you, its settings and its Jev key.

## Contact

Questions and requests go to the Caret project's issues page: https://github.com/SamGu-NRX/Caret/issues

## Changes

If this policy changes, the new version will be on this page with a new effective date.
