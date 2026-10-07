// Q2 page plumbing (q2_site.py). Submit and Send only record the press; nothing leaves the guest. Every change posts
// the form's values to /state, and the page long-polls /next for the harness's commands: {focus: id}, {reload: true},
// {go: "page.html"}. The page's name is its file name without .html.
(function () {
  const page = location.pathname.split('/').pop().replace(/\.html$/, '');
  const pressed = [];
  const read = () => {
    const fields = {};
    document.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.type === 'radio') { if (el.checked) fields[el.name] = el.value; else if (!(el.name in fields)) fields[el.name] = ''; }
      else if (el.type === 'checkbox') fields[el.id] = el.checked;
      else if (el.type === 'file') fields[el.id] = el.files && el.files.length ? el.files[0].name : '';
      else fields[el.id] = el.value;
    });
    const f = document.activeElement;
    // H10: where the page is, by its own measure, so the harness can compare Caret's drawn offers with the field.
    const r = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
    const rects = {};
    document.querySelectorAll('input, select, textarea').forEach(el => { const k = el.id || el.name; if (k && !(k in rects)) rects[k] = r(el); });
    const vv = window.visualViewport;
    const metrics = { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
      vv: vv ? [vv.offsetLeft, vv.offsetTop, vv.width, vv.height, vv.scale] : null, scroll: [window.scrollX, window.scrollY] };
    return { page, fields, focused: f && f !== document.body ? (f.id || f.name || f.tagName) : null, focusedRect: f && f !== document.body ? r(f) : null,
      rects, metrics, pressed: pressed.slice(), at: Date.now() };
  };
  const post = () => fetch('/state?page=' + page, { method: 'POST', body: JSON.stringify(read()) }).catch(() => {});
  document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => {
    e.preventDefault();
    pressed.push(e.submitter ? (e.submitter.id || e.submitter.textContent) : 'submit');
    document.getElementById('log').textContent = 'Pressed: ' + pressed.join(', ') + ' (nothing sent)';
    post();
  }));
  ['input', 'change', 'focusin'].forEach(t => document.addEventListener(t, post, true));
  window.addEventListener('resize', post);
  setInterval(post, 1000);
  post();
  (async function loop() {
    for (;;) {
      let cmd = {};
      try { cmd = await (await fetch('/next?page=' + page, { cache: 'no-store' })).json(); } catch (e) { await new Promise(r => setTimeout(r, 1000)); continue; }
      if (cmd.focus) { const el = document.getElementById(cmd.focus) || document.querySelector('[name="' + cmd.focus + '"]'); if (el) { el.focus(); post(); } }
      if (cmd.blur) { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); post(); }
      if (cmd.reload) { location.reload(); return; }
      if (cmd.go) { location.href = cmd.go; return; }
    }
  })();
})();
