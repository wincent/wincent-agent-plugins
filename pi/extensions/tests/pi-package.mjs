import {readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const packageName = '@earendil-works/pi-coding-agent';

// Deliberately ignore PATH: `pi` there may be the nono launcher or a stale
// global installation. Tests must use the dotfiles-managed runtime only.
export function locatePiPackage(env = process.env) {
  const dir = join(env.HOME ?? homedir(), 'n/pi/node_modules', packageName);
  try {
    if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === packageName) {
      return realpathSync(dir);
    }
  } catch {
    // Missing or malformed manifests get the same actionable error below.
  }
  throw new Error(`Cannot locate managed ${packageName} at ${dir}. Tests require ~/n/pi; PATH/global Pi installations are not used.`);
}

// Keep Node's import conditions (Pi has import-only exports), but resolve
// platform imports from Pi rather than the extension's type-only stub tree.
// Node handles both nested and hoisted dependencies; nextResolve avoids hook
// recursion and no package code is executed just to resolve an entry point.
export function piPackageImports(specifiers, piDir = locatePiPackage()) {
  const packages = new Set(specifiers);
  const parentURL = pathToFileURL(join(piDir, 'package.json')).href;
  return {
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, packages.has(specifier)
        ? {...context, parentURL}
        : context);
    },
  };
}
