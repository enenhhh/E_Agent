import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, realpath, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { CoreServices } from '@e-agent/core';
import type { AppLogger } from '@e-agent/observability';
import { PluginRuntime } from '@e-agent/plugin-runtime';
import { SkillRegistry, WorkflowRegistry, type WorkflowDefinition } from '@e-agent/skills';

import {
  PluginHookRunner,
  type HookRunContext,
  type HookRunResult,
  type ServerHookName,
  type ServerHookPayloadMap,
} from './plugin-hooks.js';

export interface ExtensionServices {
  skills: SkillRegistry;
  workflows: WorkflowRegistry;
  plugins: PluginRuntime;
  runHook<Name extends ServerHookName>(
    name: Name,
    payload: ServerHookPayloadMap[Name],
    context?: HookRunContext,
  ): Promise<readonly HookRunResult[]>;
  isSkillEnabled(id: string): boolean;
  isBuiltInSkill(id: string): boolean;
  setSkillEnabled(id: string, enabled: boolean): void;
  installSkill(sourcePath: string): Promise<ReturnType<SkillRegistry['getById']>>;
  saveWorkflow(value: unknown): WorkflowDefinition;
  deleteWorkflow(id: string): boolean;
  shutdown(): Promise<void>;
}

interface StoredSkillState {
  installedDefinitionPaths: string[];
  disabledIds: string[];
}

const WORKFLOW_SETTINGS_SCOPE = 'extensions:workflows';
const IGNORED_SKILL_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const DEFAULT_BUILT_IN_SKILL_PATHS = [
  'plugins/code-review/skill.json',
  'plugins/builtin-skills/skills/bug-fix/skill.json',
  'plugins/builtin-skills/skills/architect/skill.json',
  'plugins/builtin-skills/skills/refactor/skill.json',
  'plugins/builtin-skills/skills/security-audit/skill.json',
  'plugins/builtin-skills/skills/browser-research/skill.json',
  'plugins/builtin-skills/skills/computer-operator/skill.json',
  'plugins/builtin-skills/skills/doc-gen/skill.json',
  'plugins/builtin-skills/skills/test-gen/skill.json',
  'plugins/builtin-skills/skills/db-helper/skill.json',
  'plugins/builtin-skills/skills/deploy/skill.json',
  'plugins/builtin-skills/skills/explain/skill.json',
] as const;

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

async function validateSkillTree(root: string): Promise<void> {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (IGNORED_SKILL_DIRECTORIES.has(entry.name)) continue;
      const path = join(current, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw new Error('Skill 目录不能包含符号链接');
      if (details.isDirectory()) {
        pending.push(path);
      } else if (details.isFile()) {
        files += 1;
        bytes += details.size;
      } else {
        throw new Error('Skill 包含不支持的文件类型');
      }
      if (files > 1_000 || bytes > 20 * 1024 * 1024) {
        throw new Error('Skill 超过文件数量或大小限制');
      }
    }
  }
}

/** 初始化 Web 端可复用的 Skill 注册表和隔离插件运行时。 */
export async function initializeExtensions(options: {
  services: CoreServices;
  logger: AppLogger;
  developmentMode: boolean;
  applicationDataDirectory?: string;
  builtInSkillPaths?: readonly string[];
  hostEntryPath?: string;
}): Promise<ExtensionServices> {
  const configuredDatabase = process.env['E_AGENT_DATABASE_URL'];
  const defaultApplicationData =
    configuredDatabase !== undefined &&
    configuredDatabase !== ':memory:' &&
    isAbsolute(configuredDatabase.replace(/^file:/, ''))
      ? dirname(resolve(configuredDatabase.replace(/^file:/, '')))
      : resolve(process.cwd(), 'data');
  const applicationData = resolve(options.applicationDataDirectory ?? defaultApplicationData);
  const installedSkillsDirectory = resolve(applicationData, 'skills');
  const skills = new SkillRegistry();
  const stored = options.services.repositories.settings.get<StoredSkillState>(
    'extensions:skills',
  ) ?? {
    installedDefinitionPaths: [],
    disabledIds: [],
  };
  const disabledIds = new Set(stored.disabledIds);
  const installedDefinitionPaths: string[] = [];
  const builtInSkills = [
    ...(options.builtInSkillPaths ??
      DEFAULT_BUILT_IN_SKILL_PATHS.map((path) => resolve(process.cwd(), path))),
  ].map((path) => resolve(path));
  const builtInSkillIds = new Set<string>();
  for (const definitionPath of [...builtInSkills, ...stored.installedDefinitionPaths]) {
    if (existsSync(definitionPath)) {
      try {
        const loaded = await skills.load(definitionPath);
        if (builtInSkills.includes(definitionPath)) builtInSkillIds.add(loaded.definition.id);
        if (!builtInSkills.includes(definitionPath)) installedDefinitionPaths.push(definitionPath);
      } catch (error) {
        options.logger.warn({ err: error, definitionPath }, '内置 Skill 加载失败');
      }
    }
  }
  const workflows = new WorkflowRegistry(skills);
  const storedWorkflows =
    options.services.repositories.settings.get<unknown[]>(WORKFLOW_SETTINGS_SCOPE) ?? [];
  for (const workflow of storedWorkflows) {
    try {
      workflows.register(workflow);
    } catch (error) {
      options.logger.warn({ err: error }, '已保存 Workflow 加载失败');
    }
  }

  const plugins = new PluginRuntime({
    pluginsDirectory: resolve(applicationData, 'plugins'),
    dataDirectory: resolve(applicationData, 'plugin-runtime'),
    hostEntryPath: resolve(
      options.hostEntryPath ?? resolve(process.cwd(), 'apps/plugin-host/dist/main.js'),
    ),
    developmentMode: options.developmentMode,
    log(level, message, fields) {
      if (level === 'debug') options.logger.debug(fields ?? {}, message);
      else if (level === 'info') options.logger.info(fields ?? {}, message);
      else if (level === 'warn') options.logger.warn(fields ?? {}, message);
      else options.logger.error(fields ?? {}, message);
    },
  });
  await plugins.initialize();
  const hookRunner = new PluginHookRunner(
    plugins,
    options.services.repositories.audit,
    options.logger,
  );
  const persistSkillState = (): void => {
    options.services.repositories.settings.set<StoredSkillState>('extensions:skills', {
      installedDefinitionPaths,
      disabledIds: [...disabledIds].sort(),
    });
  };
  const persistWorkflows = (): void => {
    options.services.repositories.settings.set(WORKFLOW_SETTINGS_SCOPE, workflows.list());
  };
  return {
    skills,
    workflows,
    plugins,
    runHook: (name, payload, context) => hookRunner.run(name, payload, context),
    isSkillEnabled: (id) => !disabledIds.has(id),
    isBuiltInSkill: (id) => builtInSkillIds.has(id),
    setSkillEnabled(id, enabled) {
      if (skills.getById(id) === undefined) throw new Error(`未找到 Skill：${id}`);
      if (enabled) disabledIds.delete(id);
      else disabledIds.add(id);
      persistSkillState();
    },
    async installSkill(sourcePath) {
      const sourceDefinition = resolve(sourcePath);
      const sourceStats = await stat(sourceDefinition);
      const definitionPath = sourceStats.isDirectory()
        ? join(sourceDefinition, 'skill.json')
        : sourceDefinition;
      const temporaryRegistry = new SkillRegistry();
      const validated = await temporaryRegistry.load(definitionPath);
      if (skills.getById(validated.definition.id) !== undefined) {
        throw new Error(`Skill 已存在：${validated.definition.id}`);
      }
      const canonicalRoot = await realpath(validated.root);
      await validateSkillTree(canonicalRoot);
      for (const promptPath of Object.values(validated.definition.prompts)) {
        const canonicalPrompt = await realpath(resolve(canonicalRoot, promptPath));
        if (!isWithin(canonicalRoot, canonicalPrompt)) {
          throw new Error('Skill Prompt 符号链接逃逸源目录');
        }
      }
      await mkdir(installedSkillsDirectory, { recursive: true });
      const destination = resolve(installedSkillsDirectory, validated.definition.id);
      if (!isWithin(installedSkillsDirectory, destination)) throw new Error('Skill 标识不安全');
      const staging = resolve(installedSkillsDirectory, `.staging-${randomUUID()}`);
      try {
        await cp(canonicalRoot, staging, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (source) =>
            source === canonicalRoot || !IGNORED_SKILL_DIRECTORIES.has(basename(source)),
        });
        await rename(staging, destination);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const installedDefinition = join(destination, 'skill.json');
      const registered = await skills.load(installedDefinition);
      installedDefinitionPaths.push(installedDefinition);
      persistSkillState();
      return registered;
    },
    saveWorkflow(value) {
      const workflow = workflows.upsert(value);
      persistWorkflows();
      return workflow;
    },
    deleteWorkflow(id) {
      const deleted = workflows.delete(id);
      if (deleted) persistWorkflows();
      return deleted;
    },
    shutdown: () => plugins.shutdown(),
  };
}
