import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, PLAIN, COMMON, MENU_ROWS, infoWord, languageOf, languageName, languageMatches, typedLanguage } from "../mods/herdr-inline-markdown/languages.js";

const names = list => list.map(l => l.name);

test("the list: Plain text first, then each language with the id it is written as and the aliases it reads as", () => {
  assert.equal(LANGUAGES[0], PLAIN);
  assert.deepEqual([PLAIN.id, PLAIN.name], ["", "Plain text"]);
  assert.deepEqual(LANGUAGES.map(l => l.id), ["", "bash", "c", "cpp", "csharp", "css", "diff", "go", "html", "java", "js", "json", "kotlin", "markdown", "mermaid", "php", "python", "ruby", "rust", "sql", "swift", "toml", "ts", "xml", "yaml"]);
  assert.deepEqual(names(LANGUAGES), ["Plain text", "Bash", "C", "C++", "C#", "CSS", "Diff", "Go", "HTML", "Java", "JavaScript", "JSON", "Kotlin", "Markdown", "Mermaid", "PHP", "Python", "Ruby", "Rust", "SQL", "Swift", "TOML", "TypeScript", "XML", "YAML"]);
  const js = LANGUAGES.find(l => l.id === "js");
  assert.deepEqual(js.aliases, ["javascript", "jsx", "mjs", "cjs", "node"]);
  const words = LANGUAGES.flatMap(l => [...new Set([l.name, l.id, ...l.aliases].filter(Boolean).map(w => w.toLowerCase()))]);
  assert.equal(new Set(words).size, words.length, "no word names two languages");
});

test("the common languages, shown with nothing typed, are twelve rows: Plain text first", () => {
  assert.deepEqual(names(COMMON), ["Plain text", "Bash", "CSS", "HTML", "JavaScript", "JSON", "Markdown", "Mermaid", "Python", "Rust", "TypeScript", "YAML"]);
  assert.equal(MENU_ROWS, 12);
  assert.deepEqual(languageMatches(""), { items: COMMON, typed: "" });
  assert.deepEqual(languageMatches("   "), { items: COMMON, typed: "" }, "spaces alone are nothing typed");
});

test("a name for an info string's first word: by id, alias or name in any case; Plain text for none; an unknown word as written", () => {
  for (const word of ["js", "JS", "javascript", "JavaScript", "jsx", "node", "MJS"]) assert.equal(languageName(word), "JavaScript", word);
  for (const [word, name] of [["py", "Python"], ["sh", "Bash"], ["zsh", "Bash"], ["c++", "C++"], ["C#", "C#"], ["cs", "C#"], ["yml", "YAML"], ["Mermaid", "Mermaid"], ["md", "Markdown"], ["tsx", "TypeScript"], ["svg", "XML"]]) {
    assert.equal(languageName(word), name, word);
  }
  assert.equal(languageName(""), "Plain text");
  assert.equal(languageOf(""), PLAIN);
  for (const word of ["Zig", "objective-c", "text"]) {
    assert.equal(languageOf(word), null, word);
    assert.equal(languageName(word), word, `${word}: as written`);
  }
  assert.deepEqual(["js title=\"a.js\"", "  py  ", "", "rust,ignore"].map(infoWord), ["js", "py", "", "rust,ignore"]);
});

test("typing filters as the slash menu ranks: a name or alias starting with it, a word of the name, then one holding it", () => {
  assert.deepEqual(languageMatches("ty"), { items: [LANGUAGES.find(l => l.id === "ts")], typed: "ty" }, "TypeScript, and a row to use what was typed");
  assert.deepEqual(names(languageMatches("ja").items), ["Java", "JavaScript"]);
  assert.deepEqual(names(languageMatches("te").items), ["Plain text"], "a word of the name");
  assert.deepEqual(names(languageMatches("crip").items), ["JavaScript", "TypeScript"], "holding it");
  assert.deepEqual(names(languageMatches("SCRIPT").items), ["JavaScript", "TypeScript"], "in any case");
  assert.deepEqual(names(languageMatches("node").items), ["JavaScript"], "an alias");
  assert.deepEqual(languageMatches("js").typed, "", "a known word gets no row of its own");
  assert.deepEqual(languageMatches("Plain text").typed, "", "nor does a known name");
  assert.deepEqual(languageMatches("zig"), { items: [], typed: "zig" });
});

test("at most twelve rows, the row for what was typed among them", () => {
  assert.deepEqual(names(languageMatches("s").items), ["Bash", "SQL", "Swift", "XML", "C#", "CSS", "JavaScript", "JSON", "Rust", "TypeScript"]);
  assert.equal(languageMatches("s").typed, "s");
  for (const q of [..."abcdefghijklmnopqrstuvwxyz0123456789+#"]) {
    const { items, typed } = languageMatches(q);
    assert.ok(items.length + (typed ? 1 : 0) <= MENU_ROWS, q);
  }
});

test("a typed language keeps letters, digits and + # - . _ and drops the rest", () => {
  assert.equal(typedLanguage("c#!"), "c#");
  assert.equal(typedLanguage(" objective-c "), "objective-c");
  assert.equal(typedLanguage("a`b c"), "abc", "never a backtick, which a backtick fence's info string can't hold");
  assert.equal(typedLanguage("f.x_y+1"), "f.x_y+1");
  assert.equal(typedLanguage("élan"), "élan", "letters of any script");
  assert.equal(typedLanguage("!!!"), "");
  assert.deepEqual(languageMatches("c#!"), { items: [], typed: "c#" }, "the row says what will be written");
  assert.deepEqual(languageMatches("!!!"), { items: [], typed: "" }, "nothing left to write: no row");
});
