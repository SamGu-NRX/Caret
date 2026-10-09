# Changelog

Caret v2's versions, newest first. A version is major.minor.patch; a prerelease adds a label such as `beta.1` to the
DMG and the git tag. The app's own version (CFBundleShortVersionString) carries only the numbers.

## 2.0.0-beta.2 (internal)

### Setting up

- **Four steps, one permission.** Setup asks only for Accessibility. First you type a sentence in Caret's own window
  and take the next words with Tab, before granting anything. Turn on Caret opens System Settings at Accessibility
  with a small panel inside it: turn Caret on in the list, or drag it in if it isn't there. Setup moves on by itself
  when the switch lands, and a relaunch partway through comes back to the same step.
- **Your browser.** An optional step adds Caret to Chrome or Helium and moves on when the extension connects.
- **Before anything leaves your Mac.** The last step shows the lines a first look may send, and you choose Send
  these and look, or Keep everything on this Mac. The Jev key field is on this step now.

### Writing

- **Longer suggestions.** The first words appear about as fast as before; the rest of the sentence follows when the
  model has it. In a narrow field you get the whole words that fit.
- **Spelling fixes as you type,** for the word you just finished, in Mac apps and now in web fields, taken with Tab.
  On a page, the page's own ⌘Z brings the old word back.
- **Cotypist's keys,** as a setting: Tab takes the next word and the key above Tab takes the whole suggestion.
- **Turn Caret off in one app** from the menu bar, and see the apps it's off in under What Caret Knows › Writing.
- **How you write.** Tell Caret how you write, overall or for one app or site. Only the local model reads it.
- **Electron apps** such as Slack and Notion get suggestions without waiting for another app to wake them up.
- **Caret's own model copy.** The menu offers Download Caret's Model (3.4 GB) so Caret keeps working without
  Cotypist. Until then it reads Cotypist's file in place.

### Fixes

- The fill pop-up keeps clear of a web form's other fields and labels.
- Secure input anywhere (a password field, Terminal's Secure Keyboard Entry) stops every offer.
- Caret never reads or offers in Terminal, System Settings or Caret itself.
- The privacy text now says inline suggestions are written on your Mac and nothing goes to Groq.
- uninstall.sh also removes Caret's Metal shader cache.

### Internal build

- Signed with the team's Apple Development certificate and stamped CaretInternalBuild; not notarized and not for
  anyone outside the team. Offers you didn't ask for stay off, Jev stops at $0.50 a day, and value questions in Ask
  are still off.

## 2.0.0-beta.1 (internal)

The first Caret v2 build for daily use on our own Macs.

### What you get

- **Writing suggestions.** The next few words appear faintly at the caret in Mac apps and in web text fields, and Tab
  takes them. They are written on your Mac by the Gemma model Cotypist already keeps on disk; Caret reads that file in
  place and never copies it. When the file isn't there, the first line of Caret's menu says so. Spelling and grammar
  fixes in a sentence you just wrote are also taken with Tab.
- **Form fill.** When a field wants a value that is on screen in another window, Caret offers it at the field. A
  pop-up fills a whole form with Tab, ⌘1 is Fill all from any field's offer, and ⌘Z puts the fields back. Pages work
  once you add Caret to Chrome or Helium from the menu.
- **Ask.** Ask Caret, in the menu, takes a request in your words. When something is unclear it comes back with a short
  question and the real choices, and it fills what you pick.
- **Calendar.** When you write a plan with a time in it, Caret offers to add the event. It asks for Calendar access the
  first time you accept one, and the event can be undone.

### Internal build

- Signed with the team's Apple Development certificate and stamped CaretInternalBuild. It is not notarized and not for
  anyone outside the team; release packaging refuses it.
- Offers you didn't ask for stay off ("Caret decides when to help" is off). Jev, the cloud model behind fill and Ask,
  stops at $0.50 a day. Value questions in Ask are not turned on yet.
- Pause Caret and Quit Caret are in the menu bar menu, and the kit's uninstall.sh removes what Caret added.
