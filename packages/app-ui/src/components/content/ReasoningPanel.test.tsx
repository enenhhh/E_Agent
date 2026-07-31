import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReasoningPanel } from './ReasoningPanel';

afterEach(cleanup);

describe('ReasoningPanel', () => {
  it('流式思考保持展开，完成后按默认偏好折叠并显示耗时', async () => {
    const { rerender } = render(
      <ReasoningPanel content="正在分析依赖关系" display="collapsed" streaming />,
    );

    const streamingPanel = screen.getByText('思考中').closest('details');
    expect(streamingPanel).toHaveAttribute('open');
    expect(streamingPanel).toHaveClass('reasoning-panel--streaming');
    expect(screen.getByText('正在分析依赖关系')).toBeVisible();

    rerender(
      <ReasoningPanel
        content="正在分析依赖关系"
        display="collapsed"
        durationMs={13_000}
        streaming={false}
      />,
    );

    expect(screen.getByText('已思考 13s')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('已思考 13s').closest('details')).not.toHaveAttribute('open');
    });
  });

  it.each([
    { durationMs: -100, label: '已思考 0ms' },
    { durationMs: 499.6, label: '已思考 500ms' },
    { durationMs: 1_000, label: '已思考 1s' },
    { durationMs: 1_499, label: '已思考 1s' },
    { durationMs: 1_500, label: '已思考 2s' },
  ])('将 $durationMs ms 格式化为“$label”', ({ durationMs, label }) => {
    render(
      <ReasoningPanel
        content="耗时边界"
        display="collapsed"
        durationMs={durationMs}
        streaming={false}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('缺少持久化耗时时显示通用完成文案', () => {
    render(<ReasoningPanel content="已有思考内容" display="collapsed" streaming={false} />);
    expect(screen.getByText('思考完成')).toBeInTheDocument();
  });

  it('隐藏偏好或空内容时完全不渲染', () => {
    const { container, rerender } = render(
      <ReasoningPanel content="不会显示" display="hidden" streaming={false} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<ReasoningPanel content="" display="expanded" streaming={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('遵循初始展开和折叠偏好', () => {
    const { rerender } = render(
      <ReasoningPanel content="保持展开" display="expanded" streaming={false} />,
    );
    expect(screen.getByText('保持展开').closest('details')).toHaveAttribute('open');

    rerender(
      <ReasoningPanel key="collapsed" content="默认折叠" display="collapsed" streaming={false} />,
    );
    expect(screen.getByText('默认折叠').closest('details')).not.toHaveAttribute('open');
  });

  it('支持用户通过摘要手动展开和折叠已完成思考', () => {
    const { container } = render(
      <ReasoningPanel content="可回看内容" display="collapsed" streaming={false} />,
    );
    const details = container.querySelector('details');
    const summary = container.querySelector('summary');
    expect(details).not.toHaveAttribute('open');

    fireEvent.click(summary!);
    expect(details).toHaveAttribute('open');
    fireEvent.click(summary!);
    expect(details).not.toHaveAttribute('open');
  });

  it('从完成态切换到流式态时重新展开并恢复流式样式', async () => {
    const { rerender } = render(
      <ReasoningPanel content="继续推理" display="collapsed" streaming={false} />,
    );
    expect(screen.getByText('思考完成').closest('details')).not.toHaveAttribute('open');

    rerender(<ReasoningPanel content="继续推理" display="collapsed" streaming />);
    await waitFor(() => {
      expect(screen.getByText('思考中').closest('details')).toHaveAttribute('open');
    });
    expect(screen.getByText('思考中').closest('details')).toHaveClass('reasoning-panel--streaming');
  });

  it('运行中结束后遵循展开偏好', async () => {
    const { rerender } = render(<ReasoningPanel content="分析过程" display="expanded" streaming />);
    rerender(
      <ReasoningPanel content="分析过程" display="expanded" durationMs={2_000} streaming={false} />,
    );
    await waitFor(() => {
      expect(screen.getByText('已思考 2s').closest('details')).toHaveAttribute('open');
    });
  });

  it('使用安全 Markdown 渲染思考内容', () => {
    const { container } = render(
      <ReasoningPanel
        content={'## 分析\n\n- 依赖 A\n\n<script>alert("x")</script>'}
        display="expanded"
        streaming={false}
      />,
    );
    expect(screen.getByRole('heading', { name: '分析' })).toBeInTheDocument();
    expect(screen.getByText('依赖 A')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });
});
