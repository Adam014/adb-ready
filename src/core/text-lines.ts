export class TextLineBuffer {
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });
  readonly #onLine: (line: string) => void;
  #pending = "";

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(chunk: Uint8Array): void {
    this.#consume(this.#decoder.decode(chunk, { stream: true }));
  }

  flush(): void {
    this.#consume(this.#decoder.decode());
    if (this.#pending !== "") {
      this.#onLine(this.#pending.replace(/\r$/u, ""));
      this.#pending = "";
    }
  }

  #consume(text: string): void {
    this.#pending += text;
    while (true) {
      const newline = this.#pending.indexOf("\n");
      if (newline < 0) return;
      const line = this.#pending.slice(0, newline).replace(/\r$/u, "");
      this.#pending = this.#pending.slice(newline + 1);
      this.#onLine(line);
    }
  }
}
