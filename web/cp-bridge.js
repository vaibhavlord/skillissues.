const origin = "https://skillissuescompiler.vercel.app";
export const isHostedWorkspace = location.origin === origin && location.pathname === "/"
  && new URLSearchParams(location.search).get("cp") === "1";
export const isBundledWorkspace = location.protocol === "chrome-extension:";

function sendHosted(message) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    function finish() {
      clearTimeout(timeout);
      window.removeEventListener("message", respond);
    }
    function respond(event) {
      if (event.source !== window || event.origin !== origin
        || event.data?.channel !== "skillissues-cp:response" || event.data.id !== id) return;
      finish();
      resolve(event.data.result);
    }
    const timeout = setTimeout(() => {
      finish();
      reject(new Error("Open this workspace with the Skill Issues CP extension to load imported problems."));
    }, 3500);
    window.addEventListener("message", respond);
    window.postMessage({ channel: "skillissues-cp:request", id, message }, origin);
  });
}

export async function requestCompiler(message) {
  const result = await (isHostedWorkspace ? sendHosted(message) : chrome.runtime.sendMessage(message));
  if (!result?.ok) throw new Error(result?.error || "Could not connect to the Skill Issues CP extension.");
  return result.data;
}

export function onSamplesChanged(path, callback) {
  if (isHostedWorkspace) {
    window.addEventListener("message", (event) => {
      if (event.source === window && event.origin === origin && event.data?.channel === "skillissues-cp:changed") {
        callback();
      }
    });
  } else {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["problem:" + path]) callback();
    });
  }
}
