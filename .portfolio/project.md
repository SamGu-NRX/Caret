---
# kgu.one builds this project's page from this file (https://kgu.one/projects/caret).
# When a change alters what the project does, its results, awards, stack or links,
# update this file in the same change. Rules:
# - Facts only, each one backed by this repo, the resume or a public source.
# - No em dashes and no middle dots.
# - line: at most 120 characters, ending in a period. What someone does or gets,
#   then one mechanism. No adjectives.
# - The body opens with one paragraph of 50 to 80 words, first person: what it is,
#   who used it, the hard part, one fact. The site uses it as the summary.
# - The rest of the body is the full write-up, in plain Markdown (## and ###
#   headings, lists, emphasis, inline code, https links), at most 1,500 words.
title: Caret
kind: project
date: 2026-09
line: Cursor-style Tab, in every app on your Mac. Caret finishes your sentence or offers a workflow, then waits for your yes.
award: 1st place, Cursor x AITX
badge: 1st
stack: [Swift, Python, Groq]
links:
  - label: Site
    href: https://caret-landing-ebon.vercel.app/
  - label: Code
    href: https://github.com/SamGu-NRX/Caret
---

Caret puts Cursor-style Tab autocomplete in every text field on your Mac. About every two seconds it reads what you’re doing and makes one call: stay quiet, finish your sentence, or offer an action. Nothing runs until you accept it. I designed that routing and built the Python core behind the Swift app, and our team took first place at the Cursor x AITX Hackathon.

The hard part of an assistant that’s always on is knowing when to keep quiet, and the routing is built around that.

## Two decisions

Each cycle, a judge model looks at the current frame: the field you’re in, the clipboard, and whatever recent history the app attached. It answers at most two questions.

1. Route. `ABSTAIN`, `INLINE` or `ACTION`.
2. Workflow. Only when the route is `ACTION`, pick one registered workflow or computer task, or none.

Everything around those two answers is ordinary code. Code sets the timing, validates what the model returns and runs the result, so the model never executes anything on its own. Inline text comes from a fast Groq-hosted model, and you take it with Tab. Action offers appear in a small panel and run only if you pick one with Command-1, 2 or 3. Until then, every offer is a read-only preview.

## The core

The core is plain Python with no third-party dependencies, and the Mac app talks to it over a JSON-lines bridge. The router keeps one evaluation in flight and never queues requests behind it. If you keep typing, it folds your changes into the newest snapshot, and it throws away any result tagged with an older snapshot before you see it. A suggestion always belongs to what’s on screen now, not to what you typed a few seconds ago.

For history, Caret starts Screenpipe in the background, and the core can ask it for the last few windows, minutes of activity or clipboard entries. The judge we built it for is TypeSafe Jev.

## What’s next

The native shell, the Python core and the bridge work today, and the sample meeting workflows run on made-up data. I’m continuing Caret, and these parts are in progress:

- live Jev as the default judge, in place of the simple pattern-matching judge the app uses now so it runs without an API key;
- the full Screenpipe history in every decision;
- Gmail and sending calendar events;
- browser checkout, which stops at the payment page by design.

Until those land, Caret can’t send email or buy anything.
