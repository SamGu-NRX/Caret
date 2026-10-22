// The Gmail-shaped inbox of public/mail/index.html. Plain DOM, no framework, so what a row click changes is exactly
// one pushState and one re-render of <main>.
(async () => {
  const main = document.getElementById("main");
  const messages = await (await fetch("/mail/messages.json")).json();
  let historyUpdates = 0;

  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true });
  const report = () => {
    const reply = document.querySelector("textarea");
    void post("/mail/state", { open: openId(), reply: reply === null ? null : reply.value, historyUpdates, title: document.title });
  };
  const openId = () => (/^#thread\/(.+)$/.exec(location.hash) ?? [])[1] ?? null;
  const cell = (text, cls) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  };

  function renderList() {
    document.title = "Inbox - Mail";
    main.replaceChildren();
    const table = document.createElement("table");
    table.setAttribute("role", "grid");
    table.setAttribute("aria-label", "Inbox");
    for (const m of messages) {
      const tr = document.createElement("tr");
      tr.setAttribute("role", "row");
      tr.tabIndex = -1;
      tr.dataset.id = m.id;
      tr.append(cell(m.sender), cell(m.subject), cell(m.time, "time"));
      tr.addEventListener("click", () => {
        history.pushState({ thread: m.id }, "", `#thread/${m.id}`);
        historyUpdates++;
        render();
      });
      table.append(tr);
    }
    // The negative: shaped like a row, but a submit button in a form, which a row click must never be.
    const form = document.createElement("form");
    form.className = "saved";
    form.method = "post";
    form.action = "/mail/search";
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Saved search: flight itineraries";
    form.append(button);
    main.append(table, form);
  }

  function renderThread(m) {
    document.title = `${m.subject} - Mail`;
    main.replaceChildren();
    const thread = document.createElement("section");
    thread.className = "thread";
    const h = document.createElement("h2");
    h.textContent = m.subject;
    thread.append(h);
    for (const line of [`From: ${m.from}`, ...m.body]) {
      const p = document.createElement("p");
      p.textContent = line;
      thread.append(p);
    }
    const reply = document.createElement("textarea");
    reply.setAttribute("aria-label", "Reply");
    reply.addEventListener("input", report);
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "Send";
    send.addEventListener("click", () => void post("/mail/send", { thread: m.id, reply: reply.value }));
    thread.append(reply, send);
    main.append(thread);
  }

  function render() {
    const m = messages.find((x) => x.id === openId());
    if (m === undefined) renderList();
    else renderThread(m);
    report();
  }

  window.addEventListener("popstate", render);
  render();
})();
