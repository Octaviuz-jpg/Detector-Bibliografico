import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const extractText = async (req, res, next) => {
  const filePath = req.file.path;

  try {
    // Cargar el documento
    const loadingTask = pdfjs.getDocument(filePath);
    const pdf = await loadingTask.promise;
    let fullText = "";

    // Recorrer cada página
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      // 'items' contiene cada fragmento de texto
      // Intentamos ordenar por la posición vertical (transform[5]) y horizontal (transform[4])
      const strings = content.items
        .sort((a, b) => {
          if (a.transform[5] !== b.transform[5]) {
            return b.transform[5] - a.transform[5]; // De arriba a abajo
          }
          return a.transform[4] - b.transform[4]; // De izquierda a derecha
        })
        .map((item) => item.str);

      fullText += strings.join(" ") + "\n";
    }

    req.textoExtraido = fullText.trim();
    next();
  } catch (error) {
    console.error("Error al procesar PDF con PDF.js:", error);
    res.status(500).json({ error: "Error al procesar el PDF" });
  }

  //console.log(req.textoExtraido);
};
