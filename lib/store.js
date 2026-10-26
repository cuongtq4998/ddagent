'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA = 1;

// Single-writer JSON store (only the daemon uses it). Atomic write + debounce.
class Store {
  constructor(file) {
    this.file = file;
    this.state = { schemaVersion: SCHEMA, slots: {}, history: [] };
    this.timer = null;
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.schemaVersion === SCHEMA) this.state = { ...this.state, ...s };
    } catch { /* first run or unreadable: start empty and reconcile from disk */ }
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 200);
    this.timer.unref();
  }
  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, SCHEMA };
