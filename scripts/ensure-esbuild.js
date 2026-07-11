/**
 * Ensure the platform-specific esbuild binary is present (needed by tsx / vite).
 * npm sometimes skips optionalDependencies in monorepos or with --omit=optional.
 */
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import process from 'node:process'

const require = createRequire(import.meta.url)

const platformMap = {
  'darwin-arm64': '@esbuild/darwin-arm64',
  'darwin-x64': '@esbuild/darwin-x64',
  'linux-arm64': '@esbuild/linux-arm64',
  'linux-x64': '@esbuild/linux-x64',
  'win32-x64': '@esbuild/win32-x64',
}

const key = `${process.platform}-${process.arch}`
const pkg = platformMap[key]

if (!pkg) {
  console.warn(`[ensure-esbuild] No known package for ${key}; skipping`)
  process.exit(0)
}

try {
  require.resolve(`${pkg}/package.json`)
  // ok
} catch {
  console.warn(`[ensure-esbuild] Missing ${pkg}; installing…`)
  try {
    execSync(`npm install ${pkg} --no-save --no-audit --no-fund`, {
      stdio: 'inherit',
      cwd: new URL('..', import.meta.url).pathname,
    })
  } catch (e) {
    console.warn(
      `[ensure-esbuild] Could not install ${pkg}. Run: npm install ${pkg}`,
    )
  }
}
