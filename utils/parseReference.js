// utils/parseReferencias.js
export function parseReferencias(rawResponse) {
  if (!rawResponse || typeof rawResponse !== "string") {
    return [];
  }

  // Buscar el primer array JSON dentro del string
  const match = rawResponse.match(/\[[\s\S]*\]/);

  if (!match) {
    console.warn("⚠ No se encontró un array JSON en la respuesta de Ollama");
    return [];
  }

  try {
    const referencias = JSON.parse(match[0]);
    return Array.isArray(referencias) ? referencias : [];
  } catch (error) {
    console.error("❌ Error parseando referencias:", error);
    return [];
  }
}
