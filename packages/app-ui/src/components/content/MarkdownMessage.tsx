import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { IconButton } from '../ui/IconButton';

function CodeBlock({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const language = className?.replace('language-', '') ?? 'text';
  const text = String(children).replace(/\n$/, '');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <header>
        <span>{language}</span>
        <IconButton label="复制代码" onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
      </header>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <a href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
          code: ({ children, className }) =>
            className ? (
              <CodeBlock className={className}>{children}</CodeBlock>
            ) : (
              <code className="inline-code">{children}</code>
            ),
        }}
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
