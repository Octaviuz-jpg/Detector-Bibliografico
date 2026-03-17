# 📚 Bibliographic Detector: Motor Híbrido de Extracción

Este sistema es una herramienta avanzada para automatizar la extracción y validación de citas académicas desde texto crudo de PDFs.

## 🚀 Flujo de Trabajo
1. **Extracción:** Usa Groq (Llama 3.3) para estructurar datos.
2. **Validación Académica:** Consulta Crossref para DOIs y OpenAlex para métricas de autores.
3. **Protocolo de Rescate:** Si falta el ISBN, consulta la API de Google Books con manejo de ráfagas (anti-429).



## 🛠️ Requisitos
- Node.js v16+
- API Key de Groq

## ⚙️ Instalación
1. `npm install`
2. Configura tu `.env` con `GROQ_API_KEY`.
3. Ejecuta el servidor y envía el texto extraído del PDF.

## 📊 Capacidades de Validación
- **DOI/ISSN:** Extraídos de Crossref.
- **ISBN:** Rescatados de Google Books (estándar ISBN_13).
- **Impacto:** Índice H y ORCID validados.