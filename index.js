import express from "express";
import multer from "multer";
import { extractText } from "./middleware/extractText.js"; // 👈 importa tu middleware
//import { procesarConOllama } from "./controllers/ollamaController.js"; // 👈 importa el controlador
import { extractBibliografia } from "./middleware/extractBibliografia.js"; // 👈 importa el middleware de bibliografía
import { procesarConOllama } from "./controllers/gropController.js"; // 👈 importa el controlador de Groq

const app = express();
const port = 3000;

// Configuración de multer: guarda los archivos en la carpeta "uploads/"
const upload = multer({ dest: "uploads/" });

app.use(express.json());

// Configuración de Pug
app.set("view engine", "pug");
app.set("views", "./views");

// Ruta para subir el PDF
app.post(
  "/upload",
  upload.single("pdf"),
  extractText,
  extractBibliografia,
  procesarConOllama
);

// Ruta para mostrar la vista
app.get("/", (req, res) => {
  res.render("uploadPdf"); // busca views/uploadPdf.pug
});

app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
