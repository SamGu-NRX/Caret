# Connecting native computer use

The app integrator can append this adapter to the existing core launch arguments:

```text
--adapter caret.adapters.native_computer_use:NativeComputerUseWorkflow
```

Set `CARET_COMPUTER_USE_JEV` to the absolute path of the built upstream executable,
and supply `TYPESAFE_API_KEY` through the existing private environment file.
Neither value belongs in committed app configuration. A Gateway or Groq key does
not authenticate to Jev.

The adapter registers `native-open-calendar`, with execution method
`computer-use-jev`. The app's current action acceptance path already accepts this
method and renders its returned summary and evidence. Preparation starts no
process. Acceptance runs the fixed Calendar activation goal through the upstream
Go decision loop and its persistent Swift Accessibility worker. It permits at
most eight decision steps and requests cancellation after 120 seconds, with 15 seconds to shut down. These are explicit
bounds for this first navigation action, not measured performance settings.

Calendar must already be running. The pinned upstream activates applications;
it cannot launch them. The accepted action is navigation only and does not create
calendar holds. The completion summary identifies Jev's completion judgment;
it is not independent calendar-event readback.

The registration is available to a live Jev/Gateway workflow selector. The
meeting-only pattern judge never selects `native-open-calendar`. To test this
native action with a scripted outer router, select ACTION and then this exact
workflow ID; the executor itself still requires a live Jev key.

The adapter never turns clipboard contents or arbitrary ambient text into an
executor goal. Add further reviewed, named native workflows explicitly. The
runtime trace is temporary, and only the final four step descriptions are
returned as evidence. A failed or timed-out run may have already changed the
desktop and is never reported as completion.
