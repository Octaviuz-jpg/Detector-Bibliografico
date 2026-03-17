import Groq from "groq-sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// --- CONFIGURACIÓN ---
const API_KEY = "TU_API_KEY_DE_GROQ_AQUI"; // Reemplaza con tu API Key de Groq
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
      let issn = null;
      let isbn = null;

      if (titulo.length > 15) {
        console.log(
          `🔍 Buscando metadatos para: "${titulo.substring(0, 35)}..."`,
        );
        // 🔥 Pasamos autoresPDF para ayudar a Google Books si Crossref falla
        const dataExterna = await obtenerDatosExtraObra(titulo, autoresPDF);
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

      // 🔥 PAUSA ANTI-BLOQUEO ENTRE REFERENCIAS (2 segundos)
      await new Promise((r) => setTimeout(r, 2000));
    }

    res.json({ success: true, data: resultadosFinales });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * 🛠️ OBTENER METADATOS CON JUEZ DE IA + RESCATE GOOGLE BOOKS
 */
async function obtenerDatosExtraObra(titulo, autores) {
  try {
    const tituloLimpio = titulo.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const apellidoAutor =
      autores && autores.length > 0 ? autores[0].split(" ").pop() : "";

    if (tituloLimpio.length < 5) return { doi: null, issn: null, isbn: null };

    const queryGlobal = `${tituloLimpio} ${apellidoAutor}`.trim();
    console.log(`\n--- DEBUG: ${tituloLimpio.substring(0, 30)}... ---`);

    // 1. INTENTO CON CROSSREF
    const res = await axios.get("https://api.crossref.org/works", {
      params: { "query.bibliographic": queryGlobal, rows: 1 },
      timeout: 8000,
    });

    let item = res.data.message.items?.[0];
    let doi = null,
      issn = null,
      isbn = null,
      url = null;

    if (item) {
      const tituloAPI = item.title ? item.title[0] : "Sin título";
      const promptIA = `¿Es "${tituloLimpio}" la misma obra que "${tituloAPI}"? Responde solo S o N.`;

      const validacion = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptIA }],
        model: MODELO_INTELIGENTE,
        temperature: 0,
      });

      const decision = validacion.choices[0].message.content
        .trim()
        .toUpperCase();
      if (decision.includes("S")) {
        issn = item.ISSN && item.ISSN.length > 0 ? item.ISSN[0] : null;
        isbn =
          item.ISBN && item.ISBN.length > 0
            ? item.ISBN[0].split("/").pop()
            : null;
        doi = item.DOI ? `https://doi.org/${item.DOI}` : null;
        url = item.URL || doi;
      }
    }

    // 2. 🔥 RESCATE CON GOOGLE BOOKS (Solo si no hay ISBN)
    if (!isbn) {
      try {
        await new Promise((r) => setTimeout(r, 1500)); // Pausa para evitar 429
        const gRes = await axios.get(
          "https://www.googleapis.com/books/v1/volumes",
          {
            params: {
              q: `intitle:${tituloLimpio} inauthor:${apellidoAutor}`,
              maxResults: 1,
            },
            timeout: 5000,
          },
        );

        const libro = gRes.data.items?.[0]?.volumeInfo;
        if (libro) {
          // Validamos con IA el resultado de Google también
          const promptIA_G = `¿Es el libro "${tituloLimpio}" el mismo que "${libro.title}"? Responde S o N.`;
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
            isbn =
              ids.find((id) => id.type.includes("ISBN"))?.identifier || isbn;
            url = url || libro.infoLink;
            console.log(`✅ ISBN Rescatado de Google Books: ${isbn}`);
          }
        }
      } catch (ge) {
        console.log("⚠️ Google Books saturado o sin resultados.");
      }
    }

    return { doi, issn, isbn, url };
  } catch (e) {
    console.error(`🚨 ERROR:`, e.message);
    return { doi: null, issn: null, isbn: null };
  }
}

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
