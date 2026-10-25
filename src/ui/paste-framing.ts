import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";

export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/** 包括被丢弃的内容在内都受此上限约束，避免未闭合粘贴无限积累。 */
export const MAX_PASTE_BYTES = 256 * 1024;
export type PasteDiscardReason = "boundary" | "control";

export class PasteFramingError extends Error {}

/** 只交付完整的可见粘贴；按解码后的字符检查 C1，避免误拒绝 UTF-8 延续字节。 */
export class PasteFramingFilter {
  private active = false;
  private pending = "";
  private flushedPrefix = 0;
  // 失效前缀仍参与粘贴标记匹配，但不能再作为键盘输入交付。
  private invalidPrefixLength = 0;
  private collecting = false;
  private discardPaste = false;
  private paste = "";
  private pasteBytes = 0;

  private readonly onDiscard: (reason: PasteDiscardReason) => void;
  private readonly onBoundary: () => void;
  constructor(
    onDiscard: (reason: PasteDiscardReason) => void = () => {},
    onBoundary: () => void = () => {},
  ) {
    this.onDiscard = onDiscard;
    this.onBoundary = onBoundary;
  }

  private discard(reason: PasteDiscardReason): void {
    if (!this.discardPaste) this.onDiscard(reason);
    this.discardPaste = true;
    this.paste = "";
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.invalidPrefixLength = this.pending.length;
      if (this.collecting) {
        this.discard("boundary");
      }
    }
  }

  push(text: string): string {
    let output = "";
    for (const character of text) {
      this.pending += character;
      if (!this.active) this.invalidPrefixLength = this.pending.length;
      if (this.collecting) {
        while (this.pending !== "" && !PASTE_END.startsWith(this.pending)) {
          const character = String.fromCodePoint(this.pending.codePointAt(0)!);
          this.pasteBytes += Buffer.byteLength(character);
          if (this.pasteBytes > MAX_PASTE_BYTES) {
            throw new PasteFramingError("粘贴内容超过 256 KiB，已取消本次交互。");
          }
          if (hasUnsafeTerminalControlCharacters(character)) this.discard("control");
          if (!this.discardPaste) this.paste += character;
          this.pending = this.pending.slice(character.length);
        }
        if (this.pending === PASTE_END) {
          this.onBoundary();
          if (
            this.active &&
            !this.discardPaste &&
            !hasUnsafeTerminalControlCharacters(this.paste)
          ) {
            output += PASTE_START + this.paste + PASTE_END;
          }
          this.collecting = false;
          this.paste = "";
          this.pasteBytes = 0;
          this.pending = "";
          this.invalidPrefixLength = 0;
        }
        continue;
      }
      while (
        this.pending !== "" &&
        !PASTE_START.startsWith(this.pending) &&
        !PASTE_END.startsWith(this.pending)
      ) {
        if (this.flushedPrefix > 0) {
          this.flushedPrefix--;
        } else if (this.active && this.invalidPrefixLength === 0) output += this.pending[0];
        if (this.invalidPrefixLength > 0) this.invalidPrefixLength--;
        this.pending = this.pending.slice(1);
      }
      if (this.pending === PASTE_START) {
        this.onBoundary();
        this.collecting = true;
        this.discardPaste = false;
        if (!this.active || this.invalidPrefixLength > 0 || this.flushedPrefix > 0)
          this.discard("boundary");
        this.pending = "";
        this.flushedPrefix = 0;
        this.invalidPrefixLength = 0;
        this.paste = "";
        this.pasteBytes = 0;
      } else if (this.pending === PASTE_END) {
        // 孤立的协议结束标记不作为表单文字交付。
        this.pending = "";
        this.flushedPrefix = 0;
        this.invalidPrefixLength = 0;
      }
    }
    return output;
  }

  hasPendingKeyboardPrefix(): boolean {
    return !this.collecting && this.pending.length > this.flushedPrefix;
  }

  hasUnfinishedPaste(): boolean {
    return (
      this.collecting ||
      (this.pending.length > 1 &&
        (PASTE_START.startsWith(this.pending) || PASTE_END.startsWith(this.pending)))
    );
  }

  assertComplete(): void {
    if (
      this.hasUnfinishedPaste() ||
      (this.pending.length > this.flushedPrefix && PASTE_START.startsWith(this.pending))
    ) {
      throw new PasteFramingError("粘贴或输入序列尚未结束，已取消本次交互。");
    }
  }

  flushKeyboardPrefix(): string {
    // CSI 前缀继续由会话保管，不能提前交给 Ink 后在新页面拼成按键。
    if (this.collecting || this.pending.length > 1) return "";
    const result =
      this.active && this.invalidPrefixLength === 0 ? this.pending.slice(this.flushedPrefix) : "";
    // 刷新只影响键盘体验，仍保留完整标记匹配状态及跨边界丢弃语义。
    this.flushedPrefix = this.pending.length;
    return result;
  }

  clear(): void {
    this.pending = "";
    this.paste = "";
    this.pasteBytes = 0;
    this.flushedPrefix = 0;
    this.invalidPrefixLength = 0;
    this.collecting = false;
    this.active = false;
  }
}
