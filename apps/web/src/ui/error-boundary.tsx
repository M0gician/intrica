import { Component, type ReactNode } from "react";
import { Button } from "./button";
import "./error-boundary.css";

type Props = {
  children: ReactNode;
  title: string;
  retryLabel: string;
};

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="ui-error-boundary" role="alert">
        <h2>{this.props.title}</h2>
        <p>{this.state.error.message}</p>
        <Button onClick={() => this.setState({ error: null })}>{this.props.retryLabel}</Button>
      </section>
    );
  }
}
