import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchCalibrationConfig, updateCalibrationConfig,
  resetCalibrationConfig, recalculateAllScores,
  fetchAdminStats, fetchPoiStatus, fetchPoiProgress,
  refreshGooglePois, refreshMercados, refreshDriveTimes, refreshAllGooglePois,
  fetchStoreSummary, clearAllStores, clearAllCompetitors, importStoresCsv, importCompetitorsCsv,
  savePoiSeed,
  loadPoiSeed,
  refreshDepartmentPois,
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


const FORMAT_COLORS: Record<string, string> = {
  'Despensa Familiar': '#16a34a',
  'Maxi Despensa':     '#2563eb',
  'Walmart':           '#0891b2',
  'Paiz':              '#7c3aed',
  'Other':             '#6b7280',
};

const AdminPanel: React.FC<Props> = ({ onClose, onDataChanged: _onDataChanged }) => {
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
  const [selectedDept,      setSelectedDept]      = useState('Guatemala');
  const fileInputRef     = useRef<HTMLInputElement>(null);
  const compFileInputRef = useRef<HTMLInputElement>(null);

  // POI refresh progress polling
  const [poiProgress, setPoiProgress] = useState<{
    active: boolean; phase: string; step: string;
    current: number; total: number; inserted: number; error: string | null;
  } | null>(null);
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startProgressPolling = () => {
    if (progressPollRef.current) return; // already polling
    progressPollRef.current = setInterval(async () => {
      try {
        const p = await fetchPoiProgress();
        setPoiProgress(p);
        if (!p.active) {
          clearInterval(progressPollRef.current!);
          progressPollRef.current = null;
          // Refresh stats after completion
          load();
        }
      } catch { /* ignore */ }
    }, 2000);
  };

  // Clean up poll on unmount
  React.useEffect(() => () => {
    if (progressPollRef.current) clearInterval(progressPollRef.current);
  }, []);

  const [googleApiKey, setGoogleApiKey] = useState('');

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

  const handleRefreshDepartment = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key de Google en la pestaña Sistema'); return; }
    try {
      setMsg(`⏳ Sincronizando POIs de ${selectedDept} (~20–60 s)…`);
      await refreshDepartmentPois(selectedDept, googleApiKey.trim());
      setMsg('');
      startProgressPolling();
    } catch { setMsg(`❌ Error al sincronizar ${selectedDept}`); }
  };

  const handleRefreshPois = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key de Google en la pestaña Sistema'); return; }
    try {
      setMsg('⏳ Actualizando POIs comerciales (~5 min, ~$4–12)…');
      await refreshGooglePois(googleApiKey.trim());
      setMsg('');
      startProgressPolling();
    } catch { setMsg('❌ Error al iniciar actualización de POIs'); }
  };

  const handleRefreshMercados = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key de Google en la pestaña Sistema'); return; }
    try {
      setMsg('⏳ Buscando mercados informales (~1 min, ~$0.37)…');
      await refreshMercados(googleApiKey.trim());
      setMsg('');
      startProgressPolling();
    } catch { setMsg('❌ Error'); }
  };

  const handleRefreshDriveTimes = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key de Google en la pestaña Sistema'); return; }
    try {
      setMsg('⏳ Calculando tiempos de viaje a capital (~30 s, ~$0.34)…');
      await refreshDriveTimes(googleApiKey.trim());
      setMsg('');
      startProgressPolling();
    } catch { setMsg('❌ Error'); }
  };

  const handleRefreshAll = async () => {
    if (!googleApiKey.trim()) { setMsg('Ingresa tu API Key de Google en la pestaña Sistema'); return; }
    if (!confirm('Esto actualizará todos los datos de POIs: tiempos de viaje, mercados, iglesias y POIs comerciales.\nCosto estimado: $5–13. ¿Continuar?')) return;
    try {
      setMsg('');
      await refreshAllGooglePois(googleApiKey.trim());
      startProgressPolling();
    } catch { setMsg('❌ Error'); }
  };

  const handleSavePoiSeed = async () => {
    try {
      setMsg('⏳ Guardando snapshot de POIs…');
      const r = await savePoiSeed();
      setMsg(`✅ ${r.message}`);
    } catch { setMsg('❌ Error al guardar seed'); }
  };

  const handleLoadPoiSeed = async () => {
    try {
      setMsg('⏳ Cargando POIs desde seed…');
      const r = await loadPoiSeed();
      setMsg(`✅ ${r.message}`);
    } catch { setMsg('❌ Error al cargar seed'); }
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
      const errData = e.response?.data;
      const detail = errData?.detail ? ` (${errData.detail})` : '';
      setImportResult({
        error: (errData?.error ?? 'Error al importar') + detail,
        validation_errors: errData?.errors,
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
      const errData = e.response?.data;
      const detail = errData?.detail ? ` (${errData.detail})` : '';
      setImportCompResult({
        error: (errData?.error ?? 'Error al importar') + detail,
        validation_errors: errData?.errors,
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

              {/* Live POI refresh progress bar */}
              {poiProgress && (poiProgress.active || poiProgress.error) && (() => {
                const pct = poiProgress.total > 0
                  ? Math.round((poiProgress.current / poiProgress.total) * 100)
                  : 0;
                const phaseLabels: Record<string, string> = {
                  drive_times: 'Tiempos de viaje',
                  mercados:    'Mercados informales',
                  lds:         'Iglesias SUD',
                  pois:        'POIs comerciales',
                  osm_seed:    'POIs OpenStreetMap',
                  idle:        'Inactivo',
                };
                return (
                  <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-2 bg-blue-50 dark:bg-blue-900/20">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-blue-800 dark:text-blue-300">
                        {poiProgress.active ? '⏳' : poiProgress.error ? '❌' : '✅'}{' '}
                        {phaseLabels[poiProgress.phase] ?? poiProgress.phase}
                      </span>
                      <span className="text-blue-600 dark:text-blue-400 font-mono">
                        {poiProgress.current}/{poiProgress.total} · {poiProgress.inserted} POIs
                      </span>
                    </div>
                    <div className="h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          poiProgress.error ? 'bg-red-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${poiProgress.active ? Math.max(pct, 3) : 100}%` }}
                      />
                    </div>
                    {poiProgress.step && (
                      <p className="text-[10px] text-blue-600 dark:text-blue-400 truncate">
                        {poiProgress.step}
                      </p>
                    )}
                    {poiProgress.error && (
                      <p className="text-[10px] text-red-600 dark:text-red-400">{poiProgress.error}</p>
                    )}
                    {!poiProgress.active && !poiProgress.error && (
                      <p className="text-[10px] text-blue-600 dark:text-blue-400">
                        ✅ Completado — {poiProgress.inserted} POIs insertados
                      </p>
                    )}
                  </div>
                );
              })()}

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
                  Los tiempos de viaje son un indicador de accesibilidad logística.
                  Los mercados informales pesan 3× en la puntuación comercial — actualizar mensualmente.
                </p>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-0.5">
                  API Key de Google Cloud (Places API)
                </label>
                <input
                  type="password"
                  placeholder="AIza..."
                  value={googleApiKey}
                  onChange={e => setGoogleApiKey(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm
                             bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 font-mono"
                />
                <p className="text-xs text-gray-400">
                  Necesitas una clave con la API de "Places" habilitada en Google Cloud Console.
                  La clave no se almacena — sólo se usa para esta solicitud.
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
                  {/* Per-department sync */}
                  <div className="flex gap-2 items-center">
                    <select
                      value={selectedDept}
                      onChange={e => setSelectedDept(e.target.value)}
                      className="flex-1 py-1.5 px-2 rounded-lg bg-gray-700 text-white text-xs border border-gray-600 focus:outline-none"
                    >
                      {[
                        'Alta Verapaz','Baja Verapaz','Chimaltenango','Chiquimula',
                        'El Progreso','Escuintla','Guatemala','Huehuetenango',
                        'Izabal','Jalapa','Jutiapa','Petén','Quetzaltenango',
                        'Quiché','Retalhuleu','Sacatepéquez','San Marcos',
                        'Santa Rosa','Sololá','Suchitepéquez','Totonicapán','Zacapa',
                      ].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <button
                      onClick={handleRefreshDepartment}
                      className="py-1.5 px-3 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium transition-colors whitespace-nowrap"
                      title="Sincroniza solo este departamento (~20–60 s, ~$0.20–0.55). Los resultados aparecen en el mapa al terminar."
                    >
                      Sync depto
                    </button>
                  </div>
                  <button
                    onClick={handleRefreshPois}
                    className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors text-left"
                  >
                    POIs comerciales: todos los deptos (~5 min, ~$4–12)
                  </button>
                  <button
                    onClick={handleRefreshAll}
                    className="w-full py-2 px-3 rounded-lg bg-gray-700 hover:bg-gray-800 text-white text-xs font-medium transition-colors text-left"
                  >
                    Actualización completa (~15 min, ~$5–13)
                  </button>
                </div>
              </div>

              {/* POI persistence */}
              <div className="border border-emerald-200 dark:border-emerald-800 rounded-lg p-3 space-y-2 bg-emerald-50 dark:bg-emerald-900/20">
                <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                  💾 Persistencia de POIs entre sesiones
                </p>
                <p className="text-xs text-emerald-700 dark:text-emerald-400">
                  Guarda una copia de los POIs en el repositorio para que no se pierdan al reiniciar.
                  Se guarda automáticamente al terminar cada sync de Google. Si ya tienes POIs cargados
                  y quieres guardarlos ahora, haz clic en "Guardar".
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleSavePoiSeed}
                    className="flex-1 py-1.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium transition-colors"
                    title="Exporta poi_cache → backend/data/poi_cache_seed.json. Commitea ese archivo para persistir."
                  >
                    💾 Guardar POIs ahora
                  </button>
                  <button
                    onClick={handleLoadPoiSeed}
                    className="flex-1 py-1.5 px-3 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium transition-colors"
                    title="Carga poi_cache_seed.json en poi_cache si la tabla está vacía"
                  >
                    📂 Cargar desde seed
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
