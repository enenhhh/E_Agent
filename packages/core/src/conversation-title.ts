import type { ChatMessageInput } from '@e-agent/contracts';

/** 只有这些初始占位标题允许被首轮自动标题替换。 */
export const DEFAULT_CONVERSATION_TITLES = [
  '新会话',
  '新对话',
  'New conversation',
  'New chat',
] as const;

const maximumChineseTitleLength = 32;
const maximumLatinTitleLength = 64;
const maximumLatinWords = 10;
const maximumTitleSourceCodeUnits = 4_096;

function messageText(message: ChatMessageInput): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function cleanTitleSource(value: string): string {
  return value
    .slice(0, maximumTitleSourceCodeUnits)
    .normalize('NFC')
    .replace(/@(file|folder|web|skill):(?:"[^"]*"|[^\s]+)/giu, ' ')
    .replace(/\[image:[^\]]*\]/giu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/```(?:[a-z0-9_+-]+)?/giu, ' ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s*/gmu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/[*_~]+/gu, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stripRequestPrefix(value: string): string {
  return value
    .replace(/^(?:请问|请帮我|请你|帮我|麻烦(?:帮我)?|能否|可以(?:帮我)?)\s*/u, '')
    .replace(
      /^请(修复|分析|检查|排查|重构|实现|生成|编写|创建|添加|补充|优化|解释|删除|修改|更新|设计|部署|测试|审查|总结|查找|定位)/u,
      '$1',
    )
    .replace(/^(?:please|could you|can you|would you)\s+/iu, '')
    .trim();
}

function firstMeaningfulClause(value: string): string {
  const clauses = value
    .split(/[。！？!?；;]/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const first = clauses.find((clause) => Array.from(clause).length >= 3);
  return first ?? clauses[0] ?? value;
}

function truncateTitle(value: string): string {
  const containsCjk =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
  let normalized = value;
  if (!containsCjk) {
    normalized = normalized.split(/\s+/u).slice(0, maximumLatinWords).join(' ');
  }
  const maximumLength = containsCjk ? maximumChineseTitleLength : maximumLatinTitleLength;
  const characters = Array.from(normalized);
  return characters.length <= maximumLength
    ? normalized
    : `${characters.slice(0, maximumLength - 1).join('')}…`;
}

/**
 * 从首轮消息中生成确定性本地标题。
 *
 * 不调用模型，不读取外部资源；先使用用户请求，用户内容清理后为空时再使用助手回答。
 */
export function deriveConversationTitle(
  messages: readonly ChatMessageInput[],
  assistantContent = '',
): string {
  const userMessage = [...messages].reverse().find((message) => message.role === 'user');
  const candidates = [userMessage === undefined ? '' : messageText(userMessage), assistantContent];
  for (const candidate of candidates) {
    const cleaned = stripRequestPrefix(cleanTitleSource(candidate));
    if (cleaned === '') continue;
    const clause = firstMeaningfulClause(cleaned)
      .replace(/^[\s"'“”‘’《》【】()[\]{}:：,，.。-]+/u, '')
      .replace(/[\s"'“”‘’《》【】()[\]{}:：,，.。-]+$/u, '')
      .trim();
    if (clause !== '') return truncateTitle(clause);
  }
  return '新任务';
}

export function isDefaultConversationTitle(value: string): boolean {
  return DEFAULT_CONVERSATION_TITLES.some((title) => title === value.trim());
}
