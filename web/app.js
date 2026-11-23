import { highlight } from "./highlight.js";
import { setupCompetitiveTools } from "./cp.js";
import { isBundledWorkspace, isHostedWorkspace } from "./cp-bridge.js";

const starterCode = 'print("Hello, Python!")\n';
const isExtension = isBundledWorkspace;
const competitiveWorkspace = isExtension || isHostedWorkspace;
const problemPath = competitiveWorkspace ? new URLSearchParams(location.search).get("problem") : null;
const draftKey = problemPath ? "draft:" + problemPath : "code";
const indentWidth = 4;
const matchingPairs = { "(": ")", "[": "]", "{": "}", "'": "'", '"': '"' };
const closingCharacters = new Set(Object.values(matchingPairs));

const byId = (id) => document.getElementById(id);
const code = byId("code");
const gutter = byId("gutter");
const paint = byId("code-paint");
const codeLines = byId("code-lines");
const cursor = byId("cursor");
const runButton = byId("run");
const inputTab = byId("input-tab");
const outputTab = byId("output-tab");
const inputPanel = byId("input-panel");
const outputPanel = byId("output-panel");
const consoleActions = byId("console-actions");
const inputTranscript = byId("input-transcript");
const transcript = byId("transcript");
const liveStdin = byId("live-stdin");
const empty = byId("console-empty");
const state = byId("run-state");
const timing = byId("timing");
const copyButton = byId("copy");
const clearButton = byId("clear");
const notice = byId("notice");
const maxInputBytes = 4096;
const pythonLoadTimeout = 20000;
const canUseLiveInput = window.crossOriginIsolated && typeof SharedArrayBuffer === "function";
const encoder = new TextEncoder();
const themeButtons = document.querySelectorAll("[data-theme-choice]");
const mac = /Mac|iPad|iPhone/.test(navigator.platform);
const runTooltip = mac ? "Run code (⌘ + Enter)" : "Run code (Ctrl + Enter)";
runButton.title = runTooltip;

let activeRun = null;
let testing = false;
let preparedPython = null;
let preferredRuntime = "site";
let currentLine = -1;
let leaveEditor = false;
let noticeTimeout;

function prepareOfflineCache() {
  if (isExtension) return Promise.resolve();
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
  if (!activeRun) runButton.disabled = testing || !code.value.trim();
}

function editorChanged() {
  saveSetting(draftKey, code.value);
  drawEditor();
}

function insertAtSelection(text) {
  // insertText gives the browser's native undo stack the edit when supported.
  if (document.execCommand("insertText", false, text)) return;
  code.setRangeText(text, code.selectionStart, code.selectionEnd, "end");
  editorChanged();
}

function deleteRange(start, end) {
  code.setSelectionRange(start, end);
  // Use the browser's undo stack when supported.
  if (document.execCommand("delete")) return;
  code.setRangeText("", start, end, "end");
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
  deleteRange(start - width, start + width);
  return true;
}

function deleteIndentation(event) {
  const { value, selectionStart: start, selectionEnd: end } = code;
  if (start !== end || start === 0) return false;

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const indent = value.slice(lineStart, start);
  if (!/^[ \t]+$/.test(indent)) return false;

  const trailingSpaces = indent.length - indent.lastIndexOf("\t") - 1;
  const width = trailingSpaces ? (trailingSpaces % indentWidth || indentWidth) : 1;
  event.preventDefault();
  deleteRange(start - width, start);
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

code.value = readSetting(draftKey) ?? (problemPath ? "" : starterCode);
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
  if (editMatchingPair(event) || (event.key === "Backspace" && deleteIndentation(event))) {
    leaveEditor = false;
    return;
  }
  if (event.key === "Tab" && !leaveEditor && !event.shiftKey) {
    event.preventDefault();
    const column = code.value.slice(0, code.selectionStart).split("\n").at(-1).length;
    insertAtSelection(" ".repeat(indentWidth - (column % indentWidth)));
  }
  if (event.key === "Enter") {
    const { value, selectionStart: start, selectionEnd: end } = code;
    const before = value.slice(0, start);
    const lineStart = before.lastIndexOf("\n") + 1;
    const line = before.slice(lineStart);
    event.preventDefault();
    if (!event.shiftKey && !activeRun && !testing && start === end && line.trim() === "r"
      && !value.slice(end).trim() && value.slice(0, lineStart).trim()) {
      const nextLine = value.indexOf("\n", end);
      deleteRange(lineStart, nextLine === -1 ? value.length : nextLine);
      runCode({ fromRShortcut: true });
    } else {
      const indent = line.match(/^[\t ]*/)[0];
      insertAtSelection("\n" + indent + (line.trimEnd().endsWith(":") ? " ".repeat(indentWidth) : ""));
    }
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

function scrollConsole(panel) {
  panel.scrollTop = panel.scrollHeight;
}

function selectConsoleTab(tab) {
  const isInput = tab === inputTab;
  const visiblePanel = isInput ? inputPanel : outputPanel;
  const hiddenPanel = isInput ? outputPanel : inputPanel;
  const otherTab = isInput ? outputTab : inputTab;
  const moveFocus = hiddenPanel.contains(document.activeElement);
  const moveTabFocus = document.activeElement === otherTab;
  tab.setAttribute("aria-selected", "true");
  tab.tabIndex = 0;
  otherTab.setAttribute("aria-selected", "false");
  otherTab.tabIndex = -1;
  visiblePanel.hidden = false;
  hiddenPanel.hidden = true;
  consoleActions.hidden = isInput;
  scrollConsole(visiblePanel);
  if (moveFocus) visiblePanel.focus({ preventScroll: true });
  if (moveTabFocus) tab.focus({ preventScroll: true });
}

for (const tab of [inputTab, outputTab]) {
  tab.addEventListener("click", () => {
    selectConsoleTab(tab);
    if (tab === inputTab && activeRun?.waiting) focusInput();
  });
  tab.addEventListener("keydown", (event) => {
    let nextTab;
    if (event.key === "Home") nextTab = inputTab;
    if (event.key === "End") nextTab = outputTab;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextTab = tab === inputTab ? outputTab : inputTab;
    }
    if (!nextTab) return;
    event.preventDefault();
    selectConsoleTab(nextTab);
    nextTab.focus({ preventScroll: true });
  });
}

function showOutput(text, className) {
  if (!text) return;
  const node = className ? Object.assign(document.createElement("span"), { className, textContent: text }) : document.createTextNode(text);
  transcript.append(node);
  copyButton.disabled = clearButton.disabled = false;
  scrollConsole(outputPanel);
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
  runButton.disabled = !running && (testing || !code.value.trim());
}

function showInput() {
  liveStdin.value = "";
  liveStdin.rows = 1;
  liveStdin.hidden = false;
  setState("input", "Waiting for input");
  selectConsoleTab(inputTab);
  focusInput();
}

function focusInput() {
  liveStdin.focus({ preventScroll: true });
  scrollConsole(inputPanel);
  if (window.matchMedia("(max-width: 720px)").matches) {
    liveStdin.scrollIntoView({ block: "nearest" });
  }
}

function writeInput(run, value) {
  const bytes = value === null ? null : encoder.encode(value);
  if (bytes) {
    run.inputBytes.set(bytes);
    const echo = document.createElement("span");
    echo.className = "input-echo";
    echo.textContent = value + "\n";
    inputTranscript.append(echo);
    scrollConsole(inputPanel);
  }
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
  const lines = endInput && !liveStdin.value ? [] : inputLines(liveStdin.value);
  if (!lines) return;
  if (endInput) lines.push(null);
  run.queued = lines;
  run.nextLine = 0;
  run.waiting = false;
  hideInput();
  setState("running", "Running");
  writeInput(run, run.queued[run.nextLine++]);
}

function hideInput() {
  const hadFocus = document.activeElement === liveStdin;
  liveStdin.hidden = true;
  if (hadFocus) inputPanel.focus({ preventScroll: true });
}

inputPanel.addEventListener("click", (event) => {
  if (event.target === inputPanel && activeRun?.waiting) focusInput();
});
liveStdin.addEventListener("input", () => {
  liveStdin.rows = Math.min(5, liveStdin.value.split("\n").length);
  scrollConsole(inputPanel);
});
liveStdin.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.ctrlKey && event.key.toLowerCase() === "d" && activeRun?.waiting) {
    event.preventDefault();
    queueInput(true);
  } else if (event.key === "Enter" && !event.shiftKey && activeRun?.waiting) {
    event.preventDefault();
    event.stopPropagation();
    queueInput();
  }
});

function finishRun(run, event) {
  if (activeRun !== run) return;
  window.clearTimeout(run.timeout);
  if (run.worker) run.worker.terminate();
  else discardPreparedPython();
  activeRun = null;
  hideInput();
  selectConsoleTab(outputTab);
  setRunning(false);

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
    if (!output) showOutput(exitMessage + "\n", "error");
    if (run.fromRShortcut) {
      const prefix = output && !output.endsWith("\n") ? "\n" : "";
      showOutput(prefix + "LAUDE ITNA BHI NHI ATA KYA !!!!!\n", "error");
    }
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
      resumeRunClock(run);
      setState("running", "Running");
      break;
    case "output":
      showOutput(event.text);
      break;
    case "input":
      if (event.prompt) inputTranscript.append(event.prompt);
      run.remaining = Math.max(0, run.deadline - performance.now());
      if (run.nextLine < run.queued.length) {
        writeInput(run, run.queued[run.nextLine++]);
      } else {
        window.clearTimeout(run.timeout);
        run.timeout = window.setTimeout(() => stopRun("Input timed out."), 300000);
        run.waiting = true;
        showInput();
      }
      break;
    case "done":
      finishRun(run, event);
      preparePython();
      break;
  }
}

function discardPreparedPython() {
  if (!preparedPython) return;
  window.clearTimeout(preparedPython.timeout);
  preparedPython.worker?.terminate();
  preparedPython = null;
}

async function preparePython() {
  if (preparedPython) return;
  const preparation = { worker: null, ready: false };
  preparedPython = preparation;
  // Give the service worker a chance to cache the runtime on a first visit.
  await offlineCacheReady;
  if (preparedPython === preparation) loadPython(preparation, preferredRuntime, !isExtension);
}

function loadPython(preparation, runtime, canRetry) {
  let worker = null;
  function failed() {
    if (preparedPython !== preparation || preparation.worker !== worker) return;
    window.clearTimeout(preparation.timeout);
    worker?.terminate();
    preparation.worker = null;
    preparation.ready = false;
    if (canRetry) {
      if (activeRun) setState("running", "Retrying Python startup…");
      loadPython(preparation, runtime === "site" ? "cdn" : "site", false);
    } else {
      preparedPython = null;
      if (activeRun) finishRun(activeRun, {
        error: isExtension ? "The bundled Python runtime could not start." : "Python could not start from either runtime source. Check your connection and press Run to try again.",
      });
    }
  }

  const url = new URL("./python-worker.js", import.meta.url);
  if (runtime === "cdn") url.searchParams.set("cdn", "1");
  try {
    worker = new Worker(url, { type: "module" });
  } catch {
    failed();
    return;
  }
  preparation.worker = worker;
  worker.onerror = failed;
  worker.onmessage = ({ data }) => {
    if (data.type === "unavailable") failed();
    if (data.type !== "ready" || preparedPython !== preparation || preparation.worker !== worker) return;
    window.clearTimeout(preparation.timeout);
    preparation.ready = true;
    preferredRuntime = runtime;
    startPreparedRun();
  };
  preparation.timeout = window.setTimeout(failed, pythonLoadTimeout);
}

function startPreparedRun() {
  const run = activeRun;
  if (!run || !preparedPython?.ready) return;
  const { worker } = preparedPython;
  preparedPython = null;
  run.worker = worker;
  setState("running", "Running");
  const failed = () => finishRun(run, { error: "The Python worker stopped responding. Press Run to try again." });
  worker.onerror = failed;
  worker.onmessage = ({ data }) => handleRunEvent(run, data);
  run.timeout = window.setTimeout(failed, pythonLoadTimeout);
  try {
    worker.postMessage({ source: run.source, sharedInput: run.sharedInput });
  } catch {
    failed();
  }
}

function runCode({ fromRShortcut = false } = {}) {
  const source = code.value;
  if (activeRun || testing || !source.trim()) return;
  if (source.length > 65536) {
    announce("Code is limited to 65,536 characters");
    return;
  }
  const sharedInput = canUseLiveInput
    ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT + maxInputBytes)
    : null;
  const run = {
    source,
    sharedInput,
    fromRShortcut,
    created: performance.now(),
    remaining: 30000,
    queued: [],
    nextLine: 0,
    waiting: false,
    inputState: sharedInput ? new Int32Array(sharedInput, 0, 1) : null,
    inputBytes: sharedInput ? new Uint8Array(sharedInput, Int32Array.BYTES_PER_ELEMENT) : null,
  };
  activeRun = run;
  inputTranscript.replaceChildren();
  selectConsoleTab(outputTab);
  clearOutput();
  timing.textContent = "";
  setState("running", "Loading Python…");
  setRunning(true);
  preparePython();
  startPreparedRun();
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
preparePython();
if (competitiveWorkspace) setupCompetitiveTools({
  code,
  problemPath,
  canTest: () => !activeRun,
  setTesting(value) {
    testing = value;
    setRunning(false);
    if (value) discardPreparedPython();
    else preparePython();
  },
});
