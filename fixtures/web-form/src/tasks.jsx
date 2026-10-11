// The task pages' react-select fields (F1), built into public/tasks/tasks.bundle.js by tasks/build-bundle.mjs. Every
// element with data-react-select gets its own React root:
//   data-react-select="NAME"   options from window.TASK_OPTIONS[NAME] (public/tasks/options.js)
//   data-async="URL"           instead, options loaded from URL?q= as the user types (Greenhouse's School)
//   data-input-id, data-labelledby, data-prefix (classNamePrefix, "select" as on Greenhouse), data-placeholder
// A change dispatches a bubbling "task-select" event, detail { value }, for the page's reveal logic. The value the
// oracle reads is the rendered single value (probe.js), not this event.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Select from "react-select";
import AsyncSelect from "react-select/async";

const toOptions = (list) => list.map((v) => ({ value: v, label: v }));

function Field({ el }) {
  const d = el.dataset;
  const [value, setValue] = useState(null);
  const onChange = (v) => {
    setValue(v);
    el.dispatchEvent(new CustomEvent("task-select", { bubbles: true, detail: { value: v?.value ?? "" } }));
  };
  const common = {
    inputId: d.inputId,
    "aria-labelledby": d.labelledby,
    classNamePrefix: d.prefix ?? "select",
    placeholder: d.placeholder ?? "Select...",
    value,
    onChange,
    isClearable: true,
  };
  if (d.async !== undefined) {
    const load = async (q) => toOptions(await (await fetch(`${d.async}?q=${encodeURIComponent(q)}`)).json());
    return <AsyncSelect {...common} loadOptions={load} cacheOptions={false} defaultOptions={false} />;
  }
  const list = window.TASK_OPTIONS[d.reactSelect];
  if (list === undefined) throw new Error(`no option list ${d.reactSelect} in TASK_OPTIONS`);
  return <Select {...common} options={toOptions(list)} />;
}

/** Mounts every data-react-select under `root` that is not mounted yet. */
function mount(root) {
  for (const el of root.querySelectorAll("[data-react-select]")) {
    if (el.dataset.mounted === "true") continue;
    el.dataset.mounted = "true";
    createRoot(el).render(<Field el={el} />);
  }
}

window.TaskSelects = { mount };
mount(document);
