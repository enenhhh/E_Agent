import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { PluginRuntime, PluginStatus } from '@e-agent/plugin-runtime';
import type { JsonValue } from '@e-agent/plugin-sdk';
import { renderPromptTemplate, SkillRegistry, type RegisteredSkill } from '@e-agent/skills';

import { DesktopError } from './errors.js';

export interface SkillPromptInput {
  command: string;
  userContent: string;
  contextMessages: readonly string[];
  contextMentions: readonly string[];
}

export interface DesktopSkillResolverOptions {
  pluginsDirectory: string;
  plugins: PluginRuntime;
  locale: 'zh-CN' | 'en-US';
}

/**
 * 从已启用插件加载 Skill 定义、渲染 Prompt，并执行其可选确定性前置命令。
 */
export class DesktopSkillResolver {
  private readonly loaded = new Map<string, Promise<RegisteredSkill>>();

  public constructor(private readonly options: DesktopSkillResolverOptions) {}

  public async resolve(input: SkillPromptInput): Promise<string> {
    const registry = await this.createRegistry({ enabledOnly: true });
    const skill = registry.getByCommand(input.command) ?? registry.getById(input.command);
    if (skill !== undefined) {
      const variables = buildVariables(input, skill);
      const promptPath = join(skill.root, skill.definition.prompts[this.options.locale]);
      const template = await readFile(promptPath, 'utf8');
      const prompt = renderPromptTemplate(template, variables);
      const executor = skill.definition.executor;
      if (executor === undefined) {
        return prompt;
      }
      const staticResult = await this.options.plugins.invoke(
        executor.pluginId,
        'command',
        executor.commandId,
        variables as unknown as JsonValue,
      );
      return `${prompt}\n\n${formatStaticResult(staticResult)}`;
    }
    throw new DesktopError(
      'SKILL_NOT_AVAILABLE',
      `Skill ${input.command} 未安装、未启用或定义无效`,
    );
  }

  /**
   * 构建隔离的已验证 Skill 注册表；单个损坏定义不会阻断其他 Skill。
   */
  public async createRegistry(options: { enabledOnly: boolean }): Promise<SkillRegistry> {
    const registry = new SkillRegistry();
    const statuses = [...(await this.options.plugins.list())].sort((left, right) => {
      const leftBuiltIn = left.manifest.id.startsWith('com.eagent.') ? 0 : 1;
      const rightBuiltIn = right.manifest.id.startsWith('com.eagent.') ? 0 : 1;
      return leftBuiltIn - rightBuiltIn || left.manifest.id.localeCompare(right.manifest.id);
    });
    for (const status of statuses) {
      if (!status.approved || (options.enabledOnly && !status.enabled)) {
        continue;
      }
      for (const contribution of status.manifest.contributes.skills ?? []) {
        if (options.enabledOnly && !this.options.plugins.isSkillEnabled(contribution.id)) {
          continue;
        }
        try {
          registry.register(await this.load(status, contribution.definition));
        } catch {
          // 损坏或冲突的单个定义保持隔离，不影响其他已验证 Skill。
        }
      }
    }
    return registry;
  }

  private async load(
    status: PluginStatus,
    relativeDefinitionPath: string,
  ): Promise<RegisteredSkill> {
    const pluginRoot = await this.options.plugins.getPluginRoot(status.manifest.id);
    const path = join(pluginRoot, relativeDefinitionPath);
    const cacheKey = `${path}:${status.integrity}`;
    let loading = this.loaded.get(cacheKey);
    if (loading === undefined) {
      loading = new SkillRegistry().load(path);
      this.loaded.set(cacheKey, loading);
      void loading.catch(() => this.loaded.delete(cacheKey));
    }
    return loading;
  }
}

function buildVariables(input: SkillPromptInput, skill: RegisteredSkill): Record<string, string> {
  const filePath =
    input.contextMentions
      .map((mention) => /^@file:(?:"([^"]+)"|(.+))$/u.exec(mention))
      .map((match) => match?.[1] ?? match?.[2])
      .find((value): value is string => value !== undefined) ?? '';
  const isDiff = /(?:^|\n)(?:diff --git |@@\s+-\d|Index: )/u.test(input.userContent);
  const selectedContext = input.contextMessages.join('\n\n').slice(0, 900_000);
  const code = isDiff
    ? selectedContext
    : selectedContext.length > 0
      ? selectedContext
      : input.userContent;
  const candidates: Record<string, string> = {
    language: languageFor(filePath, input.userContent),
    filePath,
    projectContext: selectedContext.slice(0, 20_000),
    databaseSchema: selectedContext,
    diff: isDiff ? input.userContent : '',
    code: code.slice(0, 1_000_000),
    request: input.userContent,
    requirements: input.userContent,
    userContent: input.userContent,
    content: input.userContent,
    input: input.userContent,
    prompt: input.userContent,
    query: input.userContent,
    dialect: 'auto',
    target: 'all',
    detailLevel: 'standard',
    testFramework: 'auto',
    docStyle: 'auto',
  };
  if (skill.definition.command === '@deploy') {
    candidates['projectContext'] =
      selectedContext.trim().length > 0 ? selectedContext : input.userContent;
  }
  return Object.fromEntries(
    skill.definition.variables.map((definition) => {
      const fallback = definition.required ? input.userContent : '';
      return [
        definition.name,
        (candidates[definition.name] ?? fallback).slice(0, definition.maximumLength),
      ];
    }),
  );
}

function languageFor(filePath: string, content: string): string {
  const fenced = /```([a-zA-Z0-9_+-]{1,32})/u.exec(content)?.[1];
  if (fenced !== undefined) {
    return fenced;
  }
  const languages: Record<string, string> = {
    '.c': 'C',
    '.cpp': 'C++',
    '.cs': 'C#',
    '.go': 'Go',
    '.java': 'Java',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript React',
    '.kt': 'Kotlin',
    '.php': 'PHP',
    '.py': 'Python',
    '.rb': 'Ruby',
    '.rs': 'Rust',
    '.swift': 'Swift',
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript React',
  };
  return languages[extname(filePath).toLowerCase()] ?? 'auto';
}

function formatStaticResult(value: JsonValue | undefined): string {
  const heading =
    '下面是隔离插件给出的确定性静态预扫描结果。它只是证据线索，最终结论仍需依据代码验证：';
  if (value === undefined) {
    return `${heading}\n{"status":"no-result"}`;
  }
  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    const record = value as Readonly<Record<string, JsonValue>>;
    const compact = {
      staticAnalysis: record['staticAnalysis'] ?? null,
      recommendedVerdict: record['recommendedVerdict'] ?? null,
      markdown: record['markdown'] ?? null,
    };
    return `${heading}\n${JSON.stringify(compact)}`;
  }
  return `${heading}\n${JSON.stringify(value)}`;
}
