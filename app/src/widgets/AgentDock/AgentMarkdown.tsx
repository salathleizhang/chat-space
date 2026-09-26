import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agent 正文只渲染受控 Markdown。工具状态、提问、计划和图片仍由各自的
 * 类型化组件负责；不启用 raw HTML，也不允许正文偷偷加载远程图片。
 */
const components: Components = {
  a: ({ children, node: _node, ...props }) => (
    <a
      {...props}
      className="font-medium text-ink-strong underline decoration-ink-faint underline-offset-4 transition-colors hover:decoration-ink-strong"
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  ),
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children, node: _node, ...props }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-control border border-hairline">
      <table {...props} className="w-full border-collapse text-left text-xs">
        {children}
      </table>
    </div>
  ),
};

export function AgentMarkdown({
  children,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div"> & { children: string }) {
  return (
    <div
      {...props}
      data-agent-markdown
      className={`agent-markdown min-w-0 break-words ${className}`.trim()}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
