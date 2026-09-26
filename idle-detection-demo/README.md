# Idle Detection 监控台

演示 Idle Detection API 的完整集成：权限申请、空闲/活跃/锁屏状态监听、状态时间线可视化、空闲时自动降级（动画降频 + 暂停轮询），以及完整的异常处理与降级方案。

## 运行

Idle Detection API 要求安全上下文（HTTPS 或 localhost）：

```bash
cd idle-detection-demo
python3 -m http.server 8000
# 打开 http://localhost:8000
```

需要 Chromium 94+（Chrome / Edge）。其他浏览器自动进入降级模式。

## 功能与验收对照

| 验收标准 | 实现 |
| --- | --- |
| 权限状态准确 | Permissions API `query({name:'idle-detection'})` + `change` 监听，徽标实时更新 |
| 空闲/活跃/锁屏正确 | `IdleDetector` 的 `userState`/`screenState` 合成三态 |
| 空闲时自动降级 | 动画帧间隔 0 → 250ms（约 4fps），轮询暂停并计数跳过 |
| 权限被拒提示 | 拒绝时显示红色提示条，可改用降级方案 |
| 不支持时降级 | 检测 `window.IdleDetector`，自动切换事件驱动检测（pointer/key/wheel/touch/scroll，节流 500ms） |
| 非安全上下文提示 | 检测 `window.isSecureContext`，显示提示并禁用原生入口 |
| 状态抖动平滑 | 状态须稳定 1.2s 才提交（防抖），待确认状态在时间线上以半透明显示 |
| 时间线可视化 | Canvas 绘制最近 5 分钟状态段 + 标签页后台底纹 + 分钟刻度 |
| 主线程不卡 | PerformanceObserver 监控 longtask；事件监听全部 passive + 节流；时间线 2Hz 重绘 |

## 其他行为

- **用户未交互时申请**：`requestPermission()` 仅在按钮点击手势内调用；若被浏览器拒绝（NotAllowedError）会提示需要用户交互。
- **标签页后台**：`visibilitychange` 时暂停渲染与轮询，时间线记录后台区间，回前台恢复。
- **锁屏/后台**：渲染完全暂停（帧间隔 Infinity）。
- 原生模式阈值最小 60s（API 限制）；降级模式可选 5s/15s 便于测试。
