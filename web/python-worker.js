const cdnRuntimeURL = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";
const siteRuntimeURL = new URL("./runtime/v0.29.3/", import.meta.url).href;
const runtimeURL = new URL(import.meta.url).searchParams.has("cdn") ? cdnRuntimeURL : siteRuntimeURL;
const maxOutput = 256 * 1024;
const waiting = -2;

const runScript = `
import builtins
import runpy
import sys
import traceback

def install_console_input(set_prompt):
    native_input = builtins.input
    stdin, stdout = sys.stdin, sys.stdout

    def input(prompt="", /):
        if sys.stdin is not stdin or sys.stdout is not stdout:
            return native_input(prompt)
        set_prompt(str(prompt))
        try:
            return native_input()
        finally:
            set_prompt("")

    builtins.input = input

def run_script(trace=None):
    sys.argv[:] = ["main.py"]
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    try:
        if trace is not None:
            sys.settrace(trace)
        runpy.run_path("main.py", run_name="__main__")
    except SystemExit as error:
        if error.code is None:
            return 0
        if isinstance(error.code, int):
            return error.code & 255
        print(error.code, file=sys.stderr)
        return 1
    except BaseException as error:
        frame = error.__traceback__
        while frame and frame.tb_frame.f_code.co_filename != "main.py":
            frame = frame.tb_next
        traceback.print_exception(type(error), error, frame)
        return 1
    finally:
        if trace is not None:
            sys.settrace(None)
        sys.stdout.flush()
        sys.stderr.flush()
    return 0

install_console_input(set_console_prompt)
`;

const traceScript = `
import json
from itertools import islice

trace_limit = 350
trace_count = 0

def shorten(text, limit):
    return text if len(text) <= limit else text[:limit - 1] + "…"

def preview(value, depth=0):
    kind = type(value)
    if kind is str or kind is bytes:
        return repr(value[:48]) + ("…" if len(value) > 48 else "")
    if kind is int and value.bit_length() > 256:
        return f"<{value.bit_length()}-bit int>"
    if kind is int or kind is bool or kind is float or kind is complex or value is None:
        return repr(value)
    if kind is dict:
        if depth >= 1 and value:
            return "{…}"
        items = [f"{preview(key, depth + 1)}: {preview(item, depth + 1)}"
                 for key, item in islice(value.items(), 6)]
        if len(value) > 6:
            items.append("…")
        return "{" + ", ".join(items) + "}"
    if kind is list or kind is tuple or kind is set or kind is frozenset:
        if kind is list:
            start, end = "[", "]"
        elif kind is tuple:
            start, end = "(", ",)" if len(value) == 1 else ")"
        elif kind is frozenset:
            start, end = "frozenset({", "})"
        else:
            start, end = "{", "}"
        if not value:
            return repr(value)
        if depth >= 1:
            return start + "…" + end
        items = [preview(item, depth + 1) for item in islice(value, 6)]
        if len(value) > 6:
            items.append("…")
        return start + ", ".join(items) + end
    # Avoid calling user-defined repr methods while inspecting a program.
    return "<" + type.__getattribute__(kind, "__name__") + ">"

def snapshot(name, namespace):
    variables = []
    for key, value in namespace.items():
        if type(key) is not str or key.startswith("__"):
            continue
        if len(variables) == 12:
            return {"name": name, "variables": variables, "more": True}
        kind = type.__getattribute__(type(value), "__name__")
        variables.append([shorten(key, 64), shorten(kind, 40), shorten(preview(value), 120)])
    return {"name": name, "variables": variables, "more": False}

def trace_user_code(frame, event, arg):
    global trace_count
    if frame.f_code.co_filename != "main.py":
        return None
    if event in ("line", "return") and frame.f_lineno > 0:
        if trace_count >= trace_limit:
            report_trace_limit()
            sys.settrace(None)
            return None
        trace_count += 1
        frames = []
        current = frame
        while current is not None and len(frames) < 4:
            if current.f_code.co_filename == "main.py":
                name = current.f_code.co_name
                if name == "<module>":
                    break
                frames.append(snapshot(shorten(name, 64), current.f_locals))
            current = current.f_back
        frames.append(snapshot("Globals", frame.f_globals))
        record_trace_step(json.dumps({"line": frame.f_lineno, "event": event, "frames": frames}))
    return trace_user_code

run_script(trace_user_code)
`;

async function loadPython() {
  const { loadPyodide } = await import(runtimeURL + "pyodide.mjs");
  return loadPyodide({ indexURL: runtimeURL, packageBaseUrl: cdnRuntimeURL });
}

const pythonReady = loadPython().then((pyodide) => {
  self.postMessage({ type: "ready" });
  return pyodide;
}, () => {
  self.postMessage({ type: "unavailable" });
});

self.addEventListener("message", async ({ data: { source, sharedInput, visualize } }) => {
  const pyodide = await pythonReady;
  if (!pyodide) return;
  const emit = self.postMessage.bind(self);
  const inputState = sharedInput ? new Int32Array(sharedInput, 0, 1) : null;
  const inputBytes = sharedInput ? new Uint8Array(sharedInput, Int32Array.BYTES_PER_ELEMENT) : null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const inputDecoder = new TextDecoder();
  let remainder = new Uint8Array();
  let inputEnded = false;
  let inputPrompt = "";
  let output = "";
  let outputBytes = 0;
  let lastFlush = -Infinity;
  let stopped = false;
  let started;

  function flushOutput() {
    if (!output) return;
    emit({ type: "output", text: output });
    output = "";
    lastFlush = performance.now();
  }

  function done(exitCode, details) {
    if (stopped) return;
    stopped = true;
    output += decoder.decode();
    flushOutput();
    emit({ type: "done", exitCode, milliseconds: Math.round(performance.now() - started), ...details });
  }

  function write(buffer) {
    if (stopped) return buffer.length;
    const accepted = Math.min(buffer.length, maxOutput - outputBytes);
    outputBytes += accepted;
    output += decoder.decode(buffer.subarray(0, accepted), { stream: true });
    if (accepted < buffer.length) done(1, { message: "Run stopped after reaching the console output limit." });
    else if (output.length >= 4096 || performance.now() - lastFlush >= 25) flushOutput();
    return buffer.length;
  }

  function setPrompt(text) {
    const length = encoder.encode(text).length;
    if (length > maxOutput - outputBytes) {
      done(1, { message: "Run stopped after reaching the console output limit." });
      return;
    }
    outputBytes += length;
    inputPrompt = text;
  }

  function readLine() {
    if (stopped || inputEnded) return null;
    if (!inputState) {
      done(1, { error: "Console input needs a cross-origin-isolated preview. Open the localhost preview or use the included hosting headers." });
      return null;
    }
    flushOutput();
    Atomics.store(inputState, 0, waiting);
    emit({ type: "input", prompt: inputPrompt });
    inputPrompt = "";
    while (Atomics.load(inputState, 0) === waiting) Atomics.wait(inputState, 0, waiting);
    const byteCount = Atomics.load(inputState, 0);
    if (byteCount === -1) {
      inputEnded = true;
      return null;
    }
    return inputDecoder.decode(inputBytes.slice(0, byteCount));
  }

  function read(buffer) {
    if (!buffer.length) return 0;
    if (!remainder.length) {
      const line = readLine();
      if (line === null) return 0;
      remainder = encoder.encode(line + "\n");
    }
    const length = Math.min(buffer.length, remainder.length);
    buffer.set(remainder.subarray(0, length));
    remainder = remainder.subarray(length);
    return length;
  }

  started = performance.now();
  try {
    pyodide.setStdin({ read });
    pyodide.setStdout({ write });
    pyodide.setStderr({ write });
    pyodide.globals.set("set_console_prompt", setPrompt);
    if (visualize) {
      pyodide.globals.set("record_trace_step", (step) => {
        if (stopped) return;
        flushOutput();
        emit({ type: "trace", step: JSON.parse(step) });
      });
      pyodide.globals.set("report_trace_limit", () => emit({ type: "trace-limit" }));
    }
    pyodide.FS.writeFile("main.py", source);
    emit({ type: "started" });
    done(pyodide.runPython(runScript + (visualize ? traceScript : "\nrun_script()")));
  } catch (error) {
    output += error.message + "\n";
    done(1);
  }
}, { once: true });
