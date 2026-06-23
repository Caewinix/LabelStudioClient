export class LineAccumulator {
  private buffer = Buffer.alloc(0);

  append(data: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const lines: string[] = [];
    for (;;) {
      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex < 0) break;
      const lineData = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      lines.push(lineData.toString('utf8'));
    }
    return lines;
  }
}
