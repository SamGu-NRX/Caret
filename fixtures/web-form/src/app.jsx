// The fixture's React 18 part: a controlled form, a field whose onChange ignores the event (React puts the old
// value back on its next render: the revert case), and a vendored react-select. Every render posts the state to the
// fixture server (/state), so the acceptance run reads what React holds, not just what the DOM shows.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Select from "react-select";

const COUNTRIES = [
  { value: "us", label: "United States" },
  { value: "um", label: "United States Minor Outlying Islands" },
  { value: "ca", label: "Canada" },
  { value: "mx", label: "Mexico" },
];

function App() {
  const [preferred, setPreferred] = useState("");
  const [city] = useState("Springfield");
  const [country, setCountry] = useState(null);
  const [touched, setTouched] = useState(false);
  const state = { preferred, city, country: country?.value ?? null };
  useEffect(() => {
    fetch("/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state) }).catch(() => {});
  }, [preferred, city, country]);
  const invalid = touched && preferred.trim() === "";
  return (
    <form id="react-form" onSubmit={(e) => e.preventDefault()}>
      <h2>About you (React)</h2>
      <p>
        <label htmlFor="preferred">Preferred name</label>
        <input id="preferred" name="preferred_name" value={preferred} onChange={(e) => setPreferred(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={invalid} aria-describedby="preferred-error" />
        <span id="preferred-error">{invalid ? "Enter a preferred name" : ""}</span>
      </p>
      <p>
        <label htmlFor="city">City</label>
        {/* onChange ignores the event on purpose: state never changes, so React restores the old value. */}
        <input id="city" name="city" value={city} onChange={() => {}} />
      </p>
      <div>
        <label id="rs-country-label" htmlFor="rs-country">Country of residence</label>
        <Select inputId="rs-country" name="rs_country" aria-labelledby="rs-country-label" options={COUNTRIES} value={country} onChange={setCountry} />
      </div>
      <pre id="react-state">{JSON.stringify(state)}</pre>
    </form>
  );
}

createRoot(document.getElementById("react-root")).render(<App />);
