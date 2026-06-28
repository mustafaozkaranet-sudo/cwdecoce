# SDR-01 // Web Audio Morse Decoder — PRD

## Original problem statement
Web audio api based morse decoder. Threshold and pitch adjustable. FFT spectrum is included.

## User choices (Dec 2025)
- Input: microphone AND file upload
- Extras: waveform visualization + WPM display + copy-to-clipboard
- Theme: dark lab/oscilloscope (green/amber on near-black)

## Architecture
- Frontend-only React app (no backend, no DB, no auth)
- Web Audio API: AudioContext + AnalyserNode (FFT 2048, smoothing 0.6)
- Narrow-band detection: average of bins ±~40 Hz around target pitch from `getByteFrequencyData`
- State machine: edge detection on (level > threshold); classifies tone/silence durations into ./-, letter and word gaps
- Auto unit calibration from rolling average of last 8 dot durations → WPM = 1200 / unitMs

## Core requirements (static)
- Mic capture (start/stop) + file upload (.wav/.mp3) with play/stop
- Adjustable target pitch (200–1500 Hz) and threshold (20–255)
- Live FFT spectrum + time-domain waveform canvases
- Live decoded text, current symbol indicator, WPM + unit readouts
- Copy decoded text to clipboard, Clear stream

## What's been implemented (2025-12)
- Single-page SDR terminal UI (JetBrains Mono + IBM Plex Sans, phosphor green + amber)
- MorseDecoder component with full Web Audio pipeline, two canvases, sliders, tabs, badges
- Drag-and-drop / file picker for audio files, AudioBufferSource playback
- Scanline overlay on canvases, sharp-edged shadcn Slider/Button/Tabs/Badge overrides
- Sonner toast notifications for capture, file load, copy, errors

## Backlog
- P1: Text → Morse encoder + WebAudio oscillator playback (key/buzzer)
- P1: Morse code reference chart panel
- P2: Goertzel filter (instead of broadband FFT bins) for sharper narrow-band detection
- P2: Auto pitch lock (find peak bin, snap pitch slider)
- P2: Save decoded session to .txt / share link
- P3: Multi-band decoding (decode several pitches simultaneously)

## Next actions
- Optional: add text-to-morse playback + reference chart for hams
- Optional: tighten detection with Goertzel filter for clearer signals under noise
