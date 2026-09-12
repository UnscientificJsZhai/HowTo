import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";

export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/** 权限观察不受键盘解析、隐藏状态或组件生命周期影响。 */
export class PasteStartObserver {
  private suffix = Buffer.alloc(0);

  observe(chunk: Buffer): boolean {
    const combined = Buffer.concat([this.suffix, chunk]);
    const found = combined.includes(Buffer.from(PASTE_START));
    this.suffix = Buffer.from(combined.subarray(Math.max(0, combined.length - 5)));
    return found;
  }
}

/** 只交付完整的可见粘贴；按解码后的字符检查 C1，避免误拒绝 UTF-8 延续字节。 */
export class PasteFramingFilter {
  private active = false;
  private pending = "";
  private flushedPrefix = 0;
  private invalidPrefix = false;
  private collecting = false;
  private discardPaste = false;
  private paste = "";

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.invalidPrefix = true;
      if (this.collecting) {
        this.discardPaste = true;
        this.paste = "";
      }
    }
  }

  push(text: string): string {
    let output = "";
    for (const character of text) {
      if (this.pending === "" && !this.collecting) this.invalidPrefix = !this.active;
      this.pending += character;
      if (!this.active) this.invalidPrefix = true;
      if (this.collecting) {
        while (this.pending !== "" && !PASTE_END.startsWith(this.pending)) {
          if (!this.discardPaste) this.paste += this.pending[0];
          this.pending = this.pending.slice(1);
        }
        if (this.pending === PASTE_END) {
          if (
            this.active &&
            !this.discardPaste &&
            !hasUnsafeTerminalControlCharacters(this.paste)
          ) {
            output += PASTE_START + this.paste + PASTE_END;
          }
          this.collecting = false;
          this.paste = "";
          this.pending = "";
          this.invalidPrefix = false;
        }
        continue;
      }
      while (
        this.pending !== "" &&
        !PASTE_START.startsWith(this.pending) &&
        !PASTE_END.startsWith(this.pending)
      ) {
        if (this.flushedPrefix > 0) this.flushedPrefix--;
        else if (this.active && !this.invalidPrefix) output += this.pending[0];
        this.pending = this.pending.slice(1);
        if (this.pending === "") this.invalidPrefix = !this.active;
      }
      if (this.pending === PASTE_START) {
        this.collecting = true;
        this.discardPaste = !this.active || this.invalidPrefix || this.flushedPrefix > 0;
        this.pending = "";
        this.flushedPrefix = 0;
        this.paste = "";
      } else if (this.pending === PASTE_END) {
        // 孤立的协议结束标记不作为表单文字交付。
        this.pending = "";
        this.flushedPrefix = 0;
        this.invalidPrefix = false;
      }
    }
    return output;
  }

  hasPendingKeyboardPrefix(): boolean {
    return !this.collecting && this.pending.length > this.flushedPrefix;
  }

  flushKeyboardPrefix(): string {
    if (this.collecting) return "";
    const result = this.active && !this.invalidPrefix ? this.pending.slice(this.flushedPrefix) : "";
    // 刷新只影响键盘体验，保留完整标记匹配状态；权限观察器也完全独立。
    this.flushedPrefix = this.pending.length;
    return result;
  }

  clear(): void {
    this.pending = "";
    this.paste = "";
    this.flushedPrefix = 0;
    this.collecting = false;
    this.active = false;
  }
}
