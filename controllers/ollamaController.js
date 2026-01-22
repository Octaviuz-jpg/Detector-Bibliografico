import { parseReferencias } from "../utils/parseReference.js";
import { search } from "duck-duck-scrape"; // Importamos el buscador libre
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const procesarConOllama = async (req, res) => {
  try {
    const texto = req.bibliografia;
    console.log(req.bibliografia);

    // --- TU LÓGICA DE OLLAMA (SIN TOCAR) ---
    const prompt = `

Actúa como un experto en bibliografía académica. Tu tarea es extraer TODAS las referencias del texto.
Incluso si la referencia es corta (ej. OCDE) o muy larga, debes incluirla.
Extrae únicamente las referencias bibliográficas académicas que aparecen literalmente en el siguiente texto. No inventes ni sustituyas autores, títulos o años.
Devuelve el resultado en un JSON estricto con este formato:

[
  { "autor": "", "año": "", "titulo": "", "fuente": "" }
]
REGLAS IMPORTANTES:
IDENTIFICACIÓN DE AUTOR: El campo "autor" termina inmediatamente antes del año entre paréntesis o de la fecha. Si no hay fecha, termina en el primer punto y seguido (.) que no sea una abreviatura de nombre (ej. "J.P.").
No cambies el idioma de las referencias, y siempre trata de agarrar exactamente el titulo completo y correcto.
Si una referencia está dividida en varias líneas, únelas en una sola entrada.
No descartes referencias con autores múltiples, iniciales repetidas o títulos largos.
Si una referencia contiene múltiples partes (autor, año, título, revista, institución, URL), devuélvela como un solo objeto JSON. 
No dividas en dos referencias aunque aparezcan varias líneas o "(s.f.)".
No ignores referencias de instituciones (ej. OCDE, ONU, NIST).


Si el texto contiene errores tipográficos, devuélvelos tal cual.



Texto:
${texto}
`;

    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3",
        prompt,
        stream: false,
        options: {
          temperature: 0.1, // Subimos un poco de 0 para darle "flexibilidad"
          num_ctx: 8192, // Memoria de lectura
          num_predict: -1, // Que no se detenga hasta terminar
          top_k: 20, // Ayuda a elegir mejores palabras
          top_p: 0.9,
        },
      }),
    });

    const data = await response.json();

    // Aquí Ollama devuelve un string con texto + JSON incrustado
    const referenciasBase = parseReferencias(data.response);
  } catch (error) {
    console.error("Error procesando con Ollama:", error);
    res.status(500).json({ error: "Error procesando con Ollama" });
  }

  
};
