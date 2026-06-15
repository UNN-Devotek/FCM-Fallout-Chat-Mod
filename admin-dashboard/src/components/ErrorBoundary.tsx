import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            color: 'var(--danger)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <h1
            style={{
              fontSize: '24px',
              letterSpacing: '4px',
              marginBottom: '16px',
              textShadow: '0 0 12px rgba(255,68,68,0.6)',
            }}
          >
            SYSTEM MALFUNCTION
          </h1>
          <div
            style={{
              fontSize: '13px',
              color: 'var(--text-secondary)',
              marginBottom: '24px',
              maxWidth: '500px',
              margin: '0 auto 24px',
            }}
          >
            {this.state.error?.message || 'An unexpected error occurred.'}
          </div>
          <button
            onClick={this.handleReset}
            style={{
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              background: 'transparent',
              padding: '10px 24px',
              fontSize: '13px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '2px',
            }}
          >
            RETRY
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
