import React, { useState } from 'react';

// Placeholder layout — fully implemented in Module 6+
const App: React.FC = () => {
  const [isDark, setIsDark] = useState(false);

  const toggleDark = () => {
    setIsDark(!isDark);
    document.documentElement.classList.toggle('dark');
  };

  return (
    <div className={`h-full flex flex-col ${isDark ? 'dark' : ''}`}>
      {/* Header */}
      <header className="bg-brand-700 dark:bg-gray-800 text-white px-4 py-3 flex items-center justify-between shadow-md z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-400 rounded-full flex items-center justify-center font-bold text-brand-900 text-sm">
            GR
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">GeoRetail Guatemala</h1>
            <p className="text-brand-200 text-xs">Inteligencia de Ubicación Retail</p>
          </div>
        </div>
        <button
          onClick={toggleDark}
          className="text-sm bg-brand-600 hover:bg-brand-500 px-3 py-1 rounded-md transition-colors"
        >
          {isDark ? '☀️ Claro' : '🌙 Oscuro'}
        </button>
      </header>

      {/* Main content — map + sidebar */}
      <main className="flex-1 flex overflow-hidden bg-gray-100 dark:bg-gray-900">
        {/* Placeholder map area */}
        <div className="flex-1 flex items-center justify-center bg-gray-200 dark:bg-gray-800">
          <div className="text-center text-gray-500 dark:text-gray-400">
            <div className="text-6xl mb-4">🗺️</div>
            <h2 className="text-xl font-semibold mb-2">Mapa Interactivo</h2>
            <p className="text-sm">Módulo 6 — Componente del mapa con Leaflet.js</p>
            <div className="mt-4 text-xs text-gray-400">
              Infraestructura lista ✅ · Base de datos configurada ✅ · API stub ✅
            </div>
          </div>
        </div>

        {/* Placeholder sidebar */}
        <aside className="w-80 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 p-4 overflow-y-auto scrollbar-thin">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-4">
            Top Oportunidades
          </h2>
          <div className="space-y-2">
            {['Municipio A', 'Municipio B', 'Municipio C'].map((m, i) => (
              <div
                key={m}
                className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200">#{i + 1} {m}</span>
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">--</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">Módulo 7 — Panel lateral</p>
              </div>
            ))}
          </div>
        </aside>
      </main>

      {/* Status bar */}
      <footer className="bg-gray-800 dark:bg-gray-950 text-gray-400 text-xs px-4 py-1 flex items-center gap-4">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-400 inline-block"></span>
          Módulo 1 completado
        </span>
        <span>Infraestructura · Base de datos · Docker · API Stub</span>
      </footer>
    </div>
  );
};

export default App;
