// Turns the mic (44.1/48 kHz) into 16 kHz frames of 512 samples for the captioner.
// Each output sample is the average of the input samples it covers (cheap anti-alias).
const OUT_RATE = 16000;
const FRAME = 512;

class Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Float32Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      if (++this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      this.frame[this.n++] = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      if (this.n === FRAME) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("downsampler", Downsampler);
