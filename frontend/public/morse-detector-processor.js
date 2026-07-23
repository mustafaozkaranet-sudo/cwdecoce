// Time-domain envelope detector — runs on the audio thread for sample-accurate edges.
// Level is adaptively normalized; main thread can sync scale via FFT calibrate messages.

class MorseDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelope = 0;
    this.peakTrack = 0.0001;
    this.levelGain = 1;
    this.isOn = false;
    this.threshold = 140;
    this.noiseFloor = 25;
    this.pendingState = false;
    this.pendingSamples = 0;
    this.samplesSinceLevelPost = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "config") {
        if (data.threshold !== undefined) this.threshold = data.threshold;
        if (data.noiseFloor !== undefined) this.noiseFloor = data.noiseFloor;
        return;
      }
      if (data.type === "calibrate" && data.fftLevel > 30 && this.lastLevel > 5) {
        const target = data.fftLevel / this.lastLevel;
        this.levelGain = this.levelGain * 0.85 + target * 0.15;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    const sr = sampleRate;
    const minEdgeSamples = Math.max(1, Math.round(sr * 0.002));
    const levelPostInterval = Math.max(128, Math.round(sr * 0.025));
    const ATTACK = 0.7;
    const RELEASE = 0.18;

    for (let i = 0; i < input.length; i++) {
      const abs = Math.abs(input[i]);

      if (abs > this.peakTrack) this.peakTrack = abs;
      else this.peakTrack *= 0.9996;

      if (abs > this.envelope) {
        this.envelope = ATTACK * this.envelope + (1 - ATTACK) * abs;
      } else {
        this.envelope = RELEASE * this.envelope + (1 - RELEASE) * abs;
      }

      const norm = this.envelope / Math.max(this.peakTrack, 0.0004);
      const level = Math.min(255, Math.round(norm * 190 * this.levelGain));
      this.lastLevel = level;

      const thr = this.threshold;
      const hystOn = Math.max(3, thr * 0.05);
      const hystOff = Math.max(2, thr * 0.015);

      const rawOn = level >= this.noiseFloor && (this.isOn
        ? level > thr - hystOff
        : level > thr + hystOn);

      if (rawOn !== this.isOn) {
        if (this.pendingState !== rawOn) {
          this.pendingState = rawOn;
          this.pendingSamples = 1;
        } else {
          this.pendingSamples += 1;
          if (this.pendingSamples >= minEdgeSamples) {
            this.isOn = rawOn;
            this.pendingState = rawOn;
            this.pendingSamples = 0;
            const timeSec = (currentFrame + i) / sr;
            this.port.postMessage({ type: "edge", on: rawOn, timeSec });
          }
        }
      } else {
        this.pendingState = rawOn;
        this.pendingSamples = 0;
      }

      this.samplesSinceLevelPost += 1;
      if (this.samplesSinceLevelPost >= levelPostInterval) {
        this.samplesSinceLevelPost = 0;
        this.port.postMessage({ type: "level", level, isOn: this.isOn });
      }
    }

    const output = outputs[0] && outputs[0][0];
    if (output) output.fill(0);

    return true;
  }
}

registerProcessor("morse-detector-processor", MorseDetectorProcessor);
