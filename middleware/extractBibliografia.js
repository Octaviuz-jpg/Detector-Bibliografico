/**
 * Middleware: extractBibliografia.js
 * Objetivo: Aislar la sección de referencias para reducir el ruido enviado a la IA.
 */
export const extractBibliografia = (req, res, next) => {
  // 1. Obtener el texto extraído del paso anterior (pdf-parse o similar)
  const texto = req.textoExtraido || "";

  if (!texto || texto.trim().length < 10) {
    console.warn("⚠️ El texto extraído está vacío o es muy corto.");
    req.bibliografia = "";
    return next();
  }

  // 2. Normalización inicial: Colapsar espacios y limpiar saltos de línea molestos
  const clean = texto.replace(/\s+/g, " ").trim();

  /**
   * 3. DETECCIÓN FLEXIBLE DE SECCIONES
   * Usamos Regex con la bandera 'i' (ignoreCase) para capturar:
   * "Bibliografía", "bibliografia", "REFERENCIAS", "References", "Fuentes bibliográficas", etc.
   */
  const regexInicio =
    /(bibliograf[ií]a|referencias|references|fuentes citadas)/i;
  const matchInicio = clean.match(regexInicio);

  /**
   * 4. DETECCIÓN DE FIN DE SECCIÓN
   * Buscamos palabras que suelen indicar que la bibliografía terminó (Anexos, Apéndices, etc.)
   */
  const regexFin =
    /(leyes y decretos citados|anexos|appendix|ap[eé]ndice|agradecimientos)/i;
  const matchFin = clean.match(regexFin);

  let soloBibliografia = "";

  if (matchInicio) {
    // Si encontramos la palabra clave, extraemos desde ahí
    const inicioIndice = matchInicio.index;

    if (matchFin && matchFin.index > inicioIndice) {
      // Si hay una sección de cierre después de la bibliografía, cortamos ahí
      soloBibliografia = clean.substring(inicioIndice, matchFin.index).trim();
      console.log("✅ Sección de Bibliografía delimitada con éxito.");
    } else {
      // Si no hay sección de cierre, tomamos todo hasta el final
      soloBibliografia = clean.substring(inicioIndice).trim();
      console.log(
        "✅ Sección de Bibliografía extraída hasta el final del documento.",
      );
    }
  } else {
    /**
     * 5. LÓGICA DE RESPALDO (FALLBACK)
     * Si no aparece la palabra "Bibliografía" (por formato de PDF o error de OCR),
     * tomamos los últimos 10,000 caracteres del documento.
     * Esto evita que el sistema devuelva error y permite que la IA busque las citas.
     */
    console.warn(
      "⚠️ No se encontró la palabra clave 'Bibliografía'. Usando fallback de seguridad.",
    );
    soloBibliografia = clean.slice(-10000);
  }

  // 6. LIMPIEZA FINAL
  // Convertimos cualquier residuo de saltos de línea en espacios para que el JSON no se rompa
  const textoFinal = soloBibliografia
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 7. ASIGNACIÓN AL REQUEST
  // Guardamos el resultado en req.bibliografia para que el controlador lo use
  req.bibliografia = textoFinal;

  next();
};
