// The replicas' own page script (W4), standing in for each site's: an upload widget shows the chosen file's name, and
// a Yes/No toggle marks its pressed option with aria-pressed (and ticks its hidden checkbox), except the one marked
// data-broken, which ignores presses. Submit only counts on the fixture server, as on /form.
(() => {
  const show = (input, out) => input?.addEventListener("change", () => {
    const f = input.files?.[0];
    if (out !== null) out.textContent = f ? f.name : "";
  });
  show(document.getElementById("resume"), document.getElementById("resume-filename"));
  show(document.getElementById("cover_letter"), document.getElementById("cover_letter-filename"));
  show(document.getElementById("resume-upload-input"), document.getElementById("lever-filename"));
  const ashby = document.getElementById("_systemfield_resume");
  ashby?.addEventListener("change", () => {
    const f = ashby.files?.[0];
    let p = document.getElementById("ashby-filename");
    if (p === null) {
      p = document.createElement("p");
      p.id = "ashby-filename";
      document.getElementById("resume-box").append(p);
    }
    p.textContent = f ? f.name : "";
    // The heading then names the file too, as some upload widgets do (W4 review #6): the field's name changes.
    const heading = document.querySelector('label[for="_systemfield_resume"]');
    if (heading !== null && f) heading.textContent = `Resume (${f.name} attached)`;
  });
  for (const group of document.querySelectorAll(".yesno")) {
    for (const b of group.querySelectorAll("button")) {
      if (group.dataset.trap === "true") b.addEventListener("mousedown", () => b.setAttribute("form", "relocate-form"));
      b.addEventListener("click", (e) => {
        e.preventDefault();
        if (group.dataset.broken === "true") return;
        for (const o of group.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        const box = group.querySelector("input[type=checkbox]");
        if (box !== null) box.checked = b.dataset.option === "yes";
      });
    }
  }
  for (const f of document.querySelectorAll("form")) f.addEventListener("submit", (e) => { e.preventDefault(); fetch("/submit", { method: "POST" }); });
  document.getElementById("submit-application")?.addEventListener("click", () => fetch("/submit", { method: "POST" }));
})();
