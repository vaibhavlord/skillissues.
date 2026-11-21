const cdnRuntimeURL = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";
const siteRuntimeURL = new URL("./runtime/v0.29.3/", import.meta.url).href;
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

def run_script():
    sys.argv[:] = ["main.py"]
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    try:
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
        sys.stdout.flush()
        sys.stderr.flush()
    return 0

install_console_input(set_console_prompt)
run_script()
`;

self.addEventListener("message", async ({ data: { source, sharedInput } }) => {
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

  let pyodide;
  let runtimeURL = siteRuntimeURL;
  try {
    let loader;
    try {
      loader = await import(siteRuntimeURL + "pyodide.mjs");
    } catch {
      runtimeURL = cdnRuntimeURL;
      loader = await import(cdnRuntimeURL + "pyodide.mjs");
    }
    pyodide = await loader.loadPyodide({ indexURL: runtimeURL, packageBaseUrl: cdnRuntimeURL });
    pyodide.setStdin({ read });
    pyodide.setStdout({ write });
    pyodide.setStderr({ write });
    pyodide.globals.set("set_console_prompt", setPrompt);
    pyodide.FS.writeFile("main.py", source);
  } catch {
    emit({ type: "unavailable" });
    return;
  }

  started = performance.now();
  emit({ type: "started" });
  try {
    done(pyodide.runPython(runScript));
  } catch (error) {
    output += error.message + "\n";
    done(1);
  }
}, { once: true });
