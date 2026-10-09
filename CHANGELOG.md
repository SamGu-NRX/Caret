# Changelog

Caret v2's versions, newest first. A version is major.minor.patch; a prerelease adds a label such as `beta.1` to the
DMG and the git tag. The app's own version (CFBundleShortVersionString) carries only the numbers.

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
