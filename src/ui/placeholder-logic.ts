const UNRESOLVED_PLACEHOLDER_PATTERN = /{{[^{}]*}}/;

export class PlaceholderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderResolutionError";
  }
}

export function replaceCommandPlaceholders(command: string, values: Map<string, string>): string {
  let resolvedCommand = command;

  for (const [name, value] of values) {
    resolvedCommand = resolvedCommand.split(`{{${name}}}`).join(value);
  }

  return resolvedCommand;
}

export function assertNoUnresolvedPlaceholders(command: string): void {
  if (UNRESOLVED_PLACEHOLDER_PATTERN.test(command)) {
    throw new PlaceholderResolutionError("final command contains unresolved placeholders");
  }
}
