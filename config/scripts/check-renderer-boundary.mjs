import { builtinModules } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript-api'

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const TEST_FILE_PATTERN = /\.(?:spec|test)\.[cm]?[jt]sx?$/
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, moduleName.replace(/^node:/, '')])
)

function isWithin(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  )
}

function stripSourceExtension(filePath) {
  return filePath.replace(/\.[cm]?[jt]sx?$/, '')
}

function scriptKindFor(filePath) {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function collectModuleReferences(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath)
  )
  const references = []

  function addReference(node, moduleSpecifier, typeOnly = false) {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
      return
    }
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    references.push({ line: position.line + 1, specifier: moduleSpecifier.text, typeOnly })
  }

  function isTypeOnlyDeclaration(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (!clause) {
        return false
      }
      if (clause.isTypeOnly) {
        return true
      }
      return (
        !clause.name &&
        !!clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
      )
    }
    if (ts.isExportDeclaration(node)) {
      return (
        node.isTypeOnly ||
        (!!node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly))
      )
    }
    return false
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addReference(node, node.moduleSpecifier, isTypeOnlyDeclaration(node))
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addReference(node, node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) {
        addReference(node, node.arguments[0])
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

async function listRendererSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return listRendererSourceFiles(entryPath)
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) {
        return []
      }
      return TEST_FILE_PATTERN.test(entry.name) ? [] : [entryPath]
    })
  )
  return nestedFiles.flat()
}

function violationReason(projectRoot, filePath, reference) {
  const { specifier, typeOnly } = reference
  if (specifier === 'electron' || specifier.startsWith('electron/')) {
    return 'Electron is available only behind the preload contract'
  }
  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) {
    return 'Node.js built-ins are unavailable in the browser renderer'
  }
  if (specifier === '@main' || specifier.startsWith('@main/')) {
    return 'renderer code cannot import main-process implementations'
  }
  if (specifier === '@preload' || specifier.startsWith('@preload/')) {
    return 'renderer code may import only the preload API type contract'
  }
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
    return null
  }

  const targetPath = resolve(dirname(filePath), specifier)
  const mainRoot = resolve(projectRoot, 'src/main')
  const preloadRoot = resolve(projectRoot, 'src/preload')
  const preloadContract = resolve(preloadRoot, 'api-types')

  if (isWithin(mainRoot, targetPath)) {
    return 'renderer code cannot import main-process implementations'
  }
  if (isWithin(preloadRoot, targetPath)) {
    if (stripSourceExtension(targetPath) === preloadContract && typeOnly) {
      return null
    }
    return 'renderer code may use only type imports from the preload API contract'
  }
  return null
}

export async function findRendererBoundaryViolations(projectRoot = process.cwd()) {
  const rendererRoot = resolve(projectRoot, 'src/renderer/src')
  const files = await listRendererSourceFiles(rendererRoot)
  const violations = []

  for (const filePath of files) {
    const sourceText = await readFile(filePath, 'utf8')
    const references = collectModuleReferences(sourceText, filePath)
    if (references.some(({ specifier }) => specifier === 'vitest')) {
      continue
    }
    for (const reference of references) {
      const reason = violationReason(projectRoot, filePath, reference)
      if (!reason) {
        continue
      }
      violations.push({
        file: relative(projectRoot, filePath).split(sep).join('/'),
        line: reference.line,
        reason,
        specifier: reference.specifier
      })
    }
  }

  return violations.sort((left, right) =>
    `${left.file}:${left.line}:${left.specifier}`.localeCompare(
      `${right.file}:${right.line}:${right.specifier}`
    )
  )
}

async function main() {
  const violations = await findRendererBoundaryViolations()
  if (violations.length === 0) {
    console.log('Renderer boundary check passed.')
    return
  }

  console.error('Renderer boundary violations:')
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} imports ${JSON.stringify(violation.specifier)}: ${violation.reason}`
    )
  }
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main()
}
