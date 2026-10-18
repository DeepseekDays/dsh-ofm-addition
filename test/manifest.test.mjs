/**
 * Offline checks against the harness's own parsers.
 *
 * The two failures that cost a restart are a `dsh.client` declaration the module
 * registry refuses and a bundle patch the loader refuses to read. Neither is
 * worth guessing at, so this rig extracts `parseDshClient` / `clientExportOf`
 * out of the installed `@deepseek-ai/dsh-client-modules` by name and runs them
 * over this package, then parses the patch with the same YAML reader the loader
 * uses. It is skipped (not failed) when no DSH install is reachable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))

/** Candidate DSH installs, most specific first. */
function findApp() {
  const candidates = [
    process.env.DSH_APP_DIR,
    'C:/Program Files/DSH/resources/app',
    path.join(os.homedir(), 'AppData/Local/Programs/DSH/resources/app'),
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'))) return candidate
  }
  return undefined
}

const appDir = findApp()

/**
 * Pull one function's source out of a bundle by name.
 *
 * Brace matching rather than a regex: the bodies contain braces in strings and
 * template literals, and a truncated extraction would silently test nothing.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found in the harness bundle`)
  let depth = 0
  let index = source.indexOf('{', start)
  const from = index
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`function ${name} has unbalanced braces (from offset ${from})`)
}

test('the harness client-module parser accepts this package manifest', (t) => {
  if (appDir === undefined) {
    t.skip('no DSH install found; set DSH_APP_DIR to run this check')
    return
  }
  const source = fs.readFileSync(path.join(appDir, 'node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'), 'utf8')
  // eslint-disable-next-line no-new-func -- running the harness's own parser is the point
  const load = new Function(
    `${extractFunction(source, 'optionalStringArray')}\n${extractFunction(source, 'parseDshClient')}\n${extractFunction(source, 'clientExportOf')}\nreturn { parseDshClient, clientExportOf }`,
  )
  const { parseDshClient, clientExportOf } = load()

  const declaration = parseDshClient(manifest.name, manifest.dsh?.client)
  assert.notEqual(declaration, undefined, 'dsh.client must be declared')
  assert.equal(declaration.platform, 'web')
  assert.deepEqual(declaration.inject, [])
  assert.equal(declaration.immediately, true)

  const clientExport = clientExportOf(manifest.name, manifest.exports)
  assert.equal(typeof clientExport, 'string', 'exports["./client"] must resolve to a path')
  assert.equal(
    fs.existsSync(path.resolve(pkgDir, clientExport)),
    true,
    `exports["./client"] points at a missing file: ${clientExport}`,
  )

  // A malformed declaration is rejected rather than ignored — prove the parser
  // is really the one under test.
  assert.throws(() => parseDshClient(manifest.name, { platform: 'web', immediately: 'yes' }))
  assert.throws(() => parseDshClient(manifest.name, { platform: 'web', inject: [1] }))
})

test('the bundle patch parses and mounts exactly this package', (t) => {
  if (appDir === undefined) {
    t.skip('no DSH install found; set DSH_APP_DIR to run this check')
    return
  }
  const require = createRequire(pathToFileURL(path.join(appDir, 'package.json')))
  let yaml
  try {
    yaml = require('js-yaml')
  } catch {
    t.skip('js-yaml is not resolvable from the DSH install')
    return
  }

  const patch = yaml.load(fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8'))
  assert.ok(Array.isArray(patch), 'a profile patch layer is a top-level array')

  const inserts = patch.flatMap((row) => row?.insert ?? [])
  assert.equal(inserts.length, 1, 'this bundle inserts one row')

  const [row] = inserts
  assert.equal(row.name, manifest.name, 'the inserted row must name this package')
  assert.equal(typeof row.id, 'string')
  assert.notEqual(row.id.trim(), '', 'the row id is the settings namespace, so it must be set')
  assert.equal(row.id, 'ofm-addition')
  assert.equal(JSON.stringify(row.config), '{}')

  // The `dsh.bundle.patch` this manifest advertises must be the patch that ships.
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(fs.existsSync(path.join(pkgDir, manifest.dsh.bundle.patch)), true)
})

test('the entry points the loader will import actually exist', () => {
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, './index.js')
  for (const file of [manifest.main, manifest.exports['./client'], manifest.dsh.bundle.patch]) {
    assert.equal(fs.existsSync(path.resolve(pkgDir, file)), true, `missing ${file}`)
  }
  // `files` decides what a published copy contains; everything load-time needs
  // must be in it, or the plugin works here and breaks once published.
  for (const entry of ['index.js', 'client.js', 'src', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(entry), `"files" is missing ${entry}`)
  }
})

test('nothing in the shipped tree reaches for a package the profile may not have', () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'test' ? [] : walk(full)
      return entry.name.endsWith('.js') || entry.name.endsWith('.mjs') ? [full] : []
    })
  const bare = new Set()
  for (const file of walk(pkgDir)) {
    if (file.includes(`${path.sep}test${path.sep}`) || path.basename(file) === 'install.mjs') continue
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (!specifier.startsWith('.') && !specifier.startsWith('node:')) bare.add(specifier)
    }
    // The browser half may only require what the shell's module table provides.
    if (path.basename(file) === 'client.js') {
      for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        assert.equal(match[1], 'react', `client.js requires "${match[1]}"; the module table does not provide it`)
      }
    }
  }
  assert.deepEqual([...bare], [], 'the shipped tree must import nothing but node builtins and relative paths')
})
