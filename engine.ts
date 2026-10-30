// The engine behind tq: holds a TypeScript project open and answers queries about its symbols.
// The daemon keeps one Project per root alive; `tq --no-daemon` loads one for a single query.
import { statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// ---------- project ----------

export type Project = {
  root: string;
  service: ts.LanguageService;
  program: ts.Program;
  checker: ts.TypeChecker;
  files: ts.SourceFile[];
  /** Rebuilds what changed on disk since the last query: edited, added, or removed files. */
  refresh: () => void;
  index?: Decl[];
};

export function openProject(dir: string): Project {
  const t0 = performance.now();
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Ask(`No tsconfig.json found: ${dir}`, 1);
  const root = dirname(configPath);
  const readConfig = () => {
    const json = ts.readConfigFile(configPath, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(json.config, ts.sys, root);
  };
  let parsed = readConfig();
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => parsed.fileNames,
    // The file's mtime is its version, so an edit on disk reaches the next query on its own.
    getScriptVersion: (f) => {
      try {
        return String(statSync(f).mtimeMs);
      } catch {
        return "missing";
      }
    },
    getScriptSnapshot: (f) => {
      const text = ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const p = { root, service } as Project;
  p.refresh = () => {
    parsed = readConfig(); // picks up added and removed files
    const program = service.getProgram();
    if (!program) throw new Ask("Could not build the program", 1);
    if (program === p.program) return;
    p.program = program;
    p.checker = program.getTypeChecker();
    p.files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && !f.fileName.includes("/node_modules/"));
    p.index = undefined;
  };
  p.refresh();
  log(`project: ${p.files.length} files, ${Math.round(performance.now() - t0)}ms`);
  return p;
}

// ---------- symbol index ----------

/** "local" is a function defined inside another's body, named `outer.inner`. */
type Kind = "function" | "class" | "method" | "property" | "interface" | "type" | "enum" | "const" | "local";

type Decl = {
  id: string; // path#Name or path#Class.member
  name: string;
  kind: Kind;
  file: ts.SourceFile;
  nodes: ts.Node[]; // overloads share one id; the last is the implementation
  nameNode: ts.Node;
  statement: ts.Node; // where the JSDoc sits
  /** For a local, the top-level declaration whose body holds it. */
  owner?: Decl;
};

function rel(p: Project, f: string) {
  return relative(p.root, f);
}

function indexFile(p: Project, file: ts.SourceFile): Decl[] {
  const out: Decl[] = [];
  const path = rel(p, file.fileName);
  const add = (name: string, kind: Kind, node: ts.Node, nameNode: ts.Node, statement: ts.Node) => {
    const id = `${path}#${name}`;
    const prev = out.find((d) => d.id === id);
    if (prev) prev.nodes.push(node);
    else out.push({ id, name, kind, file, nodes: [node], nameNode, statement });
  };
  for (const st of file.statements) {
    if (ts.isFunctionDeclaration(st)) {
      const name = st.name?.text ?? "default";
      add(name, "function", st, st.name ?? st, st);
    } else if (ts.isClassDeclaration(st)) {
      const cname = st.name?.text ?? "default";
      add(cname, "class", st, st.name ?? st, st);
      for (const m of st.members) {
        const mname = m.name && ts.isIdentifier(m.name) ? m.name.text : ts.isConstructorDeclaration(m) ? "constructor" : undefined;
        if (!mname) continue;
        const kind: Kind = ts.isPropertyDeclaration(m) ? "property" : "method";
        add(`${cname}.${mname}`, kind, m, m.name ?? m, m);
      }
    } else if (ts.isInterfaceDeclaration(st)) {
      add(st.name.text, "interface", st, st.name, st);
    } else if (ts.isTypeAliasDeclaration(st)) {
      add(st.name.text, "type", st, st.name, st);
    } else if (ts.isEnumDeclaration(st)) {
      add(st.name.text, "enum", st, st.name, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
        add(d.name.text, fn ? "function" : "const", d, d.name, st);
      }
    }
  }
  // Functions defined inside a function's body, so a name seen in the code is never "not found".
  // Only functions: a body's plain locals are too many to be worth a name each.
  const locals = (owner: Decl, outer: string, body: ts.Node) => {
    const visit = (n: ts.Node) => {
      let name: ts.Identifier | undefined;
      let statement: ts.Node = n;
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name;
      else if (
        ts.isVariableDeclaration(n) &&
        ts.isVariableStatement(n.parent.parent) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        name = n.name;
        statement = n.parent.parent;
      }
      if (name) {
        const full = `${outer}.${name.text}`;
        add(full, "local", n, name, statement);
        out.find((d) => d.name === full)!.owner = owner;
        const b = bodyOf(n);
        if (b) locals(owner, full, b);
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
  };
  for (const d of [...out]) {
    if (d.kind === "local") continue;
    for (const n of d.nodes) {
      const b = bodyOf(n);
      if (b) locals(d, d.name, b);
    }
  }
  return out;
}

function allDecls(p: Project): Decl[] {
  p.index ??= p.files.flatMap((f) => indexFile(p, f));
  return p.index;
}

function resolveSymbol(p: Project, query: string): Decl {
  const decls = allDecls(p);
  let hits: Decl[];
  if (query.includes("#")) {
    hits = decls.filter((d) => d.id === query || d.id.endsWith(`/${query}`));
  } else {
    hits = decls.filter((d) => d.name === query || d.name.endsWith(`.${query}`));
  }
  // A top-level name wins over a function of the same name inside some body, as before locals were indexed.
  const top = hits.filter((d) => d.kind !== "local");
  if (top.length) hits = top;
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0)
    throw new Ask(
      [
        `Not found: ${query}`,
        `Try \`tq find ${query.split(/[#.]/).pop()}\` to look for matches`,
        "(tq looks at declarations and functions defined inside functions. It does not see object properties, other variables inside functions, or code in strings. Use grep for those.)",
      ].join("\n"),
    );
  throw new Ask([`${hits.length} matches. Pick one by ID:`, ...hits.map((d) => `  ${d.id}  (${d.kind})`)].join("\n"));
}

/** A question back to the caller, not a crash: the other targets still run. */
export class Ask extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}

function enclosingDecl(p: Project, file: ts.SourceFile, pos: number): Decl | undefined {
  let best: Decl | undefined;
  let width = Infinity;
  for (const d of allDecls(p)) {
    if (d.file !== file) continue;
    for (const n of d.nodes) {
      if (n.getStart() <= pos && pos < n.getEnd() && n.getWidth() < width) {
        best = d;
        width = n.getWidth();
      }
    }
  }
  return best;
}

function enclosing(p: Project, file: ts.SourceFile, pos: number): string {
  const best = enclosingDecl(p, file, pos);
  if (best) return best.name;
  // Inside a test file, the test's own name says more than "top level".
  let n: ts.Node | undefined = findToken(file, pos);
  while (n && n !== file) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(test|it|describe)$/.test(n.expression.text)) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) return `${n.expression.text}("${clip(arg.text, 50)}")`;
    }
    n = n.parent;
  }
  return "(top level)";
}

// ---------- rendering pieces ----------

function lineOf(file: ts.SourceFile, pos: number) {
  return file.getLineAndCharacterOfPosition(pos).line + 1;
}

function loc(p: Project, node: ts.Node, last: ts.Node = node) {
  const f = node.getSourceFile();
  return `${rel(p, f.fileName)}:${lineOf(f, node.getStart())}-${lineOf(f, last.getEnd())}`;
}

/** The whole declaration, overloads included. */
const span = (p: Project, d: Decl) => loc(p, d.nodes[0]!, d.nodes.at(-1)!);

/** The JSDoc's first sentence, read across line breaks so it never stops mid-clause. */
function jsdocFirstLine(node: ts.Node): string {
  const lines = jsdoc(node)
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim());
  const start = lines.findIndex(Boolean);
  if (start < 0) return "";
  const end = lines.indexOf("", start);
  const paragraph = lines.slice(start, end < 0 ? undefined : end).join(" ");
  const sentence = paragraph.match(/^.*?[.。](?=\s|$)/)?.[0] ?? paragraph;
  return clip(sentence, 160);
}

function jsdoc(node: ts.Node): string {
  const file = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(file.text, node.getFullStart()) ?? [];
  return ranges
    .filter((r) => file.text.startsWith("/**", r.pos))
    .map((r) => file.text.slice(r.pos, r.end))
    .join("\n");
}

function bodyOf(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionLike(node) && "body" in node) return (node as ts.FunctionLikeDeclaration).body;
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isFunctionLike(node.initializer))
    return (node.initializer as ts.FunctionLikeDeclaration).body;
  return undefined;
}

/** The declaration as a contract: everything but function bodies. */
function header(p: Project, d: Decl, node: ts.Node): string {
  const file = node.getSourceFile();
  const prefix = ts.isVariableDeclaration(node)
    ? `${(d.statement as ts.VariableStatement).declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} `
    : "";
  const exported =
    ts.isVariableDeclaration(node) && ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export ? "export " : "";
  if (ts.isClassDeclaration(node)) {
    const open = node.members.pos;
    const head = file.text.slice(node.getStart(), open).trim();
    const members = node.members
      .map((m) => {
        const b = bodyOf(m);
        const text = file.text.slice(m.getStart(), b ? b.getStart() : m.getEnd()).trim();
        const doc = jsdocFirstLine(m);
        return `  ${oneLine(text)}${doc ? `  // ${doc}` : ""}`;
      })
      .join("\n");
    return `${head}\n${members}\n}`;
  }
  const b = bodyOf(node);
  const text = file.text.slice(node.getStart(), b ? b.getStart() : node.getEnd()).trim();
  let sig = exported + prefix + text;
  // Inferred return type, when the source does not state one.
  const fn = ts.isVariableDeclaration(node) ? node.initializer : node;
  if (fn && ts.isFunctionLike(fn) && !fn.type && b) {
    const s = p.checker.getSignatureFromDeclaration(fn as ts.SignatureDeclaration);
    if (s) sig += `  /* returns ${clip(p.checker.typeToString(s.getReturnType()), 160)} */`;
  }
  return sig;
}

function signature(p: Project, d: Decl): string {
  const doc = jsdoc(d.statement);
  const heads = d.nodes.map((n, i) => {
    const h = header(p, d, n);
    // With overloads, the last declaration is the implementation callers never see directly.
    return d.nodes.length > 1 && i === d.nodes.length - 1 ? `// implementation\n${h}` : h;
  });
  return [doc, heads.join("\n")].filter(Boolean).join("\n");
}

/** Types named in the declaration's contract, resolved to where they live in the project. */
function typesUsed(p: Project, d: Decl): Decl[] {
  const seen = new Set<string>();
  const out: Decl[] = [];
  const visit = (n: ts.Node) => {
    if (bodyOf(n) === n) return;
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
      const target = ts.isTypeReferenceNode(n) ? n.typeName : n.expression;
      const found = declOf(p, target);
      if (found && found.id !== d.id && !seen.has(found.id)) {
        seen.add(found.id);
        out.push(found);
      }
    }
    ts.forEachChild(n, (c) => {
      if (c !== bodyOf(n)) visit(c);
    });
  };
  for (const n of d.nodes) visit(n);
  return out;
}

function declOf(p: Project, n: ts.Node): Decl | undefined {
  let sym = p.checker.getSymbolAtLocation(n);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) sym = p.checker.getAliasedSymbol(sym);
  const decl = sym.declarations?.[0];
  if (!decl) return undefined;
  return allDecls(p).find((d) => d.nodes.includes(decl));
}

type Ref = {
  file: ts.SourceFile;
  pos: number;
  line: number;
  kind: "call" | "import" | "other";
  call: boolean;
  inside: string;
  /** The top-level declaration around the reference, a local's owner included. */
  insideDecl: Decl | undefined;
  /** The call expression whole, on one line, when kind is "call"; else the source line. */
  text: string;
  /** For a call, what each named argument is, as `deckDir: string`. */
  args: string;
};

function references(p: Project, d: Decl): Ref[] {
  const groups = p.service.findReferences(d.file.fileName, d.nameNode.getStart()) ?? [];
  const seen = new Set<string>();
  const out: Ref[] = [];
  const add = (file: ts.SourceFile, token: ts.Node) => {
    const pos = token.getStart();
    const key = `${file.fileName}:${pos}`;
    if (seen.has(key)) return;
    seen.add(key);
    const line = lineOf(file, pos);
    const kind = isImport(token) ? "import" : isCallee(token) ? "call" : "other";
    const call = callExpressionOf(token);
    out.push({
      file,
      pos,
      line,
      kind,
      call: kind === "call",
      inside: enclosing(p, file, pos),
      insideDecl: ((d) => d?.owner ?? d)(enclosingDecl(p, file, pos)),
      text: kind === "call" && call ? oneLine(call.getText()) : file.text.split("\n")[line - 1]!.trim(),
      args: kind === "call" && call ? argTypes(p, call) : "",
    });
  };
  for (const g of groups) {
    for (const r of g.references) {
      if (r.isDefinition) continue;
      const file = p.program.getSourceFile(r.fileName);
      if (!file || file.fileName.includes("/node_modules/")) continue;
      const token = findToken(file, r.textSpan.start);
      add(file, token);
      // `const { foo } = await import("./x.ts")` makes a local of its own; follow its uses too.
      const binding = token.parent;
      if (binding && ts.isBindingElement(binding) && ts.isIdentifier(binding.name)) {
        for (const use of localUses(p, binding.name)) add(file, use);
      }
    }
  }
  return out.sort((a, b) => a.file.fileName.localeCompare(b.file.fileName) || a.pos - b.pos);
}

/** Arguments passed by name, with their types: a literal says what it is already. */
function argTypes(p: Project, call: ts.CallExpression | ts.NewExpression): string {
  return (call.arguments ?? [])
    .filter((a) => ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || ts.isElementAccessExpression(a))
    .filter((a) => a.getText().length <= 40)
    .map((a) => `${a.getText()}: ${clip(p.checker.typeToString(p.checker.getTypeAtLocation(a)), 60)}`)
    .join(", ");
}

function localUses(p: Project, name: ts.Identifier): ts.Identifier[] {
  const sym = p.checker.getSymbolAtLocation(name);
  if (!sym) return [];
  let scope: ts.Node = name;
  while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n !== name && n.text === name.text && p.checker.getSymbolAtLocation(n) === sym) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

function isImport(token: ts.Node): boolean {
  for (let n: ts.Node | undefined = token; n; n = n.parent) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n)) return true;
    if (ts.isBindingElement(n)) {
      // Destructuring the module that a dynamic import() resolves to.
      const decl = n.parent.parent;
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        let init: ts.Expression = decl.initializer;
        if (ts.isAwaitExpression(init)) init = init.expression;
        return ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword;
      }
      return false;
    }
    if (ts.isStatement(n)) return false;
  }
  return false;
}

function callExpressionOf(token: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  let n = token;
  if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
  const parent = n.parent;
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === n ? parent : undefined;
}

function findToken(file: ts.SourceFile, pos: number): ts.Node {
  let found: ts.Node = file;
  const walk = (n: ts.Node) => {
    if (n.getStart() <= pos && pos < n.getEnd()) {
      found = n;
      ts.forEachChild(n, walk);
    }
  };
  ts.forEachChild(file, walk);
  return found;
}

function isCallee(token: ts.Node): boolean {
  let n = token;
  if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
  const parent = n.parent;
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === n) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === n) ||
    ts.isDecorator(parent)
  );
}

const isTest = (f: ts.SourceFile) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[jt]sx?$/.test(f.fileName);

function callees(p: Project, d: Decl): Decl[] {
  const seen = new Set<string>();
  const out: Decl[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const target = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
      const found = declOf(p, target);
      if (found && found.id !== d.id && !seen.has(found.id)) {
        seen.add(found.id);
        out.push(found);
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const n of d.nodes) {
    const b = bodyOf(n) ?? (ts.isClassDeclaration(n) ? n : undefined);
    if (b) visit(b);
  }
  return out;
}

// ---------- commands ----------

const tokens = (s: string) => Math.ceil(Buffer.byteLength(s) / 4);

function cmdFind(p: Project, q: string) {
  const lower = q.toLowerCase();
  const hits = allDecls(p).filter((d) => d.name.toLowerCase().includes(lower));
  print(hits.map((d) => `${d.id}  (${d.kind})`), 30, "matches");
}

function cmdOutline(p: Project, path: string) {
  const abs = resolve(cwd, path);
  const file = p.files.find((f) => f.fileName === abs || rel(p, f.fileName) === path);
  if (!file) throw new Ask(`File is not in the project: ${path}`, 1);
  for (const d of indexFile(p, file)) {
    if (d.kind === "method" || d.kind === "property" || d.kind === "local") continue; // shown inside the class or function
    const doc = jsdocFirstLine(d.statement);
    out(`── ${d.name} (${d.kind}) ${span(p, d)}${d.nodes.length > 1 ? `  overloads: ${d.nodes.length - 1}` : ""}${doc ? `  // ${doc}` : ""}`);
    const sig = signature(p, d).replace(/^\/\*\*[\s\S]*?\*\/\n?/, "");
    // A class's members are its outline; a long type's fields are not.
    out(d.kind === "class" ? sig : clipLines(sig, 12));
  }
}

function cmdSig(p: Project, q: string) {
  const d = resolveSymbol(p, q);
  out(`${d.id}  ${span(p, d)}`);
  out(signature(p, d));
  const used = typesUsed(p, d);
  if (used.length) {
    out("\nTypes:");
    for (const t of used) out(`  ${t.name}  ${span(p, t)}`);
  }
}

function cmdBody(p: Project, q: string) {
  const d = resolveSymbol(p, q);
  const n = d.nodes.at(-1)!;
  out(`${d.id}  ${loc(p, n)}`);
  const file = n.getSourceFile();
  const first = lineOf(file, n.getStart());
  // From the start of the line, so the first line keeps its indent like the rest.
  file.text
    .slice(file.getPositionOfLineAndCharacter(first - 1, 0), n.getEnd())
    .split("\n")
    .forEach((l, i) => out(`${String(first + i).padStart(5)}  ${l}`));
}

function cmdCallers(p: Project, q: string, all: boolean, showTests: boolean, limit: number | undefined) {
  const d = resolveSymbol(p, q);
  const refs = references(p, d);
  const calls = refs.filter((r) => r.call && !isTest(r.file));
  const tests = refs.filter((r) => r.call && isTest(r.file));
  const mentions = refs.filter((r) => r.kind === "other");
  out(`${d.id}  ${calls.length} calls / ${tests.length} from tests / ${mentions.length} other references`);
  const fmt = (r: Ref) =>
    `  ${rel(p, r.file.fileName)}:${r.line}  in ${r.inside}  │ ${clip(r.text, all ? 400 : 160)}${r.args ? `  ← ${r.args}` : ""}`;
  const cap = limit ?? (all ? Infinity : 20);
  if (calls.length) {
    out("\nCalls:");
    print(calls.map(fmt), cap, "calls");
  }
  if (tests.length) {
    out("\nFrom tests:");
    // Tests run to hundreds; list them one by one only when asked.
    if (showTests) print(tests.map(fmt), cap, "calls");
    else
      for (const [f, rs] of Map.groupBy(tests, (r) => rel(p, r.file.fileName)))
        out(`  ${f}: ${rs.length} places (${rs.map((r) => r.line).join(", ")})`);
    if (!showTests) out("  (use `--tests` to see each one)");
  }
  if (mentions.length) {
    out("\nOther references (passed as a value, used as a type, etc.):");
    print(mentions.map(fmt), limit ?? (all ? Infinity : 10), "references");
  }
}

/** Which fields of type t the declaration reads, by property access or destructuring. */
function fieldsRead(p: Project, d: Decl, t: Decl): string[] {
  const type = p.checker.getTypeAtLocation(t.nameNode);
  const fields = new Set(type.getProperties().map((s) => s.name));
  const owns = (s: ts.Symbol | undefined) => !!s?.declarations?.some((x) => t.nodes.some((n) => n.getStart() <= x.getStart() && x.getEnd() <= n.getEnd()));
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && fields.has(n.name.text) && owns(p.checker.getSymbolAtLocation(n.name))) out.add(n.name.text);
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const key = n.propertyName ?? n.name;
      if (ts.isIdentifier(key) && fields.has(key.text)) {
        const prop = p.checker.getTypeAtLocation(n.parent).getProperty(key.text);
        if (owns(prop)) out.add(key.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const n of d.nodes) visit(n);
  return [...out];
}

/** For a class: which of its own methods each method calls, the class's flow at a glance. */
function classFlow(p: Project, d: Decl): string[] {
  const prefix = `${d.id}.`;
  return allDecls(p)
    .filter((m) => m.id.startsWith(prefix) && m.kind === "method")
    .map((m) => {
      const inner = callees(p, m).filter((c) => c.id.startsWith(prefix) && c.kind !== "local").map((c) => c.name.slice(d.name.length + 1));
      return inner.length ? `${m.name.slice(d.name.length + 1)} → ${inner.join(", ")}` : "";
    })
    .filter(Boolean);
}

/** Declarations a change to d likely drags along: those taking the same types, and those calling the same helpers. */
function related(p: Project, d: Decl): { decl: Decl; why: string }[] {
  const reasons = new Map<string, { decl: Decl; why: string[] }>();
  const note = (decl: Decl | undefined, why: string) => {
    if (!decl || decl.id === d.id || decl.kind === "type" || decl.kind === "interface") return;
    if (decl.id.startsWith(`${d.id}.`)) return; // a class's own members are not its siblings
    const r = reasons.get(decl.id) ?? { decl, why: [] };
    if (!r.why.includes(why)) r.why.push(why);
    reasons.set(decl.id, r);
  };
  // Same parameter types. Types taken by many functions say nothing, so skip them.
  for (const t of typesUsed(p, d)) {
    const takers = references(p, t)
      .filter((r) => r.kind === "other" && inParameter(findToken(r.file, r.pos)))
      .map((r) => r.insideDecl)
      .filter((x): x is Decl => !!x && x.id !== d.id);
    const unique = [...new Map(takers.map((x) => [x.id, x])).values()];
    if (unique.length > 6) continue;
    for (const x of unique) {
      const read = fieldsRead(p, x, t);
      note(x, `takes ${t.name}${read.length ? ` (reads ${read.join(", ")})` : " (does not read its fields)"}`);
    }
  }
  // Siblings sharing at least two helpers.
  const shared = new Map<string, { decl: Decl; helpers: string[] }>();
  const helpers = callees(p, d).filter((c) => (c.kind === "function" || c.kind === "method") && !c.id.startsWith(`${d.id}.`));
  // Sharing two helpers out of twenty is chance; ask for a real share of them.
  const needed = Math.max(2, Math.ceil(helpers.length * 0.3));
  for (const c of helpers.slice(0, 15)) {
    for (const r of references(p, c)) {
      if (!r.call || !r.insideDecl || r.insideDecl.id === d.id || isTest(r.file)) continue;
      const s = shared.get(r.insideDecl.id) ?? { decl: r.insideDecl, helpers: [] };
      if (!s.helpers.includes(c.name)) s.helpers.push(c.name);
      shared.set(r.insideDecl.id, s);
    }
  }
  for (const s of shared.values()) if (s.helpers.length >= needed) note(s.decl, `also calls ${s.helpers.join(", ")}`);
  return [...reasons.values()].map((r) => ({ decl: r.decl, why: r.why.join("; ") }));
}

function inParameter(token: ts.Node): boolean {
  for (let n: ts.Node | undefined = token; n; n = n.parent) {
    if (ts.isParameter(n)) return true;
    if (ts.isBlock(n) || ts.isStatement(n)) return false;
  }
  return false;
}

const BODY_LINES = 30;

function cmdContext(p: Project, q: string, budget: number) {
  const d = resolveSymbol(p, q);
  const parts: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  const push = (s: string) => {
    if (used + tokens(s) > budget) return false;
    parts.push(s);
    used += tokens(s);
    return true;
  };

  push(`# ${d.id}  ${span(p, d)}\n${signature(p, d)}`);

  // A short body says more than any summary of it.
  const impl = d.nodes.at(-1)!;
  const body = bodyOf(impl);
  if (body && body.getText().split("\n").length <= BODY_LINES) {
    if (!push(`\n## Body\n${impl.getText()}`)) omitted.push("body");
  } else if (body) {
    omitted.push(`body (${body.getText().split("\n").length} lines, \`tq body ${d.id}\`)`);
  }

  const types = typesUsed(p, d);
  if (types.length) {
    push("\n## Types");
    for (const t of types) {
      const text = signature(p, t);
      // Short types inline; long ones by location only.
      const inline = text.split("\n").length <= 15 ? `${text}` : `${t.name}  (${text.split("\n").length} lines, \`tq sig ${t.id}\`)`;
      const read = fieldsRead(p, d, t);
      const note = read.length ? `\n// ${d.name} reads ${read.join(", ")}` : "";
      if (!push(`// ${span(p, t)}\n${inline}${note}`)) omitted.push(`type ${t.name}`);
    }
  }

  if (d.kind === "class") {
    const flow = classFlow(p, d);
    if (flow.length && !push(`\n## Calls between methods\n${flow.join("\n")}`)) omitted.push("calls between methods");
  }

  const refs = references(p, d);
  const calls = refs.filter((r) => r.call && !isTest(r.file));
  // Counted the way `callers` counts them: calls, with other uses (`typeof x`, passing it on) apart.
  const tests = refs.filter((r) => r.call && isTest(r.file));
  const testMentions = refs.filter((r) => r.kind === "other" && isTest(r.file)).length;
  if (calls.length) {
    push(`\n## Callers (${calls.length})`);
    for (const [i, r] of calls.entries()) {
      if (!push(`${rel(p, r.file.fileName)}:${r.line}  in ${r.inside}  │ ${clip(r.text, 160)}${r.args ? `  ← ${r.args}` : ""}`)) {
        omitted.push(`${calls.length - i} callers`);
        break;
      }
    }
  }

  const rel_ = related(p, d);
  if (rel_.length) {
    const list = rel_.map((r) => `${r.decl.name}  ${span(p, r.decl)}  — ${r.why}`).join("\n");
    if (!push(`\n## May need changes too\n${list}`)) omitted.push(`${rel_.length} that may need changes too`);
  }

  if (tests.length || testMentions) {
    const byFile = Map.groupBy(tests, (r) => rel(p, r.file.fileName));
    push(`\n## From tests (${tests.length} calls in ${byFile.size} files${testMentions ? `; also ${testMentions} references as a type or value` : ""})`);
    for (const [f, rs] of byFile) {
      if (!push(`${f}: ${rs.map((r) => r.line).join(", ")}`)) {
        omitted.push("some tests");
        break;
      }
    }
  }
  // A class's own methods are shown as its flow above.
  const outs = callees(p, d).filter((c) => !c.id.startsWith(`${d.id}.`));
  if (outs.length) {
    const list = outs.map((c) => `${c.name}  ${span(p, c)}`).join("\n");
    if (!push(`\n## Calls out to\n${list}`)) omitted.push(`${outs.length} it calls`);
  }

  out(parts.join("\n"));
  if (omitted.length) out(`\n(Left out: ${omitted.join(", ")}. Budget is ${budget} tokens. Raise it with \`--budget\`.)`);
  log(`context: ~${used} tokens`);
}

// ---------- utils ----------

function print(lines: string[], limit: number, unit: string) {
  for (const l of lines.slice(0, limit)) out(l);
  if (lines.length > limit) out(`  … ${lines.length - limit} more ${unit}. Use \`--limit N\` or \`--all\` to see them`);
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function oneLine(s: string) {
  return s.replace(/\s*\n\s*/g, " ");
}

function clipLines(s: string, n: number) {
  const lines = s.split("\n");
  return lines.length > n ? [...lines.slice(0, n), `  … ${lines.length - n} more lines`].join("\n") : s;
}

// Output goes to buffers, so the daemon can hand one query's answer back whole.
let stdout: string[] = [];
let stderr: string[] = [];

function out(...parts: unknown[]) {
  stdout.push(parts.map(String).join(" "));
}

function log(s: string) {
  stderr.push(`[tq] ${s}`);
}

// ---------- queries ----------

let cwd = process.cwd();

export const HELP = `tq — get just what you need about TypeScript symbols

  tq find <name>                 find symbols by part of their name
  tq outline <file>              declarations in a file, without bodies
  tq sig <symbol>                signature, JSDoc, and where its types are
  tq body <symbol>               just the body, with line numbers
  tq callers <symbol> [--all] [--tests] [--limit N]
                                 call sites, the function around each, and the types passed in
  tq context <symbol> [--budget N] what you need to change it, within a budget (default 1500 tokens)

  <symbol> is a name, Class.method, or path#Name. Give several to answer them all in one load
  Functions defined inside functions are outer.inner (find shows them too)
  tq stats [--days N]            usage summary
  tq daemon status|stop          show or stop the background process

  --project <dir>  target project (default: current directory)
  --no-daemon      skip the background process and load just for this one query`;

export type Result = { stdout: string; stderr: string; code: number };

/** One query, as the command line gave it. The caller owns the Project and keeps it between queries. */
export function runQuery(open: (dir: string) => Project, argv: string[], from: string): Result {
  stdout = [];
  stderr = [];
  cwd = from;
  let code = 0;
  try {
    code = dispatch(open, [...argv]);
  } catch (e) {
    if (!(e instanceof Ask)) throw e;
    out(e.message);
    code = e.code;
  }
  return { stdout: stdout.length ? `${stdout.join("\n")}\n` : "", stderr: stderr.length ? `${stderr.join("\n")}\n` : "", code };
}

function dispatch(open: (dir: string) => Project, args: string[]): number {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const bool = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const all = bool("--all");
  const showTests = bool("--tests");
  const limitFlag = flag("--limit");
  const limit = limitFlag === undefined ? undefined : Number(limitFlag);
  const projectDir = resolve(cwd, flag("--project") ?? ".");
  const budget = Number(flag("--budget") ?? 1500);
  const [cmd, ...targets] = args;

  if (!cmd || targets.length === 0 || cmd === "help") {
    out(HELP);
    return cmd ? 0 : 1;
  }
  const run: Record<string, (p: Project, t: string) => void> = {
    find: (p, t) => cmdFind(p, t),
    outline: (p, t) => cmdOutline(p, t),
    sig: (p, t) => cmdSig(p, t),
    body: (p, t) => cmdBody(p, t),
    callers: (p, t) => cmdCallers(p, t, all, showTests, limit),
    context: (p, t) => cmdContext(p, t, budget),
  };
  const command = run[cmd];
  if (!command) throw new Ask(`Unknown command: ${cmd}\n\n${HELP}`, 1);
  const t0 = performance.now();
  const p = open(projectDir);
  p.refresh();
  let code = 0;
  // Several targets share one project, which is most of the cost.
  for (const [i, t] of targets.entries()) {
    if (i > 0) out("\n════════\n");
    try {
      command(p, t);
    } catch (e) {
      if (!(e instanceof Ask)) throw e;
      out(e.message);
      code = e.code;
    }
  }
  log(`${cmd}: ${Math.round(performance.now() - t0)}ms`);
  return code;
}
