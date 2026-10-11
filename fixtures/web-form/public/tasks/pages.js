// The task pages' own widgets (F1), standing in for what real application sites run. probe.js only watches; this file
// is the page. Each widget is found by a class or data attribute in the page's markup:
//   select[data-options=NAME]      a native select filled from TASK_OPTIONS[NAME] after its placeholder option
//   .yesno                         buttons that mark one answer with aria-pressed (Ashby's Yes/No)
//   .picker[data-source=URL]       a combobox that queries URL?q= as you type and lists options in a listbox appended
//                                  to <body> (a portal); a pick sets data-oracle-value, typing again clears it
//   .dropzone                      takes a dropped file into its hidden file input and shows the name
//   input[type=file][data-shows]   shows the chosen file's name in the element with that id
//   button[data-opens=ID]          opens file input ID's chooser (Greenhouse's Attach)
//   button[data-next-href=URL]     the wizard's Next: goes to URL. Only the harness presses it.
//   form[data-task-submit], button[data-task-submit]   Submit: counted by the server at /tasks/submit, nothing else
// TaskPage.reveal(id, shown) hides or shows a dependent section; ?show=all shows every one (for the walk census).
(() => {
  const showAll = new URLSearchParams(location.search).get("show") === "all";
  const pageName = document.documentElement.dataset.oraclePage ?? "unknown";
  const O = window.TASK_OPTIONS;

  const fillSelect = (sel, items) => {
    for (const o of [...sel.options]) if (o.value !== "") o.remove();
    for (const v of items) sel.add(new Option(v, v));
  };
  // data-options names a list in TASK_OPTIONS, with dots for nesting ("regions.United States").
  const listOf = (name) => {
    const list = name.split(".").reduce((o, k) => o?.[k], O);
    if (!Array.isArray(list)) throw new Error(`no option list ${name} in TASK_OPTIONS`);
    return list;
  };
  for (const sel of document.querySelectorAll("select[data-options]")) fillSelect(sel, listOf(sel.dataset.options));

  const TaskPage = {
    showAll,
    fillSelect,
    reveal(id, shown) {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`no section ${id}`);
      el.hidden = !(shown || showAll);
    },
    /** The pressed answer of a .yesno group, or "". */
    pressed(group) {
      return group.querySelector('[aria-pressed="true"]')?.textContent.trim() ?? "";
    },
    /** Wires the widgets under `root` (the document, or a template's content once it is in the page). */
    wire(root) {
      for (const g of root.querySelectorAll(".yesno")) {
        for (const b of g.querySelectorAll("button")) {
          b.addEventListener("click", (e) => {
            e.preventDefault();
            for (const o of g.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
            g.dispatchEvent(new Event("change", { bubbles: true }));
          });
        }
      }
      for (const p of root.querySelectorAll(".picker")) picker(p);
      for (const dz of root.querySelectorAll(".dropzone")) dropzone(dz);
      for (const input of root.querySelectorAll("input[type=file][data-shows]")) {
        input.addEventListener("change", () => {
          document.getElementById(input.dataset.shows).textContent = [...input.files].map((f) => f.name).join(", ");
        });
      }
      for (const b of root.querySelectorAll("button[data-opens]")) b.addEventListener("click", () => document.getElementById(b.dataset.opens).click());
      for (const b of root.querySelectorAll("button[data-next-href]")) b.addEventListener("click", () => location.assign(b.dataset.nextHref));
      for (const f of root.querySelectorAll("form[data-task-submit]")) {
        f.addEventListener("submit", (e) => {
          e.preventDefault();
          submit("event");
        });
      }
      for (const b of root.querySelectorAll("button[data-task-submit]")) b.addEventListener("click", () => submit("button"));
    },
  };
  const submit = (via) => fetch(`/tasks/submit?page=${encodeURIComponent(pageName)}&via=${via}`, { method: "POST" });

  function picker(box) {
    const input = box.querySelector("input");
    const id = `${input.id || box.dataset.oracle}-listbox`;
    input.setAttribute("aria-controls", id);
    box.dataset.oracleValue = "";
    let list = null;
    let items = [];
    let active = -1;
    let asked = 0;
    const close = () => {
      list?.remove();
      list = null;
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };
    const pick = (v) => {
      input.value = v;
      box.dataset.oracleValue = v;
      close();
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const render = () => {
      if (list === null) {
        list = document.createElement("ul");
        list.id = id;
        list.className = "portal-listbox";
        list.setAttribute("role", "listbox");
        document.body.append(list);
      }
      const r = input.getBoundingClientRect();
      list.style.left = `${r.left + scrollX}px`;
      list.style.top = `${r.bottom + scrollY}px`;
      list.style.width = `${r.width}px`;
      list.replaceChildren(
        ...items.map((v, i) => {
          const li = document.createElement("li");
          li.id = `${id}-${i}`;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", String(i === active));
          li.textContent = v;
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            pick(v);
          });
          return li;
        }),
      );
      if (items.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "No results";
        list.append(li);
      }
      input.setAttribute("aria-expanded", "true");
      if (active >= 0) input.setAttribute("aria-activedescendant", `${id}-${active}`);
      else input.removeAttribute("aria-activedescendant");
    };
    const query = async () => {
      const n = ++asked;
      const r = await fetch(`${box.dataset.source}?q=${encodeURIComponent(input.value)}`);
      const found = await r.json();
      // A slower answer to an older query never replaces a newer one.
      if (n !== asked || document.activeElement !== input) return;
      items = found;
      active = -1;
      render();
    };
    input.addEventListener("input", () => {
      box.dataset.oracleValue = "";
      if (input.value.trim() === "") return close();
      query();
    });
    input.addEventListener("keydown", (e) => {
      if (list === null || items.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        render();
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        pick(items[active]);
      } else if (e.key === "Escape") close();
    });
    input.addEventListener("blur", close);
  }

  function dropzone(dz) {
    const input = dz.querySelector("input[type=file]");
    const out = dz.querySelector(".filename");
    const show = () => (out.textContent = [...input.files].map((f) => f.name).join(", "));
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("over");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("over");
      if (!e.dataTransfer?.files?.length) return;
      input.files = e.dataTransfer.files;
      show();
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    input.addEventListener("change", show);
    dz.querySelector("button")?.addEventListener("click", () => input.click());
  }

  window.TaskPage = TaskPage;
  TaskPage.wire(document);
})();
