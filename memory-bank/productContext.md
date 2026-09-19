# Product Context

Caret is a Mac assistant meant to take the current email thread and calendar, propose a next action with visible evidence, and carry that action out. This repository is a **contributor starter** for a hackathon demo, not the finished product. What the assistant becomes after the demo is unspecified.

## Target Audience

The intended user is a person on a Mac who is coordinating a meeting from an email thread and needs a few travel-aware times they can send.

The people using this repository today are hackathon teammates wiring sources into the starter. Whether Caret is for a broader audience after the event is unspecified.

## Use Cases

These are the three seeded workflows. Only the calendar-link preview currently runs, and only against labeled sample data.

- **Propose meeting times.** From a thread that asks for times, show up to three supported slots plus the evidence used, then (once live sending is connected) put a draft in front of the user before anything leaves the machine.
- **Hold and confirm.** After an approved send, place tentative calendar holds for the offered times. A later reply that picks one time keeps that hold and drops the others from this run.
- **Book a flight.** Navigate a booking site from the chosen option and stop before payment. This seed exists; it does not execute yet.
- **Revise selected text.** Change text in place in the original app after rechecking that the selection is still the same. This seed exists; it does not execute yet.

The current starter lets a teammate open a **synthetic** Dallas meeting, inspect the calculated options and evidence, save local holds, and confirm one of them. It does not read a live thread, send mail, write a real calendar, or drive a browser.

## Key Benefits

- The user sees the proposed times and the evidence together before anything is sent or held.
- Clock arithmetic, source failures, and hold state are checked in ordinary code rather than trusted to a model.
- Failed or missing sources drop the option. The product does not invent availability, travel times, or fares to fill a gap.

Benefits that depend on live Gmail, calendar, travel data, or a browser executor are targets, not present capabilities.

## Success Criteria

The stated hackathon demo, once sources are connected:

- Start from the Austin–Dallas corridor, with a real travel source or a sourced, dated cached timetable (the current buffer numbers are **not** a timetable).
- Open a real thread, invoke Caret, and inspect a filled request.
- Enter produces up to three supported options and their evidence.
- Sending the approved draft creates tentative calendar holds.
- A labeled staged reply selects one option; one confirmation keeps it and removes only this run's other holds.
- A booking path can reach a payment page and must stop there.

The starter today only proves local preview math and local hold transitions on synthetic data. Which of the remaining demo steps will be live by the event is still being decided.

## Key Constraints

- Supported scope ends before payment. Do not add purchases, hotel search, or multi-party polling.
- Fixture content is synthetic and cannot be sent. A draft is created only from supported, sourced options.
- The app does not monitor the computer in this starter. Background capture is not connected.
- Live credentials and personal threads stay out of Git. Source integrations need explicit configuration.
- External sending, calendar writes, Jev routing, and browser execution are **not connected**. Connecting them is future work, not an implied current capability.
