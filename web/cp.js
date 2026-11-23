import { onSamplesChanged, requestCompiler } from "./cp-bridge.js";

const maxInputSize = 256 * 1024;
const maxCodeLength = 65536;
const startupTimeout = 20000;
const testTimeout = 5000;
const get = (id) => document.getElementById(id);

function tokenize(value) {
  return value.trim().split(/\s+/).join(" ");
}

function runCase(source, input, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./python-worker.js", import.meta.url), { type: "module" });
    let output = "";
    let stderr = "";
    let timer;
    const finish = (result, error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      worker.terminate();
      if (error) reject(error);
      else resolve({ output, stderr, ...result });
    };
    const stop = () => finish(null, signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      stop();
      return;
    }
    const unavailable = () => finish({ verdict: "Runner error", message: "Could not start the bundled Python worker." });
    worker.onerror = unavailable;
    timer = setTimeout(unavailable, startupTimeout);
    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case "ready":
          worker.postMessage({ source, batchInput: input });
          break;
        case "started":
          clearTimeout(timer);
          timer = setTimeout(() => finish({ verdict: "Timed out", message: "Exceeded the 5-second local test limit." }), testTimeout);
          break;
        case "unavailable":
          unavailable();
          break;
        case "output":
          output += data.text;
          break;
        case "stderr":
          stderr += data.text;
          break;
        case "done":
          finish(data.message ? { verdict: "Output limit", ...data } : data);
          break;
      }
    };
  });
}

function textField(label, value, editable, limit) {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = !editable;
  if (editable) field.maxLength = limit;
  field.spellcheck = false;
  field.rows = 3;
  wrapper.append(field);
  return { wrapper, field };
}

export async function setupCompetitiveTools({ code, problemPath, canTest, setTesting }) {
  document.documentElement.classList.add("cp-mode");
  get("cp-problem").hidden = get("cp-tests").hidden = get("cp-run-tests").hidden = false;

  const library = get("cp-library");
  const submit = get("cp-submit");
  const status = get("cp-status");
  const summary = get("cp-test-summary");
  const run = get("cp-run-tests");
  const stop = get("cp-stop-tests");
  const add = get("cp-add-test");
  const list = get("cp-cases");
  const storageKey = "skillissues.tests:" + (problemPath || "scratch");
  let problem;
  let suite;
  let initialized = false;
  let submitting = false;
  let samples = [];
  let custom = [];
  let cards = [];
  let loadMessage = "";
  let updatedProblem;

  function refreshControls() {
    run.disabled = !initialized || !!suite || !cards.length || !code.value.trim();
    add.disabled = !initialized || !!suite;
    stop.hidden = !suite;
    submit.disabled = submitting || !code.value.trim();
  }

  function saveCustom() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(custom));
    } catch {
      summary.textContent = "Browser storage is full or unavailable. Custom test changes may be lost when this tab closes.";
    }
  }

  function render() {
    get("cp-tests-title").textContent = samples.length
      ? "Test cases (" + samples.length + (samples.length === 1 ? " sample)" : " samples)")
      : "Test cases";
    list.replaceChildren();
    cards = [...samples, ...custom].map((test, index) => {
      const imported = index < samples.length;
      const card = document.createElement("article");
      card.className = "cp-case";
      const header = document.createElement("div");
      header.className = "cp-case-header";
      const heading = document.createElement("h3");
      heading.textContent = imported ? "Sample " + (index + 1) : "Custom " + (index + 1 - samples.length);
      const verdict = document.createElement("span");
      verdict.className = "cp-verdict";
      header.append(heading, verdict);
      const input = textField("Input", test.input, !imported, maxInputSize);
      const output = textField("Expected output", test.output, !imported, maxInputSize);
      const values = document.createElement("div");
      values.className = "cp-values";
      values.append(input.wrapper, output.wrapper);
      const details = document.createElement("details");
      const reportTitle = document.createElement("summary");
      reportTitle.textContent = "Run output";
      const report = document.createElement("pre");
      details.append(reportTitle, report);
      details.hidden = true;
      const controls = [];
      if (!imported) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", "Remove " + heading.textContent.toLowerCase());
        remove.onclick = () => {
          custom.splice(index - samples.length, 1);
          summary.textContent = "";
          saveCustom();
          render();
        };
        const checkLabel = document.createElement("label");
        checkLabel.className = "cp-check";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = test.check;
        checkLabel.append(check, "Check expected output");
        output.field.disabled = !test.check;
        check.onchange = () => {
          test.check = check.checked;
          output.field.disabled = !test.check;
          saveCustom();
        };
        input.field.oninput = () => { test.input = input.field.value; saveCustom(); };
        output.field.oninput = () => { test.output = output.field.value; saveCustom(); };
        controls.push(check, input.field, remove);
        header.append(remove);
        card.append(header, values, checkLabel, details);
      } else {
        card.append(header, values, details);
      }
      list.append(card);
      return { test, input: input.field, imported, controls, output: output.field, verdict, details, report };
    });
    if (!cards.length && !summary.textContent) summary.textContent = loadMessage || "Add a custom test to run your code with preset input.";
    refreshControls();
  }

  function showResult(card, name, text = "") {
    card.verdict.textContent = name;
    card.verdict.dataset.verdict = name;
    card.report.textContent = text;
    card.details.hidden = !text;
    card.details.open = name !== "Passed" && name !== "Ran";
  }

  add.onclick = () => {
    custom.push({ input: "", output: "", check: false });
    summary.textContent = "";
    saveCustom();
    render();
    cards.at(-1).input.focus();
  };

  stop.onclick = () => suite?.abort();
  run.onclick = async () => {
    const source = code.value;
    if (suite || !source.trim() || !cards.length) return;
    if (!canTest()) {
      summary.textContent = "Stop the console run before running tests.";
      return;
    }
    if (source.length > maxCodeLength) {
      summary.textContent = "Code is limited to 65,536 characters.";
      return;
    }
    suite = new AbortController();
    setTesting(true);
    refreshControls();
    if (matchMedia("(max-width: 840px)").matches) get("cp-tests").scrollIntoView({ block: "start" });
    for (const card of cards) {
      showResult(card, "");
      for (const control of card.controls) control.disabled = true;
      if (!card.imported) card.output.disabled = true;
    }
    let passed = 0;
    let failed = 0;
    let ran = 0;
    let current;
    try {
      for (const [index, card] of cards.entries()) {
        current = card;
        summary.textContent = "Running test " + (index + 1) + " of " + cards.length + "…";
        showResult(card, "Running");
        const { test } = card;
        const result = await runCase(source, test.input, suite.signal);
        const { output, stderr, message, milliseconds, exitCode } = result;
        const verdict = result.verdict || (exitCode !== 0 ? "Runtime error"
          : !test.check ? "Ran" : tokenize(output) === tokenize(test.output) ? "Passed" : "Wrong answer");
        if (verdict === "Passed") passed++;
        else if (verdict === "Ran") ran++;
        else failed++;
        const report = [message, Number.isFinite(milliseconds) ? milliseconds + " ms" : "",
          "Actual output\n" + (output || "(empty)"), stderr ? "Standard error\n" + stderr : ""];
        showResult(card, verdict, report.filter(Boolean).join("\n\n"));
        if (verdict === "Runner error") break;
      }
      summary.textContent = [passed + " passed", failed + " failed", ran ? ran + " ran without an output check" : "",
        passed + failed + ran < cards.length ? (cards.length - passed - failed - ran) + " skipped" : ""]
        .filter(Boolean).join(" · ");
    } catch (error) {
      const stopped = suite.signal.aborted;
      if (current) showResult(current, stopped ? "Stopped" : "Runner error", stopped ? "" : error.message);
      summary.textContent = stopped ? "Tests stopped." : "The Python test runner could not start.";
    } finally {
      suite = null;
      setTesting(false);
      for (const card of cards) {
        for (const control of card.controls) control.disabled = false;
        if (!card.imported) card.output.disabled = !card.test.check;
      }
      refreshControls();
      if (updatedProblem) {
        applyProblem(updatedProblem);
        updatedProblem = null;
      }
    }
  };

  submit.onclick = async () => {
    if (submitting || !problem) return;
    submitting = true;
    refreshControls();
    try {
      await requestCompiler({ type: "stage-submission", path: problem.path, source: code.value });
      status.textContent = "Review and submit on Codeforces. Sign in there first if prompted.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submitting = false;
      refreshControls();
    }
  };

  code.addEventListener("input", refreshControls);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(saved)) custom = saved.filter((test) => typeof test?.input === "string" && typeof test?.output === "string");
  } catch {
    // A storage failure only affects saved custom tests.
  }

  function applyProblem(entry) {
    const unchanged = problem && problem.title === entry.title && problem.timeLimit === entry.timeLimit
      && problem.memoryLimit === entry.memoryLimit && problem.interactive === entry.interactive
      && JSON.stringify(problem.samples) === JSON.stringify(entry.samples);
    problem = entry;
    if (unchanged) return;

    get("cp-title").textContent = problem.title;
    document.title = problem.title + " — Skill Issues";
    const restrictions = [problem.timeLimit, problem.memoryLimit].filter(Boolean);
    get("cp-details").textContent = ["Codeforces", ...restrictions].join(" · ");
    const link = get("cp-link");
    link.href = problem.url;
    link.hidden = submit.hidden = false;
    samples = problem.interactive ? [] : problem.samples.map((sample) => ({ ...sample, check: true }));
    loadMessage = problem.interactive ? "This is an interactive problem. Fixed-input local tests cannot simulate the judge."
      : samples.length ? "" : "This problem has no importable samples. You can add a custom test.";
    summary.textContent = loadMessage || "Write your solution, then click Run Tests.";
    if (initialized) render();
  }

  try {
    const { problems, selected } = await requestCompiler({ type: "compiler-state" });
    if (problems.length) {
      library.append(new Option("Practice workspace", ""));
      for (const entry of problems) library.append(new Option(entry.title, entry.path));
      library.value = selected?.path || "";
      library.hidden = false;
      library.onchange = () => {
        const url = new URL(location.href);
        if (library.value) url.searchParams.set("problem", library.value);
        else url.searchParams.delete("problem");
        location.href = url.href;
      };
    }
    if (selected) applyProblem(selected);
    if (problemPath) {
      onSamplesChanged(problemPath, async () => {
        try {
          const { selected: next } = await requestCompiler({ type: "compiler-state" });
          if (!next || next.updated < problem?.updated) return;
          if (suite) updatedProblem = next;
          else applyProblem(next);
        } catch (error) {
          status.textContent = error.message;
        }
      });
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    initialized = true;
    render();
  }
}
