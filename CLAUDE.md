# CLAUDE.md

Rules for working on this repo:

- Chỉ dùng module built-in của Node (CommonJS, `'use strict'`); không thêm dependency.
- Thao tác backend mới phải cài ở cả `realBackend` và `mockBackend` trong `lib/backend.js`.
- Chỉ daemon (`server.js`) được ghi `state.json` qua `Store`.
- Phát triển và test ở mock mode (`DDAGENT_MOCK=1`), không phụ thuộc Xcode.
