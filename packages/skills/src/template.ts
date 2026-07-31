const variablePattern = /\{\{\s*([a-z][a-zA-Z0-9]*)\s*\}\}/g;

/**
 * 渲染无逻辑 Prompt 模板，拒绝缺失变量和未使用的危险对象插值。
 */
export function renderPromptTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  const referenced = new Set<string>();
  const rendered = template.replace(variablePattern, (_match: string, variableName: string) => {
    referenced.add(variableName);
    const value = variables[variableName];
    if (value === undefined) {
      throw new Error(`Prompt 缺少变量：${variableName}`);
    }
    return value;
  });
  const unresolved = rendered.match(/\{\{[^}]+\}\}/);
  if (unresolved !== null) {
    throw new Error(`Prompt 包含不受支持的模板表达式：${unresolved[0]}`);
  }
  return rendered;
}

/**
 * 提取文本开头或空白后的 @skill 命令。
 */
export function extractSkillCommands(text: string): readonly string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?:^|\s)(@[a-z][a-z0-9-]{1,48})(?=\s|$)/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ];
}
