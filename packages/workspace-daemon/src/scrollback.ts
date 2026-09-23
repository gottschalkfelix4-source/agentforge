/** Byte-capped ring buffer of output chunks. */
export class Scrollback {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap = 2 * 1024 * 1024) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.cap) {
      this.chunks = [chunk.subarray(chunk.length - this.cap)];
      this.size = this.cap;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap) {
      const first = this.chunks[0]!;
      const excess = this.size - this.cap;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
    // Keep the array from growing unboundedly with tiny chunks.
    if (this.chunks.length > 4096) this.chunks = [Buffer.concat(this.chunks)];
  }

  get length(): number {
    return this.size;
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}
