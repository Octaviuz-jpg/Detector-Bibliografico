import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI("AIzaSyCNk81YoEIiBd2O7ajGo_wWNN6VXkAFTEE");

async function investigarConGrounding() {
  try {
    console.log("⏳ Listando modelos...");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${genAI.getApiKey()}`,
    );
    const data = await response.json();
    console.log(
      "Modelos disponibles:",
      data.models.map((m) => m.name).slice(0, 5),
    );

    console.log("⏳ Conectando con grounding...");

    // Modelo que soporta grounding con Google Search
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp", // Modelo con soporte grounding
      tools: [{ googleSearchRetrieval: {} }], // Grounding activado
    });

    const prompt = "¿Quién es el investigador Ignacio Ávalos de Venezuela?";

    const result = await model.generateContent(prompt);
    console.log(
      "✅ ¡GROUNDING ACTIVO! Respuesta con fuentes:",
      result.response.text(),
    );
  } catch (error) {
    console.error("❌ ERROR:", error.message);
    console.log("💡 Requisitos para grounding:");
    console.log("- Tier pagado (no free tier)");
    console.log("- Región compatible");
    console.log("- Modelo específico: gemini-2.0-flash-exp o gemini-1.5-pro");
  }
}

investigarConGrounding();
