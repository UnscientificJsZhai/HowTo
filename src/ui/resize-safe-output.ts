import { useEffect, useState } from "react";
import { useStdout } from "ink";

const SAFE_INK_ROWS = Number.MAX_SAFE_INTEGER;
const DEFAULT_PHYSICAL_ROWS = 24;

const physicalToProxy = new WeakMap<NodeJS.WriteStream, NodeJS.WriteStream>();
const proxyToPhysical = new WeakMap<NodeJS.WriteStream, NodeJS.WriteStream>();

export function toResizeSafeOutput(output: NodeJS.WriteStream): NodeJS.WriteStream {
  if (proxyToPhysical.has(output)) {
    return output;
  }

  const existingProxy = physicalToProxy.get(output);
  if (existingProxy) {
    return existingProxy;
  }

  const wrappedFunctions = new Map<PropertyKey, unknown>();
  const proxy: NodeJS.WriteStream = new Proxy(output, {
    get(target, property) {
      if (property === "rows") {
        return SAFE_INK_ROWS;
      }

      if (property === "constructor") {
        const constructor: unknown = Reflect.get(target, property, target);
        return constructor;
      }

      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }

      if (wrappedFunctions.has(property)) {
        return wrappedFunctions.get(property);
      }

      // Stream 方法必须绑定物理流，确保 EventEmitter 的 this 与监听移除语义保持不变。
      const streamMethod = value as (this: NodeJS.WriteStream, ...arguments_: unknown[]) => unknown;
      const wrappedFunction = (...arguments_: unknown[]) => {
        const result = Reflect.apply(streamMethod, target, arguments_);
        return result === target ? proxy : result;
      };
      wrappedFunctions.set(property, wrappedFunction);
      return wrappedFunction;
    },
  });

  physicalToProxy.set(output, proxy);
  proxyToPhysical.set(proxy, output);
  return proxy;
}

export function unwrapResizeSafeOutput(output: NodeJS.WriteStream): NodeJS.WriteStream {
  return proxyToPhysical.get(output) ?? output;
}

export function usePhysicalStdoutRows(): number {
  const { stdout } = useStdout();
  const physicalStdout = unwrapResizeSafeOutput(stdout);
  const [rows, setRows] = useState(() => readPhysicalRows(physicalStdout));

  useEffect(() => {
    const updateRows = () => {
      setRows(readPhysicalRows(physicalStdout));
    };

    physicalStdout.on("resize", updateRows);
    updateRows();

    return () => {
      physicalStdout.off("resize", updateRows);
    };
  }, [physicalStdout]);

  return rows;
}

export function normalizePhysicalRows(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PHYSICAL_ROWS;
  }

  return Math.max(0, Math.floor(value));
}

function readPhysicalRows(output: NodeJS.WriteStream): number {
  return normalizePhysicalRows(output.rows);
}
