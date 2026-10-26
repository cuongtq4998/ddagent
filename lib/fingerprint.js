'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Everything that can change a build output, not just .swift files.
const EXT = new Set([
  '.swift', '.m', '.mm', '.h', '.c', '.cc', '.cpp', '.metal', '.pbxproj', '.xcconfig', '.plist',
  '.entitlements', '.storyboard', '.xib', '.json', '.strings', '.xcstrings', '.stringsdict',
  '.png', '.jpg', '.jpeg', '.pdf', '.svg', '.ttf', '.otf', '.xcprivacy', '.intentdefinition',
  '.resolved', '.xcscheme', '.sh',
]);
const SKIP_DIRS = new Set(['node_modules', 'build', 'DerivedData', 'tools', 'Pods', '.build', 'xcuserdata']);
const CTX_KEYS = ['projectPath', 'scheme', 'config', 'sdk', 'arch', 'xcode'];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.xcconfig') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (e.isFile() && EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
}

function sourceHash(root) {
  const files = [];
  walk(root, files);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(root, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  }
  return { hash: h.digest('hex'), files: files.length, hasPackages: files.some((f) => f.endsWith('Package.resolved')) };
}

// key = hash(build context + source content). Any change => new key.
function computeKey(ctx, root) {
  const src = sourceHash(root);
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(CTX_KEYS.map((k) => ctx[k]))).update(src.hash);
  return { key: h.digest('hex').slice(0, 16), files: src.files, hasPackages: src.hasPackages };
}

const sameCtx = (a, b) => !!a && !!b && CTX_KEYS.every((k) => a[k] === b[k]);

module.exports = { computeKey, sameCtx, CTX_KEYS };
