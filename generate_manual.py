#!/usr/bin/env python3
"""
Generates GeoRetail Guatemala - Manual de Usuario (Word .docx)
"""
from docx import Document
from docx.shared import Pt, Cm, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import copy

# ── helpers ────────────────────────────────────────────────────────────────────

def set_cell_bg(cell, hex_color):
    """Shade a table cell with a solid background colour."""
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hex_color)
    tcPr.append(shd)

def set_cell_border(cell, **kwargs):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcBorders = OxmlElement('w:tcBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        tag = OxmlElement(f'w:{edge}')
        tag.set(qn('w:val'), kwargs.get('val', 'single'))
        tag.set(qn('w:sz'), kwargs.get('sz', '4'))
        tag.set(qn('w:space'), '0')
        tag.set(qn('w:color'), kwargs.get('color', 'CCCCCC'))
        tcBorders.append(tag)
    tcPr.append(tcBorders)

def heading(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    return p

def body(doc, text):
    p = doc.add_paragraph(text)
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    return p

def bullet(doc, text, level=0):
    style = 'List Bullet' if level == 0 else 'List Bullet 2'
    p = doc.add_paragraph(text, style=style)
    return p

def add_kv_table(doc, rows, col_widths=(6, 10)):
    """Two-column key-value table."""
    t = doc.add_table(rows=1, cols=2)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    t.style = 'Table Grid'
    hdr = t.rows[0].cells
    for i, txt in enumerate(['Campo / Parámetro', 'Descripción']):
        hdr[i].text = txt
        run = hdr[i].paragraphs[0].runs[0]
        run.bold = True
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        set_cell_bg(hdr[i], '2E4A7A')
    for key, val in rows:
        cells = t.add_row().cells
        cells[0].text = key
        cells[0].paragraphs[0].runs[0].bold = True
        cells[1].text = val
    # widths
    for row in t.rows:
        row.cells[0].width = Cm(col_widths[0])
        row.cells[1].width = Cm(col_widths[1])
    doc.add_paragraph()
    return t

def add_score_table(doc):
    """Factor scoring table with colour banding."""
    headers = ['Factor', 'Peso (%)', 'Fuente de datos', 'Qué mide']
    data = [
        ('Población', '28 %', 'INE Censo 2018 + proyecciones',
         'Tamaño del mercado del municipio (masa de consumidores potenciales)'),
        ('Movilidad y Acceso', '22 %', 'OpenStreetMap (OSM)',
         'Densidad vial, proximidad a carretera principal, clasificación urbana'),
        ('Densidad Comercial', '22 %', 'OSM + Google Places',
         'Concentración de PDV ancla: mercados, bancos, farmacias, supermercados, estaciones de combustible'),
        ('Paisaje Competitivo', '15 %', 'OSM + importación manual',
         'Saturación de cadenas competidoras dentro de 10 km; distancia a tiendas propias'),
        ('Proxy Socioeconómico', '13 %', 'INE + datos públicos',
         'Escuelas, centros de salud, índice de urbanización, indicadores de pobreza departamental'),
    ]
    t = doc.add_table(rows=1, cols=4)
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = h
        r = hdr[i].paragraphs[0].runs[0]
        r.bold = True
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        set_cell_bg(hdr[i], '2E4A7A')
    bgs = ['F7F9FC', 'FFFFFF']
    for idx, row_data in enumerate(data):
        cells = t.add_row().cells
        bg = bgs[idx % 2]
        for j, val in enumerate(row_data):
            cells[j].text = val
            set_cell_bg(cells[j], bg)
    doc.add_paragraph()
    return t

def add_recommendation_table(doc):
    rows_data = [
        ('80 – 100', 'PRIME / GO', 'Verde ✓', 'Expansión inmediata prioritaria'),
        ('60 – 79',  'BUENO / PRECAUCIÓN', 'Amarillo ⚠', 'Viable; validar acceso y competencia local'),
        ('40 – 59',  'MARGINAL / PRECAUCIÓN', 'Amarillo ⚠', 'Requiere análisis adicional de campo'),
        ('0 – 39',   'BAJO / NO-GO', 'Rojo ✗', 'No recomendado en esta versión'),
    ]
    headers = ['Rango de Puntaje', 'Etiqueta', 'Color', 'Acción sugerida']
    t = doc.add_table(rows=1, cols=4)
    t.style = 'Table Grid'
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = h
        r = hdr[i].paragraphs[0].runs[0]
        r.bold = True
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        set_cell_bg(hdr[i], '2E4A7A')
    bg_map = {'80 – 100': 'C6EFCE', '60 – 79': 'FFEB9C', '40 – 59': 'FFEB9C', '0 – 39': 'FFC7CE'}
    for row_data in rows_data:
        cells = t.add_row().cells
        bg = bg_map.get(row_data[0], 'FFFFFF')
        for j, val in enumerate(row_data):
            cells[j].text = val
            set_cell_bg(cells[j], bg)
    doc.add_paragraph()
    return t

# ── main document ──────────────────────────────────────────────────────────────

def build_doc():
    doc = Document()

    # Page margins
    for section in doc.sections:
        section.top_margin    = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin   = Cm(3.0)
        section.right_margin  = Cm(2.5)

    # ── Portada ──────────────────────────────────────────────────────────────
    doc.add_paragraph()
    doc.add_paragraph()
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title_p.add_run('GeoRetail Guatemala')
    run.bold = True
    run.font.size = Pt(28)
    run.font.color.rgb = RGBColor(0x2E, 0x4A, 0x7A)

    sub_p = doc.add_paragraph()
    sub_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run2 = sub_p.add_run('Manual de Usuario — Versión 1.0')
    run2.font.size = Pt(16)
    run2.font.color.rgb = RGBColor(0x55, 0x55, 0x55)

    doc.add_paragraph()
    info_p = doc.add_paragraph()
    info_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run3 = info_p.add_run(
        'Plataforma de Inteligencia Geoespacial para la Expansión de Tiendas\n'
        'Despensa Familiar y Maxi Despensa en Guatemala\n\n'
        'Fecha: Marzo 2026'
    )
    run3.font.size = Pt(11)
    run3.font.color.rgb = RGBColor(0x44, 0x44, 0x44)

    doc.add_page_break()

    # ── 1. Introducción ───────────────────────────────────────────────────────
    heading(doc, '1. Introducción', 1)
    body(doc,
        'GeoRetail Guatemala es una plataforma de inteligencia geoespacial diseñada '
        'para apoyar las decisiones de expansión de Despensa Familiar y Maxi Despensa. '
        'Integra datos demográficos, de movilidad, comerciales, competitivos y '
        'socioeconómicos en un modelo de puntuación compuesto que permite identificar, '
        'priorizar y seleccionar ubicaciones de nuevas tiendas de manera objetiva, '
        'rápida y trazable.')
    body(doc,
        'Este manual describe los objetivos de la herramienta, sus componentes '
        'principales, la lógica de los cálculos y las instrucciones de uso para el '
        'usuario final.')

    # ── 2. Objetivos ─────────────────────────────────────────────────────────
    heading(doc, '2. Objetivos de la Herramienta', 1)

    heading(doc, '2.1 Objetivo General', 2)
    body(doc,
        'Proveer un sistema de soporte a decisiones basado en datos que reduzca la '
        'incertidumbre en el proceso de selección de sitios para nuevas tiendas, '
        'reemplazando criterios subjetivos por un modelo cuantificable, reproducible '
        'y ajustable.')

    heading(doc, '2.2 Objetivos Específicos', 2)
    for obj in [
        'Clasificar los 254 municipios de Guatemala según su potencial de mercado '
        'para los formatos Despensa Familiar y Maxi Despensa.',
        'Identificar micro-ubicaciones óptimas dentro de los municipios prioritarios '
        'mediante análisis de asentamientos, densidad comercial y brechas competitivas.',
        'Visualizar en un mapa interactivo las tiendas propias, competidores, '
        'oportunidades y zonas de actividad comercial.',
        'Analizar en tiempo real el área de influencia (trade area) de cualquier punto '
        'del mapa con un radio de 3, 5 y 10 km.',
        'Permitir la calibración continua del modelo sin necesidad de intervención técnica.',
        'Generar reportes exportables para presentaciones ejecutivas y trabajo de campo.',
    ]:
        bullet(doc, obj)

    # ── 3. Funcionamiento General ─────────────────────────────────────────────
    heading(doc, '3. Funcionamiento General', 1)
    body(doc,
        'La plataforma opera en dos etapas secuenciales, más un módulo transversal '
        'de análisis de trade area que se puede ejecutar en cualquier momento.')

    heading(doc, '3.1 Etapa 1 — Puntuación de Oportunidades (Nivel Municipio)', 2)
    body(doc,
        'El sistema evalúa los 254 municipios del país con un modelo de cinco factores '
        'ponderados que produce un puntaje compuesto de 0 a 100. El resultado es una '
        'lista ordenada de mercados con mayor potencial, acompañada de una recomendación '
        'de formato (Despensa Familiar o Maxi Despensa) y un semáforo GO / PRECAUCIÓN / '
        'NO-GO.')

    heading(doc, '3.2 Etapa 2 — Selección de Sitio (Nivel Micro-ubicación)', 2)
    body(doc,
        'Una vez identificado un municipio prioritario, la plataforma analiza '
        'micro-ubicaciones específicas dentro de ese municipio usando tres fuentes: '
        'asentamientos detectados por imágenes satelitales (Nighttime Lights), '
        'núcleos de actividad comercial identificados por agrupamiento de POI, '
        'y brechas competitivas (zonas sin presencia de cadenas). '
        'El resultado es un ranking de los 5 mejores sitios candidatos con su propio '
        'puntaje y recomendación de formato.')

    heading(doc, '3.3 Análisis de Trade Area (Transversal)', 2)
    body(doc,
        'Al hacer clic en cualquier punto del mapa, la plataforma calcula en tiempo '
        'real tres anillos de influencia (3 km, 5 km, 10 km) mostrando población, '
        'tiendas propias, cadenas competidoras, índice de saturación y desglose de '
        'PDV por categoría comercial. Opcionalmente, si se configura un token de '
        'Mapbox, los anillos se reemplazan por isocronas de tiempo de manejo '
        '(15 min y 30 min).')

    # ── 4. Interfaz ────────────────────────────────────────────────────────────
    heading(doc, '4. Componentes de la Interfaz', 1)

    heading(doc, '4.1 Mapa Principal', 2)
    body(doc,
        'El centro de la pantalla muestra un mapa de Guatemala basado en OpenStreetMap. '
        'Sobre él se superponen distintas capas que el usuario puede activar o desactivar '
        'de forma independiente:')
    layers = [
        ('Tiendas Propias', 'Marcadores de colores según formato (Despensa Familiar, Maxi Despensa, Walmart, Paiz, Otra).'),
        ('Competidores', 'Marcadores naranjas dimensionados según la densidad de cadenas en cada punto.'),
        ('Oportunidades Top 20', 'Burbujas amarillas sobre los municipios con mayor puntaje.'),
        ('Núcleos POI / Zonas', 'Círculos de color indicando concentraciones de actividad comercial (carga diferida).'),
        ('Brechas Competitivas', 'Calor de zonas con baja presencia de competidores pero alta actividad POI.'),
        ('Selección de Sitio', 'Marcadores GO/PRECAUCIÓN/NO-GO de candidatos micro dentro de un municipio seleccionado.'),
    ]
    add_kv_table(doc, layers, col_widths=(5, 11))

    heading(doc, '4.2 Panel Lateral (Sidebar)', 2)
    body(doc,
        'El panel a la izquierda del mapa cumple tres funciones según el contexto:')
    bullet(doc, 'Lista de oportunidades: muestra las mejores 20–50 oportunidades con puntaje, formato sugerido y semáforo.')
    bullet(doc, 'Filtros: población mínima, puntaje mínimo, formato y modo "Blue Ocean" (mercados sin tiendas propias).')
    bullet(doc, 'Detalle de sitio: al seleccionar un municipio, muestra asentamientos NTL, micro-sitios candidatos y datos de la Etapa 2.')

    heading(doc, '4.3 Panel de Trade Area', 2)
    body(doc,
        'Aparece al hacer clic en el mapa. Muestra el desglose del puntaje del punto '
        'seleccionado y los tres anillos de influencia con sus indicadores.')

    heading(doc, '4.4 Panel de Administración (⚙)', 2)
    body(doc,
        'Accesible desde el ícono de engranaje en el encabezado. Permite ajustar pesos, '
        'umbrales, importar datos y ejecutar operaciones de mantenimiento del sistema. '
        'Ver Sección 8 para detalle completo.')

    heading(doc, '4.5 Botón Reporte (📄)', 2)
    body(doc,
        'Genera un reporte HTML imprimible con el ranking de oportunidades, '
        'desglose de factores y recomendaciones de formato, agrupadas por departamento.')

    # ── 5. Lógica de Cálculo ────────────────────────────────────────────────────
    heading(doc, '5. Lógica de los Cálculos', 1)

    heading(doc, '5.1 Puntaje Compuesto de Municipio (Etapa 1)', 2)
    body(doc,
        'El puntaje final de cada municipio es la suma ponderada de cinco factores, '
        'cada uno normalizado en una escala de 0 a 100:')

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(
        'Puntaje = (Población × 0.28) + (Movilidad × 0.22) + (Comercial × 0.22)\n'
        '         + (Competencia × 0.15) + (Socioeconómico × 0.13)'
    )
    r.font.name = 'Courier New'
    r.font.size = Pt(10)
    doc.add_paragraph()

    body(doc, 'Los pesos por defecto son ajustables desde el Panel de Administración. La suma de los cinco pesos siempre debe ser igual a 1.0.')
    add_score_table(doc)

    heading(doc, '5.2 Factor Población', 2)
    body(doc,
        'La población del municipio se convierte en puntaje mediante interpolación '
        'lineal a trozos sobre los siguientes puntos de calibración (basados en umbrales '
        'operativos de la cadena):')
    pop_rows = [
        ('0 habitantes', '0 puntos'),
        ('5,000 hab.', '10 puntos'),
        ('15,000 hab.', '25 puntos'),
        ('24,000 hab.', '40 puntos  ← umbral mínimo Despensa Familiar'),
        ('40,000 hab.', '52 puntos'),
        ('55,000 hab.', '65 puntos  ← umbral mínimo Maxi Despensa'),
        ('100,000 hab.', '80 puntos'),
        ('300,000 hab.', '92 puntos'),
        ('1,100,000 hab.', '100 puntos'),
    ]
    add_kv_table(doc, pop_rows, col_widths=(5, 11))
    body(doc,
        'Municipios con proyección de crecimiento demográfico alta (tasas intercensales '
        'INE 2018–2023) reciben un bono adicional de crecimiento que puede ajustar '
        'positivamente el puntaje de población.')

    heading(doc, '5.3 Factor Movilidad y Acceso', 2)
    body(doc,
        'Mide la accesibilidad del municipio considerando tres componentes combinados:')
    bullet(doc, 'Densidad vial: kilómetros de carreteras por km² de área municipal (fuente OSM).')
    bullet(doc, 'Proximidad a carretera principal: distancia al eje vial más cercano clasificado como primario o secundario (buffer 0–15 km).')
    bullet(doc, 'Clasificación urbana: bono binario para municipios con cabecera urbana reconocida.')
    body(doc, 'Los tres componentes se normalizan y combinan para producir el puntaje de movilidad (0–100).')

    heading(doc, '5.4 Factor Densidad Comercial', 2)
    body(doc,
        'Cuenta y pondera los puntos de interés (POI) comerciales dentro de los límites '
        'del municipio. Los PDV ancla (mercados, bancos, farmacias, supermercados) '
        'reciben mayor peso que los de soporte (gasolineras, cajeros, hospitales, '
        'escuelas, tiendas). El total ponderado se normaliza a 0–100 según umbrales '
        'de referencia.')

    heading(doc, '5.5 Factor Paisaje Competitivo', 2)
    body(doc,
        'Evalúa la saturación del mercado desde dos ángulos (ambos se invierten: '
        'menos competencia = mejor puntaje):')
    bullet(doc, 'Distancia a tienda propia más cercana: a mayor distancia, menor saturación propia, mayor puntaje.')
    bullet(doc, 'Densidad de cadenas competidoras en 10 km: a menor número de cadenas, mayor puntaje.')
    body(doc,
        'El índice de saturación (tiendas propias + competidoras por cada 10,000 habitantes '
        'en el radio de 3 km) también se calcula y se muestra en el análisis de trade area.')

    heading(doc, '5.6 Factor Proxy Socioeconómico', 2)
    body(doc,
        'Aproxima el nivel socioeconómico del municipio usando indicadores públicos disponibles:')
    bullet(doc, 'Número de escuelas y centros de salud (correlación positiva con ingreso y densidad poblacional estructurada).')
    bullet(doc, 'Índice de urbanización del municipio.')
    bullet(doc, 'Índice de pobreza departamental (INE).')
    bullet(doc, 'Indicadores de remesas a nivel departamental.')

    heading(doc, '5.7 Recomendación de Formato', 2)
    body(doc, 'La plataforma sugiere el formato de tienda más adecuado según reglas basadas en población y puntajes de movilidad/comercial:')
    fmt_rows = [
        ('Población ≥ 55,000', 'Maxi Despensa recomendada'),
        ('Población 24,000–54,999', 'Despensa Familiar recomendada'),
        ('Población 24,000–54,999 + Movilidad ≥ 80% o Comercial ≥ 85%', 'Maxi Despensa posible (override)'),
        ('Población < 24,000', 'Sin recomendación de formato'),
    ]
    add_kv_table(doc, fmt_rows, col_widths=(8, 8))

    heading(doc, '5.8 Semáforo de Recomendación', 2)
    add_recommendation_table(doc)

    # ── 6. Etapa 2 ────────────────────────────────────────────────────────────
    heading(doc, '6. Selección de Micro-Sitio (Etapa 2)', 1)

    heading(doc, '6.1 Fuentes de Candidatos', 2)
    body(doc,
        'Para cada municipio seleccionado, el sistema identifica sitios candidatos '
        'a partir de tres fuentes complementarias:')
    src_rows = [
        ('Asentamientos NTL\n(Nighttime Lights)', 'Clústeres de actividad nocturna detectados por el satélite VIIRS. Cada clúster '
         'estima la población local mediante la fórmula:\n'
         'Población estimada = REDONDEAR(Radiancia × 180 × 4.2)\n'
         'donde 180 = hogares por unidad de radiancia (calibración INE) '
         'y 4.2 = tamaño promedio del hogar (Censo 2018).'),
        ('Núcleos POI\n(Zonas Comerciales)', 'Agrupamiento DBSCAN de puntos de interés. Identifica concentraciones densas de '
         'PDV que actúan como imanes comerciales. Cada núcleo recibe un puntaje ponderado '
         'por tipo de ancla presente.'),
        ('Brechas Competitivas\n(Brechas / Gaps)', 'Zonas dentro del municipio con alta actividad comercial pero baja o nula '
         'presencia de cadenas competidoras. Priorizadas en tres niveles: '
         'Alta, Media y Baja.'),
    ]
    add_kv_table(doc, src_rows, col_widths=(5, 11))

    heading(doc, '6.2 Puntaje Micro (Micro-Score)', 2)
    body(doc, 'Cada sitio candidato recibe un puntaje micro (0–100) calculado como:')
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(
        'Micro-Score = (NTL Luminosidad × 0.30) + (Gravedad Comercial × 0.30)\n'
        '            + (Calidad de Brecha × 0.20) + (Población Catchment × 0.15)\n'
        '            + (Socioeconómico × 0.05)'
    )
    r.font.name = 'Courier New'
    r.font.size = Pt(10)
    doc.add_paragraph()

    micro_rows = [
        ('NTL Luminosidad (30%)', 'Radiancia satelital normalizada. Proxy de actividad económica y poder adquisitivo local.'),
        ('Gravedad Comercial (30%)', 'Puntaje ponderado de PDV ancla en el área inmediata del candidato.'),
        ('Calidad de Brecha (20%)', 'Nivel de whitespace competitivo: Alta = 20 pts, Media = 12 pts, Baja = 6 pts.'),
        ('Población Catchment (15%)', 'Estimación de población en 3 km derivada de datos NTL.'),
        ('Socioeconómico (5%)', 'Puntaje socioeconómico heredado del municipio padre.'),
    ]
    add_kv_table(doc, micro_rows, col_widths=(5.5, 10.5))

    heading(doc, '6.3 Restricciones Aplicadas', 2)
    body(doc, 'Se excluyen automáticamente los candidatos que:')
    bullet(doc, 'Se encuentren a menos de 1 km de una tienda propia existente (evitar canibalización).')
    body(doc, 'El resultado final es una lista de los 5 mejores micro-sitios ordenados por puntaje, con su recomendación de formato y nivel GO/PRECAUCIÓN/NO-GO.')

    # ── 7. Análisis de Trade Area ──────────────────────────────────────────────
    heading(doc, '7. Análisis de Trade Area', 1)
    body(doc,
        'Al hacer clic en cualquier punto del mapa, se activa el análisis de trade area. '
        'La plataforma calcula en tiempo real los siguientes indicadores para tres '
        'radios concéntricos (3, 5 y 10 km):')

    ta_rows = [
        ('Población dentro del radio', 'Suma de la población de los municipios contenidos o intersectados por el radio, proporcional al área cubierta.'),
        ('Tiendas propias', 'Conteo y detalle de tiendas propias (nombre, formato, distancia al punto).'),
        ('Competidores', 'Conteo por cadena dentro del radio.'),
        ('Índice de Saturación', 'Tiendas totales (propias + competidoras) por cada 10,000 habitantes en el anillo de 3 km.'),
        ('Desglose de POI', 'Conteo de los 15 tipos de PDV comercial en el radio de 10 km (mercado, banco, farmacia, escuela, combustible, cajero, hospital, remesas, supermercado, terminal, ferretería, iglesia, municipalidad, tienda, cooperativa).'),
        ('Puntaje del Punto', 'Puntaje compuesto de 5 factores para ese punto específico, calculado con el mismo modelo de la Etapa 1.'),
        ('Isocronas (opcional)', 'Si se provee token Mapbox: polígonos de tiempo de manejo de 15 y 30 minutos en lugar de los círculos estándar.'),
    ]
    add_kv_table(doc, ta_rows, col_widths=(5, 11))

    # ── 8. Filtros y Herramientas ─────────────────────────────────────────────
    heading(doc, '8. Filtros y Herramientas de Exploración', 1)

    heading(doc, '8.1 Filtros Disponibles', 2)
    filter_rows = [
        ('Población mínima', 'Filtra municipios por debajo del umbral de habitantes definido.'),
        ('Puntaje mínimo', 'Muestra solo municipios con puntaje ≥ al valor seleccionado.'),
        ('Formato', 'Filtra por tipo de tienda recomendada: Despensa Familiar, Maxi Despensa o ambos.'),
        ('Blue Ocean', 'Activa un modo especial que muestra solo municipios con: población ≥ 15,000, puntaje de competencia ≥ 60 y sin tienda propia en 15 km. Identifica mercados vírgenes de alta oportunidad.'),
    ]
    add_kv_table(doc, filter_rows, col_widths=(5, 11))

    heading(doc, '8.2 Capas del Mapa', 2)
    body(doc, 'Las capas se activan y desactivan de forma independiente desde el panel de control de capas:')
    layer_rows = [
        ('Tiendas Propias', 'Verde (Despensa Familiar), Azul (Maxi Despensa), Gris (Otras).'),
        ('Competidores', 'Naranja; tamaño proporcional a la densidad de cadenas en el área.'),
        ('Oportunidades', 'Burbujas amarillas sobre los 20 municipios de mayor puntaje.'),
        ('Núcleos POI / Zonas', 'Círculos de colores indicando hotspots comerciales detectados por DBSCAN. La primera vez que se activa la capa, puede requerirse construir los núcleos desde el panel de administración.'),
        ('Brechas Competitivas', 'Mapa de calor de whitespace competitivo; filtrable por nivel (Alta / Media / Baja).'),
        ('Selección de Sitio', 'Se activa automáticamente al seleccionar un municipio en la Etapa 2.'),
    ]
    add_kv_table(doc, layer_rows, col_widths=(5, 11))

    # ── 9. Panel Administración ──────────────────────────────────────────────
    heading(doc, '9. Panel de Administración', 1)
    body(doc,
        'El Panel de Administración (ícono ⚙ en el encabezado) está destinado al '
        'usuario administrador o analista y permite controlar todos los parámetros '
        'del modelo sin intervención técnica.')

    heading(doc, '9.1 Pestaña Pesos (Weights)', 2)
    body(doc,
        'Deslizadores para ajustar el peso de cada uno de los cinco factores. '
        'La plataforma valida que la suma sea exactamente 1.0 antes de guardar. '
        'Un botón "Restablecer valores por defecto" vuelve al modelo de calibración '
        '"real-data-v2".')

    heading(doc, '9.2 Pestaña Umbrales (Thresholds)', 2)
    thresh_rows = [
        ('Población mínima Despensa Familiar', 'Mínimo de habitantes para recomendar formato Despensa Familiar (default: 24,000).'),
        ('Población mínima Maxi Despensa', 'Mínimo de habitantes para recomendar formato Maxi Despensa (default: 55,000).'),
        ('Umbral de override Movilidad', 'Si movilidad ≥ umbral (default: 80%), se puede recomendar Maxi Despensa para municipios con 24k–54k hab.'),
        ('Umbral de override Comercial', 'Si puntaje comercial ≥ umbral (default: 85%), ídem al anterior.'),
    ]
    add_kv_table(doc, thresh_rows, col_widths=(6, 10))

    heading(doc, '9.3 Pestaña Tiendas', 2)
    body(doc, 'Permite importar tiendas propias en masa mediante un archivo CSV con el siguiente formato:')
    p = doc.add_paragraph()
    r = p.add_run('store_name, format, lat, lng, status, department, municipio')
    r.font.name = 'Courier New'
    r.font.size = Pt(10)
    body(doc,
        'También permite eliminar todas las tiendas del sistema y ver un resumen '
        'de tiendas por formato y estado.')

    heading(doc, '9.4 Pestaña Competidores', 2)
    body(doc,
        'Importación masiva de competidores (mismo formato CSV). Sincronización '
        'con Google Places para actualizar posiciones de Walmart, Paiz y otras cadenas. '
        'El campo "chain" identifica la cadena (ej: Walmart, Paiz, La Torre).')

    heading(doc, '9.5 Pestaña Sistema', 2)
    system_rows = [
        ('Estadísticas del sistema', 'Conteo de tiendas, competidores, municipios con puntuación, cobertura geográfica.'),
        ('Recalcular todas las puntuaciones', 'Dispara el motor de puntuación para los 254 municipios con la configuración vigente.'),
        ('Actualizar datos OSM', 'Descarga competidores y POIs actualizados desde OpenStreetMap (Overpass API).'),
        ('Construir Núcleos POI', 'Ejecuta el algoritmo DBSCAN sobre los POIs cargados para detectar zonas comerciales. Proceso asincrónico; la capa se actualiza al finalizar.'),
        ('Construir Brechas', 'Analiza el whitespace competitivo y genera el mapa de brechas.'),
        ('Generar Isocronas', 'Crea polígonos de tiempo de manejo (requiere token Mapbox activo).'),
        ('Exportar/Importar caché POI', 'Descarga o carga el catálogo de POIs en formato JSON para uso offline o transferencia.'),
    ]
    add_kv_table(doc, system_rows, col_widths=(5.5, 10.5))

    # ── 10. Flujos de Trabajo ──────────────────────────────────────────────────
    heading(doc, '10. Flujos de Trabajo Recomendados', 1)

    heading(doc, '10.1 Análisis Inicial de Mercado', 2)
    steps_a = [
        'Abrir la plataforma. El mapa muestra Guatemala con los municipios de mayor oportunidad destacados.',
        'Revisar la lista de oportunidades en el panel lateral (Top 20 por defecto).',
        'Aplicar filtros según el contexto del análisis: formato objetivo, población mínima o modo Blue Ocean.',
        'Identificar los municipios de mayor interés (puntaje 60+) y hacer clic en cada tarjeta para explorar el detalle.',
        'Exportar el reporte (botón 📄) para presentación ejecutiva.',
    ]
    for i, s in enumerate(steps_a, 1):
        bullet(doc, f'Paso {i}: {s}')

    heading(doc, '10.2 Evaluación de un Municipio Específico', 2)
    steps_b = [
        'Hacer clic en una tarjeta de oportunidad en la lista o directamente sobre el marcador del municipio en el mapa.',
        'El mapa hace zoom al municipio y carga los asentamientos NTL y los micro-sitios candidatos.',
        'Revisar el ranking de sitios (Etapa 2): puntaje micro, fuente del candidato, formato sugerido y distancia a tienda propia.',
        'Hacer clic sobre un candidato en el mapa para activar el análisis de trade area de ese punto.',
        'Comparar los anillos de influencia y el desglose de POI para tomar la decisión de campo.',
    ]
    for i, s in enumerate(steps_b, 1):
        bullet(doc, f'Paso {i}: {s}')

    heading(doc, '10.3 Evaluación de un Punto Específico (Sin Selección Previa)', 2)
    steps_c = [
        'Navegar en el mapa hasta la zona de interés usando zoom y paneo.',
        'Hacer clic en el punto exacto que se desea evaluar.',
        'Leer el panel de trade area: puntaje del punto, recomendación de formato y anillos de influencia.',
        'Comparar la saturación propia vs. competidora en cada radio.',
        'Activar la capa de competidores y núcleos POI para complementar el análisis visual.',
    ]
    for i, s in enumerate(steps_c, 1):
        bullet(doc, f'Paso {i}: {s}')

    heading(doc, '10.4 Calibración del Modelo (Administrador)', 2)
    steps_d = [
        'Abrir el Panel de Administración (⚙).',
        'En la pestaña Pesos, ajustar los factores según la estrategia vigente (ej. aumentar Movilidad para zonas rurales).',
        'En la pestaña Umbrales, modificar los mínimos de población si la estrategia de formato cambia.',
        'Guardar los cambios y hacer clic en "Recalcular todas las puntuaciones".',
        'Esperar a que el proceso termine (se actualiza automáticamente el mapa).',
        'Validar que el nuevo ranking refleje las expectativas del negocio. Si no, ajustar y repetir.',
    ]
    for i, s in enumerate(steps_d, 1):
        bullet(doc, f'Paso {i}: {s}')

    # ── 11. Indicadores y Glosario ────────────────────────────────────────────
    heading(doc, '11. Glosario de Indicadores', 1)
    glosario = [
        ('Puntaje Compuesto (0–100)', 'Puntuación final del municipio resultado de la suma ponderada de los cinco factores. Determina el ranking de oportunidades.'),
        ('Micro-Score (0–100)', 'Puntaje de un sitio candidato dentro de la Etapa 2. Combina luminosidad NTL, gravedad comercial, brecha competitiva, población catchment y factor socioeconómico.'),
        ('Trade Area', 'Área de influencia de una tienda o punto de análisis, definida por radios de 3, 5 y 10 km (o isocronas de 15 y 30 minutos).'),
        ('NTL (Nighttime Lights)', 'Imágenes satelitales de luminosidad nocturna (satélite VIIRS de NOAA). Se utilizan como proxy de actividad económica y para estimar población en asentamientos sin datos censales.'),
        ('Radiancia NTL', 'Intensidad de luz nocturna medida en nW/cm²/sr. A mayor radiancia, mayor actividad económica y densidad de hogares estimada.'),
        ('Asentamiento NTL', 'Clúster geoespacial de píxeles VIIRS con radiancia significativa, interpretado como un núcleo urbano o semiurbano dentro del municipio.'),
        ('POI (Point of Interest)', 'Punto de interés georreferenciado: tienda, banco, farmacia, escuela, gasolinera, etc. Fuente principal: OpenStreetMap y Google Places.'),
        ('POI Ancla', 'PDV de alto peso en el modelo: mercados, bancos, farmacias y supermercados. Indican madurez comercial del área.'),
        ('Núcleo POI / Zona Comercial', 'Agrupación densa de POIs identificada por el algoritmo DBSCAN. Representa un hotspot de actividad comercial dentro del municipio.'),
        ('DBSCAN', 'Algoritmo de agrupamiento de datos geoespaciales (Density-Based Spatial Clustering of Applications with Noise). Identifica núcleos sin número predefinido de grupos.'),
        ('Brecha Competitiva (Gap)', 'Zona dentro de un municipio donde la actividad comercial es alta pero la presencia de cadenas competidoras es baja. Indica una oportunidad de entrada sin canibalización.'),
        ('Índice de Saturación', 'Número de tiendas (propias + competidoras) por cada 10,000 habitantes dentro del radio de 3 km. Valores bajos indican mercados poco atendidos.'),
        ('Blue Ocean', 'Municipios sin tienda propia en 15 km, con alta actividad comercial y baja saturación competitiva. Mercados vírgenes de oportunidad.'),
        ('Override de Formato', 'Condición por la cual un municipio con población entre 24,000 y 54,999 puede recibir recomendación de Maxi Despensa si su puntaje de movilidad o comercial supera un umbral definido.'),
        ('Isocrona', 'Polígono que delimita el área alcanzable desde un punto en un tiempo de manejo dado (ej. 15 min). Requiere token Mapbox activo.'),
        ('Calibración', 'Ajuste de los pesos y umbrales del modelo desde el Panel de Administración, sin necesidad de cambios técnicos en el sistema.'),
        ('Fuente de Datos INE', 'Instituto Nacional de Estadística de Guatemala. Provee datos del Censo 2018 y proyecciones demográficas intercensales 2018–2023.'),
        ('Overpass API', 'API de consulta de datos de OpenStreetMap. Se utiliza para descargar la red vial, POIs y ubicaciones de competidores.'),
    ]
    add_kv_table(doc, glosario, col_widths=(5.5, 10.5))

    # ── 12. Limitaciones ──────────────────────────────────────────────────────
    heading(doc, '12. Limitaciones y Consideraciones de Versión 1.0', 1)
    body(doc,
        'Esta primera versión del sistema fue construida para Guatemala y está optimizada '
        'para los formatos Despensa Familiar y Maxi Despensa. A continuación se listan '
        'limitaciones conocidas que el usuario debe considerar al interpretar los resultados:')
    limits = [
        'Los datos de población son del Censo 2018 con proyecciones hasta 2023. Municipios con crecimiento acelerado posterior pueden estar sub-valorados.',
        'La cobertura de POIs y competidores depende de la actualización de OpenStreetMap en cada zona. Áreas rurales pueden tener menor cobertura.',
        'Las estimaciones de población NTL tienen mayor precisión en áreas urbanas. En zonas rurales con poca luz artificial pueden subestimar la población real.',
        'El índice de saturación usa una simplificación lineal de la población (municipios completos) que puede no reflejar micro-densidades.',
        'El análisis de trade area usa círculos de radio fijo. Las isocronas de tiempo de manejo son más precisas pero requieren configuración adicional (token Mapbox).',
        'El sistema no incluye aún datos de renta de locales, costos de construcción ni índices de criminalidad, variables que pueden ser relevantes para la decisión final.',
        'La recomendación de formato (Despensa Familiar / Maxi Despensa) es orientativa. La decisión final debe validarse con visita de campo y análisis financiero.',
    ]
    for lim in limits:
        bullet(doc, lim)

    # ── 13. Preguntas Frecuentes ───────────────────────────────────────────────
    heading(doc, '13. Preguntas Frecuentes', 1)

    faqs = [
        ('¿Por qué un municipio con mucha población aparece con puntaje bajo?',
         'El puntaje compuesto integra cinco factores. Un municipio densamente poblado puede tener bajo puntaje si la presencia '
         'de competidores es muy alta (puntaje de Competencia bajo) o si el acceso vial es deficiente (Movilidad baja). '
         'Revise el desglose de factores en la tarjeta de oportunidad.'),
        ('¿Con qué frecuencia se actualiza la información?',
         'Los datos de OSM (POIs y competidores) se pueden actualizar manualmente desde el Panel de Administración. '
         'Los datos de población (INE) son estáticos hasta que se cargue una nueva fuente de referencia.'),
        ('¿Puedo ajustar los pesos sin conocimientos técnicos?',
         'Sí. El Panel de Administración permite mover los deslizadores de cada factor. La plataforma valida automáticamente '
         'que la suma sea 1.0. Luego haga clic en "Recalcular" para ver el nuevo ranking.'),
        ('¿Qué significa "Blue Ocean"?',
         'Es un filtro que muestra únicamente municipios sin tienda propia en 15 km, con actividad comercial moderada o alta '
         'y sin saturación de competidores. Son mercados con alta oportunidad de primer entrante.'),
        ('¿La plataforma considera el tráfico vehicular?',
         'En la configuración estándar, no. El factor Movilidad usa la red vial estática (OSM). Las isocronas de tiempo de manejo, '
         'que sí consideran velocidades promedio por tipo de vía, están disponibles cuando se configura un token de Mapbox.'),
        ('¿Puedo exportar los resultados para usar en otro sistema GIS?',
         'Sí. El botón "Reporte" genera un HTML imprimible. Adicionalmente, los endpoints de la API devuelven GeoJSON '
         'compatible con QGIS, ArcGIS y otros sistemas. Contacte al equipo técnico para habilitar exportaciones directas.'),
        ('¿Qué debo hacer si los núcleos POI no aparecen en el mapa?',
         'Vaya al Panel de Administración → Pestaña Sistema → "Construir Núcleos POI". El proceso tarda unos minutos y '
         'la capa se actualiza automáticamente al finalizar.'),
    ]

    for q, a in faqs:
        p = doc.add_paragraph()
        r = p.add_run(q)
        r.bold = True
        r.font.color.rgb = RGBColor(0x2E, 0x4A, 0x7A)
        body(doc, a)
        doc.add_paragraph()

    # ── Pie de página ─────────────────────────────────────────────────────────
    doc.add_page_break()
    closing = doc.add_paragraph()
    closing.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = closing.add_run(
        'GeoRetail Guatemala — Manual de Usuario v1.0\n'
        'Documento de uso interno. Marzo 2026.'
    )
    r.font.size = Pt(10)
    r.font.color.rgb = RGBColor(0x88, 0x88, 0x88)

    out_path = '/home/user/hello-world/GeoRetail_Guatemala_Manual_v1.0.docx'
    doc.save(out_path)
    print(f'Documento guardado en: {out_path}')

if __name__ == '__main__':
    build_doc()
