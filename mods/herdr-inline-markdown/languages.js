// The languages a code block's chip names and its menu offers. No imports from herdr or gpui-*.
// `id` is what a fence's info string gets, `name` what the chip and the menu show, `aliases` what else reads as the
// language and finds it when typed.
export const PLAIN = { id: "", name: "Plain text", aliases: [] };
export const LANGUAGES = [
  PLAIN,
  { id: "bash", name: "Bash", aliases: ["sh", "shell", "zsh", "console"] },
  { id: "c", name: "C", aliases: ["h"] },
  { id: "cpp", name: "C++", aliases: ["c++", "cc", "cxx", "hpp"] },
  { id: "csharp", name: "C#", aliases: ["cs", "c#"] },
  { id: "css", name: "CSS", aliases: [] },
  { id: "diff", name: "Diff", aliases: ["patch"] },
  { id: "go", name: "Go", aliases: ["golang"] },
  { id: "html", name: "HTML", aliases: ["htm", "xhtml"] },
  { id: "java", name: "Java", aliases: [] },
  { id: "js", name: "JavaScript", aliases: ["javascript", "jsx", "mjs", "cjs", "node"] },
  { id: "json", name: "JSON", aliases: ["jsonc", "json5"] },
  { id: "kotlin", name: "Kotlin", aliases: ["kt"] },
  { id: "markdown", name: "Markdown", aliases: ["md"] },
  { id: "mermaid", name: "Mermaid", aliases: [] },
  { id: "php", name: "PHP", aliases: [] },
  { id: "python", name: "Python", aliases: ["py"] },
  { id: "ruby", name: "Ruby", aliases: ["rb"] },
  { id: "rust", name: "Rust", aliases: ["rs"] },
  { id: "sql", name: "SQL", aliases: [] },
  { id: "swift", name: "Swift", aliases: [] },
  { id: "toml", name: "TOML", aliases: [] },
  { id: "ts", name: "TypeScript", aliases: ["typescript", "tsx"] },
  { id: "xml", name: "XML", aliases: ["svg"] },
  { id: "yaml", name: "YAML", aliases: ["yml"] },
];
const COMMON_IDS = ["", "bash", "css", "html", "js", "json", "markdown", "mermaid", "python", "rust", "ts", "yaml"];
export const COMMON = COMMON_IDS.map(id => LANGUAGES.find(l => l.id === id));
export const MENU_ROWS = 12;

const wordsOf = l => [l.name, l.id, ...l.aliases].filter(Boolean).map(w => w.toLowerCase());
const BY_WORD = new Map(LANGUAGES.flatMap(l => wordsOf(l).map(w => [w, l])));
const SEARCHED = LANGUAGES.map(l => ({ l, words: wordsOf(l), nameWords: l.name.toLowerCase().split(/\s+/) }));

export const infoWord = info => info.trim().split(/\s+/)[0];

// The language an info string's first word names, Plain text for none; null for a word the list doesn't know.
export const languageOf = word => (word ? BY_WORD.get(word.toLowerCase()) ?? null : PLAIN);
export const languageName = word => languageOf(word)?.name ?? word;

const NOT_WRITTEN = /[^\p{L}\p{N}+#\-._]/gu;
// One word that a backtick fence's info string can hold.
export const typedLanguage = text => text.replace(NOT_WRITTEN, "");

// The menu's rows for what was typed: `items` the languages found, ranked as the slash menu ranks its commands, and
// `typed` the word a last row writes as typed when it names no language ("" for no such row); at most MENU_ROWS.
export function languageMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return { items: COMMON, typed: "" };
  const tiers = [[], [], []];
  for (const { l, words, nameWords } of SEARCHED) {
    if (words.some(w => w.startsWith(q))) tiers[0].push(l);
    else if (nameWords.some(w => w.startsWith(q))) tiers[1].push(l);
    else if (words.some(w => w.includes(q))) tiers[2].push(l);
  }
  const typed = languageOf(q) ? "" : typedLanguage(query.trim());
  return { items: tiers.flat().slice(0, MENU_ROWS - (typed ? 1 : 0)), typed };
}
