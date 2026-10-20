#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { findProjectRoot, listFiles, normalizeSlashes, importSpecifiers, resolveRelativeImport } from "./lib/scan.mjs";
import { loadAllowlist, saveAllowlist, workPackageStatus, applyAllowlist } from "./lib/allowlist.mjs";

const MAPPING_TABLE = {
  runWorker: "R3.3",
  runPlanner: "R3.1",
  commitContractStubs: "R3.1",
  generateRepoMap: "R3.1",
  executeReplan: "R3.5",
  scheduleNextTasks: "R3.2",
  aggregateLedger: "R2.8",
  rebuildFromEvents: "R2.8",
  detectEcosystem: "R3.8",
};

export function getDeadUntil(symbol, filePath) {
  if (MAPPING_TABLE[symbol]) {
    return MAPPING_TABLE[symbol];
  }
  console.warn(`WARN: ${symbol} assigned R5.3`);
  return "R5.3";
}

/**
 * Analyzes dead top-level exported functions, classes, and consts in src/.
 *
 * @param {object} opts
 * @param {string} [opts.root]
 * @param {string[]} [opts.entries]
 * @param {string[]} [opts.excludeDirs]
 * @returns {Array<{ path: string, line: number, name: string }>}
 */
export function analyzeDead({
  root = findProjectRoot(),
  entries = ["src/cli/main.ts", "src/cli/dispatcher.ts", "src/index.ts"],
  excludeDirs = [],
  consumers = ["scripts/export-schemas.mjs"],
} = {}) {
  const allFiles = listFiles(root, "src", [".ts"]);
  const normalizedExclude = excludeDirs.map((d) => normalizeSlashes(d).replace(/\/+$/, ""));
  const files = allFiles.filter((f) => {
    return !normalizedExclude.some((ex) => f === ex || f.startsWith(ex + "/"));
  });
  const fileSet = new Set(files);
  const entryFiles = entries.map((e) => normalizeSlashes(e));
  // Non-src consumers whose value references keep src exports alive (e.g. the
  // schema exporter that lists contract consts). They are roots, not scanned for dead code.
  const consumerFiles = consumers
    .map((c) => normalizeSlashes(c))
    .filter((c) => fs.existsSync(path.join(root, c)));

  // 1. Build TS program
  const tsconfigPath = path.join(root, "tsconfig.json");
  let parsedOptions = {};
  if (fs.existsSync(tsconfigPath)) {
    try {
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          root,
          undefined,
          tsconfigPath
        );
        parsedOptions = parsed.options || {};
      }
    } catch {
      // Ignore tsconfig load errors
    }
  }

  const compilerOptions = {
    ...parsedOptions,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    noEmit: true,
  };

  const absRootFiles = [...files, ...consumerFiles].map((f) => path.resolve(root, f));
  const program = ts.createProgram(absRootFiles, compilerOptions);
  const checker = program.getTypeChecker();

  // 2. File reachability from entries
  const graph = new Map();
  for (const file of [...files, ...consumerFiles]) {
    graph.set(file, new Set());
    const absPath = path.resolve(root, file);
    try {
      const content = fs.readFileSync(absPath, "utf8");
      const specs = importSpecifiers(content, file);
      for (const item of specs) {
        const resolved = resolveRelativeImport(file, item.specifier, root);
        if (resolved && fileSet.has(resolved)) {
          graph.get(file).add(resolved);
        }
      }
    } catch {}
  }

  const reachableFiles = new Set();
  const fileQueue = [];
  for (const entry of [...entryFiles, ...consumerFiles]) {
    if (fileSet.has(entry) || consumerFiles.includes(entry)) {
      reachableFiles.add(entry);
      fileQueue.push(entry);
    }
  }
  while (fileQueue.length > 0) {
    const cur = fileQueue.shift();
    const nexts = graph.get(cur) || new Set();
    for (const nxt of nexts) {
      if (!reachableFiles.has(nxt)) {
        reachableFiles.add(nxt);
        fileQueue.push(nxt);
      }
    }
  }

  // 3. Collect top-level declarations
  function hasExportModifier(node) {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  }
  function hasDefaultModifier(node) {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(mods && mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  }

  const allDeclsByNode = new Map(); // AST node -> Decl
  const toCheckDeclarations = [];
  const fileDecls = new Map(); // file -> Decl[]

  for (const file of files) {
    const absPath = path.resolve(root, file);
    const sf = program.getSourceFile(absPath);
    if (!sf) continue;

    const parseErrors = program.getSyntacticDiagnostics(sf);
    if (parseErrors.length > 0) {
      console.warn(`WARN: parse error in ${file}`);
      continue;
    }

    const currentFileDecls = [];
    fileDecls.set(file, currentFileDecls);

    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt)) {
        if (stmt.name && ts.isIdentifier(stmt.name)) {
          const isExp = hasExportModifier(stmt) || hasDefaultModifier(stmt);
          const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
          const decl = {
            id: `${file}:${stmt.pos}:${stmt.name.text}`,
            path: file,
            line,
            name: stmt.name.text,
            node: stmt,
            isExported: isExp,
          };
          allDeclsByNode.set(stmt, decl);
          currentFileDecls.push(decl);
          if (isExp) toCheckDeclarations.push(decl);
        }
      } else if (ts.isClassDeclaration(stmt)) {
        if (stmt.name && ts.isIdentifier(stmt.name)) {
          const isExp = hasExportModifier(stmt) || hasDefaultModifier(stmt);
          const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
          const decl = {
            id: `${file}:${stmt.pos}:${stmt.name.text}`,
            path: file,
            line,
            name: stmt.name.text,
            node: stmt,
            isExported: isExp,
          };
          allDeclsByNode.set(stmt, decl);
          currentFileDecls.push(decl);
          if (isExp) toCheckDeclarations.push(decl);
        }
      } else if (ts.isVariableStatement(stmt)) {
        const isExp = hasExportModifier(stmt);
        for (const vDecl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(vDecl.name)) {
            const line = sf.getLineAndCharacterOfPosition(vDecl.getStart(sf)).line + 1;
            const decl = {
              id: `${file}:${vDecl.pos}:${vDecl.name.text}`,
              path: file,
              line,
              name: vDecl.name.text,
              node: vDecl,
              isExported: isExp,
            };
            allDeclsByNode.set(vDecl, decl);
            currentFileDecls.push(decl);
            if (isExp) toCheckDeclarations.push(decl);
          }
        }
      } else if (ts.isExportAssignment(stmt)) {
        if (!stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
          const localName = stmt.expression.text;
          const target = currentFileDecls.find((d) => d.name === localName);
          if (target && !target.isExported) {
            target.isExported = true;
            toCheckDeclarations.push(target);
          }
        }
      }
    }
  }

  // 4. Scan references & build dependency graph
  function isInsideImportOrExport(node) {
    let cur = node;
    while (cur && cur.kind !== ts.SyntaxKind.SourceFile) {
      if (
        ts.isImportSpecifier(cur) ||
        ts.isImportClause(cur) ||
        ts.isNamespaceImport(cur) ||
        ts.isExportSpecifier(cur) ||
        ts.isExportDeclaration(cur) ||
        ts.isImportDeclaration(cur) ||
        ts.isImportEqualsDeclaration(cur)
      ) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  function isTypePosition(node) {
    let cur = node;
    while (cur && cur.kind !== ts.SyntaxKind.SourceFile) {
      if (ts.isTypeNode(cur)) {
        if (
          ts.isExpressionWithTypeArguments(cur) &&
          cur.parent &&
          ts.isHeritageClause(cur.parent) &&
          cur.parent.token === ts.SyntaxKind.ExtendsKeyword &&
          cur.parent.parent &&
          (ts.isClassDeclaration(cur.parent.parent) || ts.isClassExpression(cur.parent.parent))
        ) {
          cur = cur.parent;
          continue;
        }
        return true;
      }
      if (ts.isTypeAliasDeclaration(cur) || ts.isInterfaceDeclaration(cur)) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  // True for `X` in `typeof X` (also `typeof ns.X`): a TypeQuery names a value binding.
  function isTypeQueryOperand(node) {
    let top = node;
    while (ts.isQualifiedName(top.parent)) top = top.parent;
    return ts.isTypeQueryNode(top.parent) && top.parent.exprName === top;
  }

  const edges = new Map(); // ownerId -> Set<targetDeclId>
  function addEdge(ownerId, targetDeclId) {
    if (!edges.has(ownerId)) edges.set(ownerId, new Set());
    edges.get(ownerId).add(targetDeclId);
  }

  for (const file of [...files, ...consumerFiles]) {
    const absPath = path.resolve(root, file);
    const sf = program.getSourceFile(absPath);
    if (!sf) continue;

    function walkNode(node) {
      if (ts.isIdentifier(node)) {
        // Skip import/export specifiers
        if (isInsideImportOrExport(node)) return;
        // Skip type positions, except the operand of a `typeof X` type query,
        // which is a use of the value binding X (e.g. z.infer<typeof X>).
        if (isTypePosition(node) && !isTypeQueryOperand(node)) return;
        // Skip declaration names
        if (
          (ts.isFunctionDeclaration(node.parent) ||
            ts.isClassDeclaration(node.parent) ||
            ts.isVariableDeclaration(node.parent) ||
            ts.isParameter(node.parent) ||
            ts.isPropertyDeclaration(node.parent) ||
            ts.isMethodDeclaration(node.parent) ||
            (ts.isPropertyAssignment(node.parent) && node.parent.name === node)) &&
          node.parent.name === node
        ) {
          return;
        }

        // Resolve symbol (a shorthand `{ X }` names the value binding X, not the property)
        let sym = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (sym) {
          while (sym && (sym.flags & ts.SymbolFlags.Alias)) {
            try {
              const next = checker.getAliasedSymbol(sym);
              if (!next || next === sym) break;
              sym = next;
            } catch {
              break;
            }
          }

          if (sym && sym.declarations) {
            const resolvedDeclarations = [];
            for (const d of sym.declarations) {
              if (ts.isBindingElement(d)) {
                const propName = d.propertyName ? d.propertyName.text : d.name.text;
                const vDecl = d.parent.parent;
                if (vDecl && vDecl.initializer) {
                  const type = checker.getTypeAtLocation(vDecl.initializer);
                  const prop = type.getProperty(propName);
                  if (prop && prop.declarations) {
                    for (const pd of prop.declarations) {
                      resolvedDeclarations.push(pd);
                    }
                  }
                }
              } else {
                resolvedDeclarations.push(d);
              }
            }

            for (const d of resolvedDeclarations) {
              const targetDecl = allDeclsByNode.get(d);
              if (targetDecl) {
                // Check if reference is outside target's own declaration
                if (file === targetDecl.path) {
                  const nodeStart = node.getStart(sf);
                  const nodeEnd = node.getEnd();
                  const dStart = targetDecl.node.getStart(sf);
                  const dEnd = targetDecl.node.getEnd();
                  if (nodeStart >= dStart && nodeEnd <= dEnd) {
                    continue;
                  }
                }

                // Find owner of reference
                let ownerId = null;
                let cur = node;
                while (cur && cur.parent !== sf) {
                  cur = cur.parent;
                }
                if (cur) {
                  if (ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur)) {
                    const oDecl = allDeclsByNode.get(cur);
                    if (oDecl) ownerId = oDecl.id;
                  } else if (ts.isVariableStatement(cur)) {
                    for (const vDecl of cur.declarationList.declarations) {
                      if (node.getStart(sf) >= vDecl.getStart(sf) && node.getEnd() <= vDecl.getEnd()) {
                        const oDecl = allDeclsByNode.get(vDecl);
                        if (oDecl) ownerId = oDecl.id;
                        break;
                      }
                    }
                    if (!ownerId && cur.declarationList.declarations.length > 0) {
                      const oDecl = allDeclsByNode.get(cur.declarationList.declarations[0]);
                      if (oDecl) ownerId = oDecl.id;
                    }
                  }
                }

                if (!ownerId) {
                  ownerId = "TOP_LEVEL:" + file;
                }

                addEdge(ownerId, targetDecl.id);
              }
            }
          }
        }
      }

      ts.forEachChild(node, walkNode);
    }

    walkNode(sf);
  }

  // 5. Fixed-point liveness
  const liveSet = new Set();
  const queue = [];

  function markLive(id) {
    if (!liveSet.has(id)) {
      liveSet.add(id);
      queue.push(id);
    }
  }

  // (a) Top-level code of files reachable from entries
  for (const file of reachableFiles) {
    markLive("TOP_LEVEL:" + file);
  }

  // (b) Exported symbols of entry files
  for (const entry of entryFiles) {
    const decls = fileDecls.get(entry) || [];
    for (const d of decls) {
      if (d.isExported) {
        markLive(d.id);
      }
    }

    const absPath = path.resolve(root, entry);
    const sf = program.getSourceFile(absPath);
    if (sf) {
      const modSym = checker.getSymbolAtLocation(sf);
      if (modSym) {
        try {
          const modExports = checker.getExportsOfModule(modSym);
          for (const exp of modExports) {
            let s = exp;
            while (s && (s.flags & ts.SymbolFlags.Alias)) {
              try {
                const next = checker.getAliasedSymbol(s);
                if (!next || next === s) break;
                s = next;
              } catch {
                break;
              }
            }
            if (s && s.declarations) {
              for (const d of s.declarations) {
                const tDecl = allDeclsByNode.get(d);
                if (tDecl) markLive(tDecl.id);
              }
            }
          }
        } catch {}
      }
    }
  }

  // (c) Propagate liveness
  while (queue.length > 0) {
    const cur = queue.shift();
    const targets = edges.get(cur);
    if (targets) {
      for (const tgt of targets) {
        markLive(tgt);
      }
    }
  }

  // 6. Collect dead declarations
  const dead = [];
  for (const decl of toCheckDeclarations) {
    if (!liveSet.has(decl.id)) {
      dead.push({
        path: decl.path,
        line: decl.line,
        name: decl.name,
      });
    }
  }

  return dead.sort((a, b) => {
    const pCmp = a.path.localeCompare(b.path);
    if (pCmp !== 0) return pCmp;
    return a.line - b.line;
  });
}

function parseArgs(args) {
  let root = null;
  let allowlist = null;
  let progress = null;
  let initAllowlist = false;
  let entries = ["src/cli/main.ts", "src/cli/dispatcher.ts", "src/index.ts"];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = path.resolve(args[++i]);
    } else if (args[i] === "--allowlist" && i + 1 < args.length) {
      allowlist = path.resolve(args[++i]);
    } else if (args[i] === "--progress" && i + 1 < args.length) {
      progress = path.resolve(args[++i]);
    } else if (args[i] === "--entries" && i + 1 < args.length) {
      entries = args[++i].split(",").map((s) => s.trim());
    } else if (args[i] === "--init-allowlist") {
      initAllowlist = true;
    }
  }

  const projRoot = root || findProjectRoot();
  return {
    root: projRoot,
    allowlistFile: allowlist || path.join(projRoot, "scripts/debt-allowlist.json"),
    progressFile: progress || path.join(projRoot, "docs/plan/PROGRESS.md"),
    entries,
    initAllowlist,
  };
}

export async function main() {
  try {
    const { root, allowlistFile, progressFile, entries, initAllowlist } = parseArgs(process.argv.slice(2));
    const deadViolations = analyzeDead({ root, entries, excludeDirs: [] });

    if (initAllowlist) {
      const data = loadAllowlist(allowlistFile);
      const existing = data.dead || [];
      const entryMap = new Map();
      for (const e of existing) {
        entryMap.set(`${e.path}:${e.symbol}`, e);
      }

      for (const v of deadViolations) {
        const key = `${v.path}:${v.name}`;
        if (!entryMap.has(key)) {
          const until = getDeadUntil(v.name, v.path);
          entryMap.set(key, { symbol: v.name, path: v.path, until });
        }
      }

      data.dead = Array.from(entryMap.values()).sort((a, b) => {
        const pCmp = a.path.localeCompare(b.path);
        if (pCmp !== 0) return pCmp;
        return a.symbol.localeCompare(b.symbol);
      });

      saveAllowlist(allowlistFile, data);
      console.log(`Updated dead allowlist in ${allowlistFile} (${data.dead.length} entries)`);
      process.exit(0);
    }

    const allowlist = loadAllowlist(allowlistFile);
    const status = workPackageStatus(progressFile);
    const formatted = deadViolations.map((v) => ({
      rule: "dead-export",
      path: v.path,
      line: v.line,
      name: v.name,
      symbol: v.name,
    }));
    const { remaining, problems } = applyAllowlist("dead", formatted, allowlist, status);

    for (const v of remaining) {
      console.log(`dead-export ${v.path}:${v.line} ${v.name}`);
    }
    for (const p of problems) {
      const relAllow = normalizeSlashes(path.relative(root, allowlistFile));
      console.log(`ALLOWLIST ${relAllow}:1 ${p}`);
    }

    const totalFails = remaining.length + problems.length;
    if (totalFails > 0) {
      console.log(`FAIL: ${totalFails} violation(s)`);
      process.exit(1);
    }

    console.log("OK");
    process.exit(0);
  } catch (err) {
    console.error(`Error running check-dead-exports: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
