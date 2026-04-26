import axios from "axios";

async function testDefinitivo() {
  // Forzamos minúsculas y limpiamos espacios
  const doi = "10.6028/NIST.SP.800-207".toLowerCase().trim();
  const url = `https://api.datacite.org/dois/${doi}`;

  try {
    const res = await axios.get(url, {
      headers: {
        Accept: "application/vnd.api+json",
        "User-Agent": "NodeJS/Axios-Test",
      },
    });

    console.log("¡POR FIN! Conectado con DataCite");
    const autores = res.data.data.attributes.creators.map((c) => c.name);
    console.log("Autores Reales:", autores);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      console.log("La API dice que NO EXISTE (404).");
      console.log(
        "Intenta abrir esto en tu navegador para ver si te da error a ti también:",
      );
      console.log(`https://api.datacite.org/dois/${doi}`);
    } else {
      console.log("Error distinto al 404:", e.message);
    }
  }
}

testDefinitivo();
