import Groq from "groq-sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// --- CONFIGURACIÓN ---
const API_KEY_GROQ = "Api_groq";
const ELSEVIER_KEY = "apielservier";
const MODELO_IA = "llama-3.3-70b-versatile";

const groq = new Groq({ apiKey: API_KEY_GROQ });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function buscarOrcidPorNombreExacto(nombreCompleto) {
  try {
    // La API de ORCID prefiere el formato: given-names:Nombre AND family-name:Apellido
    const partes = nombreCompleto.split(" ");
    const apellido = partes.pop();
    const nombres = partes.join(" ");

    const res = await axios
      .get(`https://pub.orcid.org/v3.0/expanded-search/`, {
        params: {
          q: `given-names:${nombres} AND family-name:${apellido}`,
          rows: 1, // Solo el más probable
        },
        headers: { Accept: "application/json" },
      })
      .catch(() => null);

    const resultado = res?.data?.["expanded-result"]?.[0];

    if (resultado) {
      return {
        orcid: resultado["orcid-id"],
        institucion: resultado["institution-name"]?.[0] || "No disponible",
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// --- 1. LÓGICA DE AUDITORÍA (PRICE & BRADFORD UNIVERSAL) ---
function realizarAuditoriaLeyes(reporteFinal, infoTema) {
  const anioActual = 2026;
  const total = reporteFinal.length;
  if (total === 0) return null;

  // --- LÓGICA LEY DE PRICE (OBSOLESCENCIA) ---
  const edades = reporteFinal.map(
    (r) => anioActual - (parseInt(r.referencia_extraida.anio) || 0),
  );
  const edadMedia = edades.reduce((a, b) => a + b, 0) / total;

  const fuentesRecientes = reporteFinal.filter(
    (r) => anioActual - (parseInt(r.referencia_extraida.anio) || 0) <= 5,
  ).length;
  const porcentajeActualidad = (fuentesRecientes / total) * 100;

  // Condiciones de Price: Edad Media <= 3 y Actualidad >= 75%
  const cumpleEdadMedia = edadMedia <= 3;
  const cumpleRatioPrice = porcentajeActualidad >= 75;
  const cumplePriceGlobal = cumpleEdadMedia && cumpleRatioPrice;

  // --- LÓGICA DE CLASIFICACIÓN (BRADFORD / LOTKA ADAPTADO) ---
  const terminosDeBusqueda = [
    infoTema.original.toLowerCase(),
    infoTema.ingles.toLowerCase(),
    ...infoTema.keywords.map((k) => k.toLowerCase()),
  ];

  const clasificarReferencia = (r) => {
    const tieneDOI = !!r.referencia_extraida.doi_pdf;
    const tieneISSN = !!(r.metadatos_fuente?.issn || r.metadatos_fuente?.isbn);
    const sjr = parseFloat(r.metadatos_fuente?.sjr || 0);
    const nombreRevista = (
      r.metadatos_fuente?.nombre_oficial ||
      r.referencia_extraida.revista_nombre ||
      ""
    ).toLowerCase();
    const areaRef = (r.referencia_extraida.area_tematica || "").toLowerCase();

    // 1. Núcleo (Especializada): Coincidencia directa + SJR alto + Identificadores
    const coincideConTema = terminosDeBusqueda.some(
      (t) => nombreRevista.includes(t) || areaRef.includes(t),
    );

    if ((coincideConTema && tieneISSN) || sjr > 1.2) {
      return "Zona 1: Núcleo (Especializada)";
    }

    // 2. Capa 2 (Soporte/Ingeniería): Áreas relacionadas o impacto medio
    const marcadoresIngenieria = [
      "technology",
      "engineering",
      "computing",
      "software",
      "systems",
      "ingeniería",
      "computación",
    ];
    const esIngenieria = marcadoresIngenieria.some(
      (m) => nombreRevista.includes(m) || areaRef.includes(m),
    );

    if (esIngenieria || sjr > 0.3 || tieneISSN) {
      return "Zona 2: Capa Relacionada (Soporte)";
    }

    // 3. Capa 3: Multidisciplinarias o generales
    return "Zona 3: Periferia (Generalista)";
  };

  return {
    analisis_tema: infoTema,
    ley_price: {
      edadMedia: edadMedia,
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

// --- 2. BÚSQUEDA DE AUTORES (MODO SABUESO - PRIORIDAD ORCID) ---
// --- BÚSQUEDA DE AUTORES (ESTRATEGIA DE TRIANGULACIÓN MEJORADA) ---
async function auditarAutorSemanticScholar(nombreAutor, doi = null) {
  try {
    const nombreLimpio = nombreAutor.replace(/et\s*al\.?/gi, "").trim();
    if (nombreLimpio.length < 3) return null;
    const apellido = nombreLimpio.split(",")[0].toLowerCase().trim();

    let orcidEncontrado = null;
    let datosS2 = null;

    // --- 1. INTENTO INICIAL: CROSSREF (Vía DOI) ---
    if (doi) {
      const doiLimpio = doi.replace("https://doi.org/", "");
      const resCR = await axios
        .get(`https://api.crossref.org/works/${doiLimpio}`)
        .catch(() => null);
      if (resCR?.data?.message?.author) {
        const matchCR = resCR.data.message.author.find((a) =>
          (a.family || "").toLowerCase().includes(apellido),
        );
        if (matchCR?.ORCID) orcidEncontrado = matchCR.ORCID.split("/").pop();
      }
    }

    // --- 2. CONSULTA SEMANTIC SCHOLAR ---
    // Si ya tenemos ORCID de Crossref, buscamos ese perfil específico
    if (orcidEncontrado) {
      const resS2 = await axios
        .get(
          `https://api.semanticscholar.org/graph/v1/author/externalId:ORCID:${orcidEncontrado}`,
          {
            params: { fields: "name,hIndex,authorId,externalIds,affiliations" },
          },
        )
        .catch(() => null);
      if (resS2?.data) datosS2 = resS2.data;
    }

    // Si no hay datos (porque no hubo ORCID o el ORCID no está en S2), buscamos por nombre
    if (!datosS2) {
      const resBus = await axios
        .get("https://api.semanticscholar.org/graph/v1/author/search", {
          params: {
            query: `"${nombreLimpio}"`,
            fields: "name,hIndex,externalIds,authorId,affiliations",
            limit: 3,
          },
        })
        .catch(() => null);
      if (resBus?.data?.data?.length > 0) {
        datosS2 = resBus.data.data.sort(
          (a, b) => (b.hIndex || 0) - (a.hIndex || 0),
        )[0];
      }
    }

    // --- 3. INTEGRACIÓN DEL RESCATE (AQUÍ VA EL CAMBIO) ---
    // Si ya tenemos el nombre validado por S2 pero seguimos sin ORCID...
    if (datosS2 && !datosS2.externalIds?.ORCID && !orcidEncontrado) {
      console.log(`🔍 Iniciando rescate ORCID para: ${datosS2.name}`);

      const rescate = await buscarOrcidPorNombreExacto(datosS2.name);

      if (rescate) {
        orcidEncontrado = rescate.orcid;
        console.log(`✅ ORCID rescatado: ${orcidEncontrado}`);
      }
    }

    // --- 4. CONSOLIDACIÓN FINAL ---
    const orcidFinal = orcidEncontrado || datosS2?.externalIds?.ORCID;

    return {
      nombre_identificado: datosS2?.name || nombreLimpio,
      h_index: datosS2?.hIndex || 0,
      orcid: orcidFinal || "N/A (No registrado)",
      id_s2: datosS2?.authorId || "N/A",
      metodo: orcidEncontrado
        ? "Triangulación Crossref+ORCID+S2"
        : "Búsqueda Semántica",
    };
  } catch (e) {
    console.error("Error en auditoría:", e);
    return { nombre_identificado: nombreAutor, h_index: 0, orcid: "Error" };
  }
}
// --- 3. FUNCIONES DE APOYO (RECURSOS) ---
async function auditarRevista(ref) {
  const { doi_pdf, revista_nombre } = ref;
  let issn = null;
  try {
    if (doi_pdf) {
      const doiLimpio = doi_pdf.replace("https://doi.org/", "");
      const resCR = await axios
        .get(`https://api.crossref.org/works/${doiLimpio}`)
        .catch(() => null);
      issn = resCR?.data?.message?.ISSN?.[0];
    }
    if (!issn && revista_nombre) {
      const resSc = await axios
        .get("https://api.elsevier.com/content/search/scopus", {
          params: {
            query: `SRCTITLE({${revista_nombre.split("-")[0]}})`,
            apiKey: ELSEVIER_KEY,
            count: 1,
          },
        })
        .catch(() => null);
      issn = resSc?.data?.["search-results"]?.["entry"]?.[0]?.["prism:issn"];
    }
    if (!issn) return { indexada: false, sjr: "0" };
    const resM = await axios.get(
      `https://api.elsevier.com/content/serial/title/issn/${issn}`,
      {
        params: { apiKey: ELSEVIER_KEY },
        headers: { Accept: "application/json" },
      },
    );
    const meta = resM?.data?.["serial-metadata-response"]?.["entry"]?.[0];
    return {
      issn,
      nombre_oficial: meta?.["dc:title"] || revista_nombre,
      sjr: meta?.SJRList?.SJR?.[0]?.["$"] || "0.1",
      indexada: true,
    };
  } catch (e) {
    return { indexada: false, sjr: "0" };
  }
}

async function buscarLibroEnGoogleBooks(titulo, apellidoAutor) {
  try {
    let query = `intitle:"${encodeURIComponent(titulo)}"+inauthor:"${encodeURIComponent(apellidoAutor)}"`;
    let res = await axios.get(
      `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`,
    );
    const info = res.data.items?.[0]?.volumeInfo;
    if (info) {
      const isbnObj = info.industryIdentifiers?.find((id) =>
        id.type.includes("ISBN"),
      );
      return {
        isbn: isbnObj ? isbnObj.identifier : "N/A",
        editorial: info.publisher || "Desconocida",
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// --- 4. CONTROLADOR PRINCIPAL ---
export const procesarBibliografiaHibrida = async (req, res) => {
  try {
    const { bibliografia } = req;
    const { tema_proyecto } = req.body; // El tema sí suele venir del body (input del usuario)
    if (!bibliografia)
      return res.status(400).json({ error: "Falta bibliografía" });

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "Responde estrictamente en JSON puro. No incluyas texto fuera del objeto.",
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
    const reporteFinal = [];

    for (const ref of listaReferencias) {
      console.log(`Auditando: ${ref.titulo}`);
      let metadatosFuente = {};
      if (ref.tipo === "libro") {
        await esperar(1000);
        const datosLibro = await buscarLibroEnGoogleBooks(
          ref.titulo,
          ref.autores_lista?.[0] || "",
        );
        metadatosFuente = { tipo: "Libro", ...datosLibro };
      } else {
        metadatosFuente = await auditarRevista(ref);
      }

      const autoresAuditados = [];
      const listaAutores = Array.isArray(ref.autores_lista)
        ? ref.autores_lista
        : [ref.autores_lista];
      for (const nombre of listaAutores) {
        await esperar(1500);
        const infoAutor = await auditarAutorSemanticScholar(
          nombre,
          ref.doi_pdf,
        );
        if (infoAutor) autoresAuditados.push(infoAutor);
      }

      reporteFinal.push({
        referencia_extraida: { ...ref, autores_lista: listaAutores },
        metadatos_fuente: metadatosFuente,
        investigadores_data: autoresAuditados,
      });
    }

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
    res.status(500).json({ error: error.message });
  }
};
