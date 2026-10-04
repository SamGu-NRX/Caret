// holds.html's own script, in the page's main world. hold(tag) makes a synchronous request the fixture server answers
// at once unless the acceptance run armed that tag, in which case it answers only when the run releases it: the page's
// main thread, and so the content script running a write in it, waits right there (W3).
(() => {
  const hold = (tag) => {
    const x = new XMLHttpRequest();
    x.open("GET", `/hold?tag=${encodeURIComponent(tag)}`, false);
    try { x.send(); } catch { /* the run went away */ }
  };
  const mark = (el, name) => () => { el.dataset[name] = "yes"; };
  const f = document.getElementById("h_focus");
  f.addEventListener("focus", () => hold("focus"));
  f.addEventListener("input", mark(f, "input"));
  const i = document.getElementById("h_input");
  i.addEventListener("input", () => hold("input"));
  i.addEventListener("change", mark(i, "change"));
  const s = document.getElementById("h_select");
  s.addEventListener("focus", () => hold("select"));
  s.addEventListener("input", mark(s, "input"));
  const c = document.getElementById("h_check");
  c.addEventListener("focus", () => hold("check"));

  // A field the page disables when it takes focus, as some forms do while they validate.
  const dis = document.getElementById("h_disable");
  dis.addEventListener("focus", () => { dis.disabled = true; });

  // An ARIA combobox that holds the page once the filter is typed, and again once an option is picked.
  const d = document.getElementById("hdept");
  d.addEventListener("input", () => hold("filter"));
  let list = null;
  const close = () => { list?.remove(); list = null; d.setAttribute("aria-expanded", "false"); };
  d.addEventListener("focus", () => {
    if (list !== null) return;
    list = document.createElement("ul");
    list.id = "hdept-listbox";
    list.setAttribute("role", "listbox");
    const r = d.getBoundingClientRect();
    list.style.left = `${r.left + scrollX}px`;
    list.style.top = `${r.bottom + scrollY}px`;
    for (const name of ["Engineering", "Research"]) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = name;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); d.value = name; close(); hold("pick"); });
      list.append(li);
    }
    document.body.append(list);
    d.setAttribute("aria-expanded", "true");
  });
  d.addEventListener("blur", close);
})();
