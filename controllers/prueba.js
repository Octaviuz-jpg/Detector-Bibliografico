import Groq from "groq-sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const API_KEY_GROQ = process.env.API_KEY_GROQ;
const ELSEVIER_KEY = process.env.ELSEVIER_KEY;
const MODELO_IA = "llama-3.3-70b-versatile";

const groq = new Groq({ apiKey: API_KEY_GROQ });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CACHÉ EN MEMORIA ---
const cache = {
  crossref: new Map(),
  semanticScholar: new Map(),
  elsevier: new Map(),
  orcid: new Map(),
  googleBooks: new Map(),
};

// --- MANEJO DE ERRORES DE API ---
function manejarErrorApi(err, contexto) {
  if (!err) return;
  const status = err?.response?.status;
  const code = err?.code;
  if (status === 429) console.warn(`Rate limit [${contexto}]`);
  else if (status === 404) console.warn(`No encontrado [${contexto}]`);
  else if (status === 401 || status === 403) console.warn(`Credenciales invalidas [${contexto}]`);
  else if (code === "ECONNABORTED") console.warn(`Timeout [${contexto}]`);
  else if (err?.message) console.debug(`Error [${contexto}]: ${err.message}`);
}

// --- PARSE DE NOMBRES DE AUTOR ---
function parsearNombreAutor(nombre) {
  const limpio = nombre.replace(/et\s*al\.?/gi, "").trim();
  if (!limpio || limpio.length < 2) return null;

  if (limpio.includes(",")) {
    const partes = limpio.split(",", 2);
    return {
      completo: limpio,
      apellido: partes[0].trim(),
      nombres: (partes[1] || "").trim().replace(/\.$/, ""),
    };
  }

  const partes = limpio.split(/\s+/);
  if (partes.length === 1) return { completo: limpio, apellido: limpio, nombres: "" };
  return {
    completo: limpio,
    apellido: partes.slice(-1)[0],
    nombres: partes.slice(0, -1).join(" "),
  };
}

// --- BÚSQUEDA ORCID ---
async function buscarOrcidPorNombreExacto(nombreCompleto) {
  const key = nombreCompleto.toLowerCase().trim();
  if (cache.orcid.has(key)) return cache.orcid.get(key);

  try {
    const parsed = parsearNombreAutor(nombreCompleto);
    if (!parsed || !parsed.apellido || parsed.apellido.length < 2) return null;

    const res = await axios
      .get("https://pub.orcid.org/v3.0/expanded-search/", {
        params: {
          q: `given-names:${parsed.nombres} AND family-name:${parsed.apellido}`,
          rows: 1,
        },
        headers: { Accept: "application/json" },
      })
      .catch((err) => {
        manejarErrorApi(err, "ORCID");
        return null;
      });

    const resultado = res?.data?.["expanded-result"]?.[0];
    let result = null;
    if (resultado) {
      result = {
        orcid: resultado["orcid-id"],
        institucion: resultado["institution-name"]?.[0] || "No disponible",
      };
    }
    cache.orcid.set(key, result);
    return result;
  } catch (e) {
    manejarErrorApi(e, "ORCID");
    return null;
  }
}

// --- 1. AUDITORÍA (PRICE & BRADFORD) ---
function realizarAuditoriaLeyes(reporteFinal, infoTema) {
  const anioActual = 2026;
  const total = reporteFinal.length;
  if (total === 0) return null;

  const edades = reporteFinal.map(
    (r) => anioActual - (parseInt(r.referencia_extraida.anio) || 0),
  );
  const edadMedia = edades.reduce((a, b) => a + b, 0) / total;

  const fuentesRecientes = reporteFinal.filter(
    (r) => anioActual - (parseInt(r.referencia_extraida.anio) || 0) <= 5,
  ).length;
  const porcentajeActualidad = (fuentesRecientes / total) * 100;

  const cumpleEdadMedia = edadMedia <= 3;
  const cumpleRatioPrice = porcentajeActualidad >= 75;
  const cumplePriceGlobal = cumpleEdadMedia && cumpleRatioPrice;

  const terminosDeBusqueda = [
    infoTema.original.toLowerCase(),
    infoTema.ingles.toLowerCase(),
    ...infoTema.keywords.map((k) => k.toLowerCase()),
  ];

  const clasificarReferencia = (r) => {
    const tieneISSN = !!(r.metadatos_fuente?.issn || r.metadatos_fuente?.isbn);
    const sjr = parseFloat(r.metadatos_fuente?.sjr || 0);
    const nombreRevista = (
      r.metadatos_fuente?.nombre_oficial ||
      r.referencia_extraida.revista_nombre ||
      ""
    ).toLowerCase();
    const areaRef = (r.referencia_extraida.area_tematica || "").toLowerCase();

    const coincideConTema = terminosDeBusqueda.some(
      (t) => nombreRevista.includes(t) || areaRef.includes(t),
    );

    if ((coincideConTema && tieneISSN) || sjr > 1.2) {
      return "Zona 1: Núcleo (Especializada)";
    }

    const marcadoresIngenieria = [
      "technology", "engineering", "computing", "software",
      "systems", "ingeniería", "computación",
    ];
    const esIngenieria = marcadoresIngenieria.some(
      (m) => nombreRevista.includes(m) || areaRef.includes(m),
    );

    if (esIngenieria || sjr > 0.3 || tieneISSN) {
      return "Zona 2: Capa Relacionada (Soporte)";
    }

    return "Zona 3: Periferia (Generalista)";
  };

  return {
    analisis_tema: infoTema,
    ley_price: {
      edadMedia,
      porcentaje_actual: porcentajeActualidad.toFixed(1),
      estado: cumplePriceGlobal ? "✅ CUMPLE" : "❌ NO CUMPLE",
      color: cumplePriceGlobal ? "green" : "red",
      detalle: `Edad Media: ${edadMedia.toFixed(1)} años. Recientes: ${fuentesRecientes}/${total}.`,
      cumpleEdadMedia,
      cumpleRatioPrice,
    },
    ley_bradford_pertinencia: reporteFinal.map((r) => ({
      titulo: r.referencia_extraida.titulo,
      doi: r.referencia_extraida.doi_pdf ? "✅" : "❌",
      issn_isbn:
        r.metadatos_fuente?.issn || r.metadatos_fuente?.isbn ? "✅" : "❌",
      clasificacion: clasificarReferencia(r),
    })),
  };
}

// --- 2. AUDITORÍA DE AUTORES ---
async function auditarAutorSemanticScholar(nombreAutor, doi = null) {
  try {
    const parsed = parsearNombreAutor(nombreAutor);
    if (!parsed) return null;
    const { apellido, completo: nombreLimpio } = parsed;

    let orcidEncontrado = null;
    let datosS2 = null;

    const cacheKey = `${nombreLimpio}_${doi || ""}`;
    if (cache.semanticScholar.has(cacheKey)) return cache.semanticScholar.get(cacheKey);

    // --- 1. CROSSREF (vía DOI) ---
    if (doi) {
      const doiLimpio = doi.replace("https://doi.org/", "");
      let msg = cache.crossref.get(doiLimpio);
      if (!msg) {
        const resCR = await axios
          .get(`https://api.crossref.org/works/${doiLimpio}`)
          .catch((err) => { manejarErrorApi(err, "Crossref autor"); return null; });
        if (resCR?.data?.message) {
          msg = resCR.data.message;
          cache.crossref.set(doiLimpio, msg);
        }
      }
      if (msg?.author) {
        const matchCR = msg.author.find((a) =>
          (a.family || "").toLowerCase().includes(apellido),
        );
        if (matchCR?.ORCID) orcidEncontrado = matchCR.ORCID.split("/").pop();
      }
    }

    // --- 2. SEMANTIC SCHOLAR ---
    if (orcidEncontrado) {
      const resS2 = await axios
        .get(
          `https://api.semanticscholar.org/graph/v1/author/externalId:ORCID:${orcidEncontrado}`,
          {
            params: { fields: "name,hIndex,authorId,externalIds,affiliations" },
          },
        )
        .catch((err) => { manejarErrorApi(err, "S2 ORCID"); return null; });
      if (resS2?.data) datosS2 = resS2.data;
    }

    if (!datosS2) {
      const queryTerm = apellido.length > 2 ? apellido : nombreLimpio;
      const resBus = await axios
        .get("https://api.semanticscholar.org/graph/v1/author/search", {
          params: {
            query: queryTerm,
            fields: "name,hIndex,externalIds,authorId,affiliations",
            limit: 5,
          },
        })
        .catch((err) => { manejarErrorApi(err, "S2 search"); return null; });

      if (resBus?.data?.data?.length > 0) {
        const match = resBus.data.data
          .filter((a) => (a.name || "").toLowerCase().includes(apellido))
          .sort((a, b) => (b.hIndex || 0) - (a.hIndex || 0));
        datosS2 = match[0] || resBus.data.data.sort(
          (a, b) => (b.hIndex || 0) - (a.hIndex || 0),
        )[0];
      }
    }

    // --- 3. RESCATE ORCID ---
    if (datosS2 && !datosS2.externalIds?.ORCID && !orcidEncontrado) {
      const rescate = await buscarOrcidPorNombreExacto(datosS2.name);
      if (rescate) {
        orcidEncontrado = rescate.orcid;
      }
    }

    // --- 4. CONSOLIDACIÓN ---
    const orcidFinal = orcidEncontrado || datosS2?.externalIds?.ORCID;

    const result = {
      nombre_identificado: datosS2?.name || nombreLimpio,
      h_index: datosS2?.hIndex || 0,
      orcid: orcidFinal || "N/A (No registrado)",
      id_s2: datosS2?.authorId || "N/A",
      metodo: orcidEncontrado
        ? "Triangulación Crossref+ORCID+S2"
        : "Búsqueda Semántica",
    };

    cache.semanticScholar.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("Error en auditoría de autor:", e?.message);
    return { nombre_identificado: nombreAutor, h_index: 0, orcid: "Error" };
  }
}

// --- 3. AUDITORÍA DE REVISTAS ---
async function auditarRevista(ref) {
  const { doi_pdf, revista_nombre } = ref;
  let issn = null;
  try {
    if (doi_pdf) {
      const doiLimpio = doi_pdf.replace("https://doi.org/", "");
      const msg = cache.crossref.get(doiLimpio);
      if (msg) {
        issn = msg?.ISSN?.[0];
      } else {
        const resCR = await axios
          .get(`https://api.crossref.org/works/${doiLimpio}`)
          .catch((err) => { manejarErrorApi(err, "Crossref ISSN"); return null; });
        if (resCR?.data?.message) {
          cache.crossref.set(doiLimpio, resCR.data.message);
          issn = resCR.data.message.ISSN?.[0];
        }
      }
    }

    if (!issn && revista_nombre) {
      const cacheKey = `elsevier_${revista_nombre}`;
      if (cache.elsevier.has(cacheKey)) {
        issn = cache.elsevier.get(cacheKey);
      } else {
        const resSc = await axios
          .get("https://api.elsevier.com/content/search/scopus", {
            params: {
              query: `SRCTITLE({${revista_nombre.split("-")[0]}})`,
              apiKey: ELSEVIER_KEY,
              count: 1,
            },
          })
          .catch((err) => { manejarErrorApi(err, "Elsevier Scopus"); return null; });
        issn = resSc?.data?.["search-results"]?.["entry"]?.[0]?.["prism:issn"];
        cache.elsevier.set(cacheKey, issn);
      }
    }

    if (!issn && revista_nombre) {
      try {
        const resS2 = await axios
          .get("https://api.semanticscholar.org/graph/v1/paper/search", {
            params: {
              query: revista_nombre.split("-")[0],
              limit: 1,
              fields: "externalIds",
            },
          })
          .catch(() => null);
        const pubId = resS2?.data?.data?.[0]?.externalIds;
        if (pubId) issn = pubId.ISSN || pubId.Pubmed || null;
      } catch (_) { /* fallback silencioso */ }
    }

    if (!issn) return { indexada: false, sjr: "0" };

    const resM = await axios
      .get(`https://api.elsevier.com/content/serial/title/issn/${issn}`, {
        params: { apiKey: ELSEVIER_KEY },
        headers: { Accept: "application/json" },
      })
      .catch((err) => { manejarErrorApi(err, "Elsevier metadata"); return null; });

    const meta = resM?.data?.["serial-metadata-response"]?.["entry"]?.[0];
    return {
      issn,
      nombre_oficial: meta?.["dc:title"] || revista_nombre,
      sjr: meta?.SJRList?.SJR?.[0]?.["$"] || "0.1",
      indexada: true,
    };
  } catch (e) {
    manejarErrorApi(e, "auditarRevista");
    return { indexada: false, sjr: "0" };
  }
}

// --- GOOGLE BOOKS ---
async function buscarLibroEnGoogleBooks(titulo, apellidoAutor) {
  const cacheKey = `${titulo}_${apellidoAutor}`.toLowerCase();
  if (cache.googleBooks.has(cacheKey)) return cache.googleBooks.get(cacheKey);

  try {
    const query = `intitle:"${encodeURIComponent(titulo)}"+inauthor:"${encodeURIComponent(apellidoAutor)}"`;
    const res = await axios
      .get(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`)
      .catch((err) => { manejarErrorApi(err, "Google Books"); return null; });

    const info = res?.data?.items?.[0]?.volumeInfo;
    let result = null;
    if (info) {
      const isbnObj = info.industryIdentifiers?.find((id) =>
        id.type.includes("ISBN"),
      );
      result = {
        isbn: isbnObj ? isbnObj.identifier : "N/A",
        editorial: info.publisher || "Desconocida",
      };
    }
    cache.googleBooks.set(cacheKey, result);
    return result;
  } catch (e) {
    manejarErrorApi(e, "Google Books");
    return null;
  }
}

// --- PROCESAMIENTO EN LOTES PARALELOS ---
async function procesarLotes(items, fn, concurrency = 5, delayMs = 500) {
  const resultados = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const lote = items.slice(i, i + concurrency);
    const res = await Promise.allSettled(lote.map(fn));
    resultados.push(...res.map((r) => (r.status === "fulfilled" ? r.value : null)));
    if (i + concurrency < items.length) await esperar(delayMs);
  }
  return resultados;
}

// --- 4. CONTROLADOR PRINCIPAL ---
export const procesarBibliografiaHibrida = async (req, res) => {
  try {
    const { bibliografia } = req;
    const { tema_proyecto } = req.body;
    if (!bibliografia) return res.status(400).json({ error: "Falta bibliografía" });

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Responde estrictamente en JSON puro. No incluyas texto fuera del objeto.",
        },
        {
          role: "user",
          content: `
            Actúa como un experto en auditoría bibliográfica y bibliometría.

            TAREA 1: Analiza el siguiente bloque de texto y extrae todas las referencias bibliográficas: "${bibliografia}".
            TAREA 2: El tema central de la investigación es "${tema_proyecto || "Informática"}".
                     Debes traducirlo al inglés académico y generar 3 términos técnicos (keywords) en inglés que sirvan para identificar revistas de alto impacto en ese campo.

            REGLAS DE EXTRACCIÓN:
            - Identifica si es 'libro' o 'articulo'.
            - Extrae autores (en una lista), título exacto, año, DOI (si existe), nombre de la revista y editorial.
            - Si falta el año, pon 2024 por defecto.
            - Clasifica cada referencia en un 'area_tematica' específica.
            - Si el DOI aparece en el texto aunque no esté explícitamente marcado, extráelo igual.

            ESTRUCTURA DE RETORNO (JSON):
            {
              "tema_analizado": {
                "original": "Tema en español",
                "ingles": "Tema traducido",
                "keywords": ["key1", "key2", "key3"]
              },
              "referencias": [
                {
                  "tipo": "libro/articulo",
                  "autores_lista": ["Apellido, N."],
                  "titulo": "Título completo",
                  "anio": 2024,
                  "doi_pdf": "https://doi.org/...",
                  "revista_nombre": "Nombre Revista",
                  "editorial": "Editorial",
                  "area_tematica": "Área"
                }
              ]
            }`,
        },
      ],
      model: MODELO_IA,
      response_format: { type: "json_object" },
    });

    const dataIA = JSON.parse(completion.choices[0].message.content);
    const infoTema = dataIA.tema_analizado;
    const listaReferencias = dataIA.referencias || [];

    // Procesar metadatos de fuente en lotes paralelos (5 a la vez)
    const metadatosLote = await procesarLotes(
      listaReferencias,
      async (ref) => {
        if (ref.tipo === "libro") {
          const datosLibro = await buscarLibroEnGoogleBooks(
            ref.titulo,
            ref.autores_lista?.[0] || "",
          );
          return { tipo: "Libro", ...datosLibro };
        }
        return await auditarRevista(ref);
      },
      5,
      800,
    );

    // Procesar autores en lotes paralelos (3 referencias a la vez)
    const autoresLote = await procesarLotes(
      listaReferencias,
      async (ref) => {
        const listaAutores = Array.isArray(ref.autores_lista)
          ? ref.autores_lista
          : [ref.autores_lista];

        const resultados = await Promise.allSettled(
          listaAutores.map((nombre) => auditarAutorSemanticScholar(nombre, ref.doi_pdf)),
        );

        return resultados
          .map((r) => (r.status === "fulfilled" ? r.value : null))
          .filter(Boolean);
      },
      3,
      1000,
    );

    // Consolidar reporte
    const reporteFinal = listaReferencias.map((ref, i) => ({
      referencia_extraida: {
        ...ref,
        autores_lista: Array.isArray(ref.autores_lista)
          ? ref.autores_lista
          : [ref.autores_lista],
      },
      metadatos_fuente: metadatosLote[i] || {},
      investigadores_data: autoresLote[i] || [],
    }));

    const auditoriaFinal = realizarAuditoriaLeyes(reporteFinal, infoTema);

    res.render("resultados", {
      total: reporteFinal.length,
      auditoria_bibliometrica: auditoriaFinal,
      data: reporteFinal,
      jsonRaw: JSON.stringify({
        auditoria_bibliometrica: auditoriaFinal,
        data: reporteFinal,
      }),
    });
  } catch (error) {
    console.error("Error en procesarBibliografiaHibrida:", error);
    res.status(500).json({ error: error.message });
  }
};
