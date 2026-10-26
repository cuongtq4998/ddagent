---
name: ddagent-debug
description: Dùng khi ddagent gặp lỗi build, cache-hit/incremental sai, slot bị kẹt lease hoặc dirty, simulator không boot/install, hoặc state.json lạ
---

# Debug ddagent

1. Kiểm tra môi trường: `ddagent doctor` (thêm `--mock` nếu không có Xcode).
2. Xem trạng thái: `ddagent status`, và `~/.ddagent/state.json` (hoặc `$DDAGENT_HOME`) để biết slot nào `dirty`, có `bindings` nào.
3. Phân loại triệu chứng:
   - **Cache-hit/incremental sai**: so sánh cache key trong `lib/fingerprint.js` (`CTX_KEYS`, `EXT`, `SKIP_DIRS`). Loại file ảnh hưởng build mà không nằm trong `EXT` sẽ không làm đổi key.
   - **Slot kẹt/không cấp được**: xem lease và giới hạn `DDAGENT_MAX_SLOTS`, `DDAGENT_MIN_FREE_GB` trong `lib/pool.js`.
   - **Boot/install lỗi**: lỗi CoreSimulator tạm thời được retry trong `lib/backend.js` (`TRANSIENT`); lỗi khác xem log job qua `/api/jobs/<id>`.
4. Tái hiện ở mock mode (`DDAGENT_MOCK=1`) trước khi nghi ngờ Xcode.
5. Sửa xong thì chạy `npm test`.

Daemon cũ còn chạy giữ port 7777 là nguyên nhân hay gặp: kiểm tra `curl localhost:7777/api/ping`.
