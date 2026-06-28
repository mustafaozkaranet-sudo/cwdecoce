import { useEffect, useRef, useState, useCallback } from "react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Activity,
  Mic,
  MicOff,
  Upload,
  Copy,
  Radio,
  Trash2,
  Play,
  Pause,
  Square,
} from "lucide-react";
import { decodeMorseSymbol } from "@/lib/morse";

const FFT_SIZE = 2048;
const SMOOTHING = 0.8;

export default function MorseDecoder() {
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState("mic"); // 'mic' | 'file'
  const [pitch, setPitch] = useState(700); // Hz
  const [threshold, setThreshold] = useState(140); // 0-255
  const [wpm, setWpm] = useState(0);
  const [unitMs, setUnitMs] = useState(80);
  const [autoUnit, setAutoUnit] = useState(true);
  const [signalLevel, setSignalLevel] = useState(0);
  const [signalOn, setSignalOn] = useState(false);
  const [decoded, setDecoded] = useState("");
  const [currentSymbol, setCurrentSymbol] = useState("");
  const [audioFileName, setAudioFileName] = useState("");
  const [filePlaying, setFilePlaying] = useState(false);

  // Refs that need not retrigger renders
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null); // raw broadband analyser (for FFT/wave display)
  const detectorRef = useRef(null); // post-filter analyser (for tone detection)
  const filterRef = useRef(null); // BiquadFilterNode (bandpass)
  const micStreamRef = useRef(null);
  const micSourceRef = useRef(null);
  const fileSourceRef = useRef(null); // AudioBufferSourceNode
  const audioBufferRef = useRef(null);
  const filePlayingRef = useRef(false);
  const fileStartTimeRef = useRef(0);

  const fftCanvasRef = useRef(null);
  const waveCanvasRef = useRef(null);
  const rafRef = useRef(null);

  // Morse state
  const stateRef = useRef({
    isOn: false,
    lastEdgeAt: 0,
    pendingSilenceFromEdge: 0,
    currentSymbol: "",
    dotDurations: [],
    pendingSpace: false,
    // Debouncer / Schmitt trigger state
    pendingState: false,
    pendingSince: 0,
  });

  const pitchRef = useRef(pitch);
  const thresholdRef = useRef(threshold);
  const unitRef = useRef(unitMs);
  const autoUnitRef = useRef(autoUnit);

  useEffect(() => {
    pitchRef.current = pitch;
    if (filterRef.current && audioCtxRef.current) {
      try {
        filterRef.current.frequency.setTargetAtTime(pitch, audioCtxRef.current.currentTime, 0.01);
      } catch (e) { /* ignore */ }
    }
  }, [pitch]);
  useEffect(() => { thresholdRef.current = threshold; }, [threshold]);
  useEffect(() => { unitRef.current = unitMs; }, [unitMs]);
  useEffect(() => { autoUnitRef.current = autoUnit; }, [autoUnit]);

  const ensureAudioCtx = useCallback(async () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    if (!analyserRef.current) {
      const a = audioCtxRef.current.createAnalyser();
      a.fftSize = FFT_SIZE;
      a.smoothingTimeConstant = SMOOTHING;
      analyserRef.current = a;
    }
    if (!detectorRef.current) {
      const d = audioCtxRef.current.createAnalyser();
      d.fftSize = 1024;
      d.smoothingTimeConstant = 0.1;
      detectorRef.current = d;
    }
    if (!filterRef.current) {
      const f = audioCtxRef.current.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = pitchRef.current;
      f.Q.value = 20;
      f.connect(detectorRef.current);
      filterRef.current = f;
    } else {
      filterRef.current.frequency.value = pitchRef.current;
    }
    return audioCtxRef.current;
  }, []);

  const flushSymbol = useCallback(() => {
    const st = stateRef.current;
    if (st.currentSymbol) {
      const ch = decodeMorseSymbol(st.currentSymbol);
      setDecoded((prev) => prev + ch);
      st.currentSymbol = "";
      setCurrentSymbol("");
    }
  }, []);

  const addSpace = useCallback(() => {
    setDecoded((prev) => (prev.endsWith(" ") || prev === "" ? prev : prev + " "));
  }, []);

  const processEdge = useCallback((newState, now) => {
    const st = stateRef.current;
    const dur = now - st.lastEdgeAt;
    const unit = unitRef.current;

    if (st.lastEdgeAt === 0) {
      st.lastEdgeAt = now;
      st.isOn = newState;
      return;
    }

    if (st.isOn && !newState) {
      // tone just ended -> classify dot or dash
      const isDot = dur < 2 * unit;
      st.currentSymbol += isDot ? "." : "-";
      setCurrentSymbol(st.currentSymbol);
      if (autoUnitRef.current) {
        // Both dots and dashes contribute (dash ≈ 3 units)
        const sampleUnit = isDot ? dur : dur / 3;
        // Tight outlier rejection: samples must be within 0.5×–2× of the current unit.
        // Prevents fused or choppy tones from drifting the unit up to the ceiling.
        const tooLong = sampleUnit > 2 * unit;
        const tooShort = sampleUnit < unit / 2;
        if (!tooLong && !tooShort) {
          st.dotDurations.push(sampleUnit);
          if (st.dotDurations.length > 10) st.dotDurations.shift();
          // Bootstrap: don't apply unit update until ≥2 consistent samples accumulated
          if (st.dotDurations.length >= 2) {
            const avg = st.dotDurations.reduce((a, b) => a + b, 0) / st.dotDurations.length;
            const clamped = Math.max(30, Math.min(300, Math.round(avg)));
            setUnitMs(clamped);
            unitRef.current = clamped;
            setWpm(Math.round(1200 / clamped));
          }
        }
      }
    } else if (!st.isOn && newState) {
      // silence just ended -> classify gap
      if (dur > 5 * unit) {
        flushSymbol();
        addSpace();
      } else if (dur > 2 * unit) {
        flushSymbol();
      }
      // else intra-symbol gap, ignore
    }

    st.isOn = newState;
    st.lastEdgeAt = now;
  }, [flushSymbol, addSpace]);

  const checkTrailingTimeout = useCallback((now) => {
    const st = stateRef.current;
    if (st.isOn) return;
    if (st.lastEdgeAt === 0) return;
    const gap = now - st.lastEdgeAt;
    const unit = unitRef.current;
    if (st.currentSymbol && gap > 2 * unit) {
      flushSymbol();
    }
    if (gap > 7 * unit) {
      addSpace();
      st.lastEdgeAt = now; // prevent repeated spaces
    }
  }, [flushSymbol, addSpace]);

  const renderLoop = useCallback(() => {
    const analyser = analyserRef.current;
    const detector = detectorRef.current;
    const ctx = audioCtxRef.current;
    if (!analyser || !detector || !ctx) return;

    const bufLen = analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufLen);
    const timeData = new Uint8Array(bufLen);
    const detBufLen = detector.frequencyBinCount;
    const detFreqData = new Uint8Array(detBufLen);

    const fftCanvas = fftCanvasRef.current;
    const waveCanvas = waveCanvasRef.current;

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);
      detector.getByteFrequencyData(detFreqData);

      const sampleRate = ctx.sampleRate;
      const targetHz = pitchRef.current;
      const bin = Math.round((targetHz / (sampleRate / 2)) * bufLen);
      // Visual highlight band on the broadband display (~80 Hz wide)
      const halfWidth = Math.max(2, Math.round((80 / (sampleRate / 2)) * bufLen / 2));

      // Detection level: peak of the bandpass-filtered spectrum near targetHz
      const detBin = Math.round((targetHz / (sampleRate / 2)) * detBufLen);
      const detHW = Math.max(1, Math.round((40 / (sampleRate / 2)) * detBufLen));
      let peak = 0;
      for (let i = Math.max(0, detBin - detHW); i <= Math.min(detBufLen - 1, detBin + detHW); i++) {
        if (detFreqData[i] > peak) peak = detFreqData[i];
      }
      const level = peak;
      setSignalLevel(level);

      const thr = thresholdRef.current;
      // Schmitt-trigger hysteresis: widen the on/off thresholds.
      // Absolute floor — any level below NOISE_FLOOR is treated as silence regardless
      // of the user-set threshold, to reject bandpass-rejected leakage from off-pitch tones.
      const st = stateRef.current;
      const HYST = Math.max(4, thr * 0.08);
      const NOISE_FLOOR = 35;
      const rawOn = level >= NOISE_FLOOR && (st.isOn
        ? level > thr - HYST
        : level > thr + HYST);
      setSignalOn(rawOn);

      const nowMs = performance.now();
      // Debounce: only commit a transition after MIN_EDGE_MS of stable opposite state
      const MIN_EDGE_MS = 12;
      if (rawOn !== st.isOn) {
        if (st.pendingState !== rawOn) {
          st.pendingState = rawOn;
          st.pendingSince = nowMs;
        } else if (nowMs - st.pendingSince >= MIN_EDGE_MS) {
          processEdge(rawOn, nowMs);
          st.pendingState = rawOn;
        }
      } else {
        st.pendingState = rawOn;
        checkTrailingTimeout(nowMs);
      }
      const isOn = st.isOn;

      // Draw FFT
      if (fftCanvas) {
        const w = fftCanvas.width;
        const h = fftCanvas.height;
        const c = fftCanvas.getContext("2d");
        c.fillStyle = "rgba(0,0,0,0.35)";
        c.fillRect(0, 0, w, h);

        // Frequency grid lines
        c.strokeStyle = "rgba(0,255,102,0.08)";
        c.lineWidth = 1;
        for (let f = 0; f < 4000; f += 500) {
          const x = (f / (sampleRate / 2)) * w;
          c.beginPath();
          c.moveTo(x, 0);
          c.lineTo(x, h);
          c.stroke();
        }

        // Spectrum bars (only up to ~4kHz for relevance)
        const maxBin = Math.min(bufLen, Math.round((4000 / (sampleRate / 2)) * bufLen));
        const barW = w / maxBin;
        for (let i = 0; i < maxBin; i++) {
          const v = freqData[i] / 255;
          const barH = v * h;
          c.fillStyle = i >= bin - halfWidth && i <= bin + halfWidth
            ? "rgba(255,176,0,0.95)"
            : "rgba(0,255,102,0.75)";
          c.fillRect(i * barW, h - barH, Math.max(1, barW - 0.5), barH);
        }

        // Target pitch marker
        const px = (targetHz / (sampleRate / 2)) * w;
        c.strokeStyle = "#FFB000";
        c.lineWidth = 1;
        c.setLineDash([4, 4]);
        c.beginPath();
        c.moveTo(px, 0);
        c.lineTo(px, h);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = "#FFB000";
        c.font = "10px JetBrains Mono, monospace";
        c.fillText(`${targetHz} Hz`, Math.min(w - 60, px + 4), 12);

        // Threshold horizontal line (mapped to bar height)
        const ty = h - (thr / 255) * h;
        c.strokeStyle = "rgba(255,176,0,0.6)";
        c.setLineDash([2, 6]);
        c.beginPath();
        c.moveTo(0, ty);
        c.lineTo(w, ty);
        c.stroke();
        c.setLineDash([]);
      }

      // Draw Waveform
      if (waveCanvas) {
        const w = waveCanvas.width;
        const h = waveCanvas.height;
        const c = waveCanvas.getContext("2d");
        c.fillStyle = "rgba(0,0,0,0.4)";
        c.fillRect(0, 0, w, h);

        // Grid
        c.strokeStyle = "rgba(0,255,102,0.06)";
        c.lineWidth = 1;
        for (let i = 0; i < 10; i++) {
          const x = (i / 10) * w;
          c.beginPath();
          c.moveTo(x, 0);
          c.lineTo(x, h);
          c.stroke();
        }
        c.beginPath();
        c.moveTo(0, h / 2);
        c.lineTo(w, h / 2);
        c.stroke();

        // Waveform stroke
        c.strokeStyle = isOn ? "#FFB000" : "#00FF66";
        c.shadowBlur = 8;
        c.shadowColor = isOn ? "#FFB000" : "#00FF66";
        c.lineWidth = 1.5;
        c.beginPath();
        const slice = w / bufLen;
        for (let i = 0; i < bufLen; i++) {
          const v = timeData[i] / 128.0;
          const y = (v * h) / 2;
          const x = i * slice;
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
        c.shadowBlur = 0;
      }
    };
    draw();
  }, [processEdge, checkTrailingTimeout]);

  const startMic = useCallback(async () => {
    try {
      await ensureAudioCtx();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      micStreamRef.current = stream;
      const src = audioCtxRef.current.createMediaStreamSource(stream);
      src.connect(analyserRef.current);
      src.connect(filterRef.current);
      micSourceRef.current = src;
      setRunning(true);
      if (autoUnitRef.current) {
        setUnitMs(80);
        unitRef.current = 80;
        setWpm(0);
      }
      stateRef.current = {
        isOn: false,
        lastEdgeAt: 0,
        currentSymbol: "",
        dotDurations: [],
        pendingState: false,
        pendingSince: 0,
      };
      renderLoop();
      toast.success("Microphone capture started");
    } catch (e) {
      console.error(e);
      toast.error("Microphone access denied or unavailable");
    }
  }, [ensureAudioCtx, renderLoop]);

  const stopAll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (micSourceRef.current) {
      try { micSourceRef.current.disconnect(); } catch (e) { /* ignore disconnect errors */ }
      micSourceRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (fileSourceRef.current) {
      try { fileSourceRef.current.stop(); } catch (e) { /* ignore stop errors */ }
      try { fileSourceRef.current.disconnect(); } catch (e) { /* ignore disconnect errors */ }
      fileSourceRef.current = null;
    }
    filePlayingRef.current = false;
    setFilePlaying(false);
    setRunning(false);
    setSignalOn(false);
  }, []);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    await ensureAudioCtx();
    const arrBuf = await file.arrayBuffer();
    try {
      const decoded = await audioCtxRef.current.decodeAudioData(arrBuf);
      audioBufferRef.current = decoded;
      setAudioFileName(file.name);
      toast.success(`Loaded ${file.name}`);
    } catch (e) {
      console.error(e);
      toast.error("Could not decode audio file");
    }
  }, [ensureAudioCtx]);

  const playFile = useCallback(async () => {
    if (!audioBufferRef.current) {
      toast.error("Load an audio file first");
      return;
    }
    await ensureAudioCtx();
    if (fileSourceRef.current) {
      try { fileSourceRef.current.stop(); } catch (e) { /* ignore stop errors */ }
      try { fileSourceRef.current.disconnect(); } catch (e) { /* ignore disconnect errors */ }
    }
    const src = audioCtxRef.current.createBufferSource();
    src.buffer = audioBufferRef.current;
    src.connect(analyserRef.current);
    src.connect(filterRef.current);
    src.connect(audioCtxRef.current.destination);
    src.onended = () => {
      filePlayingRef.current = false;
      setFilePlaying(false);
    };
    src.start();
    fileSourceRef.current = src;
    filePlayingRef.current = true;
    setFilePlaying(true);
    setRunning(true);
    if (autoUnitRef.current) {
      setUnitMs(80);
      unitRef.current = 80;
      setWpm(0);
    }
    stateRef.current = {
      isOn: false,
      lastEdgeAt: 0,
      currentSymbol: "",
      dotDurations: [],
      pendingState: false,
      pendingSince: 0,
    };
    renderLoop();
  }, [ensureAudioCtx, renderLoop]);

  const onDropFile = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const onPickFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const copyDecoded = useCallback(async () => {
    if (!decoded) {
      toast.error("Nothing to copy yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(decoded);
      toast.success("Copied decoded text");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }, [decoded]);

  const clearAll = useCallback(() => {
    setDecoded("");
    setCurrentSymbol("");
    setUnitMs(80);
    unitRef.current = 80;
    setWpm(0);
    stateRef.current = {
      isOn: false,
      lastEdgeAt: 0,
      currentSymbol: "",
      dotDurations: [],
      pendingState: false,
      pendingSince: 0,
    };
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  // Resize canvases to their containers (devicePixelRatio aware)
  useEffect(() => {
    const resize = () => {
      [fftCanvasRef.current, waveCanvasRef.current].forEach((cv) => {
        if (!cv) return;
        const rect = cv.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cv.width = Math.max(1, Math.floor(rect.width * dpr));
        cv.height = Math.max(1, Math.floor(rect.height * dpr));
        const ctx = cv.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cv.width = Math.floor(rect.width);
        cv.height = Math.floor(rect.height);
      });
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return (
    <div className="min-h-screen bg-[#050505] text-[#00FF66] font-[IBM_Plex_Sans,sans-serif]">
      {/* Header */}
      <header className="border-b border-[#1A3324] px-4 md:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Radio className="h-5 w-5 text-[#00FF66]" />
          <div className="flex items-baseline gap-3">
            <span className="font-[JetBrains_Mono,monospace] text-lg font-bold tracking-tight">
              SDR-01
            </span>
            <span className="text-[10px] tracking-[0.3em] uppercase text-[#80B399]">
              Morse Decoder // Web Audio
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            data-testid="signal-status-badge"
            className={`rounded-none border ${signalOn ? "bg-[#FFB000] text-black border-[#FFB000]" : "bg-transparent text-[#80B399] border-[#1A3324]"} font-[JetBrains_Mono,monospace] text-[10px] tracking-[0.2em] uppercase px-2`}
          >
            {signalOn ? "● TONE LOCK" : "○ NO LOCK"}
          </Badge>
          <Badge
            data-testid="capture-status-badge"
            className={`rounded-none border ${running ? "bg-[#00FF66] text-black border-[#00FF66]" : "bg-transparent text-[#80B399] border-[#1A3324]"} font-[JetBrains_Mono,monospace] text-[10px] tracking-[0.2em] uppercase px-2`}
          >
            {running ? "● LIVE" : "○ IDLE"}
          </Badge>
        </div>
      </header>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 p-2 md:p-4">
        {/* Visualizers */}
        <div className="col-span-1 lg:col-span-8 flex flex-col gap-2">
          {/* FFT */}
          <div className="border border-[#1A3324] bg-black relative">
            <div className="absolute top-2 left-3 z-10 text-[10px] tracking-[0.3em] uppercase text-[#80B399] flex items-center gap-2">
              <Activity className="h-3 w-3" /> FFT Spectrum
            </div>
            <div className="absolute top-2 right-3 z-10 font-[JetBrains_Mono,monospace] text-[10px] text-[#FFB000] tracking-widest">
              {Math.round(signalLevel)} / 255
            </div>
            <canvas
              ref={fftCanvasRef}
              data-testid="fft-canvas"
              className="w-full h-[220px] md:h-[260px] block"
            />
            <div className="pointer-events-none absolute inset-0 scanlines" />
          </div>

          {/* Waveform */}
          <div className="border border-[#1A3324] bg-black relative">
            <div className="absolute top-2 left-3 z-10 text-[10px] tracking-[0.3em] uppercase text-[#80B399] flex items-center gap-2">
              <Activity className="h-3 w-3" /> Waveform
            </div>
            <canvas
              ref={waveCanvasRef}
              data-testid="wave-canvas"
              className="w-full h-[140px] md:h-[180px] block"
            />
            <div className="pointer-events-none absolute inset-0 scanlines" />
          </div>
        </div>

        {/* Controls */}
        <aside className="col-span-1 lg:col-span-4 border border-[#1A3324] bg-[#0A0A0A] p-4 flex flex-col gap-5">
          <Tabs value={source} onValueChange={(v) => { stopAll(); setSource(v); }} className="w-full">
            <TabsList className="w-full grid grid-cols-2 rounded-none bg-[#050505] p-0 h-9 border border-[#1A3324]">
              <TabsTrigger
                value="mic"
                data-testid="tab-mic"
                className="rounded-none data-[state=active]:bg-[#00FF66] data-[state=active]:text-black text-[#80B399] font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-[10px]"
              >
                <Mic className="h-3 w-3 mr-1" /> Mic
              </TabsTrigger>
              <TabsTrigger
                value="file"
                data-testid="tab-file"
                className="rounded-none data-[state=active]:bg-[#00FF66] data-[state=active]:text-black text-[#80B399] font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-[10px]"
              >
                <Upload className="h-3 w-3 mr-1" /> File
              </TabsTrigger>
            </TabsList>

            <TabsContent value="mic" className="mt-4">
              <div className="flex gap-2">
                {!running ? (
                  <Button
                    data-testid="mic-start-btn"
                    onClick={startMic}
                    className="rounded-none bg-[#00FF66] text-black hover:bg-[#FFB000] hover:text-black font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-xs flex-1"
                  >
                    <Mic className="h-4 w-4 mr-2" /> Start Capture
                  </Button>
                ) : (
                  <Button
                    data-testid="mic-stop-btn"
                    onClick={stopAll}
                    className="rounded-none bg-[#FFB000] text-black hover:bg-[#00FF66] font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-xs flex-1"
                  >
                    <MicOff className="h-4 w-4 mr-2" /> Stop
                  </Button>
                )}
              </div>
            </TabsContent>

            <TabsContent value="file" className="mt-4">
              <label
                htmlFor="audio-file-input"
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDropFile}
                className="block border border-dashed border-[#1A3324] hover:border-[#00FF66] transition-colors p-3 cursor-pointer text-center"
                data-testid="file-drop-zone"
              >
                <Upload className="h-4 w-4 inline mr-2 text-[#80B399]" />
                <span className="text-[11px] tracking-[0.2em] uppercase text-[#80B399]">
                  {audioFileName || "Drop / Pick .wav .mp3"}
                </span>
                <input
                  id="audio-file-input"
                  data-testid="file-input"
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={onPickFile}
                />
              </label>
              <div className="flex gap-2 mt-3">
                {!filePlaying ? (
                  <Button
                    data-testid="file-play-btn"
                    onClick={playFile}
                    disabled={!audioFileName}
                    className="rounded-none bg-[#00FF66] text-black hover:bg-[#FFB000] disabled:opacity-40 font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-xs flex-1"
                  >
                    <Play className="h-4 w-4 mr-2" /> Play
                  </Button>
                ) : (
                  <Button
                    data-testid="file-stop-btn"
                    onClick={stopAll}
                    className="rounded-none bg-[#FFB000] text-black hover:bg-[#00FF66] font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-xs flex-1"
                  >
                    <Square className="h-4 w-4 mr-2" /> Stop
                  </Button>
                )}
              </div>
            </TabsContent>
          </Tabs>

          {/* Pitch */}
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-[10px] tracking-[0.3em] uppercase text-[#80B399]">
                Target Pitch
              </label>
              <span data-testid="pitch-readout" className="font-[JetBrains_Mono,monospace] text-[#00FF66] text-sm">
                {pitch} Hz
              </span>
            </div>
            <Slider
              data-testid="pitch-slider"
              min={200}
              max={1500}
              step={10}
              value={[pitch]}
              onValueChange={([v]) => setPitch(v)}
              className="[&_[role=slider]]:rounded-none [&_[role=slider]]:bg-[#00FF66] [&_[role=slider]]:border-[#00FF66] [&_[role=slider]]:h-4 [&_[role=slider]]:w-3 [&>span:first-child]:bg-[#1A3324] [&>span:first-child>span]:bg-[#00FF66]"
            />
          </div>

          {/* Threshold */}
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-[10px] tracking-[0.3em] uppercase text-[#80B399]">
                Threshold
              </label>
              <span data-testid="threshold-readout" className="font-[JetBrains_Mono,monospace] text-[#FFB000] text-sm">
                {threshold}
              </span>
            </div>
            <Slider
              data-testid="threshold-slider"
              min={20}
              max={250}
              step={1}
              value={[threshold]}
              onValueChange={([v]) => setThreshold(v)}
              className="[&_[role=slider]]:rounded-none [&_[role=slider]]:bg-[#FFB000] [&_[role=slider]]:border-[#FFB000] [&_[role=slider]]:h-4 [&_[role=slider]]:w-3 [&>span:first-child]:bg-[#1A3324] [&>span:first-child>span]:bg-[#FFB000]"
            />
            <div className="mt-1 h-1 bg-[#1A3324] relative">
              <div
                data-testid="level-bar"
                className="absolute inset-y-0 left-0 transition-[width] duration-75"
                style={{
                  width: `${Math.min(100, (signalLevel / 255) * 100)}%`,
                  background: signalOn ? "#FFB000" : "#00FF66",
                }}
              />
              <div
                className="absolute inset-y-0 w-px bg-[#FFB000]"
                style={{ left: `${(threshold / 255) * 100}%` }}
              />
            </div>
          </div>

          {/* Unit / WPM */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="border border-[#1A3324] p-2">
              <div className="text-[9px] tracking-[0.25em] uppercase text-[#80B399]">WPM</div>
              <div data-testid="wpm-readout" className="font-[JetBrains_Mono,monospace] text-2xl text-[#FFB000] tracking-wider">
                {wpm || "—"}
              </div>
            </div>
            <div className="border border-[#1A3324] p-2">
              <div className="text-[9px] tracking-[0.25em] uppercase text-[#80B399]">Unit (ms)</div>
              <div data-testid="unit-readout" className="font-[JetBrains_Mono,monospace] text-2xl text-[#00FF66] tracking-wider">
                {unitMs}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between text-[10px] tracking-[0.25em] uppercase text-[#80B399]">
            <button
              data-testid="auto-unit-toggle"
              onClick={() => setAutoUnit((v) => !v)}
              className={`px-2 py-1 border ${autoUnit ? "border-[#00FF66] text-[#00FF66]" : "border-[#1A3324] text-[#80B399]"} hover:border-[#00FF66] hover:text-[#00FF66] transition-colors`}
            >
              Auto unit: {autoUnit ? "ON" : "OFF"}
            </button>
            <Slider
              data-testid="manual-unit-slider"
              min={30}
              max={300}
              step={5}
              value={[unitMs]}
              onValueChange={([v]) => { setUnitMs(v); setWpm(Math.round(1200 / v)); }}
              disabled={autoUnit}
              className="flex-1 ml-3 [&_[role=slider]]:rounded-none [&_[role=slider]]:bg-[#00FF66] [&_[role=slider]]:border-[#00FF66] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&>span:first-child]:bg-[#1A3324] [&>span:first-child>span]:bg-[#00FF66] disabled:opacity-40"
            />
          </div>
        </aside>

        {/* Decoder output bottom */}
        <section className="col-span-1 lg:col-span-12 border border-[#1A3324] bg-[#0A0A0A] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <span className="text-[10px] tracking-[0.3em] uppercase text-[#80B399]">
                Decoded Stream
              </span>
              <span className="font-[JetBrains_Mono,monospace] text-[#FFB000] text-xs" data-testid="current-symbol">
                {currentSymbol || "·"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                data-testid="copy-clipboard-btn"
                onClick={copyDecoded}
                className="rounded-none bg-transparent border border-[#1A3324] text-[#00FF66] hover:bg-[#00FF66] hover:text-black h-8 px-3 font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-[10px]"
              >
                <Copy className="h-3 w-3 mr-1" /> Copy
              </Button>
              <Button
                data-testid="clear-btn"
                onClick={clearAll}
                className="rounded-none bg-transparent border border-[#1A3324] text-[#FFB000] hover:bg-[#FFB000] hover:text-black h-8 px-3 font-[JetBrains_Mono,monospace] tracking-[0.2em] uppercase text-[10px]"
              >
                <Trash2 className="h-3 w-3 mr-1" /> Clear
              </Button>
            </div>
          </div>
          <div
            data-testid="decoded-text-output"
            className="font-[JetBrains_Mono,monospace] text-lg md:text-2xl text-[#00FF66] tracking-[0.15em] min-h-[80px] bg-black border border-[#1A3324] p-4 whitespace-pre-wrap break-words"
            style={{ textShadow: "0 0 6px rgba(0,255,102,0.55)" }}
          >
            {decoded}
            <span className="inline-block w-2 h-5 align-middle ml-1 bg-[#00FF66] animate-pulse" />
          </div>
          <div className="mt-2 text-[10px] tracking-[0.25em] uppercase text-[#334D40]">
            Intra-symbol gaps are ignored. Pause &gt; 3× unit = letter. Pause &gt; 7× unit = word.
          </div>
        </section>
      </div>

      <footer className="px-4 md:px-6 py-3 text-[10px] tracking-[0.3em] uppercase text-[#334D40] border-t border-[#1A3324]">
        SDR-01 // Web Audio API · AnalyserNode · FFT {FFT_SIZE}
      </footer>
    </div>
  );
}
