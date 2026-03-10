import React, { useState } from 'react';
import type { SiteSelectionResult, SiteCandidate } from '../types';

interface Props {
  result: SiteSelectionResult;
  loading: boolean;
  onClose: () => void;
  onCandidateClick: (c: SiteCandidate) => void;
}

const REC_COLOR: Record<string, string> = {
  GO:      '#16a34a',
  CAUTION: '#d97706',
  'NO-GO': '#dc2626',
};

const SOURCE_LABEL: Record<string, string> = {
  viirs:       'VIIRS',
  poi_nucleus: 'Zona Comercial',
  comp_gap:    'Brecha',
};

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className="h-1 rounded-full transition-all"
          style={{ width: `${Math.min(100, value)}%`, background: color }}
        />
      </div>
      <span className="text-xs text-gray-500 w-6 text-right">{value.toFixed(0)}</span>
    </div>
  );
}

function CandidateCard({
  c,
  expanded,
  onToggle,
  onClick,
}: {
  c: SiteCandidate;
  expanded: boolean;
  onToggle: () => void;
  onClick: () => void;
}) {
  const color = REC_COLOR[c.recommendation] ?? '#6b7280';
  const isTop = c.rank === 1;

  return (
    <div
      className={`rounded-lg border transition-all ${
        isTop
          ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20'
          : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
      }`}
    >
      {/* Header row */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer"
        onClick={onToggle}
      >
        {/* Rank badge */}
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
          style={{ background: isTop ? '#f59e0b' : color }}
        >
          {c.rank}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span
              className="text-xs font-bold"
              style={{ color }}
            >
              {c.micro_score.toFixed(0)}/100
            </span>
            <span
              className="text-xs px-1 rounded"
              style={{ background: color + '20', color }}
            >
              {c.recommendation}
            </span>
            {c.format_suggestion && (
              <span className="text-xs text-gray-400">{c.format_suggestion}</span>
            )}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {SOURCE_LABEL[c.source]} · {c.lat.toFixed(4)}, {c.lng.toFixed(4)}
          </div>
        </div>

        {/* Fly-to button */}
        <button
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className="text-xs text-brand-600 hover:text-brand-800 dark:text-brand-400 flex-shrink-0 px-1"
          title="Ver en mapa"
        >
          ⌖
        </button>

        <span className="text-gray-400 text-xs flex-shrink-0">{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-gray-100 dark:border-gray-700 space-y-2">
          {/* Score bars */}
          <div className="mt-2 space-y-1">
            <div className="text-xs text-gray-500 dark:text-gray-400 font-medium">Factores</div>
            {[
              { label: 'NTL Luminosidad',    value: c.factors.ntl_luminosity,    color: '#f59e0b' },
              { label: 'Gravedad Comercial', value: c.factors.commercial_gravity, color: '#3b82f6' },
              { label: 'Calidad de Brecha',  value: c.factors.gap_quality,        color: '#8b5cf6' },
              { label: 'Población 3 km',     value: c.factors.pop_catchment,      color: '#10b981' },
              { label: 'Socioeconómico',     value: c.factors.socioeconomic,      color: '#6b7280' },
            ].map(f => (
              <div key={f.label}>
                <div className="text-xs text-gray-500 dark:text-gray-400">{f.label}</div>
                <ScoreBar value={f.value} color={f.color} />
              </div>
            ))}
          </div>

          {/* Key stats */}
          <div className="text-xs space-y-0.5 text-gray-600 dark:text-gray-400">
            <div>Población 3 km: <strong>{c.supporting_data.ntl_pop_3km.toLocaleString()}</strong></div>
            {c.supporting_data.nearest_own_store_km != null && (
              <div>Tienda más cercana: <strong>{c.supporting_data.nearest_own_store_km.toFixed(1)} km</strong></div>
            )}
            <div>Competidores 3 km: <strong>{c.supporting_data.competitor_count_3km}</strong></div>
            {c.supporting_data.radiance_ntl != null && (
              <div>Radiancia VIIRS: <strong>{c.supporting_data.radiance_ntl.toFixed(1)} nW/cm²/sr</strong></div>
            )}
            <div>Acceso vial: <strong>{c.supporting_data.road_accessible ? 'Sí' : 'No verificado'}</strong></div>
          </div>

          {/* Reasoning */}
          <div className="text-xs text-gray-400 dark:text-gray-500 italic border-t border-gray-100 dark:border-gray-700 pt-1">
            {c.reasoning}
          </div>
        </div>
      )}
    </div>
  );
}

const SiteSelectionPanel: React.FC<Props> = ({ result, loading, onClose, onCandidateClick }) => {
  const [expandedRank, setExpandedRank] = useState<number>(1);

  const allCandidates = result.top_candidate
    ? [result.top_candidate, ...result.alternatives]
    : result.alternatives;

  return (
    <div className="text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div>
          <div className="text-sm font-bold text-gray-800 dark:text-gray-100">
            Selección de Sitio
          </div>
          <div className="text-gray-400">{result.municipio_name}, {result.department}</div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-base leading-none px-1"
        >
          ×
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-3 text-gray-400">
          <div className="w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
          Calculando mejores ubicaciones…
        </div>
      )}

      {!loading && allCandidates.length === 0 && (
        <div className="px-3 py-3 text-gray-400 text-center">
          <div className="text-2xl mb-1">📍</div>
          <div>Sin candidatos disponibles</div>
          <div className="text-gray-300 mt-1">
            Genera Zonas y Brechas primero desde el Admin.
          </div>
        </div>
      )}

      {!loading && allCandidates.length > 0 && (
        <div className="p-2 space-y-1.5">
          {/* Constraint summary */}
          <div className="text-gray-400 pb-1">
            {result.constraints_applied.candidates_generated} candidatos ·{' '}
            {result.constraints_applied.eliminated_own_store > 0 && (
              <span className="text-amber-500">
                {result.constraints_applied.eliminated_own_store} excluidos (tienda propia) ·{' '}
              </span>
            )}
            {result.constraints_applied.surviving} analizados
          </div>

          {allCandidates.map(c => (
            <CandidateCard
              key={`${c.source}-${c.source_id}`}
              c={c}
              expanded={expandedRank === c.rank}
              onToggle={() => setExpandedRank(expandedRank === c.rank ? 0 : c.rank)}
              onClick={() => onCandidateClick(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SiteSelectionPanel;
