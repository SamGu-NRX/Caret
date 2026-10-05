// The replicas' own page script (W4), standing in for each site's: an upload widget shows the chosen file's name, and
// a Yes/No toggle marks its pressed option with aria-pressed (and ticks its hidden checkbox), except the one marked
// data-broken, which ignores presses, and those marked data-leave (B28), whose Yes then submits a form or sets
// location. Submit only counts on the fixture server, as on /form.
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
        // B28 (navpress.html): a Yes that marks the press, then leaves the page.
        if (b.dataset.option !== "yes") return;
        if (group.dataset.leave === "submit") document.getElementById("leave-form").submit();
        if (group.dataset.leave === "location") location.href = "/replica/landed?via=location";
        if (group.dataset.leave === "requestSubmit") document.getElementById("spa-form").requestSubmit();
        if (group.dataset.leave === "laterSubmit") setTimeout(() => document.getElementById("spa-form").requestSubmit(), 100);
      });
    }
  }
  for (const f of document.querySelectorAll("form")) {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      // navpress.html's single-page app form records its own submits on the page, not on /submit.
      if (f.dataset.spa === "true") f.dataset.sent = String(Number(f.dataset.sent ?? "0") + 1);
      else fetch("/submit", { method: "POST" });
    });
  }
  document.getElementById("submit-application")?.addEventListener("click", () => fetch("/submit", { method: "POST" }));
})();
