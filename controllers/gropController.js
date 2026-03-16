import Groq from "groq-sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// --- CONFIGURACIÓN ---
const API_KEY = ;/**aca va la api key de Groq  */
const MODELO_INTELIGENTE = ;/**nombre = Groq llama-3.3-70b-versatile */
const groq = new Groq({ apiKey: API_KEY });

/**
 * CONTROLADOR PRINCIPAL
 */
export const procesarBibliografiaHibrida = async (req, res) => {
  try {
    let texto = req.textoExtraido;
    if (!texto) return res.status(400).json({ error: "No se recibió texto" });

    // Limpieza inicial de ruido
    texto = texto.replace(/&amp;/g, " & ").replace(/[\t\r]/g, " ");

    console.log("\n--- 🚀 PROCESAMIENTO CON FILTRO DE IDENTIDAD ESTRICTO ---");

    // PASO 1: Extracción de datos del PDF
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "Extrae referencias bibliográficas en JSON. 'autores_lista' debe ser un array de strings con los nombres exactamente como aparecen. No inventes nombres.",
        },
        {
          role: "user",
          content: `Texto: ${texto.substring(0, 8000)} \n JSON: {"referencias": [{"autores_lista": [], "titulo": "", "anio": ""}]}`,
        },
      ],
      model: MODELO_INTELIGENTE,
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const dataRaw = JSON.parse(completion.choices[0].message.content);
    const referenciasBase = dataRaw.referencias || [];
    const resultadosFinales = [];

    // PASO 2: Validación y búsqueda de métricas
    for (const ref of referenciasBase) {
      const autoresPDF = Array.isArray(ref.autores_lista)
        ? ref.autores_lista
        : [];
      const titulo = String(ref.titulo || "");

      console.log(`\n📖 Obra: "${titulo.substring(0, 45)}..."`);

      // Consultamos Crossref para intentar obtener nombres completos oficiales
      const autoresOficiales = await obtenerAutoresDesdeCrossref(titulo);
      const autoresValidados = [];

      for (const nombrePDF of autoresPDF) {
        if (!nombrePDF || nombrePDF.length < 3) continue;

        // --- LÓGICA DE VALIDACIÓN DE IDENTIDAD ---
        // Sacamos el apellido del PDF (ej. "Avalos" de "Avalos, Ignacio")
        const apellidoPDF = nombrePDF.split(",")[0].trim().toLowerCase();

        // Buscamos si ese apellido existe en la respuesta de Crossref
        const matchReal = autoresOficiales.find((n) =>
          n.toLowerCase().includes(apellidoPDF),
        );

        // Si hay match de apellido, usamos el nombre completo de Crossref.
        // Si NO, usamos el del PDF para no traer a un extraño.
        const nombreFinalParaBuscar = matchReal ? matchReal : nombrePDF;

        console.log(
          `   🔍 Buscando: ${nombreFinalParaBuscar} ${matchReal ? "(Validado vía Crossref)" : "(Usando PDF)"}`,
        );

        try {
          // Pausa obligatoria para evitar bloqueo de Semantic Scholar (Error 429)
          await new Promise((r) => setTimeout(r, 1500));

          const metricas = await obtenerMetricasCompletas(
            nombreFinalParaBuscar,
          );

          autoresValidados.push({
            nombre_original: nombrePDF,
            nombre_completo_usado: nombreFinalParaBuscar,
            orcid: metricas.orcid,
            indice_h: metricas.indice_h,
            institucion: metricas.institucion,
          });
        } catch (err) {
          autoresValidados.push({
            nombre_original: nombrePDF,
            error: "Error en búsqueda de métricas",
          });
        }
      }

      resultadosFinales.push({
        ...ref,
        autores_validados: autoresValidados,
      });
    }

    res.json({ success: true, data: resultadosFinales });
  } catch (error) {
    console.error("❌ ERROR GENERAL:", error.message);
    res.status(500).json({ error: error.message });
  }
};

/**
 * 🌐 BÚSQUEDA EN CROSSREF
 */
async function obtenerAutoresDesdeCrossref(titulo) {
  if (!titulo || titulo.length < 15) return [];
  try {
    const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(titulo)}&rows=1`;
    const res = await axios.get(url, { timeout: 6000 });
    const item = res.data.message.items?.[0];

    // Solo devolvemos los autores si el ítem existe
    if (item && item.author) {
      return item.author.map((a) =>
        `${a.given || ""} ${a.family || ""}`.trim(),
      );
    }
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * 🎓 OBTENER MÉTRICAS (OpenAlex + Semantic Scholar + ORCID)
 */
async function obtenerMetricasCompletas(nombre) {
  try {
    const [alex, semantic] = await Promise.all([
      axios
        .get(
          `https://api.openalex.org/authors?search=${encodeURIComponent(nombre)}`,
          { timeout: 6000 },
        )
        .catch(() => null),
      axios
        .get(
          `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(nombre)}&fields=hIndex,externalIds,affiliations`,
          { timeout: 6000 },
        )
        .catch(() => null),
    ]);

    const dAlex = alex?.data?.results?.[0];
    const dSem = semantic?.data?.data?.[0];

    // Intento de recuperación de ORCID
    let orcid = dSem?.externalIds?.ORCID || null;
    if (!orcid) {
      const resOrcid = await axios
        .get(
          `https://pub.orcid.org/v3.0/expanded-search/?q=credit-name:"${nombre}"`,
          {
            headers: { Accept: "application/json" },
            timeout: 5000,
          },
        )
        .catch(() => null);
      orcid = resOrcid?.data["expanded-result"]?.[0]?.["orcid-id"] || null;
    }

    return {
      orcid: orcid,
      indice_h: Math.max(
        Number(dAlex?.summary_stats?.h_index || 0),
        Number(dSem?.hIndex || 0),
      ),
      institucion:
        dAlex?.last_known_institution?.display_name ||
        dSem?.affiliations?.[0]?.name ||
        "No detectada",
    };
  } catch (e) {
    return { indice_h: 0, orcid: null, institucion: "No encontrada" };
  }
}
