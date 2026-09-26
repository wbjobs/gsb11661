/**
 * IdleMonitor：封装 Idle Detection API，并提供基于事件的降级检测。
 *
 * 事件（EventTarget）：
 *  - 'statechange'  detail: { userState, screenState, mode, at }
 *  - 'visibility'   detail: { hidden, at }
 *  - 'error'        detail: { reason, message }
 *
 * userState:   'active' | 'idle' | 'unknown'
 * screenState: 'locked' | 'unlocked' | 'unknown'
 * mode:        'native' | 'fallback'
 */

const STABLE_MS = 400;              // 状态抖动平滑窗口：状态需稳定 400ms 才提交
const FALLBACK_ACTIVITY_EVENTS = [
  'pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll',
];

export class IdleMonitor extends EventTarget {
  constructor() {
    super();
    this.mode = null;               // 'native' | 'fallback'
    this.userState = 'unknown';
    this.screenState = 'unknown';
    this.threshold = 60_000;
    this._detector = null;
    this._abort = null;
    this._fallbackTimer = null;
    this._pendingState = null;      // 抖动平滑：待提交的候选状态
    this._pendingTimer = null;
    this._running = false;
    this._onVisibility = this._onVisibility.bind(this);
    this._onActivity = this._onActivity.bind(this);
  }

  /** 能力检测 */
  static capabilities() {
    return {
      secureContext: window.isSecureContext === true,
      apiSupported: 'IdleDetector' in window,
      permissionsApi: 'permissions' in navigator,
    };
  }

  /** 通过 Permissions API 查询权限状态：'granted' | 'denied' | 'prompt' | 'unsupported' */
  async queryPermission(onChange) {
    if (!IdleMonitor.capabilities().permissionsApi) return 'unsupported';
    try {
      const status = await navigator.permissions.query({ name: 'idle-detection' });
      if (onChange) {
        status.onchange = () => onChange(status.state);
      }
      return status.state;
    } catch (err) {
      // 某些浏览器不识别该权限名，会抛 TypeError
      return 'unsupported';
    }
  }

  /**
   * 申请权限。必须由真实用户交互触发（transient activation）。
   * 返回 'granted' | 'denied'；非交互调用时抛出带 reason 的错误。
   */
  async requestPermission() {
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      const err = new Error('权限申请必须由用户交互触发（如点击按钮）。');
      err.reason = 'no-user-gesture';
      throw err;
    }
    const result = await IdleDetector.requestPermission();
    return result; // 'granted' | 'denied'
  }

  /** 启动监听。优先使用原生 API，不可用时降级到事件检测。 */
  async start({ threshold } = {}) {
    this.stop();
    const caps = IdleMonitor.capabilities();
    this.threshold = Math.max(1_000, threshold ?? 60_000);

    document.addEventListener('visibilitychange', this._onVisibility);
    this._running = true;

    if (caps.secureContext && caps.apiSupported) {
      // 原生模式：API 强制 threshold >= 60_000
      const nativeThreshold = Math.max(60_000, this.threshold);
      try {
        this._abort = new AbortController();
        this._detector = new IdleDetector();
        this._detector.addEventListener('change', () => {
          this._commitWithSmoothing({
            userState: this._detector.userState,       // 'active' | 'idle'
            screenState: this._detector.screenState,   // 'locked' | 'unlocked'
          });
        });
        await this._detector.start({ threshold: nativeThreshold, signal: this._abort.signal });
        this.mode = 'native';
        this._commitImmediate({
          userState: this._detector.userState ?? 'active',
          screenState: this._detector.screenState ?? 'unlocked',
        });
        return this.mode;
      } catch (err) {
        // 权限被拒 / 其它启动失败 → 抛出，由调用方决定是否降级
        this._cleanupNative();
        throw err;
      }
    }

    // 降级模式：基于 DOM 事件的活跃检测
    this.mode = 'fallback';
    this.screenState = 'unknown'; // 降级模式无法感知锁屏
    for (const type of FALLBACK_ACTIVITY_EVENTS) {
      window.addEventListener(type, this._onActivity, { passive: true, capture: true });
    }
    this._armFallbackTimer();
    this._commitImmediate({ userState: 'active', screenState: 'unknown' });
    return this.mode;
  }

  stop() {
    this._running = false;
    this._cleanupNative();
    this._cleanupFallback();
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._clearPending();
    this.mode = null;
  }

  get running() {
    return this._running;
  }

  /* ---------- 内部实现 ---------- */

  _cleanupNative() {
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
    this._detector = null;
  }

  _cleanupFallback() {
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    for (const type of FALLBACK_ACTIVITY_EVENTS) {
      window.removeEventListener(type, this._onActivity, { capture: true });
    }
  }

  _armFallbackTimer() {
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    this._fallbackTimer = setTimeout(() => {
      this._commitWithSmoothing({ userState: 'idle', screenState: 'unknown' });
    }, this.threshold);
  }

  _onActivity() {
    if (!this._running || this.mode !== 'fallback') return;
    this._armFallbackTimer();
    if (this.userState !== 'active') {
      this._commitWithSmoothing({ userState: 'active', screenState: 'unknown' });
    }
  }

  _onVisibility() {
    this._emit('visibility', { hidden: document.hidden, at: Date.now() });
  }

  /**
   * 立即提交（用于启动时的初始状态，不做平滑）。
   */
  _commitImmediate(next) {
    this._clearPending();
    this.userState = next.userState;
    this.screenState = next.screenState;
    this._emit('statechange', {
      userState: this.userState,
      screenState: this.screenState,
      mode: this.mode,
      at: Date.now(),
    });
  }

  /**
   * 抖动平滑：候选状态与当前状态不同才计时；
   * 候选状态稳定 STABLE_MS 后才真正提交，期间若变回旧状态则取消。
   */
  _commitWithSmoothing(next) {
    const same =
      next.userState === this.userState && next.screenState === this.screenState;

    if (same) {
      this._clearPending();
      return;
    }

    const pendingSame =
      this._pendingState &&
      this._pendingState.userState === next.userState &&
      this._pendingState.screenState === next.screenState;

    if (pendingSame) return; // 已在等待该状态稳定

    this._clearPending();
    this._pendingState = next;
    this._pendingTimer = setTimeout(() => {
      const committed = this._pendingState;
      this._clearPending();
      this.userState = committed.userState;
      this.screenState = committed.screenState;
      this._emit('statechange', {
        userState: this.userState,
        screenState: this.screenState,
        mode: this.mode,
        at: Date.now(),
      });
    }, STABLE_MS);
  }

  _clearPending() {
    if (this._pendingTimer) clearTimeout(this._pendingTimer);
    this._pendingTimer = null;
    this._pendingState = null;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
