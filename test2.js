import { tavily } from "@tavily/core";

const tvly = tavily({ apiKey: "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" }); // Pon tu llave real

async function probar() {
  try {
    console.log("Probando conexión...");
    const res = await tvly.search("¿Qué es el ISSN?", { maxResults: 1 });
    console.log("¡ÉXITO! Encontré este link:", res.results[0].url);
  } catch (err) {
    console.log("--- ERROR DETECTADO ---");
    console.log("Código de error:", err.status);
    console.log("Mensaje:", err.message);
  }
}
probar();
