import React from 'react';
import type { FilterState, LayerState } from '../types';

interface Props {
  filters:       FilterState;
  layers:        LayerState;
  onFilterChange: (f: FilterState) => void;
  onLayerToggle:  (key: keyof LayerState) => void;
  onCalculate:    () => void;
  calculating:    boolean;
}

const FilterControls: React.FC<Props> = ({
  filters, layers, onFilterChange, onLayerToggle, onCalculate, calculating,
}) => {
  return (
    <div className="p-3 border-b border-gray-200 dark:border-gray-700 space-y-3 flex-shrink-0">
      {/* Layer toggles */}
      <div>
        <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
          Capas
        </div>
        <div className="flex flex-wrap gap-1.5">
          {([
            ['stores',        'Nuestras tiendas'],
            ['competitors',   'Competidores'],
            ['opportunities', 'Oportunidades'],
          ] as [keyof LayerState, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => onLayerToggle(key)}
              className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                layers[key]
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Heatmap toggle — shows large transparent score zones instead of dots */}
        <button
          onClick={() => onLayerToggle('heatmap')}
          className={`w-full text-xs py-1.5 px-3 rounded-md font-medium transition-colors border ${
            layers.heatmap
              ? 'bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-600'
              : 'bg-white dark:bg-gray-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600'
          }`}
          title="Muestra zonas de score como polígonos translúcidos en lugar de puntos"
        >
          🗺 {layers.heatmap ? 'Mapa de zonas (activo)' : 'Modo mapa de zonas'}
        </button>
        {layers.heatmap && (
          <p className="text-[10px] text-indigo-500 dark:text-indigo-400 -mt-2 text-center">
            Verde = GO · Amarillo = CAUTION · Rojo = NO-GO
          </p>
        )}
      </div>

      {/* Population filter */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
          <span>Población mínima</span>
          <span className="font-medium">{(filters.minPopulation / 1000).toFixed(0)}k</span>
        </div>
        <input
          type="range"
          min={0} max={200000} step={5000}
          value={filters.minPopulation}
          onChange={e => onFilterChange({ ...filters, minPopulation: Number(e.target.value) })}
          className="w-full h-1.5 accent-brand-600"
        />
        <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
          <span>0</span>
          <span>24k DF</span>
          <span>55k MD</span>
          <span>200k+</span>
        </div>
      </div>

      {/* Score filter */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
          <span>Score mínimo</span>
          <span className="font-medium">{filters.minScore}</span>
        </div>
        <input
          type="range"
          min={0} max={90} step={5}
          value={filters.minScore}
          onChange={e => onFilterChange({ ...filters, minScore: Number(e.target.value) })}
          className="w-full h-1.5 accent-brand-600"
        />
      </div>

      {/* Blue Ocean preset */}
      <div>
        <button
          onClick={() => onFilterChange({ ...filters, blueOcean: !filters.blueOcean })}
          className={`w-full text-xs py-1.5 px-3 rounded-md font-medium transition-colors border ${
            filters.blueOcean
              ? 'bg-cyan-600 hover:bg-cyan-700 text-white border-cyan-600'
              : 'bg-white dark:bg-gray-800 hover:bg-cyan-50 dark:hover:bg-cyan-900/20 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600'
          }`}
          title="Municipios con suficiente población, pocos competidores, y sin tienda propia cercana"
        >
          {filters.blueOcean ? '🌊 Mercado virgen (activo)' : '🌊 Mostrar mercado virgen'}
        </button>
        {filters.blueOcean && (
          <p className="text-[10px] text-cyan-600 dark:text-cyan-400 mt-1 text-center">
            Sin cobertura propia ≥15 km · competencia baja · pop ≥15k
          </p>
        )}
      </div>

      {/* Recalculate button */}
      <button
        onClick={onCalculate}
        disabled={calculating}
        className="w-full text-xs py-1.5 px-3 rounded-md bg-brand-600 hover:bg-brand-700
                   text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {calculating ? '⏳ Calculando…' : '🔄 Recalcular oportunidades'}
      </button>
    </div>
  );
};

export default FilterControls;
