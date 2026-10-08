// 入力のサンプルレートに依存せず24kHzへ積分して変換する。
class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.position = 0; this.sum = 0; this.weight = 0; this.samples = []; this.energy = 0; this.count = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0]; if (!input) return true;
    const step = 24000 / sampleRate;
    for (const sample of input) {
      this.energy += sample * sample; this.count++;
      let rest = step;
      while (rest > 1e-10) {
        const part = Math.min(1 - this.position, rest);
        this.sum += sample * part; this.weight += part; this.position += part; rest -= part;
        if (this.position >= 1 - 1e-10) {
          this.samples.push(Math.max(-32768, Math.min(32767, Math.round(this.sum / this.weight * 32767))));
          this.position = 0; this.sum = 0; this.weight = 0;
          if (this.samples.length === 960) {
            const data = new Int16Array(this.samples);
            this.port.postMessage({ pcm: data.buffer, rms: Math.sqrt(this.energy / this.count) }, [data.buffer]);
            this.samples = []; this.energy = 0; this.count = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('waigaya-capture', Capture);
