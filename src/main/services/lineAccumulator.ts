export class LineAccumulator {
    private buffer = Buffer.alloc(0);

    append(data: Buffer): string[] {
        this.buffer = Buffer.concat([this.buffer, data]);
        const lines: string[] = [];
        for (; ;) {
            const lfIndex = this.buffer.indexOf(0x0a);
            const crIndex = this.buffer.indexOf(0x0d);
            const separators = [lfIndex, crIndex].filter((index) => index >= 0);
            if (separators.length === 0) break;

            const separatorIndex = Math.min(...separators);
            const separator = this.buffer[separatorIndex];
            const lineData = this.buffer.subarray(0, separatorIndex);
            const nextIndex = separator === 0x0d && this.buffer[separatorIndex + 1] === 0x0a
                ? separatorIndex + 2
                : separatorIndex + 1;
            this.buffer = this.buffer.subarray(nextIndex);
            if (lineData.length > 0) lines.push(lineData.toString('utf8'));
        }
        return lines;
    }
}
