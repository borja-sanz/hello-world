import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Store, Competitor, OpportunityScore, LayerState, TradeAreaAnalysis } from '../types';

// Fix default Leaflet marker icons broken by bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ─── Custom icons ─────────────────────────────────────────────────────────────

function circleIcon(color: string, size = 12): L.DivIcon {
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div>`,
    className: '',
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function starIcon(color: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="width:16px;height:16px;background:${color};border:2px solid white;
             box-shadow:0 1px 3px rgba(0,0,0,.5);transform:rotate(45deg)"></div>`,
    className: '',
    iconSize:   [16, 16],
    iconAnchor: [8, 8],
  });
}

const STORE_COLORS: Record<string, string> = {
  'Despensa Familiar': '#16a34a',
  'Maxi Despensa':     '#14532d',
  'Walmart':           '#1d4ed8',
  'Paiz':              '#ca8a04',
  'Other':             '#6b7280',
};

const SCORE_COLORS = {
  GO:      '#16a34a',
  CAUTION: '#ca8a04',
  'NO-GO': '#dc2626',
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface MapViewProps {
  stores:        Store[];
  competitors:   Competitor[];
  opportunities: OpportunityScore[];
  layers:        LayerState;
  tradeArea:     TradeAreaAnalysis | null;
  onMapClick:    (lat: number, lng: number) => void;
  loading:       boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

const MapView: React.FC<MapViewProps> = ({
  stores, competitors, opportunities, layers, tradeArea, onMapClick, loading,
}) => {
  const mapRef         = useRef<L.Map | null>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const layersRef      = useRef<{
    stores:        L.LayerGroup;
    competitors:   L.LayerGroup;
    opportunities: L.LayerGroup;
    tradeArea:     L.LayerGroup;
  } | null>(null);

  // ── Initialize map once ───────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center:  [14.64, -90.51],
      zoom:    8,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    const groups = {
      stores:        L.layerGroup().addTo(map),
      competitors:   L.layerGroup().addTo(map),
      opportunities: L.layerGroup().addTo(map),
      tradeArea:     L.layerGroup().addTo(map),
    };

    layersRef.current = groups;
    mapRef.current    = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Click handler ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e: L.LeafletMouseEvent) => onMapClick(e.latlng.lat, e.latlng.lng);
    map.on('click', handler);
    return () => { map.off('click', handler); };
  }, [onMapClick]);

  // ── Render stores layer ───────────────────────────────────────────────────
  useEffect(() => {
    const group = layersRef.current?.stores;
    if (!group) return;
    group.clearLayers();
    if (!layers.stores) return;

    for (const s of stores) {
      if (!s.lat || !s.lng) continue;
      const color = STORE_COLORS[s.format] ?? '#6b7280';
      const marker = L.marker([s.lat, s.lng], { icon: starIcon(color) });
      marker.bindPopup(`
        <div class="text-sm">
          <strong>${s.name}</strong><br/>
          <span style="color:${color}">${s.format}</span><br/>
          ${s.department ? `${s.department}` : ''}
          ${s.status !== 'open' ? `<br/><em>${s.status}</em>` : ''}
          ${s.performance ? `<br/>Performance: <strong>${s.performance}</strong>` : ''}
        </div>
      `);
      group.addLayer(marker);
    }
  }, [stores, layers.stores]);

  // ── Render competitors layer ──────────────────────────────────────────────
  useEffect(() => {
    const group = layersRef.current?.competitors;
    if (!group) return;
    group.clearLayers();
    if (!layers.competitors) return;

    for (const c of competitors) {
      if (!c.lat || !c.lng) continue;
      const marker = L.marker([c.lat, c.lng], { icon: circleIcon('#ef4444', 10) });
      marker.bindPopup(`
        <div class="text-sm">
          <strong>${c.name}</strong><br/>
          <span style="color:#ef4444">${c.chain}</span>
          ${c.verified ? '<br/><em>✓ verificado</em>' : ''}
        </div>
      `);
      group.addLayer(marker);
    }
  }, [competitors, layers.competitors]);

  // ── Render opportunity scores layer ──────────────────────────────────────
  useEffect(() => {
    const group = layersRef.current?.opportunities;
    if (!group) return;
    group.clearLayers();
    if (!layers.opportunities) return;

    for (const opp of opportunities) {
      if (!opp.centroid) continue;
      const { lat, lng } = opp.centroid as any;
      if (!lat || !lng) continue;

      const color = SCORE_COLORS[opp.recommendation] ?? '#6b7280';
      const size  = Math.max(8, Math.min(22, Math.round(opp.score / 6)));
      const marker = L.circleMarker([lat, lng], {
        radius:      size,
        fillColor:   color,
        color:       'white',
        weight:      1.5,
        opacity:     0.9,
        fillOpacity: 0.7,
      });
      marker.bindPopup(`
        <div class="text-sm">
          <strong>${opp.municipio_name}</strong><br/>
          Score: <strong style="color:${color}">${opp.score.toFixed(0)}/100</strong>
          (${opp.recommendation})<br/>
          Pop: ${(opp.population ?? 0).toLocaleString()}<br/>
          ${opp.suggested_format ? `Formato: ${opp.suggested_format}` : ''}
        </div>
      `);
      group.addLayer(marker);
    }
  }, [opportunities, layers.opportunities]);

  // ── Render trade area rings ───────────────────────────────────────────────
  useEffect(() => {
    const group = layersRef.current?.tradeArea;
    if (!group) return;
    group.clearLayers();
    if (!tradeArea) return;

    const { lat, lng } = tradeArea.center;
    const colors = ['#3b82f6', '#8b5cf6', '#ec4899'];
    const radii  = [3000, 5000, 10000];

    radii.forEach((r, i) => {
      L.circle([lat, lng], {
        radius:      r,
        color:       colors[i],
        fillColor:   colors[i],
        fillOpacity: 0.04,
        dashArray:   '6 4',
        weight:      2,
      }).addTo(group);
    });

    // Center marker
    L.circleMarker([lat, lng], {
      radius: 6, fillColor: '#f59e0b', color: 'white',
      weight: 2, fillOpacity: 1,
    }).addTo(group);

    // Pan to clicked point
    mapRef.current?.panTo([lat, lng]);
  }, [tradeArea]);

  // ── Toggle layer visibility ───────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const lg  = layersRef.current;
    if (!map || !lg) return;

    if (layers.stores)        { if (!map.hasLayer(lg.stores))        lg.stores.addTo(map); }
    else                      { map.removeLayer(lg.stores); }
    if (layers.competitors)   { if (!map.hasLayer(lg.competitors))   lg.competitors.addTo(map); }
    else                      { map.removeLayer(lg.competitors); }
    if (layers.opportunities) { if (!map.hasLayer(lg.opportunities)) lg.opportunities.addTo(map); }
    else                      { map.removeLayer(lg.opportunities); }
  }, [layers]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-[1000]">
          <div className="bg-white dark:bg-gray-800 rounded-lg px-4 py-3 shadow-lg flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Analizando…
            </span>
          </div>
        </div>
      )}

      {/* Map legend */}
      <div className="absolute bottom-6 left-2 z-[500] bg-white dark:bg-gray-800 rounded-lg shadow-md p-2 text-xs space-y-1">
        <div className="font-semibold text-gray-600 dark:text-gray-300 mb-1">Leyenda</div>
        {Object.entries(STORE_COLORS).slice(0, 4).map(([fmt, color]) => (
          <div key={fmt} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
            <span className="text-gray-600 dark:text-gray-400">{fmt}</span>
          </div>
        ))}
        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full flex-shrink-0 bg-red-500" />
          <span className="text-gray-600 dark:text-gray-400">Competidor</span>
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full flex-shrink-0 bg-green-500" />
          <span className="text-gray-600 dark:text-gray-400">GO (80–100)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full flex-shrink-0 bg-yellow-500" />
          <span className="text-gray-600 dark:text-gray-400">CAUTION (40–79)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full flex-shrink-0 bg-red-600" />
          <span className="text-gray-600 dark:text-gray-400">NO-GO (&lt;40)</span>
        </div>
      </div>
    </div>
  );
};

export default MapView;
