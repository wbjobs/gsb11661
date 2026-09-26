'use strict';

/* ================= 工具与 DOM ================= */
const $ = (id) => document.getElementById(id);
const els = {
  stateDot: $('stateDot'), stateText: $('stateText'), stateSince: $('stateSince'),
  modeBadge: $('modeBadge'), permBadge: $('permBadge'), degradeBadge: $('degradeBadge'),
  alertInsecure: $('alertInsecure'), alertUnsupported: $('alertUnsupported'),
  alertDenied: $('alertDenied'), alertGesture: $('alertGesture'),
  btnStart: $('btnStart'), btnFallback: $('btnFallback'), btnStop: $('btnStop'),
  btnClear: $('btnClear'), threshold: $('threshold'),
  timeline: $('timeline'), stage: $('stage'),
  fpsText: $('fpsText'), frameBudgetText: $('frameBudgetText'),
  pollState: $('pollState'), pollCount: $('pollCount'), pollSkipped: $('pollSkipped'), pollLast: $('pollLast'),
  ltCount: $('ltCount'), ltMax: $('ltMax'), ltLast: $('ltLast'), ltVerdict: $('ltVerdict'),
  log: $('log'),
};

const STATE_COLORS = { active: '#2fbf71', idle: '#f5a623', locked: '#e14b5a', unknown: '#8b98b3' };
const STATE_LABELS = { active: '活跃', idle: '空闲', locked: '锁屏', unknown: '未知' };
const STABLE_MS = 1200;          // 状态需稳定 1.2s 才提交, 平滑抖动
const TIMELINE_WINDOW = 5 * 60 * 1000;

function now() { return performance.now(); }
function fmtTime(d) {
  const t = new Date(d);
  return t.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(t.getMilliseconds()).padStart(3, '0');
}
function log(msg) {
  const line = document.createElement('div');
  line.innerHTML = '<span class="t">[' + fmtTime(Date.now()) + ']</span> ' + msg;
  els.log.prepend(line);
  while (els.log.childNodes.length > 200) els.log.lastChild.remove();
}

/* ================= 能力检测 ================= */
const caps = {
  secure: window.isSecureContext === true,
  idleApi: 'IdleDetector' in window,
  permApi: !!(navigator.permissions && navigator.permissions.query),
};
if (!caps.secure) {
  els.alertInsecure.classList.add('show');
  log('非安全上下文: Idle Detection API 不可用');
}
if (!caps.idleApi) {
  els.alertUnsupported.classList.add('show');
  log('浏览器不支持 IdleDetector');
}
const nativeAvailable = caps.secure && caps.idleApi;
els.btnStart.disabled = !nativeAvailable;

/* ================= 权限状态 ================= */
let permStatus = null;
function renderPerm(state) {
  const map = { granted: ['权限: 已授权', 'on'], denied: ['权限: 已拒绝', 'err'], prompt: ['权限: 待询问', 'warn'] };
  const [text, cls] = map[state] || ['权限: 未知', ''];
  els.permBadge.textContent = text;
  els.permBadge.className = 'badge ' + cls;
}
async function watchPermission() {
  if (!caps.permApi || !caps.idleApi) { renderPerm(null); return; }
  try {
    permStatus = await navigator.permissions.query({ name: 'idle-detection' });
    renderPerm(permStatus.state);
    log('Permissions API: idle-detection = ' + permStatus.state);
    permStatus.addEventListener('change', () => {
      renderPerm(permStatus.state);
      log('权限状态变更: ' + permStatus.state);
      els.alertDenied.classList.toggle('show', permStatus.state === 'denied');
    });
  } catch (e) {
    renderPerm(null);
    log('Permissions API 查询失败: ' + e.message);
  }
}
watchPermission();

/* ================= 状态平滑(防抖) ================= */
const smoother = {
  committed: 'unknown',
  committedAt: 0,
  pending: null,       // { state, since }
  timer: 0,
  push(state) {
    if (state === this.committed) {
      if (this.pending) { this.pending = null; clearTimeout(this.timer); }
      return;
    }
    if (this.pending && this.pending.state === state) return; // 已在等待确认
    this.pending = { state, since: now() };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const prev = this.committed;
      this.committed = state;
      this.committedAt = now();
      this.pending = null;
      onStateCommitted(state, prev);
    }, STABLE_MS);
  },
  reset() {
    clearTimeout(this.timer);
    this.pending = null;
    this.committed = 'unknown';
    this.committedAt = 0;
  },
};

/* ================= 时间线 ================= */
const segments = [];        // { state, start, end } end 为 null 表示进行中
let bgStart = null;         // 标签页后台起点(时间戳 ms, Date.now 基准)
const bgRanges = [];        // { start, end }

function pushSegment(state) {
  const t = Date.now();
  const last = segments[segments.length - 1];
  if (last && last.end === null) last.end = t;
  segments.push({ state, start: t, end: null });
}
function closeSegments() {
  const last = segments[segments.length - 1];
  if (last && last.end === null) last.end = Date.now();
}

function drawTimeline() {
  const cv = els.timeline;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 90;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const end = Date.now();
  const start = end - TIMELINE_WINDOW;
  const x = (t) => ((t - start) / TIMELINE_WINDOW) * W;

  // 后台区间底纹
  ctx.fillStyle = 'rgba(90,106,133,.25)';
  for (const r of bgRanges) {
    const a = Math.max(r.start, start), b = r.end === null ? end : r.end;
    if (b > a) ctx.fillRect(x(a), 0, x(b) - x(a), H);
  }

  // 状态段
  for (const s of segments) {
    const a = Math.max(s.start, start);
    const b = s.end === null ? end : s.end;
    if (b <= a) continue;
    ctx.fillStyle = STATE_COLORS[s.state] || STATE_COLORS.unknown;
    ctx.fillRect(x(a), 14, Math.max(1, x(b) - x(a)), H - 34);
  }

  // 待确认(抖动中)候选状态: 半透明斜纹
  if (smoother.pending) {
    const a = Math.max(Date.now() - (now() - smoother.pending.since), start);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = STATE_COLORS[smoother.pending.state];
    ctx.fillRect(x(a), 14, Math.max(1, x(Date.now()) - x(a)), H - 34);
    ctx.restore();
  }

  // 时间刻度(每分钟)
  ctx.fillStyle = '#8b98b3';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (let m = 0; m <= 5; m++) {
    const t = end - m * 60000;
    const px = x(t);
    ctx.fillRect(px, H - 16, 1, 5);
    ctx.fillText(new Date(t).toLocaleTimeString('zh-CN', { hour12: false, minute: '2-digit', second: '2-digit' }), px, H - 4);
  }
  // 当前位置线
  ctx.fillStyle = '#dbe4f3';
  ctx.fillRect(W - 1, 0, 1, H);
}
setInterval(drawTimeline, 500);

/* ================= 状态提交后的联动 ================= */
function onStateCommitted(state, prev) {
  pushSegment(state);
  renderState(state);
  applyDegradation(state);
  log('状态: ' + STATE_LABELS[prev] + ' -> <b>' + STATE_LABELS[state] + '</b>');
}

function renderState(state) {
  els.stateDot.style.background = STATE_COLORS[state];
  els.stateDot.style.boxShadow = '0 0 12px ' + STATE_COLORS[state];
  els.stateText.textContent = STATE_LABELS[state];
  els.stateSince.textContent = '自 ' + fmtTime(Date.now()) + ' 起';
}

/* ================= 降级策略: 动画降频 + 暂停轮询 ================= */
const degrade = {
  frameInterval: 0,   // 0 = 每帧; 空闲时 250ms; 锁屏/后台 = Infinity
  pollingPaused: false,
};
function applyDegradation(state) {
  const hidden = document.visibilityState === 'hidden';
  if (state === 'locked' || hidden) {
    degrade.frameInterval = Infinity;
    degrade.pollingPaused = true;
  } else if (state === 'idle') {
    degrade.frameInterval = 250;   // 降到约 4fps
    degrade.pollingPaused = true;
  } else {
    degrade.frameInterval = 0;
    degrade.pollingPaused = false;
  }
  const txt = degrade.frameInterval === Infinity ? '暂停渲染'
    : degrade.frameInterval === 0 ? '每帧(约60fps)'
    : degrade.frameInterval + 'ms(约4fps)';
  els.frameBudgetText.textContent = txt;
  els.degradeBadge.textContent = degrade.frameInterval === 0 ? '降级: 未激活' : '降级: 已激活';
  els.degradeBadge.className = 'badge ' + (degrade.frameInterval === 0 ? '' : 'warn');
  els.pollState.textContent = degrade.pollingPaused ? '已暂停(空闲/锁屏/后台)' : '运行中';
}

/* ================= 动画循环(Canvas 粒子) ================= */
const particles = Array.from({ length: 60 }, () => ({
  x: Math.random(), y: Math.random(),
  vx: (Math.random() - .5) * .0016, vy: (Math.random() - .5) * .0016,
}));
let lastFrame = 0, fpsCount = 0, fpsWindow = now();
function animLoop(t) {
  requestAnimationFrame(animLoop);
  if (t - lastFrame < degrade.frameInterval) return;
  lastFrame = t;
  const cv = els.stage;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 160;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101828';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#4f8cff';
  for (const p of particles) {
    p.x = (p.x + p.vx + 1) % 1;
    p.y = (p.y + p.vy + 1) % 1;
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  fpsCount++;
  const el = now();
  if (el - fpsWindow >= 1000) {
    els.fpsText.textContent = (fpsCount * 1000 / (el - fpsWindow)).toFixed(1) + ' fps';
    fpsCount = 0; fpsWindow = el;
  }
}
requestAnimationFrame(animLoop);

/* ================= 模拟轮询 ================= */
let pollOk = 0, pollSkip = 0;
setInterval(() => {
  if (degrade.pollingPaused) {
    pollSkip++;
    els.pollSkipped.textContent = pollSkip;
    return;
  }
  pollOk++;
  els.pollCount.textContent = pollOk;
  els.pollLast.textContent = 'tick #' + pollOk + ' @ ' + fmtTime(Date.now());
}, 2000);

/* ================= PerformanceObserver 主线程监控 ================= */
let ltNum = 0, ltMaxVal = 0;
try {
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      ltNum++;
      ltMaxVal = Math.max(ltMaxVal, e.duration);
      els.ltCount.textContent = ltNum;
      els.ltMax.textContent = ltMaxVal.toFixed(0) + ' ms';
      els.ltLast.textContent = e.duration.toFixed(0) + ' ms @ ' + fmtTime(performance.timeOrigin + e.startTime);
      els.ltVerdict.textContent = ltNum > 20 ? '长任务偏多, 注意主线程' : '良好';
      log('长任务 ' + e.duration.toFixed(0) + 'ms');
    }
  });
  po.observe({ entryTypes: ['longtask'] });
} catch (e) {
  els.ltVerdict.textContent = 'longtask 不受支持';
}

/* ================= 监听器: 原生 IdleDetector ================= */
let activeMonitor = null;

function createNativeMonitor(threshold) {
  const controller = new AbortController();
  const detector = new IdleDetector();
  let stopped = false;
  return {
    mode: 'native',
    async start() {
      detector.addEventListener('change', () => {
        const user = detector.userState;      // 'active' | 'idle'
        const screen = detector.screenState;  // 'locked' | 'unlocked'
        const state = screen === 'locked' ? 'locked' : (user === 'idle' ? 'idle' : 'active');
        smoother.push(state);
      });
      await detector.start({ threshold, signal: controller.signal });
      log('IdleDetector 已启动, 阈值 ' + threshold / 1000 + 's');
      // 启动后立即同步一次当前状态
      const state = detector.screenState === 'locked' ? 'locked'
        : (detector.userState === 'idle' ? 'idle' : 'active');
      smoother.push(state);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      log('IdleDetector 已停止');
    },
  };
}

/* ================= 监听器: 降级(事件驱动活跃检测) ================= */
function createFallbackMonitor(threshold) {
  const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  let timer = 0, lastEvent = 0, running = false;
  const ACTIVITY_THROTTLE = 500;

  function onActivity() {
    const t = now();
    if (t - lastEvent < ACTIVITY_THROTTLE) return; // 节流, 保护主线程
    lastEvent = t;
    smoother.push('active');
    arm();
  }
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => smoother.push('idle'), threshold);
  }
  return {
    mode: 'fallback',
    async start() {
      running = true;
      for (const ev of EVENTS) {
        window.addEventListener(ev, onActivity, { passive: true, capture: true });
      }
      smoother.push('active');
      arm();
      log('降级检测已启动(事件驱动), 阈值 ' + threshold / 1000 + 's; 注意: 降级模式无法检测锁屏');
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimeout(timer);
      for (const ev of EVENTS) {
        window.removeEventListener(ev, onActivity, { capture: true });
      }
      log('降级检测已停止');
    },
  };
}

/* ================= 启停控制 ================= */
function setRunningUI(running, mode) {
  els.btnStart.disabled = running || !nativeAvailable;
  els.btnFallback.disabled = running;
  els.btnStop.disabled = !running;
  els.threshold.disabled = running;
  els.modeBadge.textContent = '模式: ' + (running ? (mode === 'native' ? 'Idle Detection API' : '事件降级') : '未启动');
  els.modeBadge.className = 'badge ' + (running ? 'on' : '');
}

async function startMonitor(mode) {
  if (activeMonitor) return;
  let threshold = Number(els.threshold.value);
  if (mode === 'native') {
    threshold = Math.max(threshold, 60000); // API 要求 >= 60s
    // 权限申请必须发生在用户手势内(本函数由点击触发)
    try {
      const result = await IdleDetector.requestPermission();
      renderPerm(result);
      if (result !== 'granted') {
        els.alertDenied.classList.add('show');
        log('权限未授予: ' + result + ', 可改用降级方案');
        return;
      }
      els.alertDenied.classList.remove('show');
    } catch (e) {
      // 非用户手势触发 / 其他错误
      els.alertGesture.classList.add('show');
      log('requestPermission 失败: ' + e.message + '(需在用户交互中调用)');
      setTimeout(() => els.alertGesture.classList.remove('show'), 6000);
      return;
    }
    activeMonitor = createNativeMonitor(threshold);
  } else {
    activeMonitor = createFallbackMonitor(threshold);
  }
  try {
    await activeMonitor.start();
    setRunningUI(true, mode);
  } catch (e) {
    log('启动失败: ' + e.message);
    activeMonitor = null;
    setRunningUI(false);
  }
}

function stopMonitor() {
  if (!activeMonitor) return;
  activeMonitor.stop();
  activeMonitor = null;
  smoother.reset();
  closeSegments();
  setRunningUI(false);
  renderState('unknown');
  els.stateSince.textContent = '';
}

els.btnStart.addEventListener('click', () => startMonitor('native'));
els.btnFallback.addEventListener('click', () => startMonitor('fallback'));
els.btnStop.addEventListener('click', stopMonitor);
els.btnClear.addEventListener('click', () => {
  segments.length = 0;
  bgRanges.length = 0;
  if (smoother.committed !== 'unknown') pushSegment(smoother.committed);
  log('时间线已清空');
});

/* ================= 标签页后台处理 ================= */
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  if (hidden) {
    bgStart = Date.now();
    log('标签页进入后台: 渲染暂停, 轮询挂起');
  } else {
    if (bgStart !== null) {
      bgRanges.push({ start: bgStart, end: Date.now() });
      bgStart = null;
    }
    log('标签页回到前台');
  }
  // 后台时立即应用降级(暂停渲染与轮询), 前台时按当前状态恢复
  applyDegradation(smoother.committed);
});

/* ================= 初始化 ================= */
renderState('unknown');
applyDegradation('active');
if (!nativeAvailable) {
  log('已自动准备降级方案, 点击"使用降级方案"开始');
}
