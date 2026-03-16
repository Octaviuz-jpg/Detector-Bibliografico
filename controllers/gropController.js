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

    console.log("\n--- 🚀 INICIANDO DETECCIÓN DE REFERENCIAS Y MÉTRICAS ---");

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "Extrae referencias bibliográficas en JSON. 'autores_lista' debe ser un array con nombres individuales. Extrae 'doi_pdf' y 'url_pdf' si aparecen textualmente.",
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

    for (const ref of referenciasBase) {
      const autoresPDF = Array.isArray(ref.autores_lista)
        ? ref.autores_lista
        : [];
      const titulo = String(ref.titulo || "");

      let doiFinal = ref.doi_pdf || null;
      let urlObra = ref.url_pdf || null;
      // NUEVAS VARIABLES PARA ISBN/ISSN
      let issn = null;
      let isbn = null;

      if (titulo.length > 15) {
        console.log(
          `🔍 Buscando metadatos para: "${titulo.substring(0, 35)}..."`,
        );
        const dataExterna = await obtenerDatosExtraObra(titulo);
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
          await new Promise((r) => setTimeout(r, 1200));
          const metricas = await obtenerMetricasCompletas(nombreParaBuscar);

          autoresValidados.push({
            nombre_original: nombrePersona,
            nombre_identificado: nombreParaBuscar,
            validado_via: matchReal ? "Crossref" : "PDF",
            orcid: metricas.orcid,
            institucion: metricas.institucion,
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
    }

    res.json({ success: true, data: resultadosFinales });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * 🔍 BUSCAR DATOS DE LA OBRA (DOI, URL, ISSN, ISBN)
 * Se actualiza a OpenAlex para obtener identificadores bibliográficos
 */
/**
 * 
/**
 * 🛠️ INTEGRACIÓN DEL JUEZ DE IA (Manteniendo tu estructura original)
 */
async function obtenerDatosExtraObra(titulo) {
  try {
    const tituloLimpio = titulo.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (tituloLimpio.length < 8)
      return { doi: null, url: null, issn: null, isbn: null };

    const res = await axios.get("https://api.crossref.org/works", {
      params: { "query.bibliographic": tituloLimpio, rows: 1 },
      timeout: 10000,
    });

    const item = res.data.message.items?.[0];
    if (!item) return { doi: null, url: null, issn: null, isbn: null };

    const tituloAPI = item.title ? item.title[0] : "";

    // --- MEJORA EN EL PROMPT Y LA LÓGICA DE DECISIÓN ---
    const promptIA = `Analiza si estos dos títulos representan la misma obra (libro, artículo o conferencia). 
    Ignora diferencias de edición, puntuación, subtítulos o si uno está más completo que el otro.
    Responde UNICAMENTE con la letra 'S' si son la misma obra o 'N' si son distintas.
    
    Título A: "${tituloLimpio}"
    Título B: "${tituloAPI}"`;

    const validacion = await groq.chat.completions.create({
      messages: [{ role: "user", content: promptIA }],
      model: "llama-3.3-70b-versatile",
      temperature: 0,
    });

    const respuestaIA = validacion.choices[0].message.content
      .trim()
      .toUpperCase();

    // Log para que veas en la consola qué está pasando
    console.log(
      `[IA JUDGE] PDF: ${tituloLimpio}... | API: ${tituloAPI}... | Decisión: ${respuestaIA}`,
  
    );

    // Usamos .includes para capturar la 'S' aunque la IA responda "S." o "Sí"
    if (respuestaIA.includes("S") && !respuestaIA.includes("N")) {
      let issn = null;
      let isbn = null;

      const tiposAcademicos = [
        "journal-article",
        "book",
        "proceedings-article",
        "monograph",
        "book-chapter",
      ];
      if (tiposAcademicos.includes(item.type)) {
        issn = item.ISSN && item.ISSN.length > 0 ? item.ISSN[0] : null;
        isbn =
          item.ISBN && item.ISBN.length > 0
            ? item.ISBN[0].split("/").pop()
            : null;
      }

      return {
        doi: item.DOI ? `https://doi.org/${item.DOI}` : null,
        url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : null),
        issn: issn,
        isbn: isbn,
      };
    }

    return { doi: null, url: null, issn: null, isbn: null };
  } catch (e) {
    console.error("Error en obtenerDatosExtraObra:", e.message);
    return { doi: null, url: null, issn: null, isbn: null };
  }
}
/**
 * 🎓 OBTENER MÉTRICAS DE AUTOR (Sin cambios)
 */
async function obtenerMetricasCompletas(nombre) {
  try {
    const s2Fields = "hIndex,externalIds,affiliations,name";
    const [alex, semantic] = await Promise.all([
      axios
        .get(
          `https://api.openalex.org/authors?search=${encodeURIComponent(nombre)}`,
          { timeout: 6000 },
        )
        .catch(() => null),
      axios
        .get(
          `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(nombre)}&fields=${s2Fields}`,
          { timeout: 6000 },
        )
        .catch(() => null),
    ]);

    const dAlex = alex?.data?.results?.[0];
    const dSem = semantic?.data?.data?.[0];
    const h_alex = Number(dAlex?.summary_stats?.h_index || 0);
    const h_semantic = Number(dSem?.hIndex || 0);
    const fuentes = [h_alex, h_semantic].filter((h) => h > 0);
    const orcid =
      dSem?.externalIds?.ORCID || dAlex?.ids?.orcid?.split("/").pop() || null;
    const instRaw =
      dAlex?.last_known_institution?.display_name || dSem?.affiliations?.[0];
    const institucion =
      typeof instRaw === "string" ? instRaw : instRaw?.name || "No detectada";

    return {
      orcid,
      institucion,
      metricas_h: {
        open_alex: h_alex,
        semantic_scholar: h_semantic,
        promedio:
          fuentes.length > 0
            ? Number(
                (fuentes.reduce((a, b) => a + b, 0) / fuentes.length).toFixed(
                  2,
                ),
              )
            : 0,
        maximo: Math.max(h_alex, h_semantic),
      },
    };
  } catch (e) {
    return { orcid: null, institucion: "Error", metricas_h: { promedio: 0 } };
  }
}

/**
 * 🌐 BÚSQUEDA EN CROSSREF (Sin cambios)
 */
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
