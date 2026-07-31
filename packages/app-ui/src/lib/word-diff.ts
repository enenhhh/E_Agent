export interface DiffSegment {
  text: string;
  changed: boolean;
}

/**
 * 用 LCS 标记候选文本中与基线不同的词，控制模型对比界面的噪声。
 */
export function diffAgainstBaseline(baseline: string, candidate: string): DiffSegment[] {
  const source = baseline.split(/(\s+)/u);
  const target = candidate.split(/(\s+)/u);
  const rows = source.length + 1;
  const columns = target.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    for (let targetIndex = 1; targetIndex < columns; targetIndex += 1) {
      table[sourceIndex]![targetIndex] =
        source[sourceIndex - 1] === target[targetIndex - 1]
          ? (table[sourceIndex - 1]?.[targetIndex - 1] ?? 0) + 1
          : Math.max(
              table[sourceIndex - 1]?.[targetIndex] ?? 0,
              table[sourceIndex]?.[targetIndex - 1] ?? 0,
            );
    }
  }

  const unchanged = new Set<number>();
  let sourceIndex = source.length;
  let targetIndex = target.length;
  while (sourceIndex > 0 && targetIndex > 0) {
    if (source[sourceIndex - 1] === target[targetIndex - 1]) {
      unchanged.add(targetIndex - 1);
      sourceIndex -= 1;
      targetIndex -= 1;
    } else if (
      (table[sourceIndex - 1]?.[targetIndex] ?? 0) >= (table[sourceIndex]?.[targetIndex - 1] ?? 0)
    ) {
      sourceIndex -= 1;
    } else {
      targetIndex -= 1;
    }
  }

  const segments: DiffSegment[] = [];
  target.forEach((text, index) => {
    const changed = !unchanged.has(index) && text.trim().length > 0;
    const previous = segments.at(-1);
    if (previous?.changed === changed) {
      previous.text += text;
    } else {
      segments.push({ text, changed });
    }
  });
  return segments;
}
