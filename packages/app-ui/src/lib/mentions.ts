export interface ParsedMention {
  raw: string;
  type: 'file' | 'folder' | 'web' | 'skill';
  value: string;
}

const mentionPattern = /@(file|folder|web|skill):(?:"([^"]+)"|([^\s]+))/gu;

export function parseMentions(input: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  for (const match of input.matchAll(mentionPattern)) {
    const type = match[1];
    const value = match[2] ?? match[3];
    if (!type || !value) {
      continue;
    }
    mentions.push({
      raw: match[0],
      type: type as ParsedMention['type'],
      value,
    });
  }
  return mentions;
}
