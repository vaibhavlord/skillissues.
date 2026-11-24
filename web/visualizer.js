export function createVisualizer(showLine) {
  const notice = document.getElementById("trace-notice");
  const content = document.getElementById("trace-content");
  const back = document.getElementById("trace-back");
  const next = document.getElementById("trace-next");
  const range = document.getElementById("trace-range");
  const position = document.getElementById("trace-position");
  const location = document.getElementById("trace-location");
  const line = document.getElementById("trace-line");
  const frames = document.getElementById("trace-frames");
  const output = document.getElementById("trace-output");
  let source = "";
  let sourceLines = [];
  let steps = [];
  let printed = "";
  let index = 0;
  let limited = false;

  function refreshLine(scroll = false) {
    showLine(content.hidden ? undefined : steps[index]?.line, source, scroll);
  }

  function renderFrame({ name, variables, more }) {
    const frame = document.createElement("div");
    frame.className = "trace-frame";
    const table = document.createElement("table");
    table.createCaption().textContent = name;
    const header = table.createTHead().insertRow();
    for (const label of ["Name", "Type", "Value"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      header.append(cell);
    }
    const body = table.createTBody();
    for (const variable of variables) {
      const row = body.insertRow();
      for (const value of variable) row.insertCell().textContent = value;
    }
    if (more || !variables.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = 3;
      cell.textContent = more ? "More variables omitted" : "No variables yet";
    }
    frame.append(table);
    return frame;
  }

  function render() {
    const step = steps[index];
    back.disabled = index === 0;
    next.disabled = index === steps.length - 1;
    range.disabled = steps.length < 2;
    range.max = steps.length - 1;
    range.value = index;
    range.setAttribute("aria-valuetext", `${index + 1} of ${steps.length}`);
    position.textContent = `${index + 1} / ${steps.length}`;
    location.textContent = `${step.event === "line" ? "Before" : "After"} line ${step.line}`;
    line.textContent = sourceLines[step.line - 1] ?? "";
    frames.replaceChildren(...step.frames.map(renderFrame));
    const last = index === steps.length - 1 && !limited;
    output.textContent = (last ? printed : printed.slice(0, step.outputEnd)) || "No output yet";
    refreshLine(true);
  }

  function seek(step) {
    index = Math.min(steps.length - 1, Math.max(0, step));
    render();
  }

  back.addEventListener("click", () => seek(index - 1));
  next.addEventListener("click", () => seek(index + 1));
  range.addEventListener("input", () => seek(Number(range.value)));

  return {
    refreshLine,
    start(code) {
      source = code;
      sourceLines = code.split("\n");
      steps = [];
      printed = "";
      index = 0;
      limited = false;
      content.hidden = true;
      notice.textContent = "Recording execution…";
      notice.hidden = false;
      refreshLine();
    },
    addOutput(text) { printed += text; },
    addStep(step) { steps.push({ ...step, outputEnd: printed.length }); },
    limit() { limited = true; },
    finish(event) {
      const message = event.error || event.message || (event.exitCode !== 0 ? `Python exited with code ${event.exitCode}. See Output for details.` : "");
      notice.textContent = [
        message,
        limited ? `Only the first ${steps.length} steps were recorded.` : "",
        steps.length ? "" : "No steps were recorded.",
      ].filter(Boolean).join(" ");
      notice.hidden = !notice.textContent;
      content.hidden = !steps.length;
      if (steps.length) render();
    },
  };
}
