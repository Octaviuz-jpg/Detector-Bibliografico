// middleware/extractBibliografia.js
export const extractBibliografia = (req, res, next) => {
  const texto = req.textoExtraido;

  // Normalizar espacios
  const clean = texto.replace(/\s+/g, " ").trim();

  // Detectar secciones
  const inicio = clean.toLowerCase().indexOf("bibliografía");
  const fin = clean.toLowerCase().indexOf("leyes y decretos citados");

  if (inicio === -1) {
    console.warn("⚠ No se encontró la sección de Bibliografía en el PDF");
    req.bibliografia = clean;
    return next();
  }

  let soloBibliografia = clean;

  if (fin !== -1) {
    soloBibliografia = clean.substring(inicio, fin).trim();
  } else {
    soloBibliografia = clean.substring(inicio).trim();
  }
  // Dentro de tu controlador
  const textoLimpio = soloBibliografia
    .replace(/\r\n|\r|\n/g, " ") // Convierte saltos de línea en espacios
    .replace(/\s+/g, " ") // Colapsa múltiples espacios en uno solo
    .trim();
    
      req.bibliografia = textoLimpio;
  // Dentro de tu controlador
  next();
};
