# Idle Detection 监控台

基于 **Idle Detection API + Permissions API + PerformanceObserver + Canvas + DOM** 的用户空闲/活跃/锁屏监控演示。

## 运行

```bash
# 任意静态服务器，localhost 即为安全上下文
python3 -m http.server 8000
# 打开 http://localhost:8000
```

- 原生 Idle Detection 需要 **安全上下文**（HTTPS 或 localhost）+ Chromium 系浏览器。
- 权限申请必须由**用户手势**触发，请点击页面上的「申请权限并开始监听」按钮。
- 原生 API 强制空闲阈值 ≥ 60 秒；想快速验证可选「15 秒（仅降级模式）」，在不支持/未授权时会走降级检测。

## 功能与验收对照

| 验收标准 | 实现 |
| --- | --- |
| 权限状态准确 | `navigator.permissions.query({name:'idle-detection'})` + `onchange` 实时同步，权限被收回时自动切降级 |
| 空闲/活跃/锁屏正确 | 原生 `IdleDetector` 的 `userState`/`screenState`；降级模式锁屏显示「未知」 |
| 空闲时自动降级 | 动画 60→4 FPS 跳帧降频；轮询暂停；时间线重绘降频 |
| 权限被拒提示 | 错误横幅 + 日志，并自动降级继续工作 |
| 不支持时降级 | 基于 `pointer/key/wheel/touch/scroll` 事件的活跃检测 |
| 非安全上下文提示 | `window.isSecureContext` 检测，错误横幅说明 |
| 状态抖动平滑 | 候选状态需稳定 400ms 才提交（`STABLE_MS`） |
| 时间线可视化 | Canvas 绘制最近 5 分钟状态段（活跃/空闲/锁屏/后台），DPR 自适应 |
| 主线程不卡 | `PerformanceObserver` 观察 `longtask`，统计阻塞时长并给出结论；重活全部跳帧/降频 |
| 标签页后台 | `visibilitychange`：暂停渲染与轮询，时间线记录「后台」段 |
| 未交互时申请 | 通过 `navigator.userActivation.isActive` 前置校验并提示 |

## 文件结构

- `index.html` — 页面结构
- `css/styles.css` — 样式
- `js/idle-monitor.js` — 核心：权限申请、原生/降级双模式、抖动平滑
- `js/timeline.js` — Canvas 状态时间线
- `js/app.js` — 编排：动画降帧、轮询暂停、longtask 监控、日志
