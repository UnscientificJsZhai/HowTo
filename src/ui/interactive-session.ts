import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ReadStream } from "node:tty";
import { normalizePhysicalRows, toResizeSafeOutput } from "./resize-safe-output.js";
import { PasteFramingFilter, PasteStartObserver } from "./paste-framing.js";

export type InteractiveExecutionPolicy = "execute" | "print";
export const ENABLE_PASTE = "\u001b[?2004h";
export const DISABLE_PASTE = "\u001b[?2004l";

export class InteractiveSessionError extends Error {
  constructor(message = "交互终端输入不可用。") {
    super(message);
    this.name = "InteractiveSessionError";
  }
}

interface InputResources {
  restoreRaw?: boolean;
  releaseInput?: () => void;
}

function inputIsUnavailable(input: NodeJS.ReadStream, expectedClose = false): boolean {
  return (
    input.errored !== null ||
    (!expectedClose &&
      (input.destroyed || input.closed || input.readableEnded || input.readable === false))
  );
}

function outputIsUnavailable(output: NodeJS.WriteStream): boolean {
  return (
    output.errored !== null ||
    output.destroyed ||
    output.closed ||
    output.writableEnded ||
    output.writableFinished ||
    output.writable === false
  );
}

function assertAvailableInput(input: NodeJS.ReadStream, output: NodeJS.WriteStream): void {
  if (
    !input.isTTY ||
    !output.isTTY ||
    inputIsUnavailable(input) ||
    outputIsUnavailable(output) ||
    input.listenerCount("readable") > 0 ||
    input.listenerCount("data") > 0
  ) {
    throw new InteractiveSessionError();
  }
}

class SessionInput extends Readable {
  readonly isTTY = true;
  isRaw = true;
  override _read(): void {}
  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

export class InteractiveSession {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  private readonly bridge = new SessionInput();
  private readonly observer = new PasteStartObserver();
  private readonly filter = new PasteFramingFilter();
  private decoder = new StringDecoder("utf8");
  private readonly policyListeners = new Set<() => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private policy: InteractiveExecutionPolicy = "execute";
  private failure: Error | undefined;
  private closed = false;
  private disposing = false;
  private inputAcquired = false;
  private inputCloseExpected = false;
  private inputCloseSeen = false;
  private outputCloseSeen = false;
  private inputActive = false;
  private rawAcquired = false;
  private refAcquired = false;
  private pasteAcquired = false;
  private readonly originalRaw: boolean;
  private view: object | undefined;
  private viewEnabled = false;
  private prefixTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly physicalInput: NodeJS.ReadStream,
    private readonly physicalOutput: NodeJS.WriteStream,
    private readonly resources: InputResources = {},
  ) {
    this.input = this.bridge as unknown as NodeJS.ReadStream;
    this.output = toResizeSafeOutput(this.wrapOutput());
    this.originalRaw = resources.restoreRaw ?? physicalInput.isRaw === true;
    try {
      assertAvailableInput(physicalInput, physicalOutput);
      // 校验拒绝时不能读取仍由原消费者持有的缓冲。
      this.inputAcquired = true;
      physicalInput.on("readable", this.drain);
      physicalInput.on("error", this.handleFailure);
      physicalInput.on("end", this.handleFailure);
      physicalInput.on("close", this.handleInputClose);
      physicalOutput.on("error", this.handleFailure);
      physicalOutput.on("close", this.handleOutputClose);
      physicalOutput.on("finish", this.handleFailure);
      physicalOutput.on("resize", this.updateVisibility);
      if (!physicalInput.isRaw) {
        this.rawAcquired = true;
        physicalInput.setRawMode(true);
        this.checkTerminalState();
        this.throwIfFailed();
        this.refAcquired = true;
        physicalInput.ref();
        this.checkTerminalState();
        this.throwIfFailed();
      }
      this.pasteAcquired = true;
      physicalOutput.write(ENABLE_PASTE);
      this.checkTerminalState();
      this.throwIfFailed();
      this.drain();
      this.throwIfFailed();
    } catch {
      this.fail(new InteractiveSessionError());
      throw this.failure ?? new InteractiveSessionError();
    }
  }

  getExecutionPolicy = (): InteractiveExecutionPolicy => this.policy;
  subscribeExecutionPolicy = (listener: () => void): (() => void) => {
    this.policyListeners.add(listener);
    return () => {
      this.policyListeners.delete(listener);
    };
  };
  subscribeFailure(listener: (error: Error) => void): () => void {
    if (this.failure) listener(this.failure);
    else this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  beginView(): () => void {
    this.throwIfFailed();
    if (this.closed) throw new InteractiveSessionError();
    const token = {};
    this.suspendViewInput();
    this.view = token;
    this.viewEnabled = true;
    this.updateVisibility();
    return () => {
      if (this.view === token) {
        this.suspendViewInput();
        this.view = undefined;
      }
    };
  }

  suspendViewInput(): void {
    this.viewEnabled = false;
    this.setInputActive(false);
    this.drain();
    while (this.bridge.read() !== null) {
      /* 丢弃旧 UI 尚未消费的输入。 */
    }
  }

  handoff<T>(actions: { execute: () => T; print: () => T }): T {
    this.throwIfFailed();
    if (this.closed) throw new InteractiveSessionError();
    this.drain();
    this.throwIfFailed();
    this.dispose();
    this.throwIfFailed();
    // 本次检查后不经过 await，执行 action 必须同步到达实际 spawn。
    return this.getExecutionPolicy() === "print" ? actions.print() : actions.execute();
  }

  dispose(): void {
    if (this.closed || this.disposing) return;
    this.disposing = true;
    const previousFailure = this.failure;
    this.checkTerminalState();
    this.viewEnabled = false;
    this.setInputActive(false);
    this.clearPrefixTimer();
    this.filter.clear();
    let cleanupFailed = false;
    const cleanup = (action: () => void) => {
      try {
        action();
      } catch {
        cleanupFailed = true;
      }
      this.checkTerminalState();
    };
    if (this.pasteAcquired && !this.physicalOutput.destroyed && !this.physicalOutput.writableEnded)
      cleanup(() => {
        this.physicalOutput.write(DISABLE_PASTE);
      });
    if (this.rawAcquired)
      cleanup(() => {
        this.physicalInput.setRawMode(this.originalRaw);
      });
    if (this.refAcquired)
      cleanup(() => {
        this.physicalInput.unref();
      });
    // 恢复终端时仍保留原始观察，最后再同步排空并撤下监听。
    this.drain();
    this.checkTerminalState();
    this.physicalInput.off("readable", this.drain);
    this.physicalInput.off("end", this.handleFailure);
    this.physicalOutput.off("resize", this.updateVisibility);
    this.physicalOutput.off("finish", this.handleFailure);
    if (this.resources.releaseInput) {
      // 构造尚未取得消费权时，自有 reader 的关闭仍需要错误接收者。
      if (!this.inputAcquired) {
        this.physicalInput.on("error", this.handleFailure);
        this.physicalInput.on("close", this.handleInputClose);
      }
      this.checkTerminalState();
      this.inputCloseExpected = true;
    }
    // 只关闭会话自己的读者，同步停止物理读取后才允许 handoff 检查权限并 spawn。
    cleanup(() => {
      this.resources.releaseInput?.();
    });
    this.closed = true;
    // destroyed/closed 可以先于排队中的 error/close 变为 true，必须等真实 close 收尾。
    if (
      this.inputCloseSeen ||
      (!this.inputCloseExpected && (!this.inputAcquired || !inputIsUnavailable(this.physicalInput)))
    ) {
      this.physicalInput.off("error", this.handleFailure);
      this.physicalInput.off("close", this.handleInputClose);
    }
    if (this.outputCloseSeen || !this.inputAcquired || !outputIsUnavailable(this.physicalOutput)) {
      this.physicalOutput.off("error", this.handleFailure);
      this.physicalOutput.off("close", this.handleOutputClose);
    }
    this.bridge.destroy();
    this.policyListeners.clear();
    this.failureListeners.clear();
    if (cleanupFailed && !this.failure) {
      this.failure = new InteractiveSessionError("无法恢复交互终端状态。");
    }
    if (!previousFailure && this.failure) throw this.failure;
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
  private fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    this.policy = "print";
    const listeners = [...this.failureListeners];
    this.failureListeners.clear();
    this.dispose();
    for (const listener of listeners) listener(error);
  }
  private handleFailure = (): void => {
    this.fail(new InteractiveSessionError());
  };
  private checkTerminalState(): void {
    if (
      this.inputAcquired &&
      (inputIsUnavailable(this.physicalInput, this.inputCloseExpected) ||
        outputIsUnavailable(this.physicalOutput))
    ) {
      this.handleFailure();
    }
  }
  private handleInputClose = (): void => {
    this.inputCloseSeen = true;
    if (this.closed) {
      this.physicalInput.off("error", this.handleFailure);
      this.physicalInput.off("close", this.handleInputClose);
    } else if (!this.inputCloseExpected) this.handleFailure();
  };
  private handleOutputClose = (): void => {
    this.outputCloseSeen = true;
    if (this.closed) {
      this.physicalOutput.off("error", this.handleFailure);
      this.physicalOutput.off("close", this.handleOutputClose);
    } else this.handleFailure();
  };
  private setInputActive(active: boolean): void {
    if (active !== this.inputActive) {
      // 隐藏边界不能把未完成的 UTF-8 字符带入下一个可见输入阶段。
      this.decoder = new StringDecoder("utf8");
    }
    this.inputActive = active;
    this.filter.setActive(active);
  }
  private updateVisibility = (): void => {
    const active = this.viewEnabled && normalizePhysicalRows(this.physicalOutput.rows) > 1;
    if (active && !this.inputActive) this.drain();
    this.setInputActive(active);
  };
  private clearPrefixTimer(): void {
    if (this.prefixTimer !== undefined) clearTimeout(this.prefixTimer);
    this.prefixTimer = undefined;
  }
  private drain = (): void => {
    if (this.closed || !this.inputAcquired) return;
    try {
      this.clearPrefixTimer();
      let chunk: unknown;
      while ((chunk = this.physicalInput.read()) !== null) {
        if (typeof chunk !== "string" && !Buffer.isBuffer(chunk))
          throw new InteractiveSessionError();
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (this.observer.observe(bytes) && this.policy !== "print") {
          this.policy = "print";
          for (const listener of this.policyListeners) listener();
        }
        if (normalizePhysicalRows(this.physicalOutput.rows) <= 1) this.setInputActive(false);
        const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
        const filtered = this.filter.push(text);
        if (filtered !== "") this.bridge.push(filtered);
      }
      if (!this.disposing && this.filter.hasPendingKeyboardPrefix()) {
        // 此延迟仅保留独立 Esc 的键盘语义，绝不用于恢复执行权限。
        this.prefixTimer = setTimeout(() => {
          this.prefixTimer = undefined;
          if (this.closed) return;
          const text = this.filter.flushKeyboardPrefix();
          if (text !== "") this.bridge.push(text);
        }, 20);
      }
    } catch {
      this.handleFailure();
    }
  };

  private wrapOutput(): NodeJS.WriteStream {
    const physical = this.physicalOutput;
    const methods = new Map<PropertyKey, unknown>();
    const proxy = new Proxy(physical, {
      get: (target, property) => {
        if (property === "write") {
          return (chunk: unknown, ...args: unknown[]): unknown => {
            const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
            if (
              this.failure ||
              target.destroyed ||
              target.writableEnded ||
              (!this.closed && (text === ENABLE_PASTE || text === DISABLE_PASTE))
            ) {
              const callback = args.find((arg) => typeof arg === "function") as
                (() => void) | undefined;
              callback?.();
              return true;
            }
            return Reflect.apply(target.write.bind(target), target, [chunk, ...args]);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        if (property === "constructor" || typeof value !== "function") return value;
        if (!methods.has(property))
          methods.set(property, (...args: unknown[]) => {
            const result: unknown = Reflect.apply(value, target, args);
            return result === target ? proxy : result;
          });
        return methods.get(property);
      },
    });
    return proxy;
  }
}

export function createInteractiveSession(options: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}): InteractiveSession {
  if (options.input !== process.stdin) {
    return new InteractiveSession(options.input, options.output);
  }

  // 仅供内部 CLI 的冷 stdin 路径；这些状态不能认证任意外部代码的完整读取历史。
  assertAvailableInput(options.input, options.output);
  if (
    process.stdin.fd !== 0 ||
    options.input.readableFlowing !== null ||
    options.input.readableDidRead ||
    options.input.readableLength > 0
  ) {
    throw new InteractiveSessionError();
  }
  const restoreRaw = options.input.isRaw === true;
  let reader: ReadStream | undefined;
  let released = false;
  const releaseInput = () => {
    if (released) return;
    released = true;
    reader?.destroy();
  };
  try {
    // 标准 fd 0 保留给原 stdin 和子进程；该读者的生命周期只属于本会话。
    reader = new ReadStream(0);
    return new InteractiveSession(reader, options.output, { restoreRaw, releaseInput });
  } catch {
    releaseInput();
    throw new InteractiveSessionError();
  }
}
