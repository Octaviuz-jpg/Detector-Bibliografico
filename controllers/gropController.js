import Groq from "groq-sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// --- CONFIGURACIÓN ---
const API_KEY =0; /**aca va la api key de Groq  */
const MODELO_INTELIGENTE =
  "llama-3.3-70b-versatile"; /**nombre = Groq llama-3.3-70b-versatile */
const groq = new Groq({ apiKey: API_KEY });

/**
 * CONTROLADOR PRINCIPAL: Procesa el texto extraído del PDF, identifica obras y autores,
 * y cruza datos con múltiples APIs académicas.
 */
export const procesarBibliografiaHibrida = async (req, res) => {
  try {
    let texto = req.textoExtraido;
    if (!texto) return res.status(400).json({ error: "No se recibió texto" });

    // Limpieza de caracteres especiales
    texto = texto.replace(/&amp;/g, " & ").replace(/[\t\r]/g, " ");

    console.log("\n--- 🚀 INICIANDO DETECCIÓN DE REFERENCIAS Y MÉTRICAS ---");

    // PASO 1: Extracción de datos base con IA
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Extrae referencias bibliográficas en JSON. 'autores_lista' debe ser un array con nombres individuales (ej: ['Jim Gray', 'Andreas Reuter']). Extrae 'doi_pdf' y 'url_pdf' si aparecen textualmente en la referencia. No inventes datos.",
        },
        {
          role: "user",
          content: `Texto: ${texto.substring(0, 8000)} \n JSON: {"referencias": [{"autores_lista": [], "titulo": "", "anio": "", "doi_pdf": "", "url_pdf": ""}]}`,
        },
      ],
      model: MODELO_INTELIGENTE,
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const dataRaw = JSON.parse(completion.choices[0].message.content);
    const referenciasBase = dataRaw.referencias || [];
    const resultadosFinales = [];

    // PASO 2: Procesamiento individual de cada obra detectada
    for (const ref of referenciasBase) {
      const autoresPDF = Array.isArray(ref.autores_lista) ? ref.autores_lista : [];
      const titulo = String(ref.titulo || "");
      
      // Identificadores de la OBRA: Prioridad al PDF, respaldo en API
      let doiFinal = ref.doi_pdf || null;
      let urlObra = ref.url_pdf || null;

      if ((!doiFinal || !urlObra) && titulo.length > 15) {
        console.log(`🔍 Buscando datos externos para: "${titulo.substring(0, 35)}..."`);
        const dataExterna = await obtenerDatosExtraObra(titulo);
        doiFinal = doiFinal || dataExterna.doi;
        urlObra = urlObra || dataExterna.url;
      }

      // Normalizar DOI (Asegurar formato de URL)
      if (doiFinal && !doiFinal.startsWith("http")) {
        doiFinal = `https://doi.org/${doiFinal.replace(/doi:|doi/gi, "").trim()}`;
      }

      // 3. Validación de Autores: Se busca métricas autor por autor
      const autoresOficiales = await obtenerAutoresDesdeCrossref(titulo);
      const autoresValidados = [];

      for (const nombrePersona of autoresPDF) {
        if (!nombrePersona || nombrePersona.length < 3) continue;

        // Lógica de desambiguación por apellido
        const partes = nombrePersona.split(",");
        const apellidoBusqueda = partes[0].split(" ").pop().trim().toLowerCase();
        const matchReal = autoresOficiales.find((n) => n.toLowerCase().includes(apellidoBusqueda));
        
        const nombreParaBuscar = matchReal ? matchReal : nombrePersona;

        try {
          // Delay de 1.2s para evitar 429 (Too Many Requests)
          await new Promise((r) => setTimeout(r, 1200));
          
          const metricas = await obtenerMetricasCompletas(nombreParaBuscar);

          autoresValidados.push({
            nombre_original: nombrePersona,
            nombre_identificado: nombreParaBuscar,
            validado_via: matchReal ? "Crossref" : "PDF",
            orcid: metricas.orcid,
            institucion: metricas.institucion,
            metricas_h: metricas.metricas_h
          });
        } catch (err) {
          autoresValidados.push({ 
            nombre_original: nombrePersona, 
            error: "No se pudieron obtener métricas" 
          });
        }
      }

      // 4. Consolidación de la Referencia
      resultadosFinales.push({
        titulo: ref.titulo,
        anio: ref.anio,
        doi: doiFinal,
        url: urlObra,
        fuente_identificadores: ref.doi_pdf ? "Documento" : (doiFinal ? "API Externa" : "Ninguna"),
        autores_validados: autoresValidados
      });
    }

    res.json({ success: true, data: resultadosFinales });
  } catch (error) {
    console.error("❌ ERROR GENERAL:", error.message);
    res.status(500).json({ error: error.message });
  }
};

/**
 * 🎓 OBTENER MÉTRICAS DE AUTOR (OpenAlex + Semantic Scholar)
 */
async function obtenerMetricasCompletas(nombre) {
  try {
    const s2Fields = "hIndex,externalIds,affiliations,name";
    const [alex, semantic] = await Promise.all([
      axios.get(`https://api.openalex.org/authors?search=${encodeURIComponent(nombre)}`, { timeout: 6000 }).catch(() => null),
      axios.get(`https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(nombre)}&fields=${s2Fields}`, { timeout: 6000 }).catch(() => null)
    ]);

    const dAlex = alex?.data?.results?.[0];
    const dSem = semantic?.data?.data?.[0];

    // Cálculo de índices H y promedio
    const h_alex = Number(dAlex?.summary_stats?.h_index || 0);
    const h_semantic = Number(dSem?.hIndex || 0);
    const fuentes = [h_alex, h_semantic].filter(h => h > 0);

    // Identificación de institución y ORCID
    const orcid = dSem?.externalIds?.ORCID || dAlex?.ids?.orcid?.split('/').pop() || null;
    const instRaw = dAlex?.last_known_institution?.display_name || dSem?.affiliations?.[0];
    const institucion = typeof instRaw === "string" ? instRaw : (instRaw?.name || "No detectada");

    return {
      orcid,
      institucion,
      metricas_h: {
        open_alex: h_alex,
        semantic_scholar: h_semantic,
        promedio: fuentes.length > 0 ? Number((fuentes.reduce((a, b) => a + b, 0) / fuentes.length).toFixed(2)) : 0,
        maximo: Math.max(h_alex, h_semantic)
      }
    };
  } catch (e) {
    return { orcid: null, institucion: "Error de red", metricas_h: { open_alex: 0, semantic_scholar: 0, promedio: 0, maximo: 0 } };
  }
}

/**
 * 🔍 BUSCAR DATOS DE LA OBRA (DOI y URL)
 */
async function obtenerDatosExtraObra(titulo) {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(titulo)}&limit=1&fields=externalIds,url`;
    const res = await axios.get(url, { timeout: 6000 });
    const paper = res.data.data?.[0];
    return {
      doi: paper?.externalIds?.DOI || null,
      url: paper?.url || null
    };
  } catch (e) {
    return { doi: null, url: null };
  }
}

/**
 * 🌐 BÚSQUEDA EN CROSSREF (Para normalizar nombres de autores)
 */
async function obtenerAutoresDesdeCrossref(titulo) {
  try {
    const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(titulo)}&rows=1`;
    const res = await axios.get(url, { timeout: 6000 });
    const item = res.data.message.items?.[0];
    return item?.author ? item.author.map((a) => `${a.given || ""} ${a.family || ""}`.trim()) : [];
  } catch (e) {
    return [];
  }
}