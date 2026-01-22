const { Router } = require("express");

const ollama = require("ollama");

const router = Router();

router.post(
  "/analizar",
  upload.single("archivo"),
  extractText,
  procesarConOllama
);
