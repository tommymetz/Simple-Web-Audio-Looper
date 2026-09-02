// Runs on the audio rendering thread. Only captures while explicitly told to
// (via 'start'/'stop' messages), so idle/playback/crop periods don't spam the
// main thread with a postMessage on every 128-frame render quantum — that
// constant cross-thread traffic is costly on lower-power devices. Batches
// several quanta together before posting, cutting message frequency further,
// and acknowledges 'stop' only after flushing everything buffered, so the
// caller can wait for it instead of racing a possible message backlog.

const FLUSH_SAMPLES = 2048; // ~43ms at 48kHz per postMessage while recording

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.pending = [];
    this.pendingLength = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.recording = true;
        this.pending = [];
        this.pendingLength = 0;
      } else if (event.data === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage('stopped');
      }
    };
  }

  flush() {
    if (this.pendingLength === 0) return;
    const combined = new Float32Array(this.pendingLength);
    let offset = 0;
    for (const chunk of this.pending) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.pendingLength = 0;
    this.port.postMessage(combined);
  }

  process(inputs) {
    if (!this.recording) return true;
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // Must copy — the engine reuses/clears the underlying buffer after process() returns.
      this.pending.push(channel.slice());
      this.pendingLength += channel.length;
      if (this.pendingLength >= FLUSH_SAMPLES) {
        this.flush();
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
