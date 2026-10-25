import { closeSync, constants, openSync, readSync } from "node:fs";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ReadStream } from "node:tty";
import signalExit from "signal-exit";
import { normalizePhysicalRows, toResizeSafeOutput } from "./resize-safe-output.js";
import { PasteFramingError, PasteFramingFilter } from "./paste-framing.js";
import { KeyboardFramingFilter } from "./keyboard-framing.js";

export type InteractiveExecutionPolicy = "execute" | "print";
export const ENABLE_PASTE = "\u001b[?2004h";
export const DISABLE_PASTE = "\u001b[?2004l";
export const PASTE_IDLE_TIMEOUT_MS = 5_000;
export const PASTE_DURATION_LIMIT_MS = 30_000;

export class InteractiveSessionError extends Error {
  constructor(message = "交互终端输入不可用。") {
    super(message);
    this.name = "InteractiveSessionError";
  }
}

interface InputResources {
  restoreRaw?: boolean;
  releaseInput?: () => void;
  readPendingInput?: () => Buffer;
  registerExit?: (callback: () => void, options: { alwaysLast: boolean }) => () => void;
  pasteIdleTimeoutMs?: number;
  pasteDurationLimitMs?: number;
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
  private readonly owners = new WeakMap<Buffer, object>();
  private readonly onDelivery: (owner: object | undefined) => void;
  constructor(onDelivery: (owner: object | undefined) => void) {
    // 每次 read 只交付一批输入，Ink 不能把不同页面收到的批次合并后重新解释。
    super({ objectMode: true });
    this.onDelivery = onDelivery;
  }
  deliver(text: string, owner: object): void {
    const chunk = Buffer.from(text);
    this.owners.set(chunk, owner);
    this.push(chunk);
  }
  override read(size?: number): Buffer | null {
    const chunk = super.read(size) as Buffer | null;
    // Ink 的独立 Esc 会延后解析；空 read 不能抹掉它原本的输入归属。
    if (chunk !== null) this.onDelivery(this.owners.get(chunk));
    return chunk;
  }
  override setEncoding(): this {
    // UTF-8 已由物理会话完整解码；保留 Buffer 身份以及对应的输入边界。
    return this;
  }
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
  private readonly bridge = new SessionInput((owner) => {
    this.deliveryOwner = owner;
  });
  private readonly keyboard = new KeyboardFramingFilter();
  private readonly filter = new PasteFramingFilter(
    (reason) => {
      this.reportInputNotice(
        reason === "control"
          ? "粘贴内容包含不支持的控制字符，已整块丢弃；请检查后重新输入。"
          : "粘贴跨越页面、字段或隐藏阶段，已整块丢弃；请在当前字段重新粘贴。",
      );
    },
    () => this.clearPasteTimers(),
  );
  private inputOwner: object = {};
  private deliveryOwner: object | undefined;
  private readonly noticeListeners = new Set<(message: string) => void>();
  private readonly pendingNotices = new Set<string>();
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
  private pasteIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private pasteDurationTimer: ReturnType<typeof setTimeout> | undefined;
  private unfinishedInputAtClose = false;
  private removeExitHook: (() => void) | undefined;
  private readonly physicalInput: NodeJS.ReadStream;
  private readonly physicalOutput: NodeJS.WriteStream;
  private readonly resources: InputResources;

  constructor(
    physicalInput: NodeJS.ReadStream,
    physicalOutput: NodeJS.WriteStream,
    resources: InputResources = {},
  ) {
    this.physicalInput = physicalInput;
    this.physicalOutput = physicalOutput;
    this.resources = resources;
    this.input = this.bridge as unknown as NodeJS.ReadStream;
    this.output = toResizeSafeOutput(this.wrapOutput());
    this.originalRaw = resources.restoreRaw ?? physicalInput.isRaw === true;
    try {
      assertAvailableInput(physicalInput, physicalOutput);
      // Ink 先卸载界面，再由资源持有者同步恢复物理终端。
      const registerExit: NonNullable<InputResources["registerExit"]> =
        resources.registerExit ?? signalExit;
      this.removeExitHook = registerExit(
        () => {
          try {
            this.dispose();
          } catch {
            // 退出时尽力清理，不能让清理异常改变原退出码或终止信号。
          }
        },
        { alwaysLast: true },
      );
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
  checkExecutionPolicy = (): InteractiveExecutionPolicy => {
    this.throwIfFailed();
    if (this.closed) throw new InteractiveSessionError();
    // 查询保留终端租约；启动进程前同步检查尚未交付的输入及未闭合粘贴。
    this.drain();
    this.observePendingInput();
    this.throwIfFailed();
    this.assertCompleteInput();
    return this.policy;
  };
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

  isInputCurrent = (): boolean => this.inputActive && this.deliveryOwner === this.inputOwner;

  reportInputNotice(message: string): void {
    if (this.disposing || this.closed) return;
    if (this.noticeListeners.size === 0) this.pendingNotices.add(message);
    else for (const listener of this.noticeListeners) listener(message);
  }

  reportIgnoredPaste = (): void => {
    this.reportInputNotice("当前页面忽略粘贴，请使用键盘完成选择或确认。");
  };

  reportStalePaste = (): void => {
    this.reportInputNotice("粘贴属于上一页面或字段，已丢弃；请在当前字段重新粘贴。");
  };

  subscribeInputNotice(listener: (message: string) => void): () => void {
    this.noticeListeners.add(listener);
    for (const message of this.pendingNotices) listener(message);
    this.pendingNotices.clear();
    return () => {
      this.noticeListeners.delete(listener);
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
    this.inputOwner = {};
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
    this.observePendingInput();
    this.throwIfFailed();
    this.assertCompleteInput();
    this.dispose();
    this.throwIfFailed();
    if (this.unfinishedInputAtClose)
      throw new InteractiveSessionError("粘贴或输入序列尚未结束，已取消本次交互。");
    // 本次检查后不经过 await，执行 action 必须同步到达实际 spawn。
    return this.getExecutionPolicy() === "print" ? actions.print() : actions.execute();
  }

  dispose(): void {
    if (this.closed || this.disposing) return;
    this.disposing = true;
    try {
      this.disposeResources();
    } finally {
      const removeExitHook = this.removeExitHook;
      this.removeExitHook = undefined;
      removeExitHook?.();
    }
  }

  private disposeResources(): void {
    const previousFailure = this.failure;
    this.checkTerminalState();
    this.viewEnabled = false;
    this.setInputActive(false);
    this.clearPrefixTimer();
    this.clearPasteTimers();
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
    cleanup(() => this.observePendingInput());
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
    try {
      this.assertCompleteInput();
    } catch {
      this.unfinishedInputAtClose = true;
    }
    this.filter.clear();
    this.keyboard.clear();
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
    this.noticeListeners.clear();
    this.pendingNotices.clear();
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
      if (!active) this.inputOwner = {};
      // 隐藏边界不能把未完成的 UTF-8 字符带入下一个可见输入阶段。
      this.decoder = new StringDecoder("utf8");
    }
    this.inputActive = active;
    this.filter.setActive(active);
    this.keyboard.setActive(active);
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
  private clearPasteTimers(): void {
    if (this.pasteIdleTimer !== undefined) clearTimeout(this.pasteIdleTimer);
    if (this.pasteDurationTimer !== undefined) clearTimeout(this.pasteDurationTimer);
    this.pasteIdleTimer = undefined;
    this.pasteDurationTimer = undefined;
  }
  private updatePasteTimers(): void {
    if (
      this.disposing ||
      (!this.filter.hasUnfinishedPaste() && !this.keyboard.hasUnfinishedSequence())
    ) {
      this.clearPasteTimers();
      return;
    }
    const stop = () => {
      this.fail(
        new InteractiveSessionError("粘贴或按键序列未在时限内结束，已取消本次交互；请重新运行。"),
      );
    };
    if (this.pasteIdleTimer !== undefined) clearTimeout(this.pasteIdleTimer);
    this.pasteIdleTimer = setTimeout(
      stop,
      this.resources.pasteIdleTimeoutMs ?? PASTE_IDLE_TIMEOUT_MS,
    );
    this.pasteDurationTimer ??= setTimeout(
      stop,
      this.resources.pasteDurationLimitMs ?? PASTE_DURATION_LIMIT_MS,
    );
  }
  private processInput(bytes: Buffer): void {
    const owner = this.inputOwner;
    if (normalizePhysicalRows(this.physicalOutput.rows) <= 1) this.setInputActive(false);
    const filtered = this.keyboard.push(this.filter.push(this.decoder.write(bytes)));
    if (filtered !== "") this.bridge.deliver(filtered, owner);
    this.updatePasteTimers();
  }
  private assertCompleteInput(): void {
    this.filter.assertComplete();
    this.keyboard.assertComplete();
  }
  private flushEscape(owner: object): void {
    this.prefixTimer = setTimeout(() => {
      this.prefixTimer = undefined;
      if (this.closed) return;
      const text = this.keyboard.flushEscape();
      if (text !== "") this.bridge.deliver(text, owner);
    }, 20);
  }
  private observePendingInput(): void {
    if (!this.inputAcquired || this.failure || !this.resources.readPendingInput) return;
    const bytes = this.resources.readPendingInput();
    if (bytes.length > 0) this.processInput(bytes);
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
        this.processInput(bytes);
      }
      if (!this.disposing && this.filter.hasPendingKeyboardPrefix()) {
        // 此延迟只保留独立 Esc 的键盘语义；刷新仍属于收到前缀时的输入边界。
        const owner = this.inputOwner;
        this.prefixTimer = setTimeout(() => {
          this.prefixTimer = undefined;
          if (this.closed) return;
          const text = this.keyboard.push(this.filter.flushKeyboardPrefix());
          if (text !== "") this.bridge.deliver(text, owner);
          if (this.keyboard.hasStandaloneEscape()) this.flushEscape(owner);
        }, 20);
      } else if (!this.disposing && this.keyboard.hasStandaloneEscape()) {
        this.flushEscape(this.inputOwner);
      }
    } catch (error) {
      this.fail(
        new InteractiveSessionError(error instanceof PasteFramingError ? error.message : undefined),
      );
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
  let pendingFd: number | undefined;
  const readPendingInput = () => {
    if (pendingFd === undefined) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    // 独立非阻塞描述符只在同步交接边界读取，不改变 fd 0 的 flags 或读取所有权。
    // 限制单次排空大小，持续输入不能让同步退出无限循环；超限安全失败。
    for (let count = 0; count < 64; count++) {
      const chunk = Buffer.allocUnsafe(4096);
      try {
        const length = readSync(pendingFd, chunk, 0, chunk.length, null);
        if (length === 0) throw new InteractiveSessionError();
        chunks.push(chunk.subarray(0, length));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") return Buffer.concat(chunks);
        throw error;
      }
    }
    throw new InteractiveSessionError("交接期间输入过多，已取消执行。");
  };
  let released = false;
  const releaseInput = () => {
    if (released) return;
    released = true;
    reader?.destroy();
    if (pendingFd !== undefined) {
      closeSync(pendingFd);
      pendingFd = undefined;
    }
  };
  try {
    // 标准 fd 0 保留给原 stdin 和子进程；该读者的生命周期只属于本会话。
    if (process.platform === "linux") {
      // Linux /proc/self/fd 指向当前实际 stdin；不使用可能属于其他终端的 /dev/tty。
      pendingFd = openSync(
        "/proc/self/fd/0",
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY,
      );
    }
    reader = new ReadStream(0);
    return new InteractiveSession(reader, options.output, {
      restoreRaw,
      releaseInput,
      readPendingInput,
    });
  } catch {
    releaseInput();
    throw new InteractiveSessionError();
  }
}
