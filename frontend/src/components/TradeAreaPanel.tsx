import React from 'react';
import ScoreBadge from './ScoreBadge';
import type { TradeAreaAnalysis, PoiBreakdown, FactorScores } from '../types';

const FACTOR_LABELS: { key: keyof FactorScores; label: string; color: string; weight: string }[] = [
  { key: 'population',    label: 'Población',      color: 'bg-blue-500',   weight: '28%' },
  { key: 'mobility',      label: 'Accesibilidad',  color: 'bg-purple-500', weight: '22%' },
  { key: 'commercial',    label: 'Comercio',       color: 'bg-orange-500', weight: '22%' },
  { key: 'competition',   label: 'Competencia',    color: 'bg-teal-500',   weight: '15%' },
  { key: 'socioeconomic', label: 'Socioeconómico', color: 'bg-pink-500',   weight: '13%' },
];

const POI_LABELS: { key: keyof PoiBreakdown; label: string; icon: string; weight: number }[] = [
  { key: 'marketplace',    label: 'Mercado',          icon: '🏪', weight: 3.0 },
  { key: 'bank',           label: 'Banco',            icon: '🏦', weight: 2.0 },
  { key: 'pharmacy',       label: 'Farmacia',         icon: '💊', weight: 1.5 },
  { key: 'hospital',       label: 'Hospital',         icon: '🏥', weight: 1.0 },
  { key: 'school',         label: 'Escuela',          icon: '🏫', weight: 1.0 },
  { key: 'atm',            label: 'Cajero (ATM)',     icon: '🏧', weight: 1.0 },
  { key: 'money_transfer', label: 'Remesas',          icon: '💸', weight: 1.0 },
  { key: 'supermarket',    label: 'Supermercado',     icon: '🛒', weight: 1.0 },
  { key: 'bus_station',    label: 'Terminal/Bus',     icon: '🚌', weight: 1.2 },
  { key: 'fuel',           label: 'Gasolinera',       icon: '⛽', weight: 0.8 },
  { key: 'hardware',       label: 'Ferretería',       icon: '🔧', weight: 1.0 },
];

interface Props {
  analysis: TradeAreaAnalysis;
  onClose:  () => void;
}

const TradeAreaPanel: React.FC<Props> = ({ analysis, onClose }) => {
  const { rings, score, recommendation, suggested_format, reasoning, municipio_name, poi_breakdown } = analysis;
  const presentPois = poi_breakdown
    ? POI_LABELS.filter(p => poi_breakdown[p.key] > 0)
    : [];

  return (
    <div className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div>
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Análisis de Área de Influencia
          </div>
          {municipio_name && (
            <div className="text-xs text-gray-400">{municipio_name}</div>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Score + recommendation */}
      <div className="px-3 py-2 flex items-center justify-between">
        <ScoreBadge score={score} recommendation={recommendation} size="lg" />
        {suggested_format && (
          <span className="text-sm font-medium text-brand-700 dark:text-brand-300">
            {suggested_format === 'Maxi Despensa' ? '🏬' : '🏪'} {suggested_format}
          </span>
        )}
      </div>

      {/* Reasoning */}
      {reasoning && (
        <div className="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400 italic">
          {reasoning}
        </div>
      )}

      {/* Factor score breakdown */}
      {analysis.factors && (
        <div className="px-3 pb-2">
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
            Desglose de puntaje
          </div>
          <div className="space-y-0.5">
            {FACTOR_LABELS.map(({ key, label, color, weight }) => (
              <div key={key} className="flex items-center gap-1.5">
                <span className="text-[10px] text-gray-400 dark:text-gray-500 w-24 flex-shrink-0">
                  {label} <span className="opacity-60">({weight})</span>
                </span>
                <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${color} transition-all`}
                    style={{ width: `${Math.round(analysis.factors[key])}%` }}
                  />
                </div>
                <span className="text-[10px] text-gray-500 dark:text-gray-400 w-6 text-right">
                  {Math.round(analysis.factors[key])}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* POI breakdown */}
      {presentPois.length > 0 && (
        <div className="px-3 pb-2">
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
            Puntos de interés cercanos (5km)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {presentPois.map(({ key, label, icon }) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
              >
                {icon} {poi_breakdown[key]} {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Trade area rings */}
      <div className="px-3 pb-3 space-y-2">
        {rings.map((ring) => (
          <div key={ring.radius_km}
               className="p-2 rounded-lg bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                Radio {ring.radius_km}km
              </span>
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                ring.saturation_index < 0.5 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' :
                ring.saturation_index < 1.5 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300' :
                                               'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
              }`}>
                Saturación: {ring.saturation_index.toFixed(1)}x
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-center">
              <div>
                <div className="text-sm font-bold text-gray-800 dark:text-gray-200">
                  {ring.population.toLocaleString()}
                </div>
                <div className="text-[10px] text-gray-400">personas</div>
              </div>
              <div>
                <div className="text-sm font-bold text-brand-600 dark:text-brand-400">
                  {ring.our_store_count}
                </div>
                <div className="text-[10px] text-gray-400">nuestras tiendas</div>
              </div>
              <div>
                <div className="text-sm font-bold text-red-500">
                  {ring.competitor_count}
                </div>
                <div className="text-[10px] text-gray-400">competidores</div>
              </div>
            </div>

            {/* Store list if any */}
            {ring.our_stores.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {ring.our_stores.slice(0, 3).map((s, i) => (
                  <div key={i} className="text-[10px] flex justify-between text-gray-500 dark:text-gray-400">
                    <span className="truncate">🏪 {s.name}</span>
                    <span className="flex-shrink-0 ml-1">{s.dist_km}km</span>
                  </div>
                ))}
              </div>
            )}
            {ring.competitors.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {ring.competitors.slice(0, 3).map((c, i) => (
                  <div key={i} className="text-[10px] flex justify-between text-gray-500 dark:text-gray-400">
                    <span className="truncate text-red-400">⚡ {c.chain}</span>
                    <span className="flex-shrink-0 ml-1">{c.dist_km}km</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default TradeAreaPanel;
