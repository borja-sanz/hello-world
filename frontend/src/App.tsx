import React, { useState, useEffect, useCallback } from 'react';
import MapView from './components/MapView';
import Sidebar from './components/Sidebar';
import AdminPanel from './pages/AdminPanel';
import {
  fetchStores, fetchCompetitors, fetchCompetitorChains,
  fetchOpportunities, fetchBlueOceanOpportunities,
  analyzeTradeArea, calculateAllScores,
  fetchNtlSettlements, fetchSubMunicipioScores, fetchPoiClusters,
  fetchPoiNuclei, fetchCompetitorGaps, buildPoiNuclei, buildCompetitorGaps,
} from './api';
import { exportOpportunitiesReport } from './utils/export';
import type {
  Store, Competitor, OpportunityScore, TradeAreaAnalysis,
  FilterState, LayerState, NtlSettlementsResponse, NtlSettlement, PoiCluster,
  PoiNucleus, CompetitorGap,
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
  const [stores,            setStores]            = useState<Store[]>([]);
  const [competitors,       setCompetitors]       = useState<Competitor[]>([]);
  const [opportunities,     setOpportunities]     = useState<OpportunityScore[]>([]);
  const [chains,            setChains]            = useState<{ chain: string; count: number }[]>([]);
  const [hiddenChains,      setHiddenChains]      = useState<string[]>([]);
  const [hiddenFormats,     setHiddenFormats]     = useState<string[]>([]);
  const [tradeArea,         setTradeArea]         = useState<TradeAreaAnalysis | null>(null);
  const [ntlData,           setNtlData]           = useState<NtlSettlementsResponse | null>(null);
  const [ntlLoading,        setNtlLoading]        = useState(false);
  const [poiClusters,       setPoiClusters]       = useState<PoiCluster[]>([]);
  const [poiNuclei,         setPoiNuclei]         = useState<PoiNucleus[]>([]);
  const [competitorGaps,    setCompetitorGaps]    = useState<CompetitorGap[]>([]);
  const [buildingNuclei,    setBuildingNuclei]    = useState(false);
  const [nucleiNotBuilt,    setNucleiNotBuilt]    = useState(false);
  const [selectedOpp,       setSelectedOpp]       = useState<OpportunityScore | null>(null);
  const [gapFilter,         setGapFilter]         = useState({ high: true, medium: true, low: true });
  const gapsLoadedRef = React.useRef(false);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [loading,      setLoading]      = useState(false);
  const [mapLoading,   setMapLoading]   = useState(false);
  const [calculating,  setCalculating]  = useState(false);
  const [showAdmin,    setShowAdmin]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  const [flyToTarget, setFlyToTarget] = useState<{ lat: number; lng: number; zoom?: number } | null>(null);

  const [layers, setLayers] = useState<LayerState>({
    stores: true, competitors: true, opportunities: true,
    poiNuclei: false, competitorGaps: false,
  });

  const [filters, setFilters] = useState<FilterState>({
    minPopulation: 0, minScore: 0, storeFormat: '', showOnlyGo: false, blueOcean: false,
  });

  // ── Initial data load ─────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    // Core data: stores, competitors, opportunities, chains
    Promise.all([
      fetchStores().catch(() => []),
      fetchCompetitors().catch(() => []),
      fetchOpportunities({ limit: 50 }).catch(() => ({ opportunities: [], cached: false })),
      fetchCompetitorChains().catch(() => []),
    ]).then(([s, c, o, ch]) => {
      setStores(s);
      setCompetitors(c);
      setOpportunities(addCentroidsFromOpps(o.opportunities));
      setChains(ch);
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
      centroid: (o.centroid || o.centroid_geojson)
        ? (() => {
            try {
              const raw = o.centroid || o.centroid_geojson;
              const gj = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
    setSelectedOpp(null);
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
      // Poll every 5s until scored results appear (scoring takes 30–90s server-side)
      const poll = async (attempts: number) => {
        const fresh = await fetchOpportunities({ limit: 50 }).catch(() => ({ opportunities: [], cached: false }));
        const opps = (fresh as any).opportunities ?? [];
        if (opps.length > 0 || attempts <= 0) {
          setOpportunities(addCentroidsFromOpps(opps));
          setCalculating(false);
        } else {
          setTimeout(() => poll(attempts - 1), 5000);
        }
      };
      setTimeout(() => poll(18), 5000); // up to 18 × 5s = 90s
    } catch {
      setCalculating(false);
    }
  }, []);

  // ── Layer toggle — with lazy loading for gaps and nuclei ─────────────────
  const handleLayerToggle = useCallback(async (key: keyof LayerState) => {
    setLayers(l => ({ ...l, [key]: !l[key] }));

    // Lazy-load competitor gaps the first time the layer is turned on
    if (key === 'competitorGaps' && !gapsLoadedRef.current) {
      try {
        const result = await fetchCompetitorGaps({ limit: 200 });
        setCompetitorGaps(result.gaps);
        gapsLoadedRef.current = true;
      } catch (e: any) {
        setError('Error al cargar Brechas: ' + (e?.message ?? 'timeout'));
      }
    }

    // Lazy-load poi nuclei the first time the layer is turned on
    if (key === 'poiNuclei' && poiNuclei.length === 0) {
      try {
        const result = await fetchPoiNuclei({ limit: 200 });
        if (result.nuclei.length > 0) {
          setPoiNuclei(result.nuclei);
          setNucleiNotBuilt(false);
        } else {
          setNucleiNotBuilt(true);
        }
      } catch { setNucleiNotBuilt(true); }
    }
  }, [poiNuclei.length]);

  // ── Chain / format visibility toggles ────────────────────────────────────
  const handleChainToggle = useCallback((chain: string) => {
    setHiddenChains(prev =>
      prev.includes(chain) ? prev.filter(c => c !== chain) : [...prev, chain]
    );
  }, []);

  const handleFormatToggle = useCallback((format: string) => {
    setHiddenFormats(prev =>
      prev.includes(format) ? prev.filter(f => f !== format) : [...prev, format]
    );
  }, []);

  // ── Build POI nuclei (admin action) ──────────────────────────────────────
  const handleBuildNuclei = useCallback(async () => {
    setBuildingNuclei(true);
    setNucleiNotBuilt(false);
    try {
      // Run sequentially to avoid deadlocks from concurrent table locks
      await buildPoiNuclei();
      await buildCompetitorGaps();

      // Poll every 10s for up to 90s until both tables are populated
      const poll = async (attempts: number) => {
        try {
          const [nucleiResult, gapsResult] = await Promise.all([
            fetchPoiNuclei({ limit: 200 }),
            fetchCompetitorGaps({ limit: 200 }),
          ]);
          if (nucleiResult.nuclei.length > 0) {
            setPoiNuclei(nucleiResult.nuclei);
            setNucleiNotBuilt(false);
          }
          if (gapsResult.gaps.length > 0) {
            setCompetitorGaps(gapsResult.gaps);
            gapsLoadedRef.current = true;
          }
          if (nucleiResult.nuclei.length > 0 && gapsResult.gaps.length > 0) {
            setBuildingNuclei(false);
            return;
          }
        } catch { /* keep polling */ }
        if (attempts > 0) {
          setTimeout(() => poll(attempts - 1), 10000);
        } else {
          setBuildingNuclei(false);
          setNucleiNotBuilt(true);
        }
      };
      setTimeout(() => poll(8), 10000); // up to 8 × 10s = 90s
    } catch {
      setBuildingNuclei(false);
    }
  }, []);

  // ── Filtered data passed to map ───────────────────────────────────────────
  const visibleCompetitors = hiddenChains.length === 0
    ? competitors
    : competitors.filter(c => !hiddenChains.includes(c.chain));

  const visibleStores = hiddenFormats.length === 0
    ? stores
    : stores.filter(s => !hiddenFormats.includes(s.format));

  // Filter gaps by priority tier
  const visibleGaps = competitorGaps.filter(g => {
    if (g.gap_score >= 70) return gapFilter.high;
    if (g.gap_score >= 40) return gapFilter.medium;
    return gapFilter.low;
  });

  const gapTierCounts = {
    high:   competitorGaps.filter(g => g.gap_score >= 70).length,
    medium: competitorGaps.filter(g => g.gap_score >= 40 && g.gap_score < 70).length,
    low:    competitorGaps.filter(g => g.gap_score < 40).length,
  };

  // ── Opportunity card click → fly to municipio + load NTL settlements ──────
  const handleOppClick = useCallback(async (opp: OpportunityScore) => {
    setSelectedOpp(opp);
    if (opp.centroid) {
      const lat = opp.centroid.lat as unknown as number;
      const lng = opp.centroid.lng as unknown as number;
      setFlyToTarget({ lat, lng, zoom: 11 });
    }
    // Load NTL settlements, sub-municipio scores, and POI clusters in parallel
    setNtlData(null);
    setPoiClusters([]);
    setNtlLoading(true);
    try {
      const [ntlResult, scoreResult, poiResult] = await Promise.allSettled([
        fetchNtlSettlements(opp.municipio_id),
        fetchSubMunicipioScores(opp.municipio_id, { limit: 10 }),
        fetchPoiClusters(opp.municipio_id),
      ]);

      if (ntlResult.status === 'fulfilled') {
        const ntl = ntlResult.value;
        // Merge sub-municipio scores into settlement rows by id
        if (scoreResult.status === 'fulfilled') {
          const scoreMap = new Map(
            scoreResult.value.settlements.map((s: any) => [s.id, s])
          );
          ntl.settlements = ntl.settlements.map(s => {
            const scored = scoreMap.get(s.id) as any;
            return scored
              ? { ...s, score: scored.score, recommendation: scored.recommendation,
                  suggested_format: scored.suggested_format, factors: scored.factors }
              : s;
          });
          // Re-sort by score descending when scores are available
          ntl.settlements.sort((a, b) => (b.score ?? b.radiance_ntl) - (a.score ?? a.radiance_ntl));
        }
        setNtlData(ntl);
      }
      if (poiResult.status === 'fulfilled') {
        setPoiClusters(poiResult.value.clusters);
      }
    } catch {
      // NTL data is optional — silently skip if unavailable
    } finally {
      setNtlLoading(false);
    }
  }, []);

  // ── NTL settlement clicked → fly to that settlement ───────────────────────
  const handleSettlementClick = useCallback((s: NtlSettlement) => {
    setFlyToTarget({ lat: s.lat, lng: s.lng, zoom: 14 });
  }, []);

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
            stores={visibleStores}
            competitors={visibleCompetitors}
            opportunities={opportunities}
            layers={layers}
            tradeArea={tradeArea}
            onMapClick={handleMapClick}
            loading={mapLoading}
            flyToTarget={flyToTarget}
            ntlSettlements={ntlData?.settlements}
            onNtlClick={handleSettlementClick}
            poiClusters={poiClusters}
            onOppBubbleClick={handleOppClick}
            onPoiClusterClick={(c) => handleMapClick(c.lat, c.lng)}
            poiNuclei={poiNuclei}
            competitorGaps={visibleGaps}
            selectedOpp={selectedOpp}
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
          ntlData={ntlData}
          ntlLoading={ntlLoading}
          onNtlClose={() => { setNtlData(null); setPoiClusters([]); }}
          onSettlementClick={handleSettlementClick}
          chains={chains}
          hiddenChains={hiddenChains}
          onChainToggle={handleChainToggle}
          hiddenFormats={hiddenFormats}
          onFormatToggle={handleFormatToggle}
          nucleiCount={poiNuclei.length}
          gapsCount={visibleGaps.length}
          nucleiNotBuilt={nucleiNotBuilt}
          onBuildNuclei={handleBuildNuclei}
          buildingNuclei={buildingNuclei}
          gapFilter={gapFilter}
          onGapFilterChange={setGapFilter}
          gapTierCounts={gapTierCounts}
        />
      </main>

      {/* ── Admin panel modal ── */}
      {showAdmin && (
        <AdminPanel
          onClose={() => setShowAdmin(false)}
          onDataChanged={() => {
            Promise.all([
              fetchStores().catch(() => [] as typeof stores),
              fetchCompetitors().catch(() => [] as typeof competitors),
            ]).then(([s, c]) => {
              setStores(s);
              setCompetitors(c);
            });
          }}
        />
      )}
    </div>
  );
};

export default App;
