import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const projectRoot = process.cwd();

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath));
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts"))) files.push(fullPath);
  }
  return files;
}

function importsIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
  });
  return imports;
}

function explicitAnyLocations(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const locations: string[] = [];
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      locations.push(`${path.relative(projectRoot, file)}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return locations;
}

const productionFiles = [
  path.join(projectRoot, "server.ts"),
  ...sourceFiles(path.join(projectRoot, "lib")),
  ...sourceFiles(path.join(projectRoot, "shared")),
  path.join(projectRoot, "types", "node-echonet-lite.d.ts"),
];

const layerViolations: string[] = [];
for (const file of sourceFiles(path.join(projectRoot, "lib"))) {
  const relative = path.relative(projectRoot, file);
  for (const imported of importsIn(file)) {
    if (relative.startsWith("lib/domain/")
      && imported.startsWith("../")
      && !imported.startsWith("../contracts/")
      && imported !== "../counter-utils.js") {
      layerViolations.push(`${relative} -> ${imported}`);
    }
    if (/^lib\/(persistence|adapters)\//.test(relative) && /^\.\.\/(services|http)\//.test(imported)) {
      layerViolations.push(`${relative} -> ${imported}`);
    }
    if (/^lib\/(persistence|adapters)\//.test(relative) && imported.includes("create-application")) {
      layerViolations.push(`${relative} -> ${imported}`);
    }
    if (relative.startsWith("lib/services/") && /^\.\.\/(http|persistence)\//.test(imported)) {
      layerViolations.push(`${relative} -> ${imported}`);
    }
    if (relative.startsWith("lib/services/")
      && /^\.\.\/(history-store|application-store)\.js$/.test(imported)
      && relative !== "lib/services/database-administration.ts") {
      layerViolations.push(`${relative} -> ${imported}`);
    }
    if (relative.startsWith("lib/http/routes/")
      && /^\.\.\/\.\.\/(persistence|history-store|application-store)(\/|\.js)/.test(imported)) {
      layerViolations.push(`${relative} -> ${imported}`);
    }
  }
}
assert.deepEqual(layerViolations, [], `backend layer violations:\n${layerViolations.join("\n")}`);

const compositionImports = sourceFiles(path.join(projectRoot, "tests"))
  .flatMap((file) => importsIn(file).filter((imported) => imported.includes("/create-application"))
    .map((imported) => `${path.relative(projectRoot, file)} -> ${imported}`));
assert.deepEqual(compositionImports, [], `tests must not import the production composition root:\n${compositionImports.join("\n")}`);

const explicitAny = productionFiles.flatMap(explicitAnyLocations);
assert.deepEqual(explicitAny, [], `production backend contains explicit any:\n${explicitAny.join("\n")}`);

assert.equal(existsSync(path.join(projectRoot, "lib", "application.ts")), false);
assert.equal(existsSync(path.join(projectRoot, "tests", "helpers.test.ts")), false);
assert.ok(readFileSync(path.join(projectRoot, "server.ts"), "utf8").split("\n").length <= 100);
assert.ok(readFileSync(path.join(projectRoot, "lib", "create-application.ts"), "utf8").split("\n").length <= 800);

const oversizedProductionModules = sourceFiles(path.join(projectRoot, "lib"))
  .filter((file) => readFileSync(file, "utf8").split("\n").length > 1_000)
  .map((file) => path.relative(projectRoot, file));
assert.deepEqual(oversizedProductionModules, [], `production modules must remain below 1,000 lines:\n${oversizedProductionModules.join("\n")}`);

const oversizedRouteModules = sourceFiles(path.join(projectRoot, "lib", "http", "routes"))
  .filter((file) => readFileSync(file, "utf8").split("\n").length > 500)
  .map((file) => path.relative(projectRoot, file));
assert.deepEqual(oversizedRouteModules, [], `HTTP route modules must remain below 500 lines:\n${oversizedRouteModules.join("\n")}`);

const oversizedTestModules = sourceFiles(path.join(projectRoot, "tests"))
  .filter((file) => file.endsWith(".test.ts") && readFileSync(file, "utf8").split("\n").length > 3_000)
  .map((file) => path.relative(projectRoot, file));
assert.deepEqual(oversizedTestModules, [], `test modules must remain below 3,000 lines:\n${oversizedTestModules.join("\n")}`);

console.log("architecture tests passed");
