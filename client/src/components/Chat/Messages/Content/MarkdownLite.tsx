import { memo, useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import supersub from 'remark-supersub';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { PluggableList } from 'unified';
import type { Components } from 'react-markdown';
import type { MaskedSegment } from './MaskedText';
import { code, codeNoExecution, a, p, img, table } from './MarkdownComponents';
import { CodeBlockProvider, ArtifactProvider } from '~/Providers';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import { prepareMaskedMarkdown } from './masked';
import MaskedText from './MaskedText';
import { langSubset, remarkApproxTilde } from '~/utils';

const MarkdownLite = memo(
  ({
    content = '',
    codeExecution = true,
    maskedSegments,
  }: {
    content?: string;
    codeExecution?: boolean;
    maskedSegments?: MaskedSegment[];
  }) => {
    const masked = useMemo(
      () => maskedSegments && prepareMaskedMarkdown(maskedSegments),
      [maskedSegments],
    );
    const renderMask: Components['mark'] = ({ node, children }) => {
      const mask = masked?.masks[Number(node?.properties['data-dlp-mask'])];
      return mask ? (
        <MaskedText segments={[{ text: mask.replacement, mask }]} />
      ) : (
        <mark>{children}</mark>
      );
    };
    const rehypePlugins: PluggableList = [
      [rehypeKatex],
      [
        rehypeHighlight,
        {
          detect: true,
          ignoreMissing: true,
          subset: langSubset,
        },
      ],
    ];

    return (
      <MarkdownErrorBoundary content={content} codeExecution={codeExecution}>
        <ArtifactProvider>
          <CodeBlockProvider>
            <ReactMarkdown
              remarkPlugins={[
                remarkApproxTilde,
                /** @ts-ignore */
                supersub,
                remarkGfm,
                [remarkMath, { singleDollarTextMath: false }],
                ...(masked ? [masked.remarkPlugin] : []),
              ]}
              /** @ts-ignore */
              rehypePlugins={rehypePlugins}
              components={
                {
                  code: codeExecution ? code : codeNoExecution,
                  a,
                  p,
                  img,
                  table,
                  mark: renderMask,
                } as {
                  [nodeType: string]: React.ElementType;
                }
              }
            >
              {masked?.content ?? content}
            </ReactMarkdown>
          </CodeBlockProvider>
        </ArtifactProvider>
      </MarkdownErrorBoundary>
    );
  },
);

export default MarkdownLite;
