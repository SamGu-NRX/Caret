// The oracle's eyes in a task page (F1), test-only: it reports to the fixture server and never changes the page.
//   - On load and on every change, it posts the value of each field marked data-oracle (in the document and its open
//     shadow roots) to /tasks/oracle/state.
//   - It posts every press on a button or link to /tasks/oracle/press, except clicks inside a field whose answer is a
//     press (Yes/No groups, radios, react-select, pickers), which are writes and show up as field values instead.
//   - It takes the harness's presses from /tasks/oracle/harness, a long poll only the server answers. It tags the click
//     it makes with the id the server sent, in a variable no other script can reach. The server offers each press
//     to every frame of the page once; only the frame that has the target clicks it, the others answer ok: false.
// A field whose data-oracle-kind it does not know is an error posted to /tasks/oracle/error, never a guess.
(() => {
  const page = document.documentElement.dataset.oraclePage;
  if (page === undefined) return;
  const frame = location.pathname;
  const loadId = Math.random().toString(36).slice(2);
  let seq = 0;
  let claim = null;
  const post = (path, body) => fetch(path, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  const fail = (error) => post("/tasks/oracle/error", { page, frame, error: String(error) });

  const roots = () => {
    const out = [document];
    for (let i = 0; i < out.length; i++) for (const el of out[i].querySelectorAll("*")) if (el.shadowRoot) out.push(el.shadowRoot);
    return out;
  };
  const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const READ = {
    text: (el) => el.value,
    select: (el) => (el.value === "" ? "" : text(el.selectedOptions[0])),
    checkbox: (el) => String(el.checked),
    radios: (el) => {
      const r = el.querySelector("input[type=radio]:checked");
      return r === null ? "" : text(r.labels?.[0]) || r.value;
    },
    pressgroup: (el) => text(el.querySelector('[aria-pressed="true"]')),
    "react-select": (el) => text(el.querySelector('[class*="single-value"]')),
    picker: (el) => el.dataset.oracleValue ?? "",
    file: (el) => {
      const input = el.matches("input[type=file]") ? el : el.querySelector("input[type=file]");
      return [...(input?.files ?? [])].map((f) => f.name).join(", ");
    },
  };
  const read = () => {
    const fields = {};
    for (const root of roots()) {
      for (const el of root.querySelectorAll("[data-oracle]")) {
        const kind = el.dataset.oracleKind;
        const fn = READ[kind];
        if (fn === undefined) throw new Error(`field ${el.dataset.oracle} has data-oracle-kind ${kind}, which probe.js does not read`);
        if (el.dataset.oracle in fields) throw new Error(`two fields are named ${el.dataset.oracle}`);
        fields[el.dataset.oracle] = { value: fn(el), kind, visible: el.checkVisibility({ visibilityProperty: true }) };
      }
    }
    return fields;
  };

  let last = "";
  let pending = null;
  const report = (reason) => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      let fields;
      try {
        fields = read();
      } catch (e) {
        fail(e);
        return;
      }
      const s = JSON.stringify(fields);
      if (s === last) return;
      last = s;
      post("/tasks/oracle/state", { page, frame, loadId, seq: seq++, reason, fields });
    }, 0);
  };
  for (const t of ["input", "change", "click", "task-select"]) window.addEventListener(t, (e) => report(t), true);
  const watched = new WeakSet();
  const observe = () => {
    for (const root of roots()) {
      if (watched.has(root)) continue;
      watched.add(root);
      // change is not composed: inside a shadow root only the root itself hears it.
      if (root !== document) for (const t of ["input", "change"]) root.addEventListener(t, () => report(t), true);
      new MutationObserver(() => {
        observe();
        report("mutation");
      }).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
  };
  observe();
  report("load");

  // Presses. A click inside a field whose answer is a press is that field's write, not a press.
  const ACTIONABLE = "button, [role=button], a[href], input[type=submit], input[type=button], input[type=reset], input[type=image], summary";
  const ANSWER = '[data-oracle-kind="pressgroup"], [data-oracle-kind="radios"], [data-oracle-kind="react-select"], [data-oracle-kind="picker"]';
  window.addEventListener("click", (e) => {
    const path = e.composedPath().filter((n) => n instanceof Element);
    const hit = path.find((n) => n.matches(ACTIONABLE));
    if (hit === undefined || path.some((n) => n.matches(ANSWER))) return;
    const target = hit.dataset.oraclePress ?? `${hit.tagName.toLowerCase()}:${text(hit).slice(0, 60)}`;
    post("/tasks/oracle/press", { page, frame, loadId, target, trusted: e.isTrusted, claim });
  }, true);

  // The harness's presses. Every frame polls: a single-page app may render its buttons after this script runs.
  const loop = async () => {
    for (;;) {
      let c;
      try {
        const r = await fetch(`/tasks/oracle/harness?page=${encodeURIComponent(page)}&load=${loadId}`);
        if (r.status === 204) continue;
        c = await r.json();
      } catch {
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
      const el = document.querySelector(`[data-oracle-press="${CSS.escape(c.target)}"]`);
      if (el !== null) {
        claim = c.id;
        try {
          el.click();
        } finally {
          claim = null;
        }
      }
      await post("/tasks/oracle/harness-ack", { id: c.id, ok: el !== null, loadId });
    }
  };
  loop();
})();
