---
name: ddagent-lane
description: Dùng khi một agent cần chạy app trên simulator iOS/iPadOS qua ddagent cùng lúc với các agent khác. Xin lane (1 simulator riêng, tối đa 4), chạy, rồi nhả lane
---

# Dùng simulator qua lane của ddagent

Mỗi agent giữ **một lane = một simulator có sẵn** trong suốt phiên làm việc. Tối đa 4 lane cùng lúc; agent thứ 5 tự chờ đến khi có lane được nhả. Không tạo simulator mới, chỉ tái sử dụng.

```
D=ddagent
LANE=$($D lane acquire --owner <tên-agent>)      # chờ nếu 4 lane đang bận; in ra id lane
$D run --lane $LANE --project <đường-dẫn>.xcodeproj --scheme <scheme>   # lặp lại mỗi khi sửa code
$D lane release $LANE                              # BẮT BUỘC khi xong, kể cả khi lỗi
```

Quy tắc:
- Luôn `release` khi xong. Lane bị bỏ quên sẽ tự nhả sau `DDAGENT_LANE_TTL_MIN` phút (mặc định 30) và chỉ khi không có job đang chạy.
- Dùng cùng `--owner` cho cùng một agent: xin lại sẽ nhận đúng lane hoặc simulator cũ, và lần `run` sau dùng lại DerivedData cũ (incremental / cache-hit).
- Muốn loại thiết bị cụ thể: `lane acquire --target "iPhone 17"`.
- `lane list` xem lane đang giữ và hàng đợi; `status` xem slot DerivedData.
- Lần chạy đầu tiên tự mở dashboard một lần; các agent sau không mở lại. Tắt bằng `DDAGENT_NO_OPEN=1` hoặc `--no-open`.
- Chạy thật cần `unset DDAGENT_MOCK` (settings.json đặt mặc định bằng 1) và `DEVELOPER_DIR` trỏ vào Xcode. Đặt `DDAGENT_MAX_SLOTS` ≥ số lane (mặc định bằng `DDAGENT_MAX_LANES`, 4).
- Nếu job báo "not enough free disk": giải phóng ổ đĩa hoặc hạ `DDAGENT_MIN_FREE_GB`.
