// The fixture page's own script, in the page's main world: the closed shadow root, the portal combobox, the
// dropzone, Submit (it only counts, on the server), and the test control channel. The acceptance run tells the page
// what to do through the server (/control), never through the extension or a debugger.
(() => {
  customElements.define("x-badge", class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "closed" });
      root.innerHTML = '<label for="badge">Badge code</label> <input id="badge" name="badge_code">';
    }
  });

  // Radios inside a shadow root, under a sensitive legend outside it.
  customElements.define("x-yesno", class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<label><input type="radio" name="yn" value="y"> Yes</label> <label><input type="radio" name="yn" value="n"> No</label>';
    }
  });

  // A sensitive legend inside a shadow root, around a light-DOM radio slotted into it.
  customElements.define("x-gender", class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "closed" });
      root.innerHTML = "<fieldset><legend>Gender</legend><slot></slot></fieldset>";
    }
  });

  // An ARIA combobox whose listbox lives in a portal at the end of <body>.
  const dept = document.getElementById("dept");
  const DEPTS = ["Engineering", "Design", "Research"];
  let list = null;
  const close = () => { list?.remove(); list = null; dept.setAttribute("aria-expanded", "false"); };
  const open = () => {
    if (list !== null) return;
    list = document.createElement("ul");
    list.id = "dept-listbox";
    list.setAttribute("role", "listbox");
    const r = dept.getBoundingClientRect();
    list.style.left = `${r.left + scrollX}px`;
    list.style.top = `${r.bottom + scrollY}px`;
    for (const d of DEPTS) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = d;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); dept.value = d; close(); });
      list.append(li);
    }
    document.body.append(list);
    dept.setAttribute("aria-expanded", "true");
  };
  dept.addEventListener("focus", open);
  dept.addEventListener("blur", close);

  document.getElementById("more").addEventListener("click", () => {
    const s = document.getElementById("more-state");
    s.textContent = s.textContent === "collapsed" ? "expanded" : "collapsed";
  });

  const dz = document.getElementById("dropzone");
  dz.addEventListener("dragover", (e) => e.preventDefault());
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    document.getElementById("dropped").textContent = f ? f.name : "";
  });

  document.getElementById("apply").addEventListener("submit", (e) => {
    e.preventDefault();
    fetch("/submit", { method: "POST" });
  });

  // Test control channel.
  const loadId = Math.random().toString(36).slice(2);
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const run = async (c) => {
    switch (c.cmd) {
      case "mutate": setNative(document.querySelector(c.selector), c.value); return { ok: true };
      case "replace": {
        // Replaces a field with a fresh node carrying the same author id, as a framework re-render would.
        const old = document.querySelector(c.selector);
        const fresh = old.cloneNode(true);
        fresh.value = old.value;
        old.replaceWith(fresh);
        return { ok: true };
      }
      case "read": {
        const el = document.querySelector(c.selector);
        return { ok: true, value: el.type === "checkbox" || el.type === "radio" ? String(el.checked) : (el.value ?? el.textContent) };
      }
      case "pushState": history.pushState({}, "", c.path); return { ok: true };
      case "navigate": setTimeout(() => location.assign(c.url), 50); return { ok: true };
      default: return { ok: false, error: `unknown command ${c.cmd}` };
    }
  };
  const loop = async () => {
    for (;;) {
      let c;
      try {
        const r = await fetch(`/control/next?load=${loadId}`);
        if (r.status === 204) continue;
        c = await r.json();
      } catch { await new Promise((res) => setTimeout(res, 500)); continue; }
      let out;
      try { out = await run(c); } catch (e) { out = { ok: false, error: String(e) }; }
      await post("/control/ack", { id: c.id, loadId, ...out });
    }
  };
  post("/hello", { loadId, href: location.href }).then(loop);
})();
