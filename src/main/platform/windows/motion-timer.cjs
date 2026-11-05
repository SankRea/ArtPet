let beginPeriod, endPeriod, active = false, unavailable = false;

function setMotionTimerResolution(enabled) {
  if (process.platform !== 'win32' || enabled === active || unavailable) return;
  try {
    if (!beginPeriod) {
      const winmm = require('koffi').load('winmm.dll');
      beginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 period)');
      endPeriod = winmm.func('uint32 __stdcall timeEndPeriod(uint32 period)');
    }
    // Node timers otherwise round a 33 ms wait up to roughly 46 ms on Windows.
    // Request precision only while moving, and balance every successful request.
    const result = (enabled ? beginPeriod : endPeriod)(1);
    if (result !== 0) throw new Error(`${enabled ? 'timeBeginPeriod' : 'timeEndPeriod'} 返回 ${result}`);
    active = enabled;
  } catch (error) {
    if (!active) unavailable = true;
    console.warn(`移动计时精度调整失败：${error.message}`);
  }
}

module.exports = { setMotionTimerResolution };
