#!/usr/bin/env node
/**
 * Compile sCrypt contracts → artifacts/*.json for loadArtifact().
 *
 * Forces scrypt-ts-transpiler to use its nested TypeScript 5.3 (ts-patch'd),
 * not the monorepo root TypeScript 5.8+.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')
const artifactsDir = path.join(pkgRoot, 'artifacts')
const contractsDir = path.join(pkgRoot, 'src', 'contracts')
const require = createRequire(import.meta.url)

const transpilerPkg = path.dirname(require.resolve('scrypt-ts-transpiler/package.json'))
const nestedTsMain = path.join(
  transpilerPkg,
  'node_modules',
  'typescript',
  'lib',
  'typescript.js',
)
if (!fs.existsSync(nestedTsMain)) {
  console.error('Nested typescript missing under scrypt-ts-transpiler')
  process.exit(1)
}

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'typescript') return nestedTsMain
  return origResolve.call(this, request, parent, isMain, options)
}

const ts = require('typescript')
const transformProgram = require('scrypt-ts-transpiler').default
const { compileContract, findCompiler } = require('scryptlib')
const { getBinary, safeCompilerVersion } = require('scryptlib/util/getBinary')

console.log('TypeScript for transpile:', ts.version)

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

function cleanArtifacts() {
  fs.mkdirSync(artifactsDir, { recursive: true })
  for (const f of walk(artifactsDir)) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
  // remove empty dirs
  for (const ent of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      fs.rmSync(path.join(artifactsDir, ent.name), { recursive: true, force: true })
    }
  }
}

async function ensureScryptc() {
  let scryptc = findCompiler()
  if (!scryptc || safeCompilerVersion(scryptc) === '0.0.0') {
    console.log('Downloading scryptc…')
    await getBinary()
    scryptc = findCompiler()
  }
  console.log('scryptc:', scryptc, safeCompilerVersion(scryptc))
}

async function main() {
  cleanArtifacts()
  const files = fs
    .readdirSync(contractsDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => path.join(contractsDir, f))

  if (!files.length) {
    console.error('No contracts in src/contracts/')
    process.exit(1)
  }
  console.log(
    'Contracts:',
    files.map((f) => path.relative(pkgRoot, f)).join(', '),
  )

  const options = {
    noEmit: true,
    experimentalDecorators: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
    outDir: artifactsDir,
    rootDir: path.join(pkgRoot, 'src'),
  }
  const host = ts.createCompilerHost(options)
  const program = ts.createProgram({ rootNames: files, options, host })

  const diags = ts.getPreEmitDiagnostics(program)
  for (const d of diags.slice(0, 15)) {
    console.warn(
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      d.file?.fileName ?? '',
    )
  }

  process.chdir(pkgRoot)
  transformProgram(
    program,
    host,
    { outDir: 'artifacts', debug: false, transformProgram: true },
    { ts },
  )

  const scryptFiles = walk(artifactsDir).filter((f) => f.endsWith('.scrypt'))
  console.log(
    'Transpiled:',
    scryptFiles.map((f) => path.relative(pkgRoot, f)),
  )
  if (!scryptFiles.length) {
    console.error('No .scrypt files emitted')
    process.exit(1)
  }

  // Fail if any transformer reported failure
  for (const f of walk(artifactsDir).filter((x) =>
    x.endsWith('.transformer.json'),
  )) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!j.success) {
      console.error('Transpile failed:', f, j.errors)
      process.exit(1)
    }
  }

  await ensureScryptc()

  let ok = 0
  for (const f of scryptFiles) {
    const outDir = path.dirname(f)
    console.log('scryptc', path.relative(pkgRoot, f))
    const result = compileContract(f, {
      out: outDir,
      artifact: true,
      optimize: true,
    })
    if (result?.errors?.length) {
      console.error(result.errors)
      continue
    }
    const artifactPath = path.join(outDir, `${path.basename(f, '.scrypt')}.json`)
    if (fs.existsSync(artifactPath)) {
      // Flatten to artifacts/<name>.json for easy import
      const flat = path.join(artifactsDir, path.basename(artifactPath))
      fs.copyFileSync(artifactPath, flat)
      console.log('  artifact', path.relative(pkgRoot, flat))
      ok++
    } else {
      console.error('  missing artifact at', artifactPath)
    }
  }

  console.log(`Compiled ${ok}/${scryptFiles.length} contract artifact(s)`)
  if (ok === 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
