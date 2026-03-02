import React, { useState, useEffect, useCallback } from 'react';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import AdminPanel from './pages/AdminPanel';
import {
  fetchStores, fetchCompetitors,
  fetchOpportunities, fetchBlueOceanOpportunities,
  analyzeTradeArea, calculateAllScores,
} from './api';
import { exportOpportunitiesReport } from './utils/export';
import type {
  Store, Competitor, OpportunityScore, TradeAreaAnalysis,
  FilterState, LayerState,
} from './types';

const App: React.FC = () => {
  // ── Theme ─────────────────────────────────────────────────────────────────
  const [isDark, setIsDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  // ── Data state ────────────────────────────────────────────────────────────
  const [stores,        setStores]        = useState<Store[]>([]);
  const [competitors,   setCompetitors]   = useState<Competitor[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityScore[]>([]);
  const [tradeArea,     setTradeArea]     = useState<TradeAreaAnalysis | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [loading,      setLoading]      = useState(false);
  const [mapLoading,   setMapLoading]   = useState(false);
  const [calculating,  setCalculating]  = useState(false);
  const [showAdmin,    setShowAdmin]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  const [layers, setLayers] = useState<LayerState>({
    stores: true, competitors: true, opportunities: true, heatmap: false,
  });

  const [filters, setFilters] = useState<FilterState>({
    minPopulation: 0, minScore: 0, storeFormat: '', showOnlyGo: false, blueOcean: false,
  });

  // ── Initial data load ─────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchStores().catch(() => []),
      fetchCompetitors().catch(() => []),
      fetchOpportunities({ limit: 50 }).catch(() => ({ opportunities: [], cached: false })),
    ]).then(([s, c, o]) => {
      setStores(s);
      setCompetitors(c);
      setOpportunities(addCentroidsFromOpps(o.opportunities));
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── Blue ocean mode: re-fetch from dedicated endpoint when toggled ────────
  const prevBlueOcean = React.useRef(false);
  useEffect(() => {
    if (filters.blueOcean === prevBlueOcean.current) return;
    prevBlueOcean.current = filters.blueOcean;

    setLoading(true);
    if (filters.blueOcean) {
      fetchBlueOceanOpportunities({ min_population: 15000, limit: 40 })
        .then(r => setOpportunities(addCentroidsFromOpps(r.opportunities)))
        .catch(e => setError('Error blue ocean: ' + e.message))
        .finally(() => setLoading(false));
    } else {
      fetchOpportunities({ limit: 50 })
        .catch(() => ({ opportunities: [], cached: false }))
        .then(r => setOpportunities(addCentroidsFromOpps((r as any).opportunities)))
        .finally(() => setLoading(false));
    }
  }, [filters.blueOcean]);

  // Attach lat/lng to opportunities from the centroid_geojson field if present
  function addCentroidsFromOpps(opps: any[]): OpportunityScore[] {
    return opps.map(o => ({
      ...o,
      centroid: o.centroid_geojson
        ? (() => {
            try {
              const gj = typeof o.centroid_geojson === 'string'
                ? JSON.parse(o.centroid_geojson)
                : o.centroid_geojson;
              return { lat: gj.coordinates[1], lng: gj.coordinates[0] };
            } catch { return undefined; }
          })()
        : undefined,
    }));
  }

  // ── Map click → trade area ────────────────────────────────────────────────
  const handleMapClick = useCallback(async (lat: number, lng: number) => {
    setMapLoading(true);
    setTradeArea(null);
    try {
      const analysis = await analyzeTradeArea(lat, lng);
      setTradeArea(analysis);
    } catch (e: any) {
      setError('Error al analizar área de influencia: ' + e.message);
    } finally {
      setMapLoading(false);
    }
  }, []);

  // ── Recalculate all scores ────────────────────────────────────────────────
  const handleCalculate = useCallback(async () => {
    setCalculating(true);
    try {
      await calculateAllScores();
      // Wait a beat then reload opportunities
      setTimeout(async () => {
        const fresh = await fetchOpportunities({ limit: 50 }).catch(() => ({ opportunities: [], cached: false }));
        setOpportunities(addCentroidsFromOpps(fresh.opportunities));
        setCalculating(false);
      }, 3000);
    } catch {
      setCalculating(false);
    }
  }, []);

  // ── Layer toggle ──────────────────────────────────────────────────────────
  const handleLayerToggle = useCallback((key: keyof LayerState) => {
    setLayers(l => ({ ...l, [key]: !l[key] }));
  }, []);

  // ── Opportunity card click → pan map ─────────────────────────────────────
  const handleOppClick = useCallback((opp: OpportunityScore) => {
    if (opp.centroid) {
      handleMapClick(opp.centroid.lat as unknown as number, opp.centroid.lng as unknown as number);
    }
  }, [handleMapClick]);

  return (
    <div className="h-full flex flex-col">
      {/* ── Header ── */}
      <header className="bg-brand-700 dark:bg-gray-900 text-white px-4 py-2.5 flex items-center justify-between shadow-md z-[600] flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-400 rounded-full flex items-center justify-center font-black text-brand-900 text-sm select-none">
            GR
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">GeoRetail Guatemala</h1>
            <p className="text-brand-200 text-xs">Inteligencia de Ubicación Retail</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {opportunities.length > 0 && (
            <button
              onClick={() => exportOpportunitiesReport(opportunities)}
              className="text-xs bg-brand-600 hover:bg-brand-500 px-2.5 py-1 rounded-md transition-colors"
              title="Exportar reporte HTML"
            >
              📄 Reporte
            </button>
          )}
          <button
            onClick={() => setShowAdmin(true)}
            className="text-xs bg-brand-600 hover:bg-brand-500 px-2.5 py-1 rounded-md transition-colors"
          >
            ⚙ Admin
          </button>
          <button
            onClick={() => setIsDark(d => !d)}
            className="text-xs bg-brand-600 hover:bg-brand-500 px-2.5 py-1 rounded-md transition-colors"
          >
            {isDark ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {/* ── Error banner ── */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-800
                        px-4 py-2 text-xs text-red-600 dark:text-red-400 flex items-center justify-between z-[600]">
          <span>⚠ {error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-600">×</button>
        </div>
      )}

      {/* ── Main ── */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Map */}
        <div className="flex-1 relative">
          <MapView
            stores={stores}
            competitors={competitors}
            opportunities={opportunities}
            layers={layers}
            tradeArea={tradeArea}
            onMapClick={handleMapClick}
            loading={mapLoading}
          />
        </div>

        {/* Sidebar */}
        <Sidebar
          opportunities={opportunities}
          tradeArea={tradeArea}
          filters={filters}
          layers={layers}
          loading={loading}
          calculating={calculating}
          onFilterChange={setFilters}
          onLayerToggle={handleLayerToggle}
          onOppClick={handleOppClick}
          onTradeAreaClose={() => setTradeArea(null)}
          onCalculate={handleCalculate}
          onOpenAdmin={() => setShowAdmin(true)}
        />
      </main>

      {/* ── Admin panel modal ── */}
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
    </div>
  );
};

export default App;
