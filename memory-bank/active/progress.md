# Progress

Make Caret launch a pinned Screenpipe version, expose last-N history through a Caret facade, and hard-fail any inference run that lacks a live matching gatherer or usable records.

**Complexity:** Level 4

## 2026-09-19 - COMPLEXITY-ANALYSIS - COMPLETE

* Work completed
    - Approved intent: Caret launches a particular Screenpipe version it can depend on
    - Classified Level 4 (integration across app launch, version pin, Python facade, TCC/license)
* Decisions made
    - Prior creative stands except miss path: sidecar/engine distribution is still not “vendor current Screenpipe”; this task is launch-and-depend, and a miss is a hard fail
* Insights
    - “Launch a version” is a process-identity problem, not only an HTTP client
