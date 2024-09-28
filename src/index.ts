import dotenv from "dotenv";
import express from "express";

// controllers
import * as jwksController from "./controllers/jwks";

dotenv.config();

const app = express();
const PORT = 3000;

app.get("/jwks", jwksController.serveJWKS);

app.listen(PORT, () => {
  console.log(`App listening on PORT: ${PORT}`);
});
