import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Store, Competitor, OpportunityScore, SettlementScore, LayerState, TradeAreaAnalysis, NtlSettlement, PoiCluster, PoiBreakdown, PoiNucleus, CompetitorGap } from '../types';

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

function rankIcon(rank: number, color: string): L.DivIcon {
  const size     = rank <= 3 ? 28 : rank <= 10 ? 22 : 18;
  const fontSize = rank <= 3 ? 11 : 9;
  const ring     = rank <= 3 ? `,0 0 0 3px ${color}50` : '';
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;
             background:${color};border:2px solid white;
             box-shadow:0 1px 4px rgba(0,0,0,.6)${ring};
             display:flex;align-items:center;justify-content:center;
             font-size:${fontSize}px;font-weight:700;color:white;
             font-family:sans-serif;line-height:1;">${rank}</div>`,
    className: '',
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function starIcon(color: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="width:10px;height:10px;background:${color};border:1.5px solid white;
             box-shadow:0 1px 3px rgba(0,0,0,.5);transform:rotate(45deg)"></div>`,
    className: '',
    iconSize:   [10, 10],
    iconAnchor: [5, 5],
  });
}

function poiClusterIcon(count: number): L.DivIcon {
  const size = count >= 10 ? 26 : count >= 5 ? 22 : 18;
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:4px;
             background:#0891b2;border:2px solid white;
             box-shadow:0 1px 4px rgba(0,0,0,.6);
             display:flex;align-items:center;justify-content:center;
             font-size:10px;font-weight:700;color:white;
             font-family:sans-serif;line-height:1;">${count}</div>`,
    className: '',
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const POI_LABEL_MAP: Partial<Record<keyof PoiBreakdown, string>> = {
  marketplace:    '🏪 Mercado',
  bank:           '🏦 Banco',
  pharmacy:       '💊 Farmacia',
  hospital:       '🏥 Hospital',
  school:         '🏫 Escuela',
  atm:            '🏧 Cajero',
  money_transfer: '💸 Remesas',
  supermarket:    '🛒 Supermercado',
  bus_station:    '🚌 Terminal',
  fuel:           '⛽ Gasolinera',
  hardware:       '🔧 Ferretería',
};

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
  stores:              Store[];
  competitors:         Competitor[];
  opportunities:       OpportunityScore[];
  settlementScores?:   SettlementScore[];
  layers:              LayerState;
  tradeArea:           TradeAreaAnalysis | null;
  onMapClick:          (lat: number, lng: number) => void;
  loading:             boolean;
  flyToTarget?:        { lat: number; lng: number; zoom?: number } | null;
  ntlSettlements?:     NtlSettlement[];
  onNtlClick?:         (s: NtlSettlement) => void;
  poiClusters?:        PoiCluster[];
  onOppBubbleClick?:   (opp: OpportunityScore) => void;
  onPoiClusterClick?:  (c: PoiCluster) => void;
  poiNuclei?:          PoiNucleus[];
  competitorGaps?:     CompetitorGap[];
}

// ─── Component ────────────────────────────────────────────────────────────────

const MapView: React.FC<MapViewProps> = ({
  stores, competitors, opportunities, settlementScores = [], layers,
  tradeArea, onMapClick, loading, flyToTarget,
  ntlSettlements = [], onNtlClick,
  poiClusters = [], onOppBubbleClick, onPoiClusterClick,
  poiNuclei = [], competitorGaps = [],
}) => {
  const mapRef         = useRef<L.Map | null>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const layersRef      = useRef<{
    stores:          L.LayerGroup;
    competitors:     L.LayerGroup;
    opportunities:   L.LayerGroup;
    settlements:     L.LayerGroup;
    tradeArea:       L.LayerGroup;
    ntl:             L.LayerGroup;
    poiClusters:     L.LayerGroup;
    poiNuclei:       L.LayerGroup;
    competitorGaps:  L.LayerGroup;
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
      stores:         L.layerGroup().addTo(map),
      competitors:    L.layerGroup().addTo(map),
      opportunities:  L.layerGroup().addTo(map),
      settlements:    L.layerGroup(),              // off by default
      tradeArea:      L.layerGroup().addTo(map),
      ntl:            L.layerGroup().addTo(map),
      poiClusters:    L.layerGroup().addTo(map),
      poiNuclei:      L.layerGroup(),              // off by default
      competitorGaps: L.layerGroup(),              // off by default
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

    opportunities.forEach((opp, i) => {
      if (!opp.centroid) return;
      const { lat, lng } = opp.centroid as any;
      if (!lat || !lng) return;

      const rank  = i + 1;
      const color = SCORE_COLORS[opp.recommendation] ?? '#6b7280';
      const popupHtml = `
        <div class="text-sm" style="min-width:160px">
          <span style="font-size:11px;color:#6b7280">#${rank}</span>
          <strong style="margin-left:4px">${opp.municipio_name}</strong>
          <div style="color:#6b7280;font-size:11px">${opp.department}</div>
          <div style="margin-top:4px">
            Score: <strong style="color:${color}">${opp.score.toFixed(0)}/100</strong>
            <span style="font-size:11px;color:#6b7280"> (${opp.recommendation})</span>
          </div>
          <div style="font-size:11px;margin-top:2px">
            Población: ${(opp.population ?? 0).toLocaleString()}<br/>
            ${opp.suggested_format ? `Formato sugerido: <strong>${opp.suggested_format}</strong><br/>` : ''}
            ${opp.nearest_store_km !== null ? `Tienda más cercana: ${opp.nearest_store_km} km` : 'Sin cobertura propia'}
          </div>
        </div>
      `;

      const marker = L.marker([lat, lng], {
        icon: rankIcon(rank, color),
        zIndexOffset: rank <= 10 ? 100 : 0,
      });
      marker.bindPopup(popupHtml);
      marker.on('click', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        if (onOppBubbleClick) onOppBubbleClick(opp);
      });
      group.addLayer(marker);
    });
  }, [opportunities, layers.opportunities, onOppBubbleClick]);

  // ── Render settlement scores layer ────────────────────────────────────────
  // Each settlement dot is colored by score (green/yellow/red) and sized by
  // estimated population. This gives a sub-municipio opportunity view.
  useEffect(() => {
    const group = layersRef.current?.settlements;
    if (!group) return;
    group.clearLayers();
    if (!layers.settlements || settlementScores.length === 0) return;

    for (const s of settlementScores) {
      if (!s.lat || !s.lng) continue;

      const color = s.score >= 70 ? '#16a34a' : s.score >= 40 ? '#ca8a04' : '#dc2626';
      const size  = s.score >= 70 ? 10 : s.score >= 40 ? 8 : 6;

      const popupHtml = `
        <div class="text-sm" style="min-width:160px">
          <strong>${s.name}</strong>
          <div style="color:#6b7280;font-size:11px">${s.municipio_name}, ${s.department}</div>
          <div style="margin-top:4px">
            Score: <strong style="color:${color}">${s.score}/100</strong>
          </div>
          <div style="font-size:11px;margin-top:2px">
            Población est.: ${s.estimated_pop > 0 ? s.estimated_pop.toLocaleString() : '—'}<br/>
            POIs cercanos: ${s.poi_count}<br/>
            Competidores 3km: ${s.competitor_count}<br/>
            ${s.nearest_store_km !== null ? `Tienda más cercana: ${s.nearest_store_km} km` : 'Sin cobertura propia'}
          </div>
        </div>
      `;

      const marker = L.marker([s.lat, s.lng], { icon: circleIcon(color, size) });
      marker.bindPopup(popupHtml);
      group.addLayer(marker);
    }
  }, [settlementScores, layers.settlements]);

  // ── Render NTL glow circles ───────────────────────────────────────────────
  // Each settlement is rendered as two concentric circles: a larger transparent
  // outer glow and a smaller opaque core, mimicking how satellite NTL data looks.
  useEffect(() => {
    const group = layersRef.current?.ntl;
    if (!group) return;
    group.clearLayers();
    if (!ntlSettlements || ntlSettlements.length === 0) return;

    const maxRad = Math.max(...ntlSettlements.map(s => s.radiance_ntl), 1);

    for (const s of ntlSettlements) {
      if (!s.lat || !s.lng) continue;

      // Size: log-scaled radius so small towns are still visible next to bright cities
      const normRad   = s.radiance_ntl / maxRad;
      const coreR     = Math.max(300, Math.round(normRad * 2000));   // meters
      const glowR     = coreR * 2.8;

      // Color: warm yellow → white based on radiance intensity
      const hue  = 48 - Math.round(normRad * 20);                    // 48°→28° (yellow→orange)
      const light = 55 + Math.round(normRad * 40);                   // 55%→95%
      const coreColor = `hsl(${hue}, 95%, ${light}%)`;
      const glowColor = `hsl(${hue}, 90%, ${Math.min(light + 10, 98)}%)`;

      const pop = s.estimated_pop ?? 0;
      const popStr = pop > 0
        ? `~${pop.toLocaleString()} hab. est.`
        : 'sin estimación';

      const popupHtml = `
        <div class="text-sm" style="min-width:150px">
          <strong>${s.name}</strong>
          <div style="color:#6b7280;font-size:11px;margin-top:2px">
            Radiancia VIIRS: <strong>${s.radiance_ntl.toFixed(1)} nW/cm²/sr</strong><br/>
            Población estimada: <strong>${popStr}</strong><br/>
            Fórmula: radiancia × 180 × 4.2
            ${s.area_km2 ? `<br/>Área lit: ${s.area_km2} km²` : ''}
          </div>
        </div>
      `;

      // Outer glow
      L.circle([s.lat, s.lng], {
        radius:      glowR,
        color:       glowColor,
        fillColor:   glowColor,
        weight:      0,
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(group);

      // Inner core (clickable)
      const core = L.circle([s.lat, s.lng], {
        radius:      coreR,
        color:       'white',
        fillColor:   coreColor,
        weight:      1,
        opacity:     0.6,
        fillOpacity: 0.70,
      });
      core.bindPopup(popupHtml);
      if (onNtlClick) {
        core.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          onNtlClick(s);
        });
      }
      group.addLayer(core);
    }
  }, [ntlSettlements, onNtlClick]);

  // ── Render POI cluster layer ───────────────────────────────────────────────
  useEffect(() => {
    const group = layersRef.current?.poiClusters;
    if (!group) return;
    group.clearLayers();
    if (!poiClusters || poiClusters.length === 0) return;

    for (const c of poiClusters) {
      if (!c.lat || !c.lng) continue;

      const breakdownLines = (Object.entries(c.breakdown) as [keyof PoiBreakdown, number][])
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${v}× ${POI_LABEL_MAP[k] ?? k}`)
        .join('<br/>');

      const popupHtml = `
        <div class="text-sm" style="min-width:150px">
          <strong style="color:#0891b2">Centro comercial detectado</strong>
          <div style="color:#6b7280;font-size:11px;margin-top:2px">
            ${c.poi_count} puntos de interés<br/>
            ${breakdownLines}
          </div>
          <div style="font-size:10px;color:#9ca3af;margin-top:4px">Clic para analizar área</div>
        </div>
      `;

      const marker = L.marker([c.lat, c.lng], { icon: poiClusterIcon(c.poi_count) });
      marker.bindPopup(popupHtml);
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (onPoiClusterClick) onPoiClusterClick(c);
      });
      group.addLayer(marker);
    }
  }, [poiClusters, onPoiClusterClick]);

  // ── Render POI nuclei layer (zonas comerciales) ───────────────────────────
  // Orange circles sized by POI weighted_score; color-coded by opportunity_score
  useEffect(() => {
    const group = layersRef.current?.poiNuclei;
    if (!group) return;
    group.clearLayers();
    if (!layers.poiNuclei || poiNuclei.length === 0) return;

    for (const n of poiNuclei) {
      if (!n.lat || !n.lng) continue;
      const score = n.opportunity_score;
      const color = score >= 70 ? '#f97316' : score >= 45 ? '#fb923c' : '#fdba74';
      const size  = Math.max(8, Math.min(22, Math.round(n.poi_count * 1.5)));

      const icon = L.divIcon({
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;
                 background:${color};border:2px solid white;
                 box-shadow:0 1px 4px rgba(0,0,0,.6);
                 display:flex;align-items:center;justify-content:center;
                 font-size:9px;font-weight:700;color:white;
                 font-family:sans-serif;line-height:1;">${n.poi_count}</div>`,
        className: '',
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const storeTag = n.nearest_own_store_km !== null
        ? `${n.nearest_own_store_km} km`
        : 'Sin cobertura';

      const popupHtml = `
        <div class="text-sm" style="min-width:180px">
          <strong style="color:#f97316">Zona Comercial</strong>
          <div style="color:#6b7280;font-size:11px">${n.municipio_name}, ${n.department}</div>
          <div style="margin-top:4px">
            Score oportunidad: <strong style="color:${color}">${score}/100</strong>
          </div>
          <div style="font-size:11px;margin-top:3px">
            POIs: <strong>${n.poi_count}</strong> (peso: ${n.weighted_score.toFixed(1)})<br/>
            Tienda propia: <strong>${storeTag}</strong><br/>
            Competidores 1km: ${n.competitor_count_1km} · 3km: ${n.competitor_count_3km}<br/>
            ${n.cnt_marketplace > 0 ? `🏪 Mercado: ${n.cnt_marketplace}<br/>` : ''}
            ${n.cnt_bank > 0        ? `🏦 Banco: ${n.cnt_bank}<br/>` : ''}
            ${n.cnt_pharmacy > 0    ? `💊 Farmacia: ${n.cnt_pharmacy}<br/>` : ''}
            ${n.cnt_bus_station > 0 ? `🚌 Terminal: ${n.cnt_bus_station}<br/>` : ''}
          </div>
        </div>
      `;

      const marker = L.marker([n.lat, n.lng], { icon });
      marker.bindPopup(popupHtml);
      group.addLayer(marker);
    }
  }, [poiNuclei, layers.poiNuclei]);

  // ── Render competitor gaps layer (brechas) ────────────────────────────────
  // Purple markers for competitor clusters without own-store coverage.
  // Size reflects competitor density; darker = higher gap_score.
  useEffect(() => {
    const group = layersRef.current?.competitorGaps;
    if (!group) return;
    group.clearLayers();
    if (!layers.competitorGaps || competitorGaps.length === 0) return;

    for (const g of competitorGaps) {
      if (!g.lat || !g.lng) continue;
      const size  = Math.max(10, Math.min(24, 10 + g.competitor_count * 2));
      const color = g.gap_score >= 70 ? '#7c3aed' : g.gap_score >= 45 ? '#8b5cf6' : '#a78bfa';

      const icon = L.divIcon({
        html: `<div style="width:${size}px;height:${size}px;border-radius:3px;
                 background:${color};border:2px solid white;
                 box-shadow:0 1px 4px rgba(0,0,0,.6);
                 display:flex;align-items:center;justify-content:center;
                 font-size:9px;font-weight:700;color:white;
                 font-family:sans-serif;line-height:1;">${g.competitor_count}</div>`,
        className: '',
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const storeTag = g.nearest_own_store_km !== null
        ? `${g.nearest_own_store_km} km`
        : 'Sin cobertura';
      const chainsStr = g.chains.slice(0, 4).join(', ') + (g.chains.length > 4 ? '…' : '');

      const popupHtml = `
        <div class="text-sm" style="min-width:180px">
          <strong style="color:${color}">Brecha de mercado</strong>
          <div style="font-size:11px;margin-top:4px">
            Competidores: <strong>${g.competitor_count}</strong><br/>
            Cadenas: ${chainsStr}<br/>
            Tienda propia más cercana: <strong>${storeTag}</strong><br/>
            Gap score: <strong>${g.gap_score}/100</strong>
          </div>
        </div>
      `;

      const marker = L.marker([g.lat, g.lng], { icon });
      marker.bindPopup(popupHtml);
      group.addLayer(marker);
    }
  }, [competitorGaps, layers.competitorGaps]);

  // ── flyToTarget: pan/zoom map when a sidebar card is clicked ─────────────
  useEffect(() => {
    if (!flyToTarget || !mapRef.current) return;
    mapRef.current.flyTo([flyToTarget.lat, flyToTarget.lng], flyToTarget.zoom ?? 11, {
      animate: true, duration: 0.8,
    });
  }, [flyToTarget]);

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

    if (layers.stores)          { if (!map.hasLayer(lg.stores))          lg.stores.addTo(map); }
    else                        { map.removeLayer(lg.stores); }
    if (layers.competitors)     { if (!map.hasLayer(lg.competitors))     lg.competitors.addTo(map); }
    else                        { map.removeLayer(lg.competitors); }
    if (layers.opportunities)   { if (!map.hasLayer(lg.opportunities))   lg.opportunities.addTo(map); }
    else                        { map.removeLayer(lg.opportunities); }
    if (layers.settlements)     { if (!map.hasLayer(lg.settlements))     lg.settlements.addTo(map); }
    else                        { map.removeLayer(lg.settlements); }
    if (layers.poiNuclei)       { if (!map.hasLayer(lg.poiNuclei))       lg.poiNuclei.addTo(map); }
    else                        { map.removeLayer(lg.poiNuclei); }
    if (layers.competitorGaps)  { if (!map.hasLayer(lg.competitorGaps))  lg.competitorGaps.addTo(map); }
    else                        { map.removeLayer(lg.competitorGaps); }
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
        {ntlSettlements.length > 0 && (
          <>
            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: '#fde047', boxShadow: '0 0 4px 2px #fde04780' }} />
              <span className="text-gray-600 dark:text-gray-400">Luces nocturnas</span>
            </div>
          </>
        )}
        {poiClusters.length > 0 && (
          <>
            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: '#0891b2' }} />
              <span className="text-gray-600 dark:text-gray-400">Centro comercial (POI)</span>
            </div>
          </>
        )}
        {layers.poiNuclei && poiNuclei.length > 0 && (
          <>
            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: '#f97316' }} />
              <span className="text-gray-600 dark:text-gray-400">Zona comercial</span>
            </div>
          </>
        )}
        {layers.competitorGaps && competitorGaps.length > 0 && (
          <>
            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: '#7c3aed' }} />
              <span className="text-gray-600 dark:text-gray-400">Brecha de mercado</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default MapView;
