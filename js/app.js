import { IdleMonitor } from './idle-monitor.js';
import { Timeline } from './timeline.js';

const $ = (id) => document.getElementById(id);

const els = {
  banners: $('banners'),
  userState: $('user-state'),
  screenState: $('screen-state'),
  detectMode: $('detect-mode'),
  permissionState: $('permission-state'),
  thresholdSelect: $('threshold-select'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  gestureHint: $('gesture-hint'),
  timelineCanvas: $('timeline'),
  animCanvas: $('anim'),
  fpsLabel: $('fps-label'),
  fpsTarget: $('fps-target'),
  pollState: $('poll-state'),
  pollCount: $('poll-count'),
  pollLog: $('poll-log'),
  longtaskCount: $('longtask-count'),
  longtaskTotal: $('longtask-total'),
  mainthreadVerdict: $('mainthread-verdict'),
  eventLog: $('event-log'),
};

const monitor = new IdleMonitor();
const timeline = new Timeline(els.timelineCanvas);

/* 全局降级开关：空闲或标签页后台时降低动画频率、暂停轮询 */
const degradation = {
  idle: false,
  hidden: document.hidden,
  get degraded() {
    return this.idle || this.hidden;
  },
};

/* ---------------- 日志与提示 ---------------- */

function logEvent(text) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
  els.eventLog.prepend(li);
  while (els.eventLog.children.length > 80) els.eventLog.lastChild.remove();
}

function showBanner(kind, text) {
  const div = document.createElement('div');
  div.className = `banner banner-${kind}`;
  div.textContent = text;
  els.banners.append(div);
}

/* ---------------- 能力检测与权限 ---------------- */

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = `state-badge ${cls}`;
}

function renderPermission(state) {
  const map = {
    granted: ['已授权', 'state-active'],
    denied: ['已拒绝', 'state-locked'],
    prompt: ['待申请', 'state-idle'],
    unsupported: ['无法查询', 'state-unknown'],
  };
  const [text, cls] = map[state] ?? map.unsupported;
  setBadge(els.permissionState, text, cls);
}

async function refreshPermission() {
  const state = await monitor.queryPermission((changed) => {
    renderPermission(changed);
    logEvent(`权限状态变更为：${changed}`);
    if (changed === 'denied' && monitor.running) {
      logEvent('权限被收回，切换到降级检测。');
      startFallback('权限被收回');
    }
  });
  renderPermission(state);
  return state;
}

function checkEnvironment() {
  const caps = IdleMonitor.capabilities();
  if (!caps.secureContext) {
    showBanner('error', '当前为非安全上下文（非 HTTPS / localhost），Idle Detection API 不可用，将使用基于事件的降级检测。');
  } else if (!caps.apiSupported) {
    showBanner('warn', '当前浏览器不支持 Idle Detection API，将使用基于事件的降级检测（无法感知锁屏状态）。');
  } else {
    showBanner('info', '环境检测通过：安全上下文 + Idle Detection API 可用。');
  }
  if (!caps.permissionsApi) {
    showBanner('warn', '当前浏览器不支持 Permissions API，无法查询权限状态。');
  }
}

/* ---------------- 状态渲染 ---------------- */

function renderState({ userState, screenState, mode }) {
  const userMap = {
    active: ['活跃', 'state-active'],
    idle: ['空闲', 'state-idle'],
    unknown: ['未知', 'state-unknown'],
  };
  const screenMap = {
    unlocked: ['未锁屏', 'state-active'],
    locked: ['已锁屏', 'state-locked'],
    unknown: [mode === 'fallback' ? '未知（降级模式）' : '未知', 'state-unknown'],
  };
  const [uText, uCls] = userMap[userState] ?? userMap.unknown;
  const [sText, sCls] = screenMap[screenState] ?? screenMap.unknown;
  setBadge(els.userState, uText, uCls);
  setBadge(els.screenState, sText, sCls);
  setBadge(
    els.detectMode,
    mode === 'native' ? '原生 API' : mode === 'fallback' ? '事件降级' : '未启动',
    mode ? 'state-active' : 'state-unknown',
  );
}

/* ---------------- 降级策略：动画降帧 + 轮询暂停 ---------------- */

const FPS_ACTIVE = 60;
const FPS_IDLE = 4;

function applyDegradation() {
  const degraded = degradation.degraded;
  els.fpsTarget.textContent = degraded ? String(FPS_IDLE) : String(FPS_ACTIVE);
  els.pollState.textContent = degraded ? '已暂停（空闲/后台）' : '运行中';
}

/* 动画：粒子漂浮，按目标帧率跳帧 */
const particles = Array.from({ length: 60 }, () => ({
  x: Math.random(), y: Math.random(),
  vx: (Math.random() - 0.5) * 0.002, vy: (Math.random() - 0.5) * 0.002,
  r: 2 + Math.random() * 3,
}));
let lastFrameTime = 0;
let fpsFrames = 0;
let fpsLastReport = 0;

function animationLoop(now) {
  requestAnimationFrame(animationLoop);
  if (degradation.hidden) return; // 后台标签页：不渲染

  const targetFps = degradation.degraded ? FPS_IDLE : FPS_ACTIVE;
  const minInterval = 1000 / targetFps;
  if (now - lastFrameTime < minInterval - 1) return; // 跳帧降频
  lastFrameTime = now;

  const canvas = els.animCanvas;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0b0f1a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = degradation.degraded ? '#c9a23a' : '#5ee08a';
  for (const p of particles) {
    p.x = (p.x + p.vx + 1) % 1;
    p.y = (p.y + p.vy + 1) % 1;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 实测帧率统计
  fpsFrames += 1;
  if (now - fpsLastReport >= 1000) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsLastReport || 1));
    els.fpsLabel.textContent = `${fps} FPS`;
    fpsFrames = 0;
    fpsLastReport = now;
  }
}

/* 轮询：空闲 / 后台时暂停 */
let pollTimer = null;
let pollCount = 0;

function pollTick() {
  if (degradation.degraded) return; // 暂停轮询
  pollCount += 1;
  els.pollCount.textContent = String(pollCount);
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 模拟请求 #${pollCount} 完成（200 OK）`;
  els.pollLog.prepend(li);
  while (els.pollLog.children.length > 30) els.pollLog.lastChild.remove();
}

/* 时间线重绘：活跃 1s / 降级 5s，后台完全暂停 */
function timelineTick() {
  if (degradation.hidden) return;
  timeline.draw();
  setTimeout(timelineTick, degradation.degraded ? 5000 : 1000);
}

/* ---------------- PerformanceObserver：主线程健康 ---------------- */

let longtaskCount = 0;
let longtaskTotal = 0;

function setupPerformanceObserver() {
  if (!('PerformanceObserver' in window)) {
    els.mainthreadVerdict.textContent = '当前浏览器不支持 PerformanceObserver。';
    return;
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longtaskCount += 1;
        longtaskTotal += entry.duration;
      }
      els.longtaskCount.textContent = String(longtaskCount);
      els.longtaskTotal.textContent = String(Math.round(longtaskTotal));
      const blockedRatio = longtaskTotal / (performance.now() || 1);
      els.mainthreadVerdict.textContent =
        blockedRatio > 0.1
          ? '⚠️ 主线程存在明显阻塞，请检查长任务。'
          : '主线程流畅 ✅';
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    els.mainthreadVerdict.textContent = '当前浏览器不支持 longtask 观察。';
  }
}

/* ---------------- 监听生命周期 ---------------- */

async function startNative() {
  await monitor.start({ threshold: Number(els.thresholdSelect.value) });
  logEvent(`原生 Idle Detection 已启动（阈值 ${monitor.threshold / 1000}s）。`);
}

async function startFallback(reason) {
  await monitor.start({ threshold: Number(els.thresholdSelect.value) });
  logEvent(`已切换到降级检测（${reason}）。注意：降级模式无法感知锁屏。`);
  showBanner('warn', `原生检测不可用（${reason}），已降级为基于事件的活跃检测。`);
}

async function handleStart() {
  els.btnStart.disabled = true;
  els.gestureHint.hidden = true;
  const caps = IdleMonitor.capabilities();

  try {
    if (caps.secureContext && caps.apiSupported) {
      // 申请权限（必须在用户手势中——本函数由 click 触发）
      let permission;
      try {
        permission = await monitor.requestPermission();
      } catch (err) {
        if (err.reason === 'no-user-gesture') {
          els.gestureHint.hidden = false;
          logEvent('权限申请失败：缺少用户交互。');
          return;
        }
        throw err;
      }
      renderPermission(permission);
      logEvent(`权限申请结果：${permission}`);

      if (permission === 'denied') {
        showBanner('error', 'Idle Detection 权限被拒绝。可前往浏览器站点设置重新授权；当前使用降级检测。');
        await startFallback('权限被拒绝');
      } else {
        try {
          await startNative();
        } catch (err) {
          await startFallback(err?.message ?? '启动失败');
        }
      }
    } else {
      await startFallback(caps.secureContext ? '浏览器不支持' : '非安全上下文');
    }
    els.btnStop.disabled = false;
  } finally {
    els.btnStart.disabled = false;
  }
}

function handleStop() {
  monitor.stop();
  els.btnStop.disabled = true;
  setBadge(els.detectMode, '未启动', 'state-unknown');
  logEvent('监听已停止。');
}

/* ---------------- 事件接线 ---------------- */

monitor.addEventListener('statechange', (e) => {
  const { userState, screenState, mode } = e.detail;
  renderState(e.detail);
  degradation.idle = userState === 'idle' || screenState === 'locked';
  applyDegradation();

  const timelineType =
    screenState === 'locked' ? 'locked' : userState === 'idle' ? 'idle' : 'active';
  timeline.push(timelineType);
  timeline.draw();

  logEvent(
    `状态变化：用户=${userState}，屏幕=${screenState}（${mode === 'native' ? '原生' : '降级'}）` +
      (degradation.idle ? ' → 已启用降级：动画降帧、轮询暂停' : ' → 已恢复全速运行'),
  );
});

monitor.addEventListener('visibility', (e) => {
  degradation.hidden = e.detail.hidden;
  applyDegradation();
  if (e.detail.hidden) {
    timeline.push('hidden');
    logEvent('标签页进入后台：渲染与轮询暂停。');
  } else {
    timeline.push(
      monitor.userState === 'idle' ? 'idle' : monitor.userState === 'unknown' ? 'unknown' : 'active',
    );
    timeline.draw();
    logEvent('标签页回到前台：恢复渲染与轮询。');
  }
});

els.btnStart.addEventListener('click', handleStart);
els.btnStop.addEventListener('click', handleStop);

/* ---------------- 启动 ---------------- */

checkEnvironment();
refreshPermission();
applyDegradation();
setupPerformanceObserver();
requestAnimationFrame(animationLoop);
setInterval(pollTick, 2000);
timelineTick();
logEvent('页面已加载，等待开始监听。');
