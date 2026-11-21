# skillissues

**A browser-based runner for Python scripts and competitive programming test cases.** I built the editor, execution controls, and input/output bridge in JavaScript. [Pyodide](https://pyodide.org/en/0.29.3/) supplies the WebAssembly build of CPython that compiles and runs each script.

## How I built it

- **Worker-based execution.** Pressing Play sends the source and prepared input lines to a dedicated Web Worker. The worker loads Pyodide, writes the source to a virtual `main.py`, and runs it with `runpy.run_path()`. It streams stdout and stderr back to the output pane while the editor stays responsive. [Worker implementation](web/python-worker.js)
- **Multiline and interactive input.** The worker reads staged input first. If Python calls `input()` again, the worker can block on `Atomics.wait()` while the page stays responsive. The page writes the next UTF-8 line to a `SharedArrayBuffer` and calls `Atomics.notify()` to resume execution. Static hosts without cross-origin isolation use batch input. [Console and input handling](web/app.js)
- **Stop and reset.** Stop terminates the worker, including when a script is stuck in a loop or waiting for input. A new worker per run gives each script a fresh Python runtime and virtual filesystem. Execution and output limits keep runaway programs from flooding the console. [Run lifecycle](web/app.js)
- **Editor.** The syntax highlighter classifies Python tokens for display. The editor also handles indentation, matching brackets and quotes, and saving code in browser storage. [Syntax highlighter](web/highlight.js)

## Where compilation happens

A compiler translates source into instructions for a target. Here, the target for user scripts is **CPython bytecode**.

1. **Tokenize and parse.** CPython groups source into tokens such as names, operators, and indentation, then parses them into an abstract syntax tree (AST).
2. **Analyze and generate code.** CPython builds a symbol table to determine scope, turns the AST into instructions, optimizes control flow, and assembles bytecode.
3. **Execute.** CPython’s interpreter executes those instructions. A missing colon can raise a `SyntaxError` before execution, while `ZeroDivisionError` occurs when execution reaches a division by zero.

The WebAssembly module is the CPython runtime itself. The Python script you type is compiled to bytecode inside that runtime. [CPython compiler source](https://github.com/python/cpython/blob/main/Python/compile.c)

## Run locally

```sh
python3 server.py
```

Open [localhost:4173](http://127.0.0.1:4173/). If you have the old preview running, stop it with **Ctrl+C** and start it again from this folder.

## Runtime downloads and offline use

Vercel runs `npm run build` to include Pyodide in the static deployment. To include the same files in your local preview or on another static host, run `npm install` and `npm run build` before serving `web/`.

The browser prefers the site's copy of Python and falls back to jsDelivr when a bundled copy is unavailable. On HTTPS and localhost, a service worker keeps the app and downloaded Python files in the browser's Cache Storage. Run once while connected to set up offline use. An uncached runtime and additional Python packages may need a network connection, and clearing site data removes the offline copy.
