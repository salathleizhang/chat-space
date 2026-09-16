import { Component, type ErrorInfo, type ReactNode } from "react";

interface ResettableErrorBoundaryProps {
  /** 资源版本变化后允许重新尝试渲染；通常传 URL 或资源路径。 */
  resetKey: string;
  fallback?: ReactNode | ((error: Error) => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
}

interface ResettableErrorBoundaryState {
  error: Error | null;
  resetKey: string;
}

/**
 * 给 Suspense 资源加载配套的局部错误边界。
 *
 * React 的 Suspense 只处理“还在加载”，loader promise 一旦拒绝仍会向上抛异常。
 * 3D 资产来自用户导入和第三方生成，单个坏文件不应该卸载整个工作台；同时资源换代后
 * resetKey 会变化，边界会自动清错并尝试加载新版本。
 */
export class ResettableErrorBoundary extends Component<
  ResettableErrorBoundaryProps,
  ResettableErrorBoundaryState
> {
  override state: ResettableErrorBoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: ResettableErrorBoundaryProps,
    state: ResettableErrorBoundaryState,
  ): Partial<ResettableErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return typeof this.props.fallback === "function"
      ? this.props.fallback(error)
      : (this.props.fallback ?? null);
  }
}
