# CLAUDE.md

Rules for working on this repo:

- Use only Node built-in modules (CommonJS, `'use strict'`); add no dependencies.
- Every new backend operation must be implemented in both `realBackend` and `mockBackend` in `lib/backend.js`.
- Only the daemon (`server.js`) writes `state.json`, through `Store`.
- Develop and test in mock mode (`DDAGENT_MOCK=1`); never depend on Xcode.
