import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { parseSkillDefinition, type SkillDefinition } from './schema.js';

export interface RegisteredSkill {
  definition: SkillDefinition;
  root: string;
}

/**
 * 管理经校验的 Skill 定义，并确保命令和标识均唯一。
 */
export class SkillRegistry {
  private readonly byId = new Map<string, RegisteredSkill>();
  private readonly byCommand = new Map<string, RegisteredSkill>();

  /**
   * 从 skill.json 所在目录加载 Skill。
   */
  public async load(definitionPath: string): Promise<RegisteredSkill> {
    const absoluteDefinitionPath = resolve(definitionPath);
    const raw = await readFile(absoluteDefinitionPath, 'utf8');
    const definition = parseSkillDefinition(JSON.parse(raw) as unknown);
    const registered = {
      definition,
      root: dirname(absoluteDefinitionPath),
    };
    await this.validatePromptFiles(registered);
    this.register(registered);
    return registered;
  }

  /**
   * 注册已由调用方构造的 Skill。
   */
  public register(skill: RegisteredSkill): void {
    if (this.byId.has(skill.definition.id)) {
      throw new Error(`Skill 标识重复：${skill.definition.id}`);
    }
    if (this.byCommand.has(skill.definition.command)) {
      throw new Error(`Skill 命令重复：${skill.definition.command}`);
    }
    this.byId.set(skill.definition.id, skill);
    this.byCommand.set(skill.definition.command, skill);
  }

  /**
   * 根据唯一标识查找 Skill。
   */
  public getById(id: string): RegisteredSkill | undefined {
    return this.byId.get(id);
  }

  /**
   * 根据 @命令查找 Skill。
   */
  public getByCommand(command: string): RegisteredSkill | undefined {
    return this.byCommand.get(command);
  }

  /**
   * 返回按命令排序的全部 Skill。
   */
  public list(): readonly RegisteredSkill[] {
    return [...this.byId.values()].sort((left, right) =>
      left.definition.command.localeCompare(right.definition.command),
    );
  }

  private async validatePromptFiles(skill: RegisteredSkill): Promise<void> {
    for (const path of Object.values(skill.definition.prompts)) {
      const promptPath = resolve(skill.root, path);
      if (!isWithin(skill.root, promptPath)) {
        throw new Error('Skill Prompt 路径逃逸定义目录');
      }
      await readFile(promptPath, 'utf8');
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}
