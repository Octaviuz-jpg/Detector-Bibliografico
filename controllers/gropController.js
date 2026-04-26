import Groq from "groq-sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// --- CONFIGURACIÓN ---
const API_KEY = "";
const MODELO_INTELIGENTE = "llama-3.3-70b-versatile";
const groq = new Groq({ apiKey: API_KEY });

export const procesarBibliografiaHibrida = async (req, res) => {
  try {
    let texto = req.textoExtraido;
    if (!texto) return res.status(400).json({ error: "No se recibió texto" });

    texto = texto.replace(/&amp;/g, " & ").replace(/[\t\r]/g, " ");

    console.log("\n---  INICIANDO DETECCIÓN DE REFERENCIAS Y MÉTRICAS ---");

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "Extrae referencias bibliográficas en JSON. 'autores_lista' debe ser un array con nombres individuales. Extrae el 'doi_pdf' completo. No lo cortes aunque veas puntos o números que parezcan fechas. Un DOI suele terminar en un número largo de 7 u 8 dígitos. Captura todo hasta el siguiente espacio en blanco   y 'url_pdf' si aparecen textualmente. Extrae 'revista_nombre' (solo el nombre de la revista o journal, sin volúmenes).",
        },
        {
          role: "user",
          content: `Texto: ${texto.substring(0, 8000)} \n JSON: {"referencias": [{"autores_lista": [], "titulo": "", "anio": "", "doi_pdf": "", "url_pdf": "", "revista_nombre": ""}]}`,
        },
      ],
      model: MODELO_INTELIGENTE,
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const dataRaw = JSON.parse(completion.choices[0].message.content);
    const referenciasBase = dataRaw.referencias || [];
    const resultadosFinales = [];

    for (const ref of referenciasBase) {
      const autoresPDF = Array.isArray(ref.autores_lista)
        ? ref.autores_lista
        : [];
      const titulo = String(ref.titulo || "");

      let doiFinal = ref.doi_pdf || null;
      let urlObra = ref.url_pdf || null;
      let issn = null;
      let isbn = null;

      if (titulo.length > 15) {
        console.log(
          `🔍 Buscando metadatos para: "${titulo.substring(0, 35)}..."`,
        );
        // 🔥 Pasamos autoresPDF para ayudar a Google Books si Crossref falla
        const dataExterna = await obtenerDatosExtraObra(
          titulo,
          autoresPDF,
          ref.doi_pdf,
          ref.revista_nombre,
        );
        doiFinal = doiFinal || dataExterna.doi;
        urlObra = urlObra || dataExterna.url;
        issn = dataExterna.issn;
        isbn = dataExterna.isbn;
      }

      if (doiFinal && !doiFinal.startsWith("http")) {
        doiFinal = `https://doi.org/${doiFinal.replace(/doi:|doi/gi, "").trim()}`;
      }

      const autoresOficiales = await obtenerAutoresDesdeCrossref(titulo);
      const autoresValidados = [];

      for (const nombrePersona of autoresPDF) {
        if (!nombrePersona || nombrePersona.length < 3) continue;

        const partes = nombrePersona.split(",");
        const apellidoBusqueda = partes[0]
          .split(" ")
          .pop()
          .trim()
          .toLowerCase();
        const matchReal = autoresOficiales.find((n) =>
          n.toLowerCase().includes(apellidoBusqueda),
        );
        const nombreParaBuscar = matchReal ? matchReal : nombrePersona;

        try {
          await new Promise((r) => setTimeout(r, 6000));
          const metricas = await obtenerMetricasCompletas(nombreParaBuscar);

          autoresValidados.push({
            nombre_original: nombrePersona,
            nombre_identificado: nombreParaBuscar,
            validado_via: matchReal ? "Crossref" : "PDF",
            orcid: metricas.orcid,
            institucion: metricas.institucion,
            perfil: metricas.perfil_profesional,
            metricas_h: metricas.metricas_h,
          });
        } catch (err) {
          autoresValidados.push({
            nombre_original: nombrePersona,
            error: "No se pudieron obtener métricas",
          });
        }
      }

      resultadosFinales.push({
        titulo: ref.titulo,
        anio: ref.anio,
        doi: doiFinal,
        url: urlObra,
        identificadores_fuente: {
          issn: issn,
          isbn: isbn,
        },
        fuente_identificadores: ref.doi_pdf
          ? "Documento"
          : doiFinal
            ? "API Externa"
            : "Ninguna",
        autores_validados: autoresValidados,
      });

      // PAUSA ANTI-BLOQUEO ENTRE REFERENCIAS (2 segundos)
      await new Promise((r) => setTimeout(r, 4000));
    }

    // En tu ruta de Express
    res.render("resultados", { reporte: resultadosFinales });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * 🛠️ OBTENER METADATOS CON JUEZ DE IA + RESCATE GOOGLE BOOKS (Versión Corregida)
 */
/**
 * 🛠️ OBTENER METADATOS CON PRIORIDAD EN DOI + CROSSREF + GOOGLE BOOKS
 * Integra búsqueda directa por DOI, búsqueda bibliográfica y rescate en Google Books.
 */
async function obtenerDatosExtraObra(
  titulo,
  autores,
  doiExtraido = null,
  nombreRevista = null,
) {
  try {
    const tituloLimpio = titulo.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const apellidoAutor =
      autores && autores.length > 0 ? autores[0].split(" ").pop() : "";

    if (tituloLimpio.length < 5 && !doiExtraido) {
      return { doi: null, issn: null, isbn: null, url: null };
    }

    let doi = null,
      issn = null,
      isbn = null,
      url = null;
    let item = null;

    // --- ESCENARIO A: YA TENEMOS UN DOI DEL DOCUMENTO (Prioridad Máxima) ---
    if (doiExtraido) {
      console.log(
        `🎯 Consultando Crossref directamente por DOI: ${doiExtraido}`,
      );
      try {
        // Limpieza de formato para el DOI
        const doiLimpio = doiExtraido
          .replace(/https?:\/\/doi\.org\//g, "")
          .replace(/doi:/gi, "")
          .trim();

        const resDoi = await axios.get(
          `https://api.crossref.org/works/${encodeURIComponent(doiLimpio)}`,
          {
            timeout: 5000,
          },
        );
        item = resDoi.data.message;
      } catch (e) {
        console.log(
          "⚠️ DOI no encontrado en Crossref, intentando búsqueda por título...",
        );
      }
    }

    // --- ESCENARIO B: BÚSQUEDA POR TÍTULO EN CROSSREF ---
    if (!item && tituloLimpio.length > 5) {
      const queryGlobal = `${tituloLimpio} ${apellidoAutor}`.trim();
      console.log(
        `\n--- 🔍 Procesando: "${tituloLimpio.substring(0, 40)}..." ---`,
      );

      const resSearch = await axios.get("https://api.crossref.org/works", {
        params: { "query.bibliographic": queryGlobal, rows: 1 },
        timeout: 8000,
      });

      const sugerencia = resSearch.data.message.items?.[0];

      if (sugerencia) {
        const tituloAPI = sugerencia.title ? sugerencia.title[0] : "Sin título";
        const promptIA = `¿La obra científica "${tituloLimpio}" es la misma que "${tituloAPI}"? (Responde solo S o N).`;

        const validacion = await groq.chat.completions.create({
          messages: [{ role: "user", content: promptIA }],
          model: MODELO_INTELIGENTE,
          temperature: 0,
        });

        if (
          validacion.choices[0].message.content
            .trim()
            .toUpperCase()
            .includes("S")
        ) {
          console.log("✅ Coincidencia confirmada en Crossref por título");
          item = sugerencia;
        }
      }
    }

    // --- PROCESAMIENTO DE DATOS DE CROSSREF ---
    if (item) {
      // Extracción de ISSN
      if (item.ISSN && Array.isArray(item.ISSN)) {
        issn = item.ISSN[0];
      } else if (item.ISSN) {
        issn = item.ISSN;
      }

      // Extracción de ISBN
      if (item.ISBN && Array.isArray(item.ISBN)) {
        const foundIsbn =
          item.ISBN.find((id) => id.replace(/-/g, "").length === 13) ||
          item.ISBN[0];
        if (foundIsbn) isbn = foundIsbn.split("/").pop().replace(/-/g, "");
      }

      doi = item.DOI ? `https://doi.org/${item.DOI}` : doiExtraido || null;
      url = item.URL || doi;
    }

    // --- ESCENARIO D: RESCATE DE ISSN POR NOMBRE DE REVISTA (PLAN B) ---
    if (!issn && nombreRevista) {
      console.log(`📡 Buscando ISSN para la revista: "${nombreRevista}"...`);
      const datosRevista = await buscarISSNPorNombreRevista(nombreRevista);

      if (datosRevista && datosRevista.issn) {
        issn = datosRevista.issn; // <--- Extraemos solo el string
        console.log(`✅ ISSN Encontrado vía Semantic Scholar: ${issn}`);
      }
    }

    // --- ESCENARIO C: RESCATE CON GOOGLE BOOKS (Si falta ISBN) ---
    if (!isbn && tituloLimpio.length > 5) {
      try {
        await new Promise((r) => setTimeout(r, 1500)); // Delay preventivo
        const gRes = await axios.get(
          "https://www.googleapis.com/books/v1/volumes",
          {
            params: {
              q: `${tituloLimpio} ${apellidoAutor}`,
              maxResults: 1,
            },
            timeout: 5000,
          },
        );

        const libro = gRes.data.items?.[0]?.volumeInfo;
        if (libro) {
          const promptIA_G = `¿El libro "${tituloLimpio}" es el mismo que "${libro.title}"? Responde S o N.`;
          const validacionG = await groq.chat.completions.create({
            messages: [{ role: "user", content: promptIA_G }],
            model: MODELO_INTELIGENTE,
            temperature: 0,
          });

          if (
            validacionG.choices[0].message.content
              .trim()
              .toUpperCase()
              .includes("S")
          ) {
            const ids = libro.industryIdentifiers || [];
            const idObj =
              ids.find((id) => id.type.includes("ISBN_13")) ||
              ids.find((id) => id.type.includes("ISBN_10"));

            isbn = idObj ? idObj.identifier.replace(/-/g, "") : null;
            url = url || libro.infoLink;

            if (isbn) console.log(`✅ ISBN Rescatado de Google Books: ${isbn}`);
          }
        }
      } catch (ge) {
        console.log("⚠️ Fallo en rescate de Google Books.");
      }
    }

    return { doi, issn, isbn, url };
  } catch (e) {
    console.error(`🚨 Error en obtenerDatosExtraObra:`, e.message);
    return { doi: null, issn: null, isbn: null, url: null };
  }
}

async function obtenerMetricasCompletas(nombre) {
  try {
    // 1. Definimos los campos exactos que OpenAlex permite en el select (plural)
    const camposAlex =
      "display_name,last_known_institutions,topics,summary_stats";
    const urlAlex = `https://api.openalex.org/authors?search=${encodeURIComponent(nombre)}&select=${camposAlex}`;

    // 2. Mantenemos S2 como respaldo para el h-index (con su delay preventivo)
    const s2Fields = "hIndex,externalIds,affiliations";
    const urlS2 = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(nombre)}&fields=${s2Fields}`;

    const [alex, semantic] = await Promise.all([
      axios.get(urlAlex, { timeout: 7000 }).catch(() => null),
      axios.get(urlS2, { timeout: 7000 }).catch(() => null),
    ]);

    const dAlex = alex?.data?.results?.[0];
    const dSem = semantic?.data?.data?.[0];

    // --- EXTRACCIÓN DE DATOS REALES (OpenAlex) ---
    const instObj = dAlex?.last_known_institutions?.[0];
    const institucion = instObj?.display_name || "Institución no detectada";

    // Determinamos profesión por tipo de institución (education/facility)
    let profesionBase = "Investigador";
    if (instObj?.type === "education") profesionBase = "Académico / Docente";
    if (instObj?.type === "facility") profesionBase = "Investigador Científico";

    // Extraemos el área de estudio real de los 'topics'
    const especialidad =
      dAlex?.topics?.length > 0 ? dAlex.topics[0].display_name : "Área general";

    const campoGeneral =
      dAlex?.topics?.length > 0
        ? dAlex.topics[0].field.display_name
        : "Ciencias";

    // --- MÉTRICAS ---
    const h_alex = Number(dAlex?.summary_stats?.h_index || 0);
    const h_semantic = Number(dSem?.hIndex || 0);

    return {
      orcid: dSem?.externalIds?.ORCID || null,
      institucion: institucion,
      // Creamos el perfil profesional combinado
      perfil_profesional: `${profesionBase} en ${especialidad} (${campoGeneral})`,
      metricas_h: {
        open_alex: h_alex,
        semantic_scholar: h_semantic,
        promedio:
          h_alex > 0 && h_semantic > 0
            ? (h_alex + h_semantic) / 2
            : Math.max(h_alex, h_semantic),
      },
    };
  } catch (e) {
    console.error("🚨 Error en métricas:", e.message);
    return {
      institucion: "Error de conexión",
      perfil_profesional: "No disponible",
      metricas_h: { promedio: 0 },
    };
  }
}

async function obtenerAutoresDesdeCrossref(titulo) {
  try {
    const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(titulo)}&rows=1`;
    const res = await axios.get(url, { timeout: 6000 });
    const item = res.data.message.items?.[0];
    return item?.author
      ? item.author.map((a) => `${a.given || ""} ${a.family || ""}`.trim())
      : [];
  } catch (e) {
    return [];
  }
}

/**
 * 🛰️ RESCATE DE ISSN: Buscando un paper de la revista para extraer el ISSN
 */
async function buscarISSNPorNombreRevista(nombreRevista, reintentos = 2) {
  try {
    if (!nombreRevista || nombreRevista.length < 3) return null;

    const queryLimpia = nombreRevista
      .replace(/vol\.?\s*\d+/gi, "")
      .replace(/[().,]/g, "")
      .trim();

    const res = await axios.get(
      `https://api.semanticscholar.org/graph/v1/paper/search`,
      {
        params: {
          query: `source:"${queryLimpia}"`,
          limit: 1,
          fields: "publicationVenue",
        },
        headers: { "User-Agent": "DetectorBibliograficoUNEG/1.0" },
        timeout: 8000,
      },
    );

    const paper = res.data.data?.[0];
    if (paper?.publicationVenue) {
      const venue = paper.publicationVenue;
      return {
        issn: venue.issn || (venue.issns && venue.issns[0]) || null,
        nombre_oficial: venue.name,
      };
    }
    return null;
  } catch (e) {
    // 🔥 SI EL ERROR ES 429, FORZAMOS UNA PAUSA LARGA Y REINTENTAMOS
    if (e.response?.status === 429 && reintentos > 0) {
      console.log(
        `⏳ Límite de S2 alcanzado. Pausando 5 segundos antes de reintentar... (Quedan ${reintentos})`,
      );
      await new Promise((r) => setTimeout(r, 5000));
      return buscarISSNPorNombreRevista(nombreRevista, reintentos - 1);
    }

    console.error(`🚨 Error S2 (${e.response?.status}):`, e.message);
    return null;
  }
}
