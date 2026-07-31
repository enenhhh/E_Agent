import type { ChatMessageInput, SendChatRequest } from '@e-agent/contracts';
import { DomainError } from '@e-agent/core';
import { SkillOrchestrator, SkillRegistry, type RegisteredSkill } from '@e-agent/skills';
import type { FastifyInstance } from 'fastify';

import { formatWebContext, resolveWebContextMentions } from './web-context.js';

function messageText(message: ChatMessageInput | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function resolveSkill(app: FastifyInstance, reference: string): RegisteredSkill | undefined {
  const registry = app.eAgent.extensions?.skills;
  if (registry === undefined) return undefined;
  return (
    registry.getById(reference) ??
    registry.getByCommand(reference.startsWith('@') ? reference : `@${reference}`)
  );
}

async function renderSkillPrompt(
  skill: RegisteredSkill,
  content: string,
  projectContext: string,
  locale: 'zh-CN' | 'en-US',
): Promise<string> {
  const looksLikeDiff = /(?:^diff --git |^@@\s+-\d)/mu.test(content);
  const variables = Object.fromEntries(
    skill.definition.variables.map((variable) => {
      let value = '';
      if (variable.name === 'code') value = content;
      else if (variable.name === 'diff') value = looksLikeDiff ? content : '';
      else if (variable.name === 'projectContext') {
        value = projectContext.length > 0 ? projectContext : variable.required ? content : '';
      } else if (variable.name === 'language') value = 'auto';
      else if (['content', 'input', 'prompt', 'query'].includes(variable.name)) value = content;
      else if (variable.required) value = content;
      return [variable.name, value.slice(0, variable.maximumLength)];
    }),
  );
  const registry = new SkillRegistry();
  registry.register(skill);
  const orchestrator = new SkillOrchestrator(registry, {
    execute: (invocation) => Promise.resolve(invocation.prompt),
  });
  try {
    const prompt = await orchestrator.runSkill(skill.definition.id, variables, locale);
    if (typeof prompt !== 'string') throw new Error('Skill Prompt 渲染结果不是文本');
    return prompt;
  } catch (error) {
    throw new DomainError('BAD_REQUEST', 'Skill Prompt 渲染失败', { cause: error });
  }
}

/** 将显式 Skill 与上下文提及转换为模型可消费的受控 system 消息。 */
export async function prepareChatInput(
  app: FastifyInstance,
  input: SendChatRequest,
  acceptLanguage: string | undefined,
): Promise<SendChatRequest> {
  const context = await resolveWebContextMentions(input.contextMentions ?? []);
  const references = [input.skill, context.skillReference].filter(
    (reference): reference is string => reference !== undefined,
  );
  const registered = references.map((reference) => resolveSkill(app, reference));
  if (references.length > 0 && app.eAgent.extensions === null) {
    throw new DomainError('INTERNAL_ERROR', 'Skill 系统尚未就绪', {
      statusCode: 503,
      retryable: true,
    });
  }
  if (registered.some((skill) => skill === undefined)) {
    throw new DomainError('BAD_REQUEST', '请求的 Skill 不存在');
  }
  const skills = registered.filter((skill): skill is RegisteredSkill => skill !== undefined);
  if (new Set(skills.map((skill) => skill.definition.id)).size > 1) {
    throw new DomainError('BAD_REQUEST', '一次请求只能选择一个 Skill');
  }
  const skill = skills[0];
  if (skill !== undefined && !app.eAgent.extensions!.isSkillEnabled(skill.definition.id)) {
    throw new DomainError('FORBIDDEN', '请求的 Skill 已停用');
  }

  const webContext = formatWebContext(context.documents);
  const latestUser = [...input.messages].reverse().find((message) => message.role === 'user');
  const content = messageText(latestUser);
  const locale = acceptLanguage?.toLowerCase().startsWith('en') === true ? 'en-US' : 'zh-CN';
  const injected: ChatMessageInput[] = [];
  if (skill !== undefined) {
    injected.push({
      role: 'system',
      content: await renderSkillPrompt(skill, content, webContext, locale),
    });
  }
  if (webContext !== '') {
    injected.push({ role: 'system', content: webContext });
  }
  return {
    ...input,
    messages: [...injected, ...input.messages],
  };
}
