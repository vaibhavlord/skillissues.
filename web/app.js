import { highlight } from "./highlight.js";

const starterCode = 'print("Hello, Python!")\n';
const matchingPairs = { "(": ")", "[": "]", "{": "}", "'": "'", '"': '"' };
const closingCharacters = new Set(Object.values(matchingPairs));

const byId = (id) => document.getElementById(id);
const code = byId("code");
const gutter = byId("gutter");
const paint = byId("code-paint");
const codeLines = byId("code-lines");
const cursor = byId("cursor");
const runButton = byId("run");
const outputPanel = byId("output-panel");
const inputPanel = byId("input-panel");
const outputActions = byId("output-actions");
const inputActions = byId("input-actions");
const stdinHelp = byId("stdin-help");
const consoleTabs = [byId("output-tab"), byId("input-tab")];
const transcript = byId("transcript");
const empty = byId("console-empty");
const stdin = byId("stdin");
const state = byId("run-state");
const timing = byId("timing");
const copyButton = byId("copy");
const clearButton = byId("clear");
const notice = byId("notice");
const runtimeLabel = byId("runtime");
const maxInputBytes = 4096;
const canUseLiveInput = window.crossOriginIsolated && typeof SharedArrayBuffer === "function";
const encoder = new TextEncoder();
if (!canUseLiveInput) {
  stdinHelp.textContent = "Enter all input before running. This page uses batch input.";
}
const themeButtons = document.querySelectorAll("[data-theme-choice]");
const mac = /Mac|iPad|iPhone/.test(navigator.platform);
const runTooltip = mac ? "Run code (⌘ + Enter)" : "Run code (Ctrl + Enter)";
runButton.title = runTooltip;

let activeRun = null;
let currentLine = -1;
let leaveEditor = false;
let noticeTimeout;

function prepareOfflineCache() {
  const serviceWorkers = navigator.serviceWorker;
  if (!serviceWorkers) return Promise.resolve();
  const registration = serviceWorkers.register(new URL("./offline-worker.js", import.meta.url));
  if (serviceWorkers.controller) {
    registration.catch(() => {});
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const ready = () => {
      window.clearTimeout(timeout);
      serviceWorkers.removeEventListener("controllerchange", ready);
      resolve();
    };
    const timeout = window.setTimeout(ready, 2500);
    serviceWorkers.addEventListener("controllerchange", ready);
    registration.then(() => {
      if (serviceWorkers.controller) ready();
    }, ready);
  });
}

const offlineCacheReady = prepareOfflineCache();

async function updateRuntimeLabel(version, runtimeURL) {
  const onlineLabel = "Python " + version + " · Runs in your browser";
  runtimeLabel.textContent = onlineLabel;
  if (!navigator.serviceWorker?.controller || !window.caches) return;
  const files = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
  try {
    const saved = await Promise.all(files.map((file) => window.caches.match(new URL(file, runtimeURL).href)));
    if (runtimeLabel.textContent === onlineLabel && saved.every(Boolean)) {
      runtimeLabel.textContent = "Python " + version + " · Ready offline";
    }
  } catch {
    // The runtime can still work online if storage is unavailable.
  }
}

function readSetting(key) {
  try {
    return localStorage.getItem("skillissues." + key) ?? localStorage.getItem("pybench." + key);
  }
  catch { return null; }
}

function saveSetting(key, value) {
  try { localStorage.setItem("skillissues." + key, value); }
  catch { /* The editor can still run when browser storage is disabled. */ }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const button of themeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
  }
}

setTheme(readSetting("theme") === "light" ? "light" : "dark");
for (const button of themeButtons) {
  button.addEventListener("click", () => {
    setTheme(button.dataset.themeChoice);
    saveSetting("theme", button.dataset.themeChoice);
  });
}

function syncScroll() {
  paint.scrollTop = code.scrollTop;
  paint.scrollLeft = code.scrollLeft;
  gutter.scrollTop = code.scrollTop;
}

function updateCursor() {
  const position = code.selectionDirection === "backward" ? code.selectionStart : code.selectionEnd;
  const before = code.value.slice(0, position);
  const row = before.split("\n").length - 1;
  const column = Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1;
  cursor.textContent = "Ln " + (row + 1) + ", Col " + column;
  if (row === currentLine) return;
  codeLines.children[currentLine]?.classList.remove("current");
  gutter.children[currentLine]?.classList.remove("current");
  codeLines.children[row]?.classList.add("current");
  gutter.children[row]?.classList.add("current");
  currentLine = row;
}

function drawEditor() {
  const lines = highlight(code.value);
  codeLines.innerHTML = lines.map((line) => '<div class="code-line">' + line + "</div>").join("");
  gutter.innerHTML = lines.map((_, index) => "<div>" + (index + 1) + "</div>").join("");
  currentLine = -1;
  updateCursor();
  syncScroll();
  if (!activeRun) runButton.disabled = !code.value.trim();
}

function editorChanged() {
  saveSetting("code", code.value);
  drawEditor();
}

function insertAtSelection(text) {
  // insertText gives the browser's native undo stack the edit when supported.
  if (document.execCommand("insertText", false, text)) return;
  code.setRangeText(text, code.selectionStart, code.selectionEnd, "end");
  editorChanged();
}

function deleteMatchingPair(event) {
  const { value, selectionStart: start, selectionEnd: end } = code;
  const opening = value[start - 1];
  const closing = matchingPairs[opening];
  if (start !== end || !closing || value[start] !== closing) return false;

  const triple = opening === closing && start >= 3
    && value.slice(start - 3, start + 3) === opening.repeat(6);
  const width = triple ? 3 : 1;
  event.preventDefault();
  code.setSelectionRange(start - width, start + width);
  // Keep the deletion together in the browser's undo history.
  if (!document.execCommand("delete")) {
    code.setRangeText("", start - width, start + width, "end");
    editorChanged();
  }
  return true;
}

function editMatchingPair(event) {
  const key = event.key;
  if (key === "Backspace") return deleteMatchingPair(event);
  const closing = matchingPairs[key];
  if (!closing && !closingCharacters.has(key)) return false;

  const { value, selectionStart: start, selectionEnd: end, selectionDirection } = code;
  const quote = closing === key;
  if (start === end) {
    if (quote) {
      // An odd number of backslashes turns the next quote into a literal.
      let firstBackslash = start;
      while (value[firstBackslash - 1] === "\\") firstBackslash--;
      if ((start - firstBackslash) % 2) return false;
    }
    if (closingCharacters.has(key) && value[start] === key) {
      event.preventDefault();
      code.setSelectionRange(start + 1, start + 1);
      updateCursor();
      return true;
    }
  }
  if (!closing) return false;

  event.preventDefault();
  const selected = value.slice(start, end);
  // After stepping over an empty quote pair, allow a Python triple-quoted string.
  const triple = quote && start === end
    && value.slice(start - 2, start) === key.repeat(2) && value[start - 3] !== key;
  insertAtSelection(key + selected + (triple ? key.repeat(3) : closing));
  code.setSelectionRange(start + 1, end + 1, selectionDirection);
  updateCursor();
  return true;
}

code.value = readSetting("code") ?? starterCode;
code.addEventListener("input", editorChanged);
code.addEventListener("scroll", syncScroll);
for (const event of ["keyup", "click", "select", "focus"]) code.addEventListener(event, updateCursor);
code.addEventListener("blur", () => { leaveEditor = false; });
code.addEventListener("keydown", (event) => {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape") {
    leaveEditor = true;
    return;
  }
  if (editMatchingPair(event)) {
    leaveEditor = false;
    return;
  }
  if (event.key === "Tab" && !leaveEditor && !event.shiftKey) {
    event.preventDefault();
    const column = code.value.slice(0, code.selectionStart).split("\n").at(-1).length;
    insertAtSelection(" ".repeat(4 - (column % 4)));
  }
  if (event.key === "Enter") {
    const line = code.value.slice(0, code.selectionStart).split("\n").at(-1);
    const indent = line.match(/^[\t ]*/)[0];
    event.preventDefault();
    insertAtSelection("\n" + indent + (line.trimEnd().endsWith(":") ? "    " : ""));
  }
  leaveEditor = false;
});

function announce(message) {
  notice.textContent = message;
  window.clearTimeout(noticeTimeout);
  noticeTimeout = window.setTimeout(() => { notice.textContent = ""; }, 2800);
}

function setState(kind, label) {
  state.dataset.state = kind;
  state.lastElementChild.textContent = label;
}

function scrollConsole() {
  outputPanel.scrollTop = outputPanel.scrollHeight;
}

function showOutput(text, className) {
  if (!text) return;
  const node = className ? Object.assign(document.createElement("span"), { className, textContent: text }) : document.createTextNode(text);
  transcript.append(node);
  copyButton.disabled = clearButton.disabled = false;
  scrollConsole();
}

function clearOutput() {
  transcript.replaceChildren();
  copyButton.disabled = clearButton.disabled = true;
  empty.hidden = !!activeRun;
  if (!activeRun) {
    timing.textContent = "";
    setState("idle", "Idle");
  }
}

clearButton.addEventListener("click", clearOutput);
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(transcript.textContent);
    announce("Output copied");
  } catch {
    announce("Clipboard unavailable");
  }
});

function setRunning(running) {
  runButton.dataset.running = String(running);
  runButton.querySelector("use").setAttribute("href", running ? "#i-stop" : "#i-play");
  runButton.setAttribute("aria-label", running ? "Stop run" : "Run code");
  runButton.title = running ? "Stop run" : runTooltip;
  runButton.disabled = !running && !code.value.trim();
}

function selectConsoleTab(tab) {
  const inputSelected = tab === consoleTabs[1];
  for (const item of consoleTabs) {
    item.setAttribute("aria-selected", String(item === tab));
    item.tabIndex = item === tab ? 0 : -1;
  }
  inputPanel.hidden = !inputSelected;
  outputActions.hidden = outputPanel.hidden = inputSelected;
  if (!inputSelected) scrollConsole();
}

for (const [index, tab] of consoleTabs.entries()) {
  tab.addEventListener("click", () => selectConsoleTab(tab));
  tab.addEventListener("keydown", (event) => {
    const destinations = { ArrowLeft: 1 - index, ArrowRight: 1 - index, Home: 0, End: 1 };
    if (!Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    const target = consoleTabs[destinations[event.key]];
    selectConsoleTab(target);
    target.focus();
  });
}

function updateInputControls() {
  const waiting = !!activeRun?.waiting;
  stdin.readOnly = !!activeRun && !waiting;
  inputActions.hidden = !waiting;
  stdinHelp.textContent = waiting
    ? activeRun.prompt || "Python is waiting for input."
    : canUseLiveInput
      ? "Input is sent when your program reads it."
      : "Enter all input before running. This page uses batch input.";
}

function showInput(run) {
  run.prompt = transcript.textContent.split("\n").at(-1).trim().slice(0, 160);
  stdin.value = "";
  updateInputControls();
  setState("input", "Waiting for input");
  selectConsoleTab(consoleTabs[1]);
  stdin.focus({ preventScroll: true });
  if (window.matchMedia("(max-width: 720px)").matches) {
    inputPanel.scrollIntoView({ block: "nearest" });
  }
}

function writeInput(run, value) {
  const bytes = value === null ? null : encoder.encode(value);
  if (bytes) run.inputBytes.set(bytes);
  Atomics.store(run.inputState, 0, bytes?.length ?? -1);
  Atomics.notify(run.inputState, 0);
  resumeRunClock(run);
}

function inputLines(value) {
  const lines = value.split("\n");
  // A pasted line terminator closes the preceding line, including a blank one.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.some((line) => encoder.encode(line).length > maxInputBytes)) {
    announce("Input is limited to 4 KB per line");
    return null;
  }
  return lines;
}

function queueInput(endInput = false) {
  const run = activeRun;
  if (!run?.waiting) return;
  const lines = endInput && !stdin.value ? [] : inputLines(stdin.value);
  if (!lines) return;
  if (endInput) lines.push(null);
  run.queued = lines;
  run.nextLine = 0;
  run.waiting = false;
  const focusWasInInput = inputPanel.contains(document.activeElement);
  selectConsoleTab(consoleTabs[0]);
  if (focusWasInInput) outputPanel.focus({ preventScroll: true });
  updateInputControls();
  setState("running", "Running");
  writeInput(run, run.queued[run.nextLine++]);
}

inputPanel.addEventListener("submit", (event) => {
  event.preventDefault();
  queueInput();
});
byId("eof").addEventListener("click", () => { queueInput(true); });
stdin.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.ctrlKey && event.key.toLowerCase() === "d" && activeRun?.waiting) {
    event.preventDefault();
    queueInput(true);
  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && activeRun?.waiting) {
    event.preventDefault();
    event.stopPropagation();
    queueInput();
  }
});

function finishRun(run, event) {
  if (activeRun !== run) return;
  window.clearTimeout(run.timeout);
  run.worker?.terminate();
  const focusWasInInput = inputPanel.contains(document.activeElement);
  activeRun = null;
  updateInputControls();
  selectConsoleTab(consoleTabs[0]);
  setRunning(false);
  if (focusWasInInput) outputPanel.focus({ preventScroll: true });
  if (run.runtime) updateRuntimeLabel(run.runtime.version, run.runtime.runtimeURL);

  if (event.error) {
    showOutput(event.error + "\n", "error");
    setState("error", "Run failed");
    return;
  }
  timing.textContent = event.milliseconds < 1000
    ? event.milliseconds + " ms"
    : (event.milliseconds / 1000).toFixed(2) + " s";
  if (event.message) {
    const prefix = transcript.textContent && !transcript.textContent.endsWith("\n") ? "\n" : "";
    showOutput(prefix + event.message + "\n", "message");
    setState("stopped", "Stopped");
  } else if (event.exitCode !== 0) {
    const exitMessage = "Exited with code " + event.exitCode;
    const output = transcript.textContent;
    const prefix = output ? (output.endsWith("\n") ? "" : "\n") : exitMessage + "\n";
    showOutput(prefix + "LAUDE ITNA BHI NHI ATA KYA !!!!!\n", "error");
    setState("error", exitMessage);
  } else {
    if (!transcript.hasChildNodes()) showOutput("Program finished without output.\n", "message");
    setState("done", "Completed");
  }
}

function stopRun(message = "Run stopped.") {
  const run = activeRun;
  if (run) finishRun(run, {
    message,
    milliseconds: Math.round(performance.now() - (run.started ?? run.created)),
  });
}

function resumeRunClock(run) {
  window.clearTimeout(run.timeout);
  run.deadline = performance.now() + run.remaining;
  run.timeout = window.setTimeout(() => stopRun("Run stopped after 30 seconds."), run.remaining);
}

function handleRunEvent(run, event) {
  if (activeRun !== run) return;
  switch (event.type) {
    case "started":
      run.started = performance.now();
      run.runtime = event;
      updateRuntimeLabel(event.version, event.runtimeURL);
      resumeRunClock(run);
      setState("running", "Running");
      break;
    case "output":
      showOutput(event.text);
      break;
    case "input":
      run.remaining = Math.max(0, run.deadline - performance.now());
      if (run.nextLine < run.queued.length) {
        writeInput(run, run.queued[run.nextLine++]);
      } else {
        window.clearTimeout(run.timeout);
        run.timeout = window.setTimeout(() => stopRun("Input timed out."), 300000);
        run.waiting = true;
        showInput(run);
      }
      break;
    case "done":
      finishRun(run, event);
      break;
    case "unavailable":
      finishRun(run, { error: "Python could not load. Connect to the internet for the first run, then try again." });
      break;
  }
}

async function runCode() {
  if (activeRun || !code.value.trim()) return;
  if (code.value.length > 65536) {
    announce("Code is limited to 65,536 characters");
    return;
  }
  const lines = stdin.value ? inputLines(stdin.value) : [];
  if (!lines) {
    selectConsoleTab(consoleTabs[1]);
    stdin.focus();
    return;
  }
  const sharedInput = canUseLiveInput
    ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT + maxInputBytes)
    : null;
  const run = {
    created: performance.now(),
    remaining: 30000,
    queued: [],
    nextLine: 0,
    waiting: false,
    inputState: sharedInput ? new Int32Array(sharedInput, 0, 1) : null,
    inputBytes: sharedInput ? new Uint8Array(sharedInput, Int32Array.BYTES_PER_ELEMENT) : null,
  };
  const focusWasInInput = inputPanel.contains(document.activeElement);
  activeRun = run;
  selectConsoleTab(consoleTabs[0]);
  if (focusWasInInput) outputPanel.focus({ preventScroll: true });
  updateInputControls();
  clearOutput();
  timing.textContent = "";
  setState("running", "Loading Python…");
  setRunning(true);
  try {
    await offlineCacheReady;
    if (activeRun !== run) return;
    const worker = new Worker(new URL("./python-worker.js", import.meta.url), { type: "module" });
    run.worker = worker;
    worker.onmessage = ({ data }) => handleRunEvent(run, data);
    worker.onerror = () => {
      const localhost = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
      finishRun(run, {
        error: localhost
          ? "The Python worker could not start. Restart the local preview with python3 server.py and refresh."
          : "The Python worker could not start. Refresh the page and try again.",
      });
    };
    run.timeout = window.setTimeout(() => {
      finishRun(run, { error: "Python is taking too long to load. Check your connection and try again." });
    }, 90000);
    worker.postMessage({ source: code.value, lines, sharedInput });
  } catch {
    handleRunEvent(run, { type: "unavailable" });
  }
}

runButton.addEventListener("click", () => {
  if (activeRun) stopRun();
  else runCode();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    runCode();
  }
});

drawEditor();
