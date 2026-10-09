// Slice 2's Gmail-shaped inbox (public/mail): the server serves its page and per-start codes, and its oracle counts
// sends, the negative form's submits, and what the page reports. No browser: the page's own behavior is exercised by
// the extension's run once the page engine projects rows (slice 2 step 3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MailSite } from "../mail.ts";
import { FixtureSite } from "../server.ts";

test("the inbox serves its page and messages, with a new code per start, and its oracle counts what the page posted", async () => {
  const site = new FixtureSite();
  await site.start();
  try {
    const page = await (await fetch(`${site.mainOrigin}/mail/`)).text();
    assert.match(page, /<script src="\/mail\/mail.js"><\/script>/);
    const messages = (await (await fetch(`${site.mainOrigin}/mail/messages.json`)).json()) as { id: string; body: string[] }[];
    assert.deepEqual(messages.map((m) => m.id), ["kayak", "dana", "dana-old", "priya", "support", "lena"]);
    assert.ok(messages[0]?.body.includes(`Confirmation number: ${site.mail.code}`));
    assert.ok(messages[2]?.body.includes(`Confirmation number: ${site.mail.decoy}`));
    assert.notEqual(site.mail.code, site.mail.decoy);
    // A new start draws new codes (32^6 each, so two starts collide about once in a billion).
    assert.notEqual(new MailSite().code, new MailSite().code);
    await fetch(`${site.mainOrigin}/mail/state`, { method: "POST", body: JSON.stringify({ open: "kayak", reply: "Thanks", historyUpdates: 1, title: "Flight itinerary - Mail" }) });
    await fetch(`${site.mainOrigin}/mail/search`, { method: "POST", body: "" });
    const oracle = (await (await fetch(`${site.mainOrigin}/mail/oracle`)).json()) as { sent: unknown[]; submits: number; state: { open: string; historyUpdates: number } };
    assert.deepEqual([oracle.sent.length, oracle.submits, oracle.state.open, oracle.state.historyUpdates], [0, 1, "kayak", 1]);
  } finally {
    await site.stop();
  }
});
