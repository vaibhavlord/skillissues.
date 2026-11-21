const keywords = new Set(
  "False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try type while with yield".split(" ")
);
const builtins = new Set(
  "abs all any bool chr dict enumerate filter float format getattr hasattr input int isinstance len list map max min next object open ord pow print range repr reversed round set sorted str sum super tuple type zip".split(" ")
);

const tokens = /(?<comment>#[^\n]*)|(?<string>(?:br|rb|fr|rf|tr|rt|[bruft])?(?<quote>'''|"""|'|"))|(?<number>(?:0x[\da-f_]+|0b[01_]+|0o[0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?\d[\d_]*)?j?))|(?<word>[_\p{ID_Start}][\p{ID_Continue}]*)|(?<operator>[-+*/%<>=!&|^~@:[\]{}(),.])|(?<plain>\s+|.)/gisu;

function escapeHTML(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function stringEnd(source, start, quote) {
  let cursor = start;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
    } else if (source.startsWith(quote, cursor)) {
      return cursor + quote.length;
    } else if (source[cursor] === "\n" && quote.length === 1) {
      return cursor;
    } else {
      cursor++;
    }
  }
  return source.length;
}

export function highlight(source) {
  const lines = [""];
  let expectDefinition = false;
  tokens.lastIndex = 0;
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const { comment, string, quote, number, word, operator } = match.groups;
    let value = match[0];
    let kind = comment ? "comment" : number ? "number" : operator ? "operator" : "";
    if (string) {
      tokens.lastIndex = stringEnd(source, tokens.lastIndex, quote);
      value = source.slice(match.index, tokens.lastIndex);
      kind = "string";
    }
    if (word) {
      if (expectDefinition) kind = "definition";
      else if (keywords.has(word) && !(word === "type" && /^(?:[ \t])*\(/.test(source.slice(tokens.lastIndex)))) kind = "keyword";
      else if (builtins.has(word)) kind = "builtin";
      else if (/^[ \t]*\(/.test(source.slice(tokens.lastIndex))) kind = "call";
      expectDefinition = word === "def" || word === "class";
    } else if (value.trim() || value.includes("\n")) {
      expectDefinition = false;
    }
    const parts = value.split("\n");
    parts.forEach((part, index) => {
      if (index) lines.push("");
      if (!part) return;
      const html = escapeHTML(part);
      lines[lines.length - 1] += kind ? '<span class="token-' + kind + '">' + html + "</span>" : html;
    });
  }
  return lines;
}
