'use strict';
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const PERMISSIONS = ['status', 'doctor', 'lane', 'run', 'prewarm'].map((c) => `Bash(ddagent ${c}:*)`);

function copySkills(repo, force) {
  const dest = path.join(repo, '.claude', 'skills');
  const result = { copied: [], skipped: [] };
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    const target = path.join(dest, name);
    if (fs.existsSync(target) && !force) { result.skipped.push(name); continue; }
    fs.cpSync(path.join(SKILLS_DIR, name), target, { recursive: true });
    result.copied.push(name);
  }
  return result;
}

// Merge only: existing permissions and env in the target repo are never removed.
function mergePermissions(repo) {
  const file = path.join(repo, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  settings.permissions = settings.permissions || {};
  const allow = new Set(settings.permissions.allow || []);
  const added = PERMISSIONS.filter((p) => !allow.has(p));
  settings.permissions.allow = [...allow, ...added];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return added;
}

function initRepo(repo, { force = false } = {}) {
  if (!fs.existsSync(repo)) throw new Error(`not a directory: ${repo}`);
  return { skills: copySkills(repo, force), permissionsAdded: mergePermissions(repo) };
}

module.exports = { initRepo, PERMISSIONS };
