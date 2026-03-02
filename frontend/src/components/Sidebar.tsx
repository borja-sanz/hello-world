import React, { useState } from 'react';
import OpportunityCard from './OpportunityCard';
import TradeAreaPanel from './TradeAreaPanel';
import FilterControls from './FilterControls';
import type { OpportunityScore, TradeAreaAnalysis, FilterState, LayerState } from '../types';
import { exportOpportunitiesCsv } from '../utils/export';

interface Props {
  opportunities:   OpportunityScore[];
  tradeArea:       TradeAreaAnalysis | null;
  filters:         FilterState;
  layers:          LayerState;
  loading:         boolean;
  calculating:     boolean;
  onFilterChange:  (f: FilterState) => void;
  onLayerToggle:   (key: keyof LayerState) => void;
  onOppClick:      (opp: OpportunityScore) => void;
  onTradeAreaClose: () => void;
  onCalculate:     () => void;
  onOpenAdmin:     () => void;
}

const Sidebar: React.FC<Props> = ({
  opportunities, tradeArea, filters, layers, loading, calculating,
  onFilterChange, onLayerToggle, onOppClick, onTradeAreaClose, onCalculate, onOpenAdmin,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  const filtered = opportunities
    .filter(o => (o.population ?? 0) >= filters.minPopulation && o.score >= filters.minScore);

  return (
    <aside
      className={`flex flex-col bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700
                  transition-all duration-300 ${collapsed ? 'w-10' : 'w-80'} flex-shrink-0`}
    >
      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -left-3 top-1/2 -translate-y-1/2 z-10 w-6 h-12
                   bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                   rounded-l-md flex items-center justify-center text-gray-400
                   hover:text-gray-600 shadow-sm"
        title={collapsed ? 'Expandir' : 'Colapsar'}
      >
        {collapsed ? '◀' : '▶'}
      </button>

      {collapsed ? null : (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <div>
              <div className="text-sm font-bold text-gray-800 dark:text-gray-100">
                Oportunidades
              </div>
              <div className="text-xs text-gray-400">
                {filtered.length} municipios
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => exportOpportunitiesCsv(filtered)}
                className="text-xs text-gray-400 hover:text-brand-600 transition-colors"
                title="Exportar CSV"
              >
                ⬇ CSV
              </button>
              <button
                onClick={onOpenAdmin}
                className="text-xs text-gray-400 hover:text-brand-600 transition-colors"
                title="Configuración"
              >
                ⚙
              </button>
            </div>
          </div>

          {/* Filters */}
          <FilterControls
            filters={filters}
            layers={layers}
            onFilterChange={onFilterChange}
            onLayerToggle={onLayerToggle}
            onCalculate={onCalculate}
            calculating={calculating}
          />

          {/* Trade area panel */}
          {tradeArea && (
            <TradeAreaPanel analysis={tradeArea} onClose={onTradeAreaClose} />
          )}

          {/* Rankings list */}
          <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
            {loading && (
              <div className="text-center py-8 text-gray-400 text-sm">
                <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                Cargando…
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm space-y-2">
                <div className="text-4xl">📊</div>
                <div>Sin resultados</div>
                <div className="text-xs">
                  Ajusta los filtros o haz clic en<br />
                  "Recalcular oportunidades"
                </div>
              </div>
            )}

            {!loading && filtered.map((opp, i) => (
              <OpportunityCard
                key={opp.municipio_id}
                opp={opp}
                rank={i + 1}
                onClick={onOppClick}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  );
};

export default Sidebar;
