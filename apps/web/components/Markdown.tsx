'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Chat/agent content renderer: models answer in markdown, so show it formatted
 * (bold, lists, tables, code) instead of raw asterisks. Body text uses the
 * proportional content font; code stays monospace. Styles scoped via .md-body
 * (see globals.css).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: kids }) => (
            <a href={href} target="_blank" rel="noreferrer">{kids}</a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
