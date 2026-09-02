// Runs on the audio rendering thread. Copies each 128-frame render quantum
// from the mic input and posts it to the main thread as raw Float32 PCM.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      // Must copy — the engine reuses/clears the underlying buffer after process() returns.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
