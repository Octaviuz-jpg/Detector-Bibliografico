import express from "express";
import multer from "multer";
import { extractText } from "./middleware/extractText.js"; // 👈 importa tu middleware
//import { procesarConOllama } from "./controllers/ollamaController.js"; // 👈 importa el controlador
import { extractBibliografia } from "./middleware/extractBibliografia.js"; // 👈 importa el middleware de bibliografía
import { procesarBibliografiaHibrida } from "./controllers/prueba.js"; // 👈 importa el controlador de Groq

const app = express();
const port = 3000;

// Configuración de multer: guarda los archivos en la carpeta "uploads/"
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten archivos PDF"), false);
    }
  },
});

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
  procesarBibliografiaHibrida,
);

// Ruta para mostrar la vista
app.get("/", (req, res) => {
  res.render("uploadPdf"); // busca views/uploadPdf.pug
});

app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
