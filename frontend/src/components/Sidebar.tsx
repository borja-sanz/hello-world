import React, { useState } from 'react';
import OpportunityCard from './OpportunityCard';
import TradeAreaPanel from './TradeAreaPanel';
import FilterControls from './FilterControls';
import NtlPanel from './NtlPanel';
import type {
  OpportunityScore, TradeAreaAnalysis, FilterState, LayerState,
  NtlSettlementsResponse, NtlSettlement,
} from '../types';
import { exportOpportunitiesCsv } from '../utils/export';

interface Props {
  opportunities:      OpportunityScore[];
  tradeArea:          TradeAreaAnalysis | null;
  filters:            FilterState;
  layers:             LayerState;
  loading:            boolean;
  calculating:        boolean;
  onFilterChange:     (f: FilterState) => void;
  onLayerToggle:      (key: keyof LayerState) => void;
  onOppClick:         (opp: OpportunityScore) => void;
  onTradeAreaClose:   () => void;
  onCalculate:        () => void;
  onOpenAdmin:        () => void;
  ntlData?:           NtlSettlementsResponse | null;
  ntlLoading?:        boolean;
  onNtlClose?:        () => void;
  onSettlementClick?: (s: NtlSettlement) => void;
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
}

const Sidebar: React.FC<Props> = ({
  opportunities, tradeArea, filters, layers, loading, calculating,
  onFilterChange, onLayerToggle, onOppClick, onTradeAreaClose, onCalculate, onOpenAdmin,
  ntlData, ntlLoading = false, onNtlClose, onSettlementClick,
  chains, hiddenChains, onChainToggle, hiddenFormats, onFormatToggle,
  nucleiCount = 0, gapsCount = 0, nucleiNotBuilt = false,
  onBuildNuclei, buildingNuclei = false,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  const filtered = opportunities.filter(o => {
    if (filters.blueOcean) return true;
    return (o.population ?? 0) >= filters.minPopulation && o.score >= filters.minScore;
  });

  return (
    // Wrapper: controls how much space the sidebar takes in the flex layout.
    // When collapsed → w-0 so the map expands to full width.
    // The toggle button is absolute-positioned relative to this wrapper so it
    // remains visible at all times.
    <div className={`relative flex-shrink-0 transition-all duration-300 ${collapsed ? 'w-0' : 'w-80'}`}>

      {/* Toggle tab — always visible on the left edge */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="absolute -left-3 top-1/2 -translate-y-1/2 z-20 w-6 h-14
                   bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                   rounded-l-md flex items-center justify-center text-gray-400
                   hover:text-gray-600 dark:hover:text-gray-300 shadow-sm transition-colors"
        title={collapsed ? 'Mostrar panel' : 'Ocultar panel (mapa completo)'}
      >
        {collapsed ? '◀' : '▶'}
      </button>

      {/* Sidebar panel — overflow:hidden hides content when w-0 */}
      <aside
        className="absolute inset-0 flex flex-col bg-white dark:bg-gray-900
                   border-l border-gray-200 dark:border-gray-700 overflow-hidden w-80"
      >
        {/* ── Sticky header ── */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-200
                        dark:border-gray-700 flex-shrink-0 bg-white dark:bg-gray-900 z-10">
          <div>
            <div className="text-sm font-bold text-gray-800 dark:text-gray-100">Oportunidades</div>
            <div className="text-xs text-gray-400">{filtered.length} municipios</div>
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

        {/* ── Scrollable body: filters + optional panels + opportunity list ── */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">

          <FilterControls
            filters={filters}
            layers={layers}
            onFilterChange={onFilterChange}
            onLayerToggle={onLayerToggle}
            onCalculate={onCalculate}
            calculating={calculating}
            chains={chains}
            hiddenChains={hiddenChains}
            onChainToggle={onChainToggle}
            hiddenFormats={hiddenFormats}
            onFormatToggle={onFormatToggle}
            nucleiCount={nucleiCount}
            gapsCount={gapsCount}
            nucleiNotBuilt={nucleiNotBuilt}
            onBuildNuclei={onBuildNuclei}
            buildingNuclei={buildingNuclei}
          />

          {tradeArea && (
            <div className="border-t border-gray-200 dark:border-gray-700">
              <TradeAreaPanel analysis={tradeArea} onClose={onTradeAreaClose} />
            </div>
          )}

          {(ntlData || ntlLoading) && (
            <div className="border-t border-gray-200 dark:border-gray-700">
              <NtlPanel
                data={ntlData!}
                loading={ntlLoading}
                onClose={onNtlClose ?? (() => {})}
                onSettlementClick={onSettlementClick ?? (() => {})}
              />
            </div>
          )}

          <div className="p-2 space-y-1.5 border-t border-gray-200 dark:border-gray-700">
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
        </div>
      </aside>
    </div>
  );
};

export default Sidebar;
