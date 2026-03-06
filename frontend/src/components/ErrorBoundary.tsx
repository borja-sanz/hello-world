import React from 'react';

interface State { error: Error | null; }

export default class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#f9fafb', fontFamily: 'system-ui, sans-serif', padding: '32px',
      }}>
        <div style={{ maxWidth: 600, background: 'white', borderRadius: 12, padding: 32, boxShadow: '0 4px 24px rgba(0,0,0,.1)' }}>
          <div style={{ color: '#dc2626', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
            Error al cargar la aplicación
          </div>
          <div style={{ color: '#374151', fontSize: 14, marginBottom: 16 }}>
            Ocurrió un error inesperado. Abre las DevTools del navegador (F12 → Consola) para ver más detalles.
          </div>
          <pre style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 16,
            fontSize: 12, color: '#991b1b', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 300, overflow: 'auto',
          }}>
            {this.state.error.message}
            {this.state.error.stack && '\n\n' + this.state.error.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16, padding: '8px 20px', background: '#16a34a', color: 'white',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600,
            }}
          >
            Recargar página
          </button>
        </div>
      </div>
    );
  }
}
