import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import ts from "typescript";

export interface CodeSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  signature: string;
  exported: boolean;
}

export interface CodeReference {
  name: string;
  kind: "call" | "reference";
  path: string;
  line: number;
  owner?: string;
}

interface IndexedFile {
  path: string;
  language: string;
  size: number;
  symbols: CodeSymbol[];
  imports: string[];
  calls: CodeReference[];
  references: CodeReference[];
}

interface CodeIndex {
  root: string;
  builtAt: number;
  files: IndexedFile[];
  symbols: CodeSymbol[];
  truncated: boolean;
}

const LANGUAGES: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".cs": "C#",
  ".c": "C",
  ".h": "C/C++",
  ".cc": "C++",
  ".cpp": "C++",
  ".hpp": "C++",
  ".php": "PHP",
  ".rb": "Ruby",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".sql": "SQL",
};

const MANIFESTS = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

@Injectable()
export class AgentCodeIndexService {
  private readonly cache = new Map<string, CodeIndex>();
  private static readonly SKIP_DIRS = new Set([
    ".git",
    ".next",
    ".turbo",
    ".cache",
    ".idea",
    ".vscode",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "vendor",
    "target",
    "__pycache__",
    ".venv",
    "venv",
  ]);

  constructor(private readonly config: ConfigService) {}

  invalidate(root?: string): void {
    if (root) this.cache.delete(resolve(root));
    else this.cache.clear();
  }

  async projectMap(root: string): Promise<string> {
    const index = await this.get(root);
    const byLanguage = new Map<string, number>();
    const topDirs = new Map<string, number>();
    const manifests: string[] = [];

    for (const file of index.files) {
      byLanguage.set(file.language, (byLanguage.get(file.language) ?? 0) + 1);
      const first = file.path.split(/[\\/]/)[0] ?? file.path;
      if (first !== file.path)
        topDirs.set(first, (topDirs.get(first) ?? 0) + 1);
      if (MANIFESTS.has(basename(file.path))) manifests.push(file.path);
    }

    const languages = [...byLanguage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => `${name} (${count})`)
      .join(", ");
    const directories = [...topDirs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => `${name}/ (${count})`)
      .join(", ");
    const keySymbols = index.symbols
      .filter((symbol) => symbol.exported)
      .slice(0, 35)
      .map(
        (symbol) =>
          `- ${symbol.path}:${symbol.line} [${symbol.kind}] ${symbol.name}`,
      );

    return [
      `PROJECT INDEX: ${index.files.length} files, ${index.symbols.length} symbols, ${index.files.reduce((sum, file) => sum + file.calls.length, 0)} calls, ${index.files.reduce((sum, file) => sum + file.references.length, 0)} references${index.truncated ? " (scan limit reached)" : ""}`,
      `Languages: ${languages || "none detected"}`,
      `Top directories: ${directories || "project root only"}`,
      `Manifests:\n${
        manifests
          .slice(0, 30)
          .map((path) => `- ${path}`)
          .join("\n") || "- none"
      }`,
      `Exported/key symbols:\n${keySymbols.join("\n") || "- none detected"}`,
      "Use code_search with a feature, symbol, route, model, or dependency name before reading files. Use symbol_graph before changing a public symbol.",
    ].join("\n\n");
  }

  async search(root: string, query: string, kind = "all"): Promise<string> {
    const index = await this.get(root);
    const clean = query.trim().toLowerCase();
    if (!clean) return this.projectMap(root);
    const terms = clean.split(/[^a-z0-9_$#.-]+/i).filter(Boolean);
    const includeSymbols = kind === "all" || kind === "symbols";
    const includeFiles = kind === "all" || kind === "files";
    const includeImports = kind === "all" || kind === "imports";
    const includeCalls = kind === "all" || kind === "calls";
    const includeReferences = kind === "all" || kind === "references";
    const hits: Array<{ score: number; text: string }> = [];

    if (includeSymbols) {
      for (const symbol of index.symbols) {
        const name = symbol.name.toLowerCase();
        const haystack =
          `${symbol.path} ${symbol.kind} ${symbol.signature}`.toLowerCase();
        let score = 0;
        if (name === clean) score += 120;
        else if (name.startsWith(clean)) score += 80;
        else if (name.includes(clean)) score += 55;
        for (const term of terms) {
          if (name === term) score += 35;
          else if (haystack.includes(term)) score += 12;
        }
        if (symbol.exported) score += 4;
        if (score > 0) {
          hits.push({
            score,
            text: `${symbol.path}:${symbol.line} [${symbol.kind}] ${symbol.signature}`,
          });
        }
      }
    }

    for (const file of index.files) {
      const path = file.path.toLowerCase();
      if (includeFiles) {
        let score = path.includes(clean) ? 50 : 0;
        for (const term of terms) if (path.includes(term)) score += 14;
        if (score > 0) {
          hits.push({
            score,
            text: `${file.path} [${file.language}, ${file.symbols.length} symbols]`,
          });
        }
      }
      if (includeImports) {
        for (const dependency of file.imports) {
          const dep = dependency.toLowerCase();
          let score = dep.includes(clean) ? 65 : 0;
          for (const term of terms) if (dep.includes(term)) score += 12;
          if (score > 0)
            hits.push({
              score,
              text: `${file.path} [imports] ${dependency}`,
            });
        }
      }
      if (includeCalls) {
        this.addReferenceHits(hits, file.calls, clean, terms, "call");
      }
      if (includeReferences) {
        this.addReferenceHits(hits, file.references, clean, terms, "reference");
      }
    }

    const unique = new Map<string, number>();
    for (const hit of hits.sort((a, b) => b.score - a.score)) {
      if (!unique.has(hit.text)) unique.set(hit.text, hit.score);
      if (unique.size >= 60) break;
    }
    if (!unique.size) return `No indexed code matches for "${query}".`;
    return [
      `CODE SEARCH: "${query}" (${unique.size} results)`,
      ...[...unique.keys()].map((text) => `- ${text}`),
    ].join("\n");
  }

  async symbolGraph(root: string, symbolName: string): Promise<string> {
    const index = await this.get(root);
    const target = symbolName.trim();
    if (!target) return "error: symbol is required";
    const clean = target.toLowerCase();
    const shortName = clean.split(".").pop() ?? clean;
    const exactName = (value: string): boolean => {
      const normalized = value.toLowerCase();
      return (
        normalized === clean ||
        normalized === shortName ||
        normalized.split(".").pop() === shortName
      );
    };

    const definitions = index.symbols
      .filter((symbol) => exactName(symbol.name))
      .slice(0, 30);
    const calls = index.files.flatMap((file) => file.calls);
    const references = index.files.flatMap((file) => file.references);
    const callers = calls.filter((call) => exactName(call.name)).slice(0, 80);
    const callees = calls
      .filter((call) => call.owner && exactName(call.owner))
      .slice(0, 80);
    const refs = references
      .filter((reference) => exactName(reference.name))
      .slice(0, 80);
    const definitionPaths = new Set(definitions.map((symbol) => symbol.path));
    const dependencies = index.files
      .filter((file) => definitionPaths.has(file.path))
      .flatMap((file) =>
        file.imports.map((dependency) => `${file.path} -> ${dependency}`),
      )
      .slice(0, 60);
    const lines = (items: string[]) =>
      items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";

    return [
      `SYMBOL GRAPH: ${target}`,
      `Definitions:\n${lines(
        definitions.map(
          (symbol) =>
            `${symbol.path}:${symbol.line} [${symbol.kind}] ${symbol.signature}`,
        ),
      )}`,
      `Callers:\n${lines(
        callers.map(
          (call) =>
            `${call.path}:${call.line}${call.owner ? ` in ${call.owner}` : ""} -> ${call.name}`,
        ),
      )}`,
      `Calls made by symbol:\n${lines(
        callees.map(
          (call) => `${call.path}:${call.line} ${call.owner} -> ${call.name}`,
        ),
      )}`,
      `References:\n${lines(
        refs.map(
          (reference) =>
            `${reference.path}:${reference.line}${reference.owner ? ` in ${reference.owner}` : ""}`,
        ),
      )}`,
      `Dependencies of defining files:\n${lines(dependencies)}`,
    ].join("\n\n");
  }

  private addReferenceHits(
    hits: Array<{ score: number; text: string }>,
    references: CodeReference[],
    clean: string,
    terms: string[],
    label: "call" | "reference",
  ): void {
    for (const reference of references) {
      const name = reference.name.toLowerCase();
      const haystack =
        `${reference.path} ${reference.owner ?? ""} ${name}`.toLowerCase();
      let score = name === clean ? 95 : name.includes(clean) ? 58 : 0;
      for (const term of terms) if (haystack.includes(term)) score += 12;
      if (score > 0) {
        hits.push({
          score,
          text: `${reference.path}:${reference.line} [${label}${reference.owner ? ` in ${reference.owner}` : ""}] ${reference.name}`,
        });
      }
    }
  }

  private async get(root: string): Promise<CodeIndex> {
    const normalized = resolve(root);
    const ttlMs = Math.max(
      1_000,
      Number(this.config.get("AGENT_CODE_INDEX_TTL_MS") ?? 30_000),
    );
    const cached = this.cache.get(normalized);
    if (cached && Date.now() - cached.builtAt < ttlMs) return cached;
    const built = await this.build(normalized);
    this.cache.set(normalized, built);
    return built;
  }

  private async build(root: string): Promise<CodeIndex> {
    const maxFiles = Math.max(
      100,
      Number(this.config.get("AGENT_CODE_INDEX_MAX_FILES") ?? 5_000),
    );
    const maxFileBytes = Math.max(
      32_000,
      Number(this.config.get("AGENT_CODE_INDEX_MAX_FILE_BYTES") ?? 1_000_000),
    );
    const files: IndexedFile[] = [];
    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 14 || files.length >= maxFiles) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (!AgentCodeIndexService.SKIP_DIRS.has(entry.name))
            await walk(full, depth + 1);
          continue;
        }
        const language = LANGUAGES[extname(entry.name).toLowerCase()];
        if (!language && !MANIFESTS.has(entry.name)) continue;
        try {
          const info = await stat(full);
          if (info.size > maxFileBytes) continue;
          const content = await readFile(full, "utf8");
          const path = relative(root, full).replace(/\\/g, "/");
          const ast = language
            ? this.extractTypeScriptIndex(path, content)
            : null;
          const symbols = language
            ? (ast?.symbols ?? this.extractSymbols(path, content))
            : [];
          files.push({
            path,
            language: language ?? "Manifest",
            size: info.size,
            symbols,
            imports: language
              ? (ast?.imports ?? this.extractImports(content, language))
              : [],
            calls: ast?.calls ?? [],
            references: ast?.references ?? [],
          });
        } catch {
          // Ignore unreadable and binary-looking files.
        }
      }
    };

    await walk(root, 0);
    return {
      root,
      builtAt: Date.now(),
      files,
      symbols: files.flatMap((file) => file.symbols),
      truncated,
    };
  }

  private extractTypeScriptIndex(
    path: string,
    content: string,
  ): {
    symbols: CodeSymbol[];
    imports: string[];
    calls: CodeReference[];
    references: CodeReference[];
  } | null {
    const ext = extname(path).toLowerCase();
    const scriptKinds: Record<string, ts.ScriptKind> = {
      ".ts": ts.ScriptKind.TS,
      ".tsx": ts.ScriptKind.TSX,
      ".js": ts.ScriptKind.JS,
      ".jsx": ts.ScriptKind.JSX,
      ".mjs": ts.ScriptKind.JS,
      ".cjs": ts.ScriptKind.JS,
    };
    const scriptKind = scriptKinds[ext];
    if (scriptKind === undefined) return null;

    const source = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    const symbols: CodeSymbol[] = [];
    const imports = new Set<string>();
    const calls: CodeReference[] = [];
    const references: CodeReference[] = [];
    const lineOf = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
      Boolean(
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
      );
    const signatureOf = (node: ts.Node): string => {
      const text = node.getText(source).split(/\r?\n/)[0]?.trim() ?? "";
      return text.slice(0, 240);
    };
    const named = (name: ts.PropertyName | ts.BindingName | undefined) =>
      name && ts.isIdentifier(name) ? name.text : undefined;
    const declaration = (
      node: ts.Node,
      owner?: string,
    ): { symbol: CodeSymbol; owner: string } | null => {
      let name: string | undefined;
      let kind: string | undefined;
      if (ts.isClassDeclaration(node)) {
        name = node.name?.text;
        kind = "class";
      } else if (ts.isInterfaceDeclaration(node)) {
        name = node.name.text;
        kind = "interface";
      } else if (ts.isTypeAliasDeclaration(node)) {
        name = node.name.text;
        kind = "type";
      } else if (ts.isEnumDeclaration(node)) {
        name = node.name.text;
        kind = "enum";
      } else if (ts.isFunctionDeclaration(node)) {
        name = node.name?.text;
        kind = "function";
      } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
        name = named(node.name);
        kind = "method";
      } else if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        name = named(node.name);
        kind = "function";
      }
      if (!name || !kind) return null;
      const qualified = owner && kind === "method" ? `${owner}.${name}` : name;
      const exportNode = ts.isVariableDeclaration(node)
        ? node.parent.parent
        : node;
      const exported =
        hasModifier(exportNode, ts.SyntaxKind.ExportKeyword) ||
        hasModifier(exportNode, ts.SyntaxKind.DefaultKeyword) ||
        hasModifier(exportNode, ts.SyntaxKind.PublicKeyword);
      return {
        symbol: {
          name: qualified,
          kind,
          path,
          line: lineOf(node),
          signature: signatureOf(node),
          exported,
        },
        owner: qualified,
      };
    };
    const isDeclarationName = (node: ts.Identifier): boolean => {
      const parent = node.parent;
      const namedDeclaration =
        ((ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isEnumDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent) ||
          ts.isTypeParameterDeclaration(parent)) &&
          parent.name === node) ||
        false;
      if (
        namedDeclaration ||
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportEqualsDeclaration(parent) ||
        ts.isExportSpecifier(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node)
      ) {
        return true;
      }
      return false;
    };
    const visit = (node: ts.Node, owner?: string): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const module = node.moduleSpecifier;
        if (module && ts.isStringLiteralLike(module)) imports.add(module.text);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        imports.add(node.arguments[0].text);
      }

      const found = declaration(node, owner);
      const nextOwner = found?.owner ?? owner;
      if (found && symbols.length < 700) symbols.push(found.symbol);

      if (ts.isCallExpression(node) && calls.length < 2_000) {
        const name = node.expression.getText(source).slice(0, 240);
        calls.push({ name, kind: "call", path, line: lineOf(node), owner });
      }
      if (
        ts.isIdentifier(node) &&
        references.length < 3_000 &&
        !isDeclarationName(node)
      ) {
        references.push({
          name: node.text,
          kind: "reference",
          path,
          line: lineOf(node),
          owner,
        });
      }
      ts.forEachChild(node, (child) => visit(child, nextOwner));
    };
    visit(source);
    return { symbols, imports: [...imports], calls, references };
  }

  private extractSymbols(path: string, content: string): CodeSymbol[] {
    const ext = extname(path).toLowerCase();
    const patterns: Array<{ kind: string; regex: RegExp; name: number }> = [];
    if (
      [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".vue",
        ".svelte",
      ].includes(ext)
    ) {
      patterns.push(
        {
          kind: "class",
          regex: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
          name: 1,
        },
        {
          kind: "interface",
          regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
          name: 1,
        },
        {
          kind: "type",
          regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
          name: 1,
        },
        {
          kind: "enum",
          regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
          name: 1,
        },
        {
          kind: "function",
          regex:
            /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
          name: 1,
        },
        {
          kind: "function",
          regex:
            /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^=]*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
          name: 1,
        },
      );
    } else if (ext === ".py") {
      patterns.push(
        { kind: "class", regex: /^\s*class\s+([A-Za-z_]\w*)/, name: 1 },
        {
          kind: "function",
          regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
          name: 1,
        },
      );
    } else if (ext === ".go") {
      patterns.push(
        {
          kind: "function",
          regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
          name: 1,
        },
        {
          kind: "type",
          regex: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/,
          name: 1,
        },
      );
    } else if (ext === ".rs") {
      patterns.push(
        {
          kind: "function",
          regex:
            /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
          name: 1,
        },
        {
          kind: "type",
          regex:
            /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
          name: 1,
        },
      );
    } else if (
      [
        ".java",
        ".kt",
        ".cs",
        ".c",
        ".h",
        ".cc",
        ".cpp",
        ".hpp",
        ".php",
        ".rb",
      ].includes(ext)
    ) {
      patterns.push(
        {
          kind: "type",
          regex:
            /^\s*(?:(?:public|private|protected|internal|abstract|final|sealed|static)\s+)*(?:class|interface|enum|record|struct|trait|module)\s+([A-Za-z_]\w*)/,
          name: 1,
        },
        {
          kind: "function",
          regex:
            /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|final|inline)\s+)+(?:[\w<>[\],.?*&:]+\s+)+([A-Za-z_]\w*)\s*\(/,
          name: 1,
        },
      );
    }

    const symbols: CodeSymbol[] = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (!match?.[pattern.name]) continue;
        symbols.push({
          name: match[pattern.name] as string,
          kind: pattern.kind,
          path,
          line: index + 1,
          signature: line.trim().slice(0, 240),
          exported: /\b(export|public|pub)\b/.test(line),
        });
        break;
      }
    }
    return symbols.slice(0, 500);
  }

  private extractImports(content: string, language: string): string[] {
    const found = new Set<string>();
    for (const line of content.split(/\r?\n/).slice(0, 2_000)) {
      const candidates = [
        line.match(/\bfrom\s+["']([^"']+)["']/)?.[1],
        line.match(/\brequire\(\s*["']([^"']+)["']\s*\)/)?.[1],
        line.match(/^\s*import\s+["']([^"']+)["']/)?.[1],
        line.match(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/)?.[1],
        line.match(/^\s*import\s+([A-Za-z0-9_.]+)\b/)?.[1],
        line.match(/^\s*use\s+([A-Za-z0-9_:]+)/)?.[1],
      ];
      for (const candidate of candidates) if (candidate) found.add(candidate);
      if (language === "Go") {
        const goImport = line.match(/^\s*["`]([^"`]+)["`]\s*$/)?.[1];
        if (goImport) found.add(goImport);
      }
      if (found.size >= 300) break;
    }
    return [...found];
  }
}
