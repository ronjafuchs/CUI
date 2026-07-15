// Active-time tracking.
//
// Rules: time counts only while the tab is visible, focused, not manually
// paused, and the user interacted within the idle timeout. Idle, hidden and
// paused time never enters active labeling time. Per-row time restarts each
// time a row is shown and is reported with the annotation.

export class ActivityTimer {
  constructor({ idleTimeoutS = 90, onStateChange = () => {} } = {}) {
    this.idleTimeoutMs = idleTimeoutS * 1000;
    this.onStateChange = onStateChange;
    this.manualPause = false;
    this.hidden = document.hidden;
    this.blurred = !document.hasFocus();
    this.idle = false;
    this.sessionMs = 0;
    this.rowMs = 0;
    this._last = performance.now();
    this._lastInput = performance.now();

    this._tick = this._tick.bind(this);
    this._interval = setInterval(this._tick, 1000);

    const input = () => {
      this._lastInput = performance.now();
      if (this.idle) { this._flush(); this.idle = false; this._emit(); }
    };
    for (const ev of ["keydown", "mousedown", "mousemove", "wheel", "touchstart"])
      window.addEventListener(ev, input, { passive: true });
    document.addEventListener("visibilitychange", () => {
      this._flush(); this.hidden = document.hidden; this._emit();
    });
    window.addEventListener("blur", () => { this._flush(); this.blurred = true; this._emit(); });
    window.addEventListener("focus", () => {
      this._flush(); this.blurred = false; this._lastInput = performance.now(); this._emit();
    });
  }

  get active() { return !this.manualPause && !this.hidden && !this.blurred && !this.idle; }
  get state() {
    if (this.manualPause) return "paused";
    if (this.hidden || this.blurred) return "background";
    if (this.idle) return "idle";
    return "active";
  }

  _emit() { this.onStateChange(this.state); }

  _flush() {
    const now = performance.now();
    if (this.active) {
      const dt = now - this._last;
      this.sessionMs += dt;
      this.rowMs += dt;
    }
    this._last = now;
  }

  _tick() {
    this._flush();
    if (!this.idle && !this.manualPause &&
        performance.now() - this._lastInput > this.idleTimeoutMs) {
      this.idle = true;
      this._emit();
    }
  }

  pause() { this._flush(); this.manualPause = true; this._emit(); }
  resume() {
    this._flush(); this.manualPause = false; this.idle = false;
    this._lastInput = performance.now(); this._emit();
  }
  togglePause() { this.manualPause ? this.resume() : this.pause(); }

  startRow() { this._flush(); this.rowMs = 0; }
  takeRowSeconds() { this._flush(); const s = this.rowMs / 1000; this.rowMs = 0; return s; }
  sessionSeconds() { this._flush(); return this.sessionMs / 1000; }

  destroy() { clearInterval(this._interval); }
}

export class SessionReporter {
  constructor(projectId, timer, api) {
    this.projectId = projectId;
    this.timer = timer;
    this.api = api;
    this.sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    api.session(projectId, { event: "start", session_id: this.sessionId }).catch(() => {});
    this._interval = setInterval(() => this.report(), 30000);
    this._onUnload = () => {
      const body = JSON.stringify({
        event: "end", session_id: this.sessionId,
        active_s: this.timer.sessionSeconds(),
      });
      navigator.sendBeacon(
        `/api/projects/${projectId}/session`,
        new Blob([body], { type: "application/json" })
      );
    };
    window.addEventListener("pagehide", this._onUnload);
  }
  report() {
    this.api.session(this.projectId, {
      event: "end", session_id: this.sessionId,
      active_s: this.timer.sessionSeconds(),
    }).catch(() => {});
  }
  destroy() {
    clearInterval(this._interval);
    window.removeEventListener("pagehide", this._onUnload);
    this.report();
  }
}
