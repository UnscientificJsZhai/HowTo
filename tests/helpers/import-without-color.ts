export async function importWithoutColor<T>(load: () => Promise<T>): Promise<T> {
  const previousForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "0";

  try {
    return await load();
  } finally {
    if (previousForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = previousForceColor;
    }
  }
}
