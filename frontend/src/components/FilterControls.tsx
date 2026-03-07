import React from 'react';
import type { FilterState, LayerState } from '../types';

const STORE_FORMATS = ['Despensa Familiar', 'Maxi Despensa', 'Walmart', 'Paiz', 'Other'] as const;

interface Props {
  filters:            FilterState;
  layers:             LayerState;
  onFilterChange:     (f: FilterState) => void;
  onLayerToggle:      (key: keyof LayerState) => void;
  onCalculate:        () => void;
  calculating:        boolean;
  chains:             { chain: string; count: number }[];
  hiddenChains:       string[];
  onChainToggle:      (chain: string) => void;
  hiddenFormats:      string[];
  onFormatToggle:     (format: string) => void;
  nucleiCount?:       number;
  gapsCount?:         number;
  nucleiNotBuilt?:    boolean;
  onBuildNuclei?:     () => void;
  buildingNuclei?:    boolean;
  gapFilter?:         { high: boolean; medium: boolean; low: boolean };
  onGapFilterChange?: (f: { high: boolean; medium: boolean; low: boolean }) => void;
  gapTierCounts?:     { high: number; medium: number; low: number };
}

const FilterControls: React.FC<Props> = ({
  filters, layers, onFilterChange, onLayerToggle, onCalculate, calculating,
  chains, hiddenChains, onChainToggle, hiddenFormats, onFormatToggle,
  nucleiCount = 0, gapsCount = 0, nucleiNotBuilt = false,
  onBuildNuclei, buildingNuclei = false,
  gapFilter, onGapFilterChange, gapTierCounts,
}) => {
  return (
    <div className="p-3 space-y-3">

      {/* Layer toggles */}
      <div>
        <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
          Capas
        </div>
        <div className="flex flex-wrap gap-1.5">
          {([
            ['stores',         'Nuestras tiendas'],
            ['competitors',    'Competidores'],
            ['opportunities',  'Oportunidades'],
            ['poiNuclei',      `Zonas${nucleiCount > 0 ? ` (${nucleiCount})` : ''}`],
            ['competitorGaps', `Brechas${gapsCount > 0 ? ` (${gapsCount})` : ''}`],
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

        {/* Brechas priority filter — only shown when the layer is active */}
        {layers.competitorGaps && (
          <div className="mt-2 pl-1 space-y-1">
            <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
              Prioridad de brechas
            </div>
            <div className="flex gap-1 flex-wrap">
              {([
                { key: 'high'   as const, label: 'Alta',  count: gapTierCounts?.high   ?? 0, active: 'bg-red-500 border-red-500',     inactive: 'border-red-300 text-red-300' },
                { key: 'medium' as const, label: 'Media', count: gapTierCounts?.medium ?? 0, active: 'bg-orange-500 border-orange-500', inactive: 'border-orange-300 text-orange-300' },
                { key: 'low'    as const, label: 'Baja',  count: gapTierCounts?.low    ?? 0, active: 'bg-violet-600 border-violet-600', inactive: 'border-violet-300 text-violet-300' },
              ]).map(({ key, label, count, active, inactive }) => (
                <button
                  key={key}
                  onClick={() => onGapFilterChange?.({ ...(gapFilter ?? { high: true, medium: true, low: true }), [key]: !(gapFilter?.[key] ?? true) })}
                  className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                    (gapFilter?.[key] ?? true)
                      ? `${active} text-white`
                      : `bg-transparent ${inactive} line-through`
                  }`}
                  title={key === 'high' ? 'Score ≥ 70' : key === 'medium' ? 'Score 40–69' : 'Score < 40'}
                >
                  {label}{count > 0 ? ` (${count})` : ''}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-gray-400 dark:text-gray-500">
              Alta ≥70 · Media 40–69 · Baja &lt;40 · Score = densidad + cobertura + POIs
            </p>
          </div>
        )}
      </div>

      {/* Competitor chain checkboxes */}
      {chains.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
            Competidores
          </div>
          <div className="space-y-1 max-h-32 overflow-y-auto scrollbar-thin">
            {chains.map(({ chain, count }) => {
              const hidden = hiddenChains.includes(chain);
              return (
                <label key={chain} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() => onChainToggle(chain)}
                    className="accent-red-500 w-3 h-3 flex-shrink-0"
                  />
                  <span className={`text-xs flex-1 truncate ${hidden ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-300'}`}>
                    {chain}
                  </span>
                  <span className="text-[10px] text-gray-400">{count}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Store format checkboxes */}
      <div>
        <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
          Formatos propios
        </div>
        <div className="space-y-1">
          {STORE_FORMATS.map(fmt => {
            const hidden = hiddenFormats.includes(fmt);
            const colors: Record<string, string> = {
              'Despensa Familiar': '#16a34a',
              'Maxi Despensa':     '#14532d',
              'Walmart':           '#1d4ed8',
              'Paiz':              '#ca8a04',
              'Other':             '#6b7280',
            };
            return (
              <label key={fmt} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => onFormatToggle(fmt)}
                  className="w-3 h-3 flex-shrink-0"
                  style={{ accentColor: colors[fmt] }}
                />
                <span className={`text-xs flex-1 ${hidden ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-300'}`}>
                  {fmt}
                </span>
              </label>
            );
          })}
        </div>
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

      {/* Build POI nuclei — explanation + callout when data missing */}
      {onBuildNuclei && (
        <div className="space-y-1.5">
          <button
            onClick={onBuildNuclei}
            disabled={buildingNuclei}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-orange-500 hover:bg-orange-600
                       text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {buildingNuclei ? '⏳ Construyendo zonas… (hasta 60s)' : '🏗 Construir zonas + brechas'}
          </button>
          {nucleiNotBuilt && !buildingNuclei && (
            <div className="text-[10px] bg-orange-50 dark:bg-orange-900/20 border border-orange-200
                            dark:border-orange-800 rounded-md px-2 py-1.5 text-orange-700 dark:text-orange-300">
              <strong>Zonas</strong> y <strong>Brechas</strong> requieren datos previos.<br />
              Haz clic en el botón de arriba para construirlos (tarda ~30-60s).
            </div>
          )}
          {!nucleiNotBuilt && nucleiCount === 0 && !buildingNuclei && (
            <p className="text-[10px] text-gray-400 text-center">
              Activa "Zonas" o "Brechas" para cargar · o construye primero
            </p>
          )}
        </div>
      )}

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
