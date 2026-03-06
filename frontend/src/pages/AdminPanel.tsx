import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchCalibrationConfig, updateCalibrationConfig,
  resetCalibrationConfig, recalculateAllScores,
  fetchAdminStats, fetchPoiStatus,
  refreshGooglePois, refreshMercados, refreshDriveTimes, refreshAllGooglePois,
  fetchStoreSummary, clearAllStores, clearAllCompetitors, importStoresCsv, importCompetitorsCsv,
  syncAllGooglePlacesCompetitors, syncGooglePlacesChain, reclaimOwnStores, fixStoreFormats,
  seedGuatemalaZones,
  refreshNtlSettlements,
} from '../api';
import type { CalibrationConfig } from '../types';

interface Props { onClose: () => void; onDataChanged?: () => void; }

interface StoreSummary {
  formats: { format: string; total: string; open: string; planned: string; closed: string }[];
  total: number;
}

interface ImportResult {
  inserted?: number;
  skipped?: number;
  validation_errors?: string[];
  error?: string;
}

interface ChainSyncResult {
  chain: string;
  found: number;
  inserted: number;
  skipped: number;
  error?: string;
  status: 'idle' | 'running' | 'done' | 'error';
}

const GOOGLE_CHAINS = [
  'Super del Barrio',
  'La Bodegona',
  'La Torre',
  'Maxi Bodega',
  'Suma Express',
  'Econosuper',
  'Super Más',
  'Unisuper',
];

const FORMAT_COLORS: Record<string, string> = {
  'Despensa Familiar': '#16a34a',
  'Maxi Despensa':     '#2563eb',
  'Walmart':           '#0891b2',
  'Paiz':              '#7c3aed',
  'Other':             '#6b7280',
};

const AdminPanel: React.FC<Props> = ({ onClose, onDataChanged }) => {
  const [config,        setConfig]        = useState<CalibrationConfig | null>(null);
  const [stats,         setStats]         = useState<any>(null);
  const [storeSummary,  setStoreSummary]  = useState<StoreSummary | null>(null);
  const [poiStatus,     setPoiStatus]     = useState<any>(null);
  const [saving,        setSaving]        = useState(false);
  const [importing,         setImporting]         = useState(false);
  const [importResult,      setImportResult]      = useState<ImportResult | null>(null);
  const [importingComp,     setImportingComp]     = useState(false);
  const [importCompResult,  setImportCompResult]  = useState<ImportResult | null>(null);
  const [msg,               setMsg]               = useState('');
  const [tab,               setTab]               = useState<'weights' | 'thresholds' | 'stores' | 'competitors' | 'system'>('weights');
  const fileInputRef     = useRef<HTMLInputElement>(null);
  const compFileInputRef = useRef<HTMLInputElement>(null);

  // Google Places competitor sync
  const [googleApiKey,    setGoogleApiKey]    = useState('');
  const [syncingGoogle,   setSyncingGoogle]   = useState(false);
  const [chainResults,    setChainResults]    = useState<ChainSyncResult[]>(
    GOOGLE_CHAINS.map(chain => ({ chain, found: 0, inserted: 0, skipped: 0, status: 'idle' }))
  );

  const load = useCallback(async () => {
    try {
      const [c, s, ps, ss] = await Promise.all([
        fetchCalibrationConfig(),
        fetchAdminStats(),
        fetchPoiStatus().catch(() => null),
        fetchStoreSummary().catch(() => null),
      ]);
      setConfig(c); setStats(s); setPoiStatus(ps); setStoreSummary(ss);
    } catch {
      setMsg('Error cargando configuración');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await updateCalibrationConfig(config);
      setMsg('✅ Guardado correctamente');
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Error al guardar'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('¿Restaurar pesos calibrados (real-data-v2)?')) return;
    try {
      const { config: c } = await resetCalibrationConfig();
      setConfig(c);
      setMsg('✅ Restaurado a real-data-v2');
    } catch { setMsg('❌ Error'); }
  };

  const handleRecalculate = async () => {
    try {
      setMsg('⏳ Recalculando (puede tardar ~60s)…');
      await recalculateAllScores();
      setMsg('✅ Recálculo iniciado');
    } catch { setMsg('❌ Error'); }
  };

  const handleRefreshPois = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key en la pestaña Competidores primero'); return; }
    try {
      setMsg('⏳ Actualizando POIs comerciales (~5 min, ~$4–12)…');
      await refreshGooglePois(googleApiKey.trim());
      setMsg('✅ Actualización de POIs iniciada en background');
    } catch { setMsg('❌ Error al iniciar actualización de POIs'); }
  };

  const handleRefreshMercados = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key en la pestaña Competidores primero'); return; }
    try {
      setMsg('⏳ Buscando mercados informales (~1 min, ~$0.37)…');
      await refreshMercados(googleApiKey.trim());
      setMsg('✅ Búsqueda de mercados iniciada en background');
    } catch { setMsg('❌ Error'); }
  };

  const handleRefreshDriveTimes = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key en la pestaña Competidores primero'); return; }
    try {
      setMsg('⏳ Calculando tiempos de viaje a capital (~30 s, ~$0.34)…');
      await refreshDriveTimes(googleApiKey.trim());
      setMsg('✅ Cálculo de tiempos de viaje iniciado');
    } catch { setMsg('❌ Error'); }
  };

  const handleRefreshAll = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key en la pestaña Competidores primero'); return; }
    if (!confirm('Esto actualizará todos los datos de POIs: tiempos de viaje, mercados, iglesias y POIs comerciales.\nCosto estimado: $5–13. ¿Continuar?')) return;
    try {
      setMsg('⏳ Actualización completa iniciada (~15 min, ~$5–13)…');
      await refreshAllGooglePois(googleApiKey.trim());
      setMsg('✅ Actualización completa en background — recalcula scores cuando termine');
    } catch { setMsg('❌ Error'); }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const result = await importStoresCsv(file);
      setImportResult(result);
      await load();
    } catch (e: any) {
      setImportResult({
        error: e.response?.data?.error ?? 'Error al importar',
        validation_errors: e.response?.data?.errors,
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImportCompetitors = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingComp(true);
    setImportCompResult(null);
    try {
      const result = await importCompetitorsCsv(file);
      setImportCompResult(result);
    } catch (e: any) {
      setImportCompResult({
        error: e.response?.data?.error ?? 'Error al importar',
        validation_errors: e.response?.data?.errors,
      });
    } finally {
      setImportingComp(false);
      if (compFileInputRef.current) compFileInputRef.current.value = '';
    }
  };

  const handleClearCompetitors = async () => {
    const count = stats?.competitor_count ?? '?';
    if (!confirm(`¿Eliminar los ${count} competidores actuales? Esta acción no se puede deshacer.`)) return;
    try {
      const { deleted } = await clearAllCompetitors();
      setMsg(`✅ ${deleted} competidores eliminados`);
    } catch { setMsg('❌ Error al eliminar competidores'); }
  };

  const handleClearStores = async () => {
    const count = storeSummary?.total ?? stats?.store_count ?? '?';
    if (!confirm(`¿Eliminar las ${count} tiendas actuales? Esta acción no se puede deshacer.\n\nUsa esta opción antes de importar tu red real.`)) return;
    try {
      const res = await clearAllStores();
      setMsg(`✅ ${res.deleted} tiendas eliminadas`);
      setImportResult(null);
      await load();
    } catch { setMsg('❌ Error al eliminar tiendas'); }
  };

  const handleSeedGuatemalaZones = async () => {
    try {
      setMsg('⏳ Sembrando zonas de Ciudad de Guatemala…');
      const res = await seedGuatemalaZones();
      setMsg(`✅ ${res.message}`);
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Error al sembrar zonas'}`);
    }
  };

  const handleRefreshNtlSettlements = async () => {
    try {
      setMsg('⏳ Actualizando asentamientos nacionales desde OpenStreetMap…');
      const res = await refreshNtlSettlements();
      setMsg(`✅ ${res.message}`);
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Error al actualizar asentamientos'}`);
    }
  };

  const handleFixStoreFormats = async () => {
    try {
      const res = await fixStoreFormats();
      setMsg(`✅ ${res.message}`);
      await load();
      onDataChanged?.();
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Error al corregir formatos'}`);
    }
  };

  const handleReclaimOwnStores = async () => {
    if (!confirm('Esto buscará en la tabla de competidores tiendas llamadas "Maxi Despensa", "Maxi Bodega" o "Despensa Familiar" y las moverá a tus tiendas propias. ¿Continuar?')) return;
    try {
      const res = await reclaimOwnStores();
      setMsg(`✅ ${res.message}`);
      await load();
      onDataChanged?.();
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Error al reclamar tiendas'}`);
    }
  };

  const handleGoogleSyncChain = async (chain: string) => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API key de Google'); return; }
    setChainResults(prev => prev.map(r => r.chain === chain ? { ...r, status: 'running' } : r));
    try {
      const result = await syncGooglePlacesChain(googleApiKey.trim(), chain);
      setChainResults(prev => prev.map(r =>
        r.chain === chain
          ? { ...r, ...result, status: result.error ? 'error' : 'done' }
          : r
      ));
    } catch (e: any) {
      setChainResults(prev => prev.map(r =>
        r.chain === chain ? { ...r, status: 'error', error: e.response?.data?.error ?? e.message } : r
      ));
    }
  };

  const handleGoogleSyncAll = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API key de Google'); return; }
    if (!confirm('Esto buscará todas las cadenas competidoras en Google Maps (~$0.40 en créditos de API). ¿Continuar?')) return;
    setSyncingGoogle(true);
    setMsg('');
    setChainResults(prev => prev.map(r => ({ ...r, status: 'running' })));
    try {
      await syncAllGooglePlacesCompetitors(googleApiKey.trim());
      setMsg('Sincronización iniciada — los resultados aparecen en unos 30s');
      // Poll chain-by-chain for feedback using individual sync calls
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Error'}`);
      setChainResults(prev => prev.map(r => ({ ...r, status: r.status === 'running' ? 'error' : r.status })));
    } finally {
      setSyncingGoogle(false);
    }
  };

  if (!config) {
    return (
      <div className="fixed inset-0 bg-black/50 z-[2000] flex items-center justify-center">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-8">Cargando…</div>
      </div>
    );
  }

  const totalWeight = (
    config.weight_population + config.weight_mobility + config.weight_commercial +
    config.weight_competition + config.weight_socioeconomic
  );
  const weightOk = Math.abs(totalWeight - 1.0) < 0.01;

  // Labels without hardcoded percentages — the slider shows the live value
  const WEIGHTS: { key: keyof CalibrationConfig; label: string; color: string }[] = [
    { key: 'weight_population',    label: 'Población',          color: '#3b82f6' },
    { key: 'weight_mobility',      label: 'Accesibilidad',      color: '#8b5cf6' },
    { key: 'weight_commercial',    label: 'Densidad Comercial', color: '#f97316' },
    { key: 'weight_competition',   label: 'Competencia',        color: '#14b8a6' },
    { key: 'weight_socioeconomic', label: 'Socioeconómico',     color: '#ec4899' },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-[2000] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh]
                      flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">Panel de Calibración</h2>
            <p className="text-xs text-gray-400">Ajuste de pesos, umbrales y datos de tiendas</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
          {([
            ['weights',      'Pesos'],
            ['thresholds',   'Umbrales'],
            ['stores',       'Tiendas'],
            ['competitors',  'Competidores'],
            ['system',       'Sistema'],
          ] as const).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* ── Weights tab ── */}
          {tab === 'weights' && (
            <div className="space-y-5">
              <div className={`text-xs px-3 py-1.5 rounded-full text-center font-medium ${
                weightOk ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}>
                Suma de pesos: {(totalWeight * 100).toFixed(0)}% {weightOk ? '✓' : '— debe ser 100%'}
              </div>

              {WEIGHTS.map(({ key, label, color }) => (
                <div key={key}>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>
                    <span className="font-bold tabular-nums" style={{ color }}>
                      {((config[key] as number) * 100).toFixed(0)}%
                    </span>
                  </div>
                  <input
                    type="range" min={0} max={0.6} step={0.01}
                    value={config[key] as number}
                    onChange={e => setConfig({ ...config, [key]: Number(e.target.value) })}
                    className="w-full h-2"
                    style={{ accentColor: color }}
                  />
                </div>
              ))}

              <p className="text-xs text-gray-400">
                Valores por defecto (real-data-v2): Población 28%, Accesibilidad 22%, Comercial 22%, Competencia 15%, Socioeconómico 13%
              </p>
            </div>
          )}

          {/* ── Thresholds tab ── */}
          {tab === 'thresholds' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Umbral Despensa Familiar (personas)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number" min={5000} max={100000} step={1000}
                    value={config.despensa_familiar_min_pop}
                    onChange={e => setConfig({ ...config, despensa_familiar_min_pop: Number(e.target.value) })}
                    className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm
                               bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                  />
                  <span className="text-sm text-gray-400">{(config.despensa_familiar_min_pop / 1000).toFixed(0)}k</span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Umbral Maxi Despensa (personas)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number" min={10000} max={200000} step={5000}
                    value={config.maxi_despensa_min_pop}
                    onChange={e => setConfig({ ...config, maxi_despensa_min_pop: Number(e.target.value) })}
                    className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm
                               bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                  />
                  <span className="text-sm text-gray-400">{(config.maxi_despensa_min_pop / 1000).toFixed(0)}k</span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Override accesibilidad → Maxi Despensa ({(config.mobility_override_threshold * 100).toFixed(0)}%)
                </label>
                <input
                  type="range" min={0.5} max={1.0} step={0.05}
                  value={config.mobility_override_threshold}
                  onChange={e => setConfig({ ...config, mobility_override_threshold: Number(e.target.value) })}
                  className="w-full h-2 accent-purple-600"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Si accesibilidad ≥ este umbral, se recomienda Maxi aunque la población sea menor
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Override comercio → Maxi Despensa ({(config.commercial_override_threshold * 100).toFixed(0)}%)
                </label>
                <input
                  type="range" min={0.5} max={1.0} step={0.05}
                  value={config.commercial_override_threshold}
                  onChange={e => setConfig({ ...config, commercial_override_threshold: Number(e.target.value) })}
                  className="w-full h-2 accent-orange-600"
                />
              </div>
            </div>
          )}

          {/* ── Stores tab ── */}
          {tab === 'stores' && (
            <div className="space-y-5">

              {/* Format breakdown */}
              {storeSummary && storeSummary.formats.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                    Red actual — {storeSummary.total} tiendas
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {storeSummary.formats.map(f => (
                      <div key={f.format}
                           className="rounded-lg p-3 border-l-4"
                           style={{ borderColor: FORMAT_COLORS[f.format] ?? '#6b7280',
                                    backgroundColor: `${FORMAT_COLORS[f.format] ?? '#6b7280'}12` }}>
                        <div className="text-xl font-bold text-gray-800 dark:text-gray-100">{f.total}</div>
                        <div className="text-xs font-medium text-gray-600 dark:text-gray-300">{f.format}</div>
                        <div className="text-xs text-gray-400">
                          {f.open} abiertas · {f.planned} planificadas
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-gray-400 text-center py-4">
                  No hay tiendas en la base de datos
                </div>
              )}

              {/* CSV Import */}
              <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 space-y-3">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Importar tiendas desde CSV
                </p>
                <div className="text-xs text-gray-500 bg-gray-50 dark:bg-gray-700/50 rounded p-2 font-mono leading-relaxed">
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mb-1">Columnas requeridas:</div>
                  store_name, format, lat, lng<br/>
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mt-1 mb-1">Columnas opcionales:</div>
                  status, department, municipio, open_date, notes<br/>
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mt-1 mb-1">Formatos válidos:</div>
                  Despensa Familiar · Maxi Despensa · Walmart · Paiz
                </div>
                <label className={`flex items-center justify-center gap-2 w-full py-2 px-4 rounded-lg border
                                  text-sm font-medium cursor-pointer transition-colors
                                  ${importing
                                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                                    : 'bg-brand-50 hover:bg-brand-100 text-brand-700 border-brand-300 dark:bg-brand-900/20 dark:text-brand-400 dark:border-brand-700'
                                  }`}>
                  {importing ? '⏳ Importando…' : '📂 Seleccionar archivo CSV'}
                  <input
                    ref={fileInputRef}
                    type="file" accept=".csv" className="hidden"
                    onChange={handleImport} disabled={importing}
                  />
                </label>

                {importResult && (
                  <div className={`text-sm p-3 rounded-lg ${
                    importResult.error
                      ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                      : 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                  }`}>
                    {importResult.error ? (
                      <>
                        ❌ {importResult.error}
                        {(importResult.validation_errors?.length ?? 0) > 0 && (
                          <ul className="mt-1 text-xs opacity-80 list-disc list-inside">
                            {importResult.validation_errors!.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                            {importResult.validation_errors!.length > 10 && (
                              <li>…y {importResult.validation_errors!.length - 10} más</li>
                            )}
                          </ul>
                        )}
                      </>
                    ) : (
                      <>
                        ✅ {importResult.inserted} tiendas importadas
                        {(importResult.skipped ?? 0) > 0 && `, ${importResult.skipped} omitidas`}
                        {(importResult.validation_errors?.length ?? 0) > 0 && (
                          <ul className="mt-1 text-xs opacity-80 list-disc list-inside">
                            {importResult.validation_errors!.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                            {importResult.validation_errors!.length > 5 && (
                              <li>…y {importResult.validation_errors!.length - 5} más</li>
                            )}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Clear stores — danger zone */}
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <p className="text-xs text-gray-500 mb-2">
                  Para cargar tu red real desde cero, elimina primero las tiendas de ejemplo.
                  Esta acción no puede deshacerse.
                </p>
                <button
                  onClick={handleClearStores}
                  className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
                >
                  Eliminar todas las tiendas ({storeSummary?.total ?? stats?.store_count ?? 0})
                </button>
              </div>
            </div>
          )}

          {/* ── Competitors tab ── */}
          {tab === 'competitors' && (
            <div className="space-y-5">

              {/* CSV Import */}
              <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 space-y-3">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Importar competidores desde CSV
                </p>
                <div className="text-xs text-gray-500 bg-gray-50 dark:bg-gray-700/50 rounded p-2 font-mono leading-relaxed">
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mb-1">Columnas requeridas:</div>
                  comp_name, chain, lat, lng<br/>
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mt-1 mb-1">Columnas opcionales:</div>
                  address, municipio, department, notes<br/>
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mt-1 mb-0.5">Alias aceptados:</div>
                  <span className="opacity-70">name/nombre → comp_name · cadena → chain · latitude → lat · longitude → lng</span>
                </div>
                <label className={`flex items-center justify-center gap-2 w-full py-2 px-4 rounded-lg border
                                  text-sm font-medium cursor-pointer transition-colors
                                  ${importingComp
                                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                                    : 'bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-700'
                                  }`}>
                  {importingComp ? '⏳ Importando…' : '📂 Seleccionar archivo CSV'}
                  <input
                    ref={compFileInputRef}
                    type="file" accept=".csv" className="hidden"
                    onChange={handleImportCompetitors} disabled={importingComp}
                  />
                </label>

                {importCompResult && (
                  <div className={`text-sm p-3 rounded-lg ${
                    importCompResult.error
                      ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                      : 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                  }`}>
                    {importCompResult.error ? (
                      <>
                        ❌ {importCompResult.error}
                        {(importCompResult.validation_errors?.length ?? 0) > 0 && (
                          <ul className="mt-1 text-xs opacity-80 list-disc list-inside">
                            {importCompResult.validation_errors!.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                            {importCompResult.validation_errors!.length > 10 && (
                              <li>…y {importCompResult.validation_errors!.length - 10} más</li>
                            )}
                          </ul>
                        )}
                      </>
                    ) : (
                      <>
                        ✅ {importCompResult.inserted} competidores importados
                        {(importCompResult.skipped ?? 0) > 0 && `, ${importCompResult.skipped} omitidos`}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Clear competitors — danger zone */}
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <p className="text-xs text-gray-500 mb-2">
                  Elimina todos los competidores existentes antes de importar tu CSV.
                  Esta acción no puede deshacerse.
                </p>
                <button
                  onClick={handleClearCompetitors}
                  className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
                >
                  Eliminar todos los competidores ({stats?.competitor_count ?? 0})
                </button>
              </div>

              {/* Reclaim own stores */}
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-1">
                  Corregir tiendas propias mal clasificadas
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">
                  Mueve a "Mis Tiendas" cualquier competidor cuyo nombre incluya
                  <strong> Maxi Despensa</strong>, <strong>Maxi Bodega</strong> o <strong>Despensa Familiar</strong>.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleReclaimOwnStores}
                    className="flex-1 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium transition-colors"
                  >
                    Reclamar tiendas propias
                  </button>
                  <button
                    onClick={handleFixStoreFormats}
                    className="flex-1 py-2 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-sm font-medium transition-colors"
                    title="Corrige el campo 'format' de tiendas cuyo nombre incluya Despensa Familiar / Maxi Despensa / Maxi Bodega"
                  >
                    Corregir formatos
                  </button>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Sincronizar competidores desde Google Maps
                </p>
                <p className="text-xs text-gray-500 mb-3">
                  Usa la API de Google Places para encontrar tiendas de cadenas competidoras en toda Guatemala.
                  Cobertura mucho mejor que OSM (~95% vs ~10–20%).
                  Costo estimado: ~$0.40 por sincronización completa.
                </p>

                {/* API Key input */}
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  API Key de Google Cloud (Places API)
                </label>
                <input
                  type="password"
                  placeholder="AIza..."
                  value={googleApiKey}
                  onChange={e => setGoogleApiKey(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm
                             bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 font-mono mb-3"
                />
                <p className="text-xs text-gray-400 mb-3">
                  Necesitas una clave con la API de "Places" habilitada en Google Cloud Console.
                  La clave no se almacena — sólo se usa para esta solicitud.
                </p>

                {/* Sync all button */}
                <button
                  onClick={handleGoogleSyncAll}
                  disabled={syncingGoogle || !googleApiKey.trim()}
                  className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium
                             transition-colors disabled:opacity-50 mb-4"
                >
                  {syncingGoogle ? '⏳ Sincronizando…' : 'Sincronizar todas las cadenas'}
                </button>

                {/* Per-chain table */}
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                  O sincroniza cadena por cadena:
                </p>
                <div className="space-y-1.5">
                  {chainResults.map(r => (
                    <div key={r.chain}
                         className="flex items-center justify-between gap-2 rounded-lg px-3 py-2
                                    bg-gray-50 dark:bg-gray-700/50">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                          {r.chain}
                        </div>
                        {r.status === 'done' && (
                          <div className="text-xs text-green-600 dark:text-green-400">
                            {r.found} encontradas · {r.inserted} nuevas · {r.skipped} ya existían
                          </div>
                        )}
                        {r.status === 'error' && (
                          <div className="text-xs text-red-500 truncate">{r.error}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {r.status === 'running' && (
                          <span className="text-xs text-blue-500 animate-pulse">buscando…</span>
                        )}
                        {r.status === 'done' && <span className="text-green-500">✓</span>}
                        {r.status === 'error' && <span className="text-red-500">✕</span>}
                        <button
                          onClick={() => handleGoogleSyncChain(r.chain)}
                          disabled={r.status === 'running' || syncingGoogle}
                          className="px-2.5 py-1 rounded text-xs bg-blue-100 hover:bg-blue-200 text-blue-700
                                     dark:bg-blue-900/30 dark:text-blue-400 disabled:opacity-40 transition-colors"
                        >
                          Buscar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── System tab ── */}
          {tab === 'system' && (
            <div className="space-y-4">
              {/* Stats grid */}
              {stats && (
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['Municipios',            stats.municipio_count],
                    ['Nuestras tiendas',      stats.store_count],
                    ['Tiendas abiertas',      stats.open_stores],
                    ['Competidores',          stats.competitor_count],
                    ['Cadenas comp.',         stats.competitor_chains],
                    ['Registros de score',    stats.score_records],
                    ['POIs (Google)',          stats.google_poi_count ?? 0],
                    ['Mercados informales',   stats.mercado_count ?? 0],
                    ['Tiempos de viaje',      `${stats.drive_time_coverage ?? 0}/${stats.municipio_count ?? 0}`],
                  ] as [string, string | number][]).map(([label, val]) => (
                    <div key={label}
                         className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                      <div className="text-lg font-bold text-gray-800 dark:text-gray-100">
                        {typeof val === 'number' ? val.toLocaleString() : val}
                      </div>
                      <div className="text-xs text-gray-500">{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Google POI status */}
              {poiStatus && (
                <div className="text-xs text-gray-500 border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-1">
                  <div className="font-medium text-gray-700 dark:text-gray-300">Estado Google POIs</div>
                  <div>{(poiStatus.total ?? 0).toLocaleString()} POIs en caché</div>
                  <div className="text-gray-400">
                    Mercados: {poiStatus.by_type?.marketplace ?? 0} ·
                    Bancos: {poiStatus.by_type?.bank ?? 0} ·
                    Farmacias: {poiStatus.by_type?.pharmacy ?? 0} ·
                    Iglesias SUD: {poiStatus.by_type?.lds_church ?? 0}
                  </div>
                  <div className="text-gray-400">
                    Tiempos de viaje: {poiStatus.drive_time_coverage ?? 0} municipios
                  </div>
                  {poiStatus.recent_refreshes?.[0] && (
                    <div className="text-gray-400">
                      Última actualización: {new Date(poiStatus.recent_refreshes[0].executed_at).toLocaleString()}
                    </div>
                  )}
                </div>
              )}

              {/* Recalculate */}
              <button
                onClick={handleRecalculate}
                className="w-full py-2 px-4 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
              >
                Recalcular todos los scores
              </button>

              {/* Google POI refresh section */}
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Actualizar datos Google Maps
                </p>
                <p className="text-xs text-gray-400">
                  Usa la API Key ingresada en la pestaña Competidores. Los tiempos de viaje son un
                  indicador de accesibilidad logística. Los mercados informales pesan
                  3× en la puntuación comercial — actualizar mensualmente.
                </p>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    onClick={handleRefreshDriveTimes}
                    className="w-full py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium transition-colors text-left"
                  >
                    Tiempos de viaje → capital (~30 s, ~$0.34)
                  </button>
                  <button
                    onClick={handleRefreshMercados}
                    className="w-full py-2 px-3 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-xs font-medium transition-colors text-left"
                  >
                    Mercados informales (~1 min, ~$0.37)
                  </button>
                  <button
                    onClick={handleRefreshNtlSettlements}
                    className="w-full py-2 px-3 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium transition-colors text-left"
                    title="Descarga todos los lugares poblados de Guatemala desde OpenStreetMap (aldeas, caseríos, pueblos) para los 254 municipios. Preserva las zonas de Ciudad de Guatemala."
                  >
                    Asentamientos nacionales — todos los municipios (OSM)
                  </button>
                  <button
                    onClick={handleSeedGuatemalaZones}
                    className="w-full py-2 px-3 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium transition-colors text-left"
                    title="Inserta las 22 zonas administrativas de Ciudad de Guatemala en ntl_settlements para mejorar el detalle del desglose sub-municipio"
                  >
                    Zonas Ciudad de Guatemala (sub-municipio)
                  </button>
                  <button
                    onClick={handleRefreshPois}
                    className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors text-left"
                  >
                    POIs comerciales: bancos, farmacias, escuelas… (~5 min, ~$4–12)
                  </button>
                  <button
                    onClick={handleRefreshAll}
                    className="w-full py-2 px-3 rounded-lg bg-gray-700 hover:bg-gray-800 text-white text-xs font-medium transition-colors text-left"
                  >
                    Actualización completa (~15 min, ~$5–13)
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {msg && (
          <div className="px-5 py-2 text-sm text-center text-gray-600 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
            {msg}
          </div>
        )}
        {(tab === 'weights' || tab === 'thresholds') && (
          <div className="flex gap-2 px-5 py-3 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleReset}
              className="flex-1 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Restaurar defaults
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !weightOk}
              className="flex-1 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminPanel;
