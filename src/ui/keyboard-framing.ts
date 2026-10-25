import { PASTE_START, PASTE_END, PasteFramingError } from "./paste-framing.js";

const ESCAPE = "\u001b";
// 使用 Ink 已支持的完整按键编码，避免独立 Esc 再次进入 Ink 的前缀缓存。
const ESCAPE_KEY = "\u001b[27u";
const MAX_KEY_SEQUENCE_LENGTH = 4096;

/** 只向 Ink 交付完整按键序列，未完成前缀不能跨页面取得新的输入归属。 */
export class KeyboardFramingFilter {
  private pending = "";
  private active = false;
  private valid = true;

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.valid = false;
  }

  push(text: string): string {
    let output = "";
    let index = 0;
    while (index < text.length) {
      // 上一层只交付完整粘贴。数据帧不能与待定 Esc 或 CSI 前缀合成按键。
      if (text.startsWith(PASTE_START, index)) {
        const end = text.indexOf(PASTE_END, index + PASTE_START.length);
        if (end < 0) throw new PasteFramingError("粘贴输入序列不完整，已取消本次交互。");
        output += this.flushEscape();
        this.pending = "";
        if (this.active) output += text.slice(index, end + PASTE_END.length);
        index = end + PASTE_END.length;
        continue;
      }
      const character = String.fromCodePoint(text.codePointAt(index)!);
      index += character.length;
      if (this.pending === "") {
        if (character !== ESCAPE) {
          if (this.active) output += character;
          continue;
        }
        this.valid = this.active;
      }
      this.pending += character;
      if (this.pending.length > MAX_KEY_SEQUENCE_LENGTH)
        throw new PasteFramingError("按键输入序列过长，已取消本次交互。");
      if (!this.isComplete()) continue;
      if (this.pending.startsWith(ESCAPE + ESCAPE) && !["[", "O"].includes(this.pending[2])) {
        if (this.valid && this.active) output += ESCAPE_KEY.repeat(2);
        // 第三个码点重新分帧，尤其不能把第三个 Esc 原样交给 Ink 缓存。
        this.pending = "";
        index -= character.length;
        continue;
      }
      if (this.valid && this.active) output += this.pending;
      this.pending = "";
    }
    return output;
  }

  private isComplete(): boolean {
    const prefix = this.pending[1] === ESCAPE ? 2 : 1;
    if (this.pending.length <= prefix) return false;
    const kind = this.pending[prefix];
    if (kind !== "[" && kind !== "O") return true;
    const payload = this.pending.slice(prefix + 1);
    if (payload === "") return false;
    for (const [index, character] of [...payload].entries()) {
      const code = character.codePointAt(0)!;
      if (kind === "[" && ((code >= 0x20 && code <= 0x3f) || (index === 0 && character === "[")))
        continue;
      if (code >= 0x40 && code <= 0x7e) return true;
      throw new PasteFramingError("按键输入序列无效，已取消本次交互。");
    }
    return false;
  }

  hasStandaloneEscape(): boolean {
    return this.pending === ESCAPE || this.pending === ESCAPE + ESCAPE;
  }

  hasUnfinishedSequence(): boolean {
    return this.pending !== "" && !this.hasStandaloneEscape();
  }

  flushEscape(): string {
    if (!this.hasStandaloneEscape()) return "";
    const output = this.valid && this.active ? ESCAPE_KEY.repeat(this.pending.length) : "";
    this.pending = "";
    return output;
  }

  assertComplete(): void {
    if (this.pending !== "") throw new PasteFramingError("按键输入序列尚未结束，已取消本次交互。");
  }

  clear(): void {
    this.pending = "";
    this.active = false;
  }
}
