import Groq from "groq-sdk";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const groq = new Groq({
  apiKey: process.env.API_KEY,
});

export const procesarConOllama = async (req, res) => {
  try {
    const texto = req.bibliografia;
    const startTime = Date.now();

    if (!texto) {
      return res.status(400).json({
        success: false,
        error: "No se proporcionó texto bibliográfico",
      });
    }

    console.log("🔍 Iniciando procesamiento de bibliografía...");

    // --- PASO 1: EXTRACCIÓN INTELIGENTE CON ANÁLISIS DE FUENTE ---
    const promptExtraccion = `
Eres un experto bibliotecario especializado en extracción de referencias. Analiza el texto y extrae TODAS las referencias bibliográficas.

PARA CADA REFERENCIA, IDENTIFICA:
1. AUTOR(ES): Todo el texto hasta el año de publicación
2. AÑO: Año de publicación en formato 4 dígitos
3. TÍTULO: Título completo (no cortes en el primer punto, incluye subtítulos)
4. FUENTE: Texto completo después del título

ANALIZA LA FUENTE PARA DETECTAR:
- Tipo de publicación: revista/libro/documento_legal/sitio_web/tesis/otro
- Identificadores: DOI, ISBN, ISSN, URLs
- Nombre de revista o editorial
- Volumen, número, páginas (si aplica)

EJEMPLOS:
• "Revista Venezolana de Gerencia. Vol.11, No. 33, pp. 49-73"
  → tipo: "revista", revista_nombre: "Revista Venezolana de Gerencia", volumen: "11", numero: "33"

• "Springer International Publishing. https://doi.org/10.1007/978-3-030-02083-5"
  → tipo: "libro", editorial: "Springer International Publishing", doi: "10.1007/978-3-030-02083-5"

• "Gaceta Oficial N° 36.970 del 12 de junio. Caracas, Venezuela"
  → tipo: "documento_oficial"

DEVUELVE EXCLUSIVAMENTE JSON con este formato:
{
  "referencias": [
    {
      "autor": "string",
      "año": "string",
      "titulo": "string", 
      "fuente": "string",
      "tipo_inferido": "revista/libro/documento_oficial/sitio_web/tesis/otro",
      "identificadores": {
        "doi": "string o null",
        "isbn": "string o null", 
        "issn": "string o null",
        "url": "string o null"
      },
      "revista_nombre": "string o null",
      "editorial": "string o null",
      "volumen": "string o null",
      "numero": "string o null",
      "paginas": "string o null"
    }
  ]
}

TEXTO A PROCESAR:
${texto.substring(0, 10000)}
`;

    console.log("🤖 Extrayendo referencias con Groq/LLaMA...");

    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: promptExtraccion }],
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const { referencias: referenciasBase } = JSON.parse(
      completion.choices[0].message.content,
    );

    console.log(`📚 ${referenciasBase.length} referencias extraídas`);

    // --- PASO 2: PROCESAMIENTO INTELIGENTE DE CADA REFERENCIA ---
    const referenciasFinales = [];

    for (let i = 0; i < referenciasBase.length; i++) {
      const ref = referenciasBase[i];
      console.log(
        `\n📖 Procesando referencia ${i + 1}/${referenciasBase.length}:`,
      );
      console.log(`   Título: ${ref.titulo.substring(0, 70)}...`);
      console.log(`   Tipo: ${ref.tipo_inferido}`);

      let resultado;

      // Verificar si ya tiene identificadores en la fuente
      const identificadoresExtraidos = extraerIdentificadoresDeFuente(
        ref.fuente,
      );

      if (identificadoresExtraidos.tieneAlguno) {
        // Procesar con identificadores existentes
        resultado = await procesarConIdentificadoresExistentes(
          ref,
          identificadoresExtraidos,
        );
      } else {
        // Procesar según tipo (búsqueda normal)
        resultado = await procesarSegunTipo(ref);
      }

      referenciasFinales.push(resultado);

      // Pausa para no saturar APIs
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // --- RESPUESTA FINAL ---
    res.json({
      success: true,
      total_referencias: referenciasFinales.length,
      tiempo_procesamiento: `${Date.now() - startTime}ms`,
      estadisticas: generarEstadisticasCompletas(referenciasFinales),
      referencias: referenciasFinales,
      recomendaciones: generarRecomendacionesFinales(referenciasFinales),
    });
  } catch (error) {
    console.error("❌ Error en el procesamiento:", error);
    res.status(500).json({
      success: false,
      error: "Error procesando bibliografía",
      detalle: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// ========== FUNCIONES AUXILIARES ==========

function extraerIdentificadoresDeFuente(fuente) {
  const resultado = {
    tieneAlguno: false,
    doi: null,
    isbn: null,
    issn: null,
    url: null,
  };

  // Extraer DOI (patrones comunes)
  const doiPatterns = [
    /10\.\d{4,9}\/[-._;()\/:A-Z0-9]+/gi,
    /doi\.org\/(10\.\d{4,9}\/[-._;()\/:A-Z0-9]+)/gi,
    /https?:\/\/doi\.org\/(10\.\d{4,9}\/[-._;()\/:A-Z0-9]+)/gi,
  ];

  for (const pattern of doiPatterns) {
    const match = fuente.match(pattern);
    if (match && match[0]) {
      let doi = match[0];
      if (doi.includes("doi.org/")) doi = doi.split("doi.org/")[1];
      if (doi.includes("https://")) doi = doi.split("https://")[1];
      resultado.doi = doi.trim();
      resultado.tieneAlguno = true;
      break;
    }
  }

  // Extraer ISBN
  const isbnPatterns = [
    /ISBN[-]?(1[03])?:?\s*([-0-9\s]{17}|[-0-9\s]{13})/gi,
    /978[-]?[0-9]{1,5}[-]?[0-9]+[-]?[0-9]+[-]?[0-9X]/gi,
    /\b(97[89][-]?)?\d{1,5}[-]?\d+[-]?\d+[-]?[\dX]\b/gi,
  ];

  for (const pattern of isbnPatterns) {
    const match = fuente.match(pattern);
    if (match && match[0]) {
      const isbn = match[0]
        .replace(/ISBN[-]?(1[03])?:?\s*/gi, "")
        .replace(/\s+/g, "")
        .trim();
      resultado.isbn = isbn;
      resultado.tieneAlguno = true;
      break;
    }
  }

  // Extraer ISSN
  const issnPattern = /\b\d{4}-\d{3}[\dxX]\b/gi;
  const issnMatch = fuente.match(issnPattern);
  if (issnMatch) {
    resultado.issn = issnMatch[0];
    resultado.tieneAlguno = true;
  }

  // Extraer URL
  const urlPattern = /https?:\/\/[^\s<>"]+|www\.[^\s<>"]+/gi;
  const urlMatch = fuente.match(urlPattern);
  if (urlMatch) {
    let url = urlMatch[0];
    if (!url.startsWith("http")) url = "https://" + url;
    resultado.url = url;
    resultado.tieneAlguno = true;
  }

  return resultado;
}

async function procesarConIdentificadoresExistentes(ref, identificadores) {
  console.log(`   ✅ Identificadores encontrados en fuente`);

  let datosVerificados = {};
  let enlaces = {};
  let estado = "IDENTIFICADOR_ENCONTRADO";
  let nota = "";

  // Procesar DOI si existe
  if (identificadores.doi) {
    const doiInfo = await verificarYClasificarDOI(identificadores.doi, ref);

    datosVerificados.doi = identificadores.doi;
    datosVerificados.doi_valido = doiInfo.valido;
    datosVerificados.tipo_doi = doiInfo.tipo;

    enlaces.doi = `https://doi.org/${identificadores.doi}`;

    if (doiInfo.esLibro) {
      estado = "LIBRO_CON_DOI";
      nota = "DOI de libro encontrado en fuente";
      enlaces.springer = doiInfo.editorial?.includes("Springer")
        ? `https://link.springer.com/book/${identificadores.doi}`
        : null;
    } else if (doiInfo.tipo === "article") {
      estado = "ARTICULO_CON_DOI";
      nota = "DOI de artículo encontrado en fuente";
      enlaces.crossref = `https://api.crossref.org/works/${identificadores.doi}`;
    }
  }

  // Procesar ISBN si existe
  if (identificadores.isbn) {
    const isbnInfo = await verificarISBN(identificadores.isbn);

    if (isbnInfo.encontrado) {
      datosVerificados.isbn = identificadores.isbn;
      datosVerificados.isbn_valido = true;
      datosVerificados.titulo_isbn = isbnInfo.titulo;
      datosVerificados.editorial_isbn = isbnInfo.editorial;

      enlaces.isbn_search = `https://isbnsearch.org/isbn/${identificadores.isbn}`;
      enlaces.worldcat = `https://www.worldcat.org/isbn/${identificadores.isbn}`;

      estado = "ISBN_VALIDADO";
      nota = "ISBN verificado correctamente";
    }
  }

  // Procesar ISSN si existe
  if (identificadores.issn) {
    datosVerificados.issn = identificadores.issn;
    enlaces.issn_portal = `https://portal.issn.org/resource/ISSN/${identificadores.issn}`;

    estado = estado === "IDENTIFICADOR_ENCONTRADO" ? "ISSN_ENCONTRADO" : estado;
  }

  // Procesar URL si existe
  if (identificadores.url) {
    enlaces.url_directa = identificadores.url;
    enlaces.archive = `https://web.archive.org/web/*/${identificadores.url}`;

    if (identificadores.url.includes(".pdf")) {
      estado = "DOCUMENTO_PDF";
      nota = "Enlace directo a documento PDF";
    }
  }

  // Enlaces adicionales según tipo
  if (ref.tipo_inferido === "revista") {
    enlaces.google_scholar = `https://gemini.google.com/app?hl=es${encodeURIComponent(
      `"${ref.titulo}" ${ref.autor}`,
    )}`;
    enlaces.scielo = `https://search.scielo.org/?q=${encodeURIComponent(
      ref.titulo.substring(0, 100),
    )}&lang=es`;
  }

  if (ref.tipo_inferido === "libro") {
    enlaces.google_books = `https://www.google.com/search?tbm=bks&q=${encodeURIComponent(
      ref.titulo,
    )}`;
    enlaces.openlibrary = `https://openlibrary.org/search?q=${encodeURIComponent(
      ref.titulo,
    )}`;
  }

  return {
    ...ref,
    tipo: ref.tipo_inferido,
    datos_verificados: datosVerificados,
    identificadores_encontrados: {
      doi: identificadores.doi,
      isbn: identificadores.isbn,
      issn: identificadores.issn,
      url: identificadores.url,
    },
    enlaces: enlaces,
    estado: estado,
    nota: nota || `Identificador encontrado en fuente`,
    procesamiento: "IDENTIFICADORES_EXTRAIDOS",
  };
}

async function verificarYClasificarDOI(doi, ref) {
  try {
    console.log(`     🔍 Verificando DOI: ${doi}...`);

    // Patrones conocidos de DOIs de libros
    const patronesLibros = [
      /10\.1007\/978/, // Springer books
      /10\.1016\/.*book/, // Elsevier books
      /10\.4324\/978/, // Routledge/Taylor & Francis
      /10\.1093\/acprof/, // Oxford Scholarship
    ];

    for (const patron of patronesLibros) {
      if (patron.test(doi)) {
        return {
          valido: true,
          esLibro: true,
          tipo: "book",
          editorial: obtenerEditorialDeDOI(doi),
        };
      }
    }

    // Consultar Crossref para determinar tipo
    const response = await axios.get(`https://api.crossref.org/works/${doi}`, {
      timeout: 4000,
    });

    if (response.data.message) {
      const item = response.data.message;
      return {
        valido: true,
        esLibro:
          item.type === "book" ||
          item.type === "book-chapter" ||
          item.type === "monograph",
        tipo: item.type,
        editorial: item.publisher,
        titulo: item.title?.[0],
        año: item.published?.["date-parts"]?.[0]?.[0],
      };
    }
  } catch (error) {
    console.log(`     ⚠️ Error verificando DOI: ${error.message}`);

    // Heurística basada en contexto
    if (
      ref.editorial?.includes("Springer") ||
      ref.fuente.includes("Springer")
    ) {
      return {
        valido: true,
        esLibro: true,
        tipo: "probable_book",
        editorial: "Springer",
      };
    }

    // Verificar si al menos responde
    try {
      await axios.head(`https://doi.org/${doi}`, { timeout: 3000 });
      return { valido: true, esLibro: false, tipo: "unknown" };
    } catch {
      return { valido: false, error: "DOI no accesible" };
    }
  }

  return { valido: false, esLibro: false, tipo: "unknown" };
}

function obtenerEditorialDeDOI(doi) {
  if (doi.includes("10.1007")) return "Springer";
  if (doi.includes("10.1016")) return "Elsevier";
  if (doi.includes("10.4324")) return "Routledge/Taylor & Francis";
  if (doi.includes("10.1093")) return "Oxford University Press";
  if (doi.includes("10.1057")) return "Palgrave Macmillan";
  if (doi.includes("10.3917")) return "Presses Universitaires de France";
  if (doi.includes("10.2307")) return "JSTOR";
  return "Desconocida";
}

async function verificarISBN(isbn) {
  try {
    // Limpiar ISBN
    const isbnLimpio = isbn.replace(/[^0-9X]/gi, "");

    // OpenLibrary (gratuito)
    const response = await axios.get("https://openlibrary.org/api/books", {
      params: {
        bibkeys: `ISBN:${isbnLimpio}`,
        format: "json",
        jscmd: "data",
      },
      timeout: 4000,
    });

    const key = `ISBN:${isbnLimpio}`;
    if (response.data[key]) {
      const libro = response.data[key];
      return {
        encontrado: true,
        titulo: libro.title,
        autores: libro.authors?.map((a) => a.name) || [],
        editorial: libro.publishers?.[0]?.name,
        año: libro.publish_date,
        url: `https://openlibrary.org${libro.url}`,
      };
    }
  } catch (error) {
    console.log(`     ⚠️ OpenLibrary error: ${error.message}`);
  }

  return { encontrado: false };
}

async function procesarSegunTipo(ref) {
  console.log(`   🔍 Procesando como ${ref.tipo_inferido}...`);

  switch (ref.tipo_inferido) {
    case "revista":
      return await procesarRevista(ref);
    case "libro":
      return await procesarLibro(ref);
    case "documento_oficial":
    case "ley":
      return await procesarDocumentoOficial(ref);
    case "sitio_web":
    case "web":
      return await procesarSitioWeb(ref);
    case "tesis":
      return await procesarTesis(ref);
    default:
      return await procesarGenerico(ref);
  }
}

async function procesarRevista(ref) {
  let datos = {};
  let enlaces = {};
  let estado = "REVISTA_PROCESADA";

  // Buscar ISSN por nombre de revista
  if (ref.revista_nombre) {
    const issnInfo = await buscarISSNporNombreRevista(ref.revista_nombre);
    if (issnInfo.encontrado) {
      datos.issn = issnInfo.issn;
      datos.nombre_revista_oficial = issnInfo.nombre;
      enlaces.issn_portal = `https://portal.issn.org/resource/ISSN/${issnInfo.issn}`;
      estado = "REVISTA_IDENTIFICADA";
    }
  }

  // Buscar artículo específico
  const articuloInfo = await buscarArticuloEnCrossref(ref);
  if (articuloInfo.encontrado) {
    datos.doi = articuloInfo.doi;
    datos.score = articuloInfo.score;
    enlaces.doi = `https://doi.org/${articuloInfo.doi}`;
    enlaces.crossref = `https://api.crossref.org/works/${articuloInfo.doi}`;
    estado = "ARTICULO_ENCONTRADO";
  }

  // Enlaces de búsqueda
  enlaces.google_scholar = `https://scholar.google.com/scholar?q=${encodeURIComponent(
    `"${ref.titulo}" ${ref.autor}`,
  )}`;
  enlaces.scielo = `https://search.scielo.org/?q=${encodeURIComponent(
    ref.titulo.substring(0, 100),
  )}&lang=es`;
  enlaces.redalyc = `https://www.redalyc.org/resultados?q=${encodeURIComponent(
    ref.revista_nombre || ref.titulo.substring(0, 50),
  )}`;

  // Si parece revista latinoamericana
  if (esRevistaLatinoamericana(ref)) {
    enlaces.latindex = `https://www.latindex.org/latindex/buscarRevistas?termino=${encodeURIComponent(
      ref.revista_nombre || "",
    )}`;
  }

  return {
    ...ref,
    tipo: "revista",
    datos_revista: datos,
    enlaces: enlaces,
    estado: estado,
    nota:
      estado === "ARTICULO_ENCONTRADO"
        ? "Artículo encontrado en Crossref"
        : "Buscar manualmente en enlaces proporcionados",
  };
}

async function buscarISSNporNombreRevista(nombreRevista) {
  try {
    const nombreLimpio = nombreRevista
      .replace(/vol\.?\s*\d+/i, "")
      .replace(/núm\.?\s*\d+/i, "")
      .replace(/pp\.?\s*\d+.*/, "")
      .replace(/\.$/, "")
      .trim();

    // Buscar en Crossref journals
    const response = await axios.get("https://api.crossref.org/journals", {
      params: { query: nombreLimpio, rows: 1 },
      timeout: 4000,
    });

    if (response.data.message.items?.length > 0) {
      const journal = response.data.message.items[0];
      return {
        encontrado: true,
        issn: journal.ISSN?.[0] || null,
        nombre: journal.title,
        editorial: journal.publisher,
      };
    }
  } catch (error) {
    console.log(`     ⚠️ Error buscando ISSN: ${error.message}`);
  }

  return { encontrado: false };
}

async function buscarArticuloEnCrossref(ref) {
  try {
    const query = `"${ref.titulo.substring(0, 100)}" ${
      ref.autor.split(",")[0]
    }`;

    const response = await axios.get("https://api.crossref.org/works", {
      params: {
        query: query,
        rows: 2,
        mailto: "bibliografia@ejemplo.com",
        select: "DOI,title,author,score",
      },
      timeout: 5000,
    });

    if (response.data.message.items?.length > 0) {
      const item = response.data.message.items[0];
      return {
        encontrado: true,
        doi: item.DOI,
        score: item.score || 0,
        titulo_match: item.title?.[0],
        autores_match: item.author?.map((a) =>
          `${a.given || ""} ${a.family || ""}`.trim(),
        ),
      };
    }
  } catch (error) {
    console.log(`     ⚠️ Error buscando artículo: ${error.message}`);
  }

  return { encontrado: false };
}

function esRevistaLatinoamericana(ref) {
  const palabrasClave = [
    "venezolana",
    "latino",
    "ibero",
    "mexicana",
    "colombiana",
    "argentina",
    "chilena",
    "peruana",
    "ecuatoriana",
    "española",
    "iberoamericana",
    "iberoamérica",
  ];

  const textoBusqueda = (ref.revista_nombre + " " + ref.fuente).toLowerCase();
  return palabrasClave.some((palabra) => textoBusqueda.includes(palabra));
}

async function procesarLibro(ref) {
  let datos = {};
  let enlaces = {};
  let estado = "LIBRO_PROCESADO";

  // Buscar ISBN
  if (!ref.identificadores?.isbn) {
    const isbnInfo = await buscarISBNporTitulo(ref.titulo, ref.autor);
    if (isbnInfo.encontrado) {
      datos.isbn = isbnInfo.isbn;
      datos.titulo_verificado = isbnInfo.titulo;
      datos.editorial_verificada = isbnInfo.editorial;
      estado = "ISBN_ENCONTRADO";
    }
  }

  // Enlaces de búsqueda para libros
  enlaces.worldcat = `https://www.worldcat.org/search?q=${encodeURIComponent(
    `"${ref.titulo}" ${ref.autor}`,
  )}`;
  enlaces.google_books = `https://www.google.com/search?tbm=bks&q=${encodeURIComponent(
    ref.titulo,
  )}`;
  enlaces.openlibrary = `https://openlibrary.org/search?q=${encodeURIComponent(
    ref.titulo,
  )}`;

  // Si tiene ISBN, añadir enlaces específicos
  if (datos.isbn) {
    enlaces.isbn_search = `https://isbnsearch.org/isbn/${datos.isbn}`;
    enlaces.isbndb = `https://isbndb.com/book/${datos.isbn}`;
  }

  // Para libros venezolanos/latinoamericanos
  if (
    ref.editorial?.includes("Nueva Sociedad") ||
    ref.fuente.includes("Caracas")
  ) {
    enlaces.bnv = "https://www.bnv.gob.ve/";
    enlaces.catalogobnv = "https://catalogo.bnv.gob.ve/";
  }

  return {
    ...ref,
    tipo: "libro",
    datos_libro: datos,
    enlaces: enlaces,
    estado: estado,
    nota:
      estado === "ISBN_ENCONTRADO"
        ? "ISBN encontrado"
        : "Buscar manualmente el ISBN",
  };
}

async function buscarISBNporTitulo(titulo, autor) {
  try {
    // OpenLibrary
    const response = await axios.get("https://openlibrary.org/search.json", {
      params: {
        title: titulo.substring(0, 100),
        author: autor ? autor.split(",")[0] : "",
        limit: 2,
      },
      timeout: 4000,
    });

    if (response.data.docs?.length > 0) {
      const libro = response.data.docs[0];
      const isbn = libro.isbn
        ? Array.isArray(libro.isbn)
          ? libro.isbn[0]
          : libro.isbn
        : null;

      if (isbn) {
        return {
          encontrado: true,
          isbn: isbn,
          titulo: libro.title,
          autor: libro.author_name?.[0],
          año: libro.first_publish_year,
        };
      }
    }
  } catch (error) {
    console.log(`     ⚠️ Error buscando ISBN: ${error.message}`);
  }

  return { encontrado: false };
}

async function procesarDocumentoOficial(ref) {
  let subtipo = "documento_oficial";
  let entidad = "";

  if (ref.fuente.includes("Gaceta Oficial")) {
    subtipo = "gaceta_oficial";
    entidad = "Venezuela";
  } else if (ref.fuente.includes("Ley")) {
    subtipo = "ley";
  } else if (
    ref.fuente.includes("ONU") ||
    ref.fuente.includes("UNESCO") ||
    ref.fuente.includes("FAO")
  ) {
    subtipo = "documento_internacional";
    entidad =
      ref.fuente.match(/(ONU|UNESCO|FAO|CEPAL)/)?.[0] ||
      "Organización Internacional";
  }

  const enlaces = {
    busqueda_oficial: `https://www.google.com/search?q=${encodeURIComponent(
      `"${ref.titulo}" ${ref.autor} ${ref.año}`,
    )}`,
    ...(subtipo === "gaceta_oficial" && {
      gaceta_venezuela: "https://www.imprentanacional.gob.ve/gaceta-oficial/",
    }),
    ...(subtipo === "documento_internacional" &&
      entidad === "ONU" && {
        un_documents: "https://digitallibrary.un.org/",
      }),
    ...(subtipo === "documento_internacional" &&
      entidad === "FAO" && {
        fao_documents: "https://www.fao.org/documents/es/",
      }),
  };

  return {
    ...ref,
    tipo: subtipo,
    entidad: entidad,
    enlaces: enlaces,
    estado: "DOCUMENTO_OFICIAL",
    nota: "Documentos oficiales no tienen ISSN/ISBN. Verificar en fuentes oficiales.",
  };
}

async function procesarSitioWeb(ref) {
  // Extraer URL de la fuente
  const urlMatch = ref.fuente.match(/https?:\/\/[^\s<>"]+/);
  const url = urlMatch ? urlMatch[0] : null;

  const enlaces = {
    ...(url && { url_original: url }),
    ...(url && { archive: `https://web.archive.org/web/*/${url}` }),
    ...(url && {
      google_cache: `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(
        url,
      )}`,
    }),
    busqueda_general: `https://www.google.com/search?q=${encodeURIComponent(
      `"${ref.titulo}" ${ref.autor}`,
    )}`,
  };

  return {
    ...ref,
    tipo: "sitio_web",
    url_directa: url,
    enlaces: enlaces,
    estado: "SITIO_WEB",
    nota: url
      ? "Verificar si la URL sigue activa"
      : "URL no encontrada en el texto",
  };
}

async function procesarTesis(ref) {
  const enlaces = {
    google_scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(
      `"${ref.titulo}" tesis ${ref.autor}`,
    )}`,
    worldcat_thesis: `https://www.worldcat.org/search?q=${encodeURIComponent(
      `"${ref.titulo}" thesis`,
    )}`,
    proquest: "https://www.proquest.com/",
    cybertesis: "https://cybertesis.unmsm.edu.pe/",
  };

  return {
    ...ref,
    tipo: "tesis",
    enlaces: enlaces,
    estado: "TESIS",
    nota: "Las tesis generalmente no tienen ISSN/ISBN. Buscar en repositorios universitarios.",
  };
}

async function procesarGenerico(ref) {
  const enlaces = {
    google_scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(
      `"${ref.titulo}" ${ref.autor}`,
    )}`,
    google_general: `https://www.google.com/search?q=${encodeURIComponent(
      `${ref.titulo} ${ref.autor} ${ref.año}`,
    )}`,
    worldcat: `https://www.worldcat.org/search?q=${encodeURIComponent(
      ref.titulo,
    )}`,
    crossref_search: `https://search.crossref.org/?q=${encodeURIComponent(
      ref.titulo.substring(0, 100),
    )}`,
  };

  return {
    ...ref,
    tipo: ref.tipo_inferido || "generico",
    enlaces: enlaces,
    estado: "BUSQUEDA_GENERICA",
    nota: "Tipo no específico. Use los enlaces para búsqueda general.",
  };
}

function generarEstadisticasCompletas(referencias) {
  const total = referencias.length;

  const porTipo = referencias.reduce((acc, ref) => {
    acc[ref.tipo] = (acc[ref.tipo] || 0) + 1;
    return acc;
  }, {});

  const porEstado = referencias.reduce((acc, ref) => {
    acc[ref.estado] = (acc[ref.estado] || 0) + 1;
    return acc;
  }, {});

  const conIdentificadores = referencias.filter(
    (r) =>
      r.identificadores_encontrados?.doi ||
      r.identificadores_encontrados?.isbn ||
      r.identificadores_encontrados?.issn,
  ).length;

  const conDOI = referencias.filter(
    (r) => r.datos_verificados?.doi || r.identificadores_encontrados?.doi,
  ).length;
  const conISBN = referencias.filter(
    (r) => r.datos_libro?.isbn || r.identificadores_encontrados?.isbn,
  ).length;
  const conISSN = referencias.filter(
    (r) => r.datos_revista?.issn || r.identificadores_encontrados?.issn,
  ).length;

  return {
    total_referencias: total,
    distribucion_por_tipo: porTipo,
    distribucion_por_estado: porEstado,
    identificadores_encontrados: {
      total: conIdentificadores,
      doi: conDOI,
      isbn: conISBN,
      issn: conISSN,
    },
    porcentaje_exito:
      total > 0 ? Math.round((conIdentificadores / total) * 100) : 0,
  };
}

function generarRecomendacionesFinales(referencias) {
  const recomendaciones = [];

  const tieneDocumentosOficiales = referencias.some(
    (r) => r.tipo === "documento_oficial" || r.tipo === "ley",
  );
  if (tieneDocumentosOficiales) {
    recomendaciones.push({
      tipo: "documentos_oficiales",
      mensaje:
        "Documentos oficiales/legales no tienen ISSN/ISBN. Verificar en fuentes oficiales gubernamentales.",
      accion: "Consulte gacetas oficiales o sitios web gubernamentales.",
    });
  }

  const tieneRevistasLatam = referencias.some(
    (r) =>
      r.tipo === "revista" &&
      (r.revista_nombre?.toLowerCase().includes("venezolana") ||
        r.fuente?.toLowerCase().includes("latino")),
  );
  if (tieneRevistasLatam) {
    recomendaciones.push({
      tipo: "revistas_latinoamericanas",
      mensaje:
        "Para revistas latinoamericanas, utilice: SciELO, Redalyc, Latindex.",
      accion: "Busque en: https://search.scielo.org y https://www.redalyc.org",
    });
  }

  const tieneLibrosSinISBN = referencias.some(
    (r) =>
      r.tipo === "libro" &&
      !r.datos_libro?.isbn &&
      !r.identificadores_encontrados?.isbn,
  );
  if (tieneLibrosSinISBN) {
    recomendaciones.push({
      tipo: "libros_sin_isbn",
      mensaje:
        "Algunos libros no tienen ISBN registrado, especialmente ediciones locales o antiguas.",
      accion:
        "Busque en catálogos de bibliotecas nacionales: https://www.bnv.gob.ve/",
    });
  }

  if (recomendaciones.length === 0) {
    recomendaciones.push({
      tipo: "general",
      mensaje: "Todas las referencias procesadas correctamente.",
      accion: "Verifique los enlaces proporcionados para cada referencia.",
    });
  }

  return recomendaciones;
}
