import { Request, Response } from "express";
import fs from "fs";
import jose from "node-jose";

export const serveJWKS = async (_: Request, res: Response) => {
  const ks = fs.readFileSync("keys.json");
  const keyStore = await jose.JWK.asKeyStore(ks.toString());
  res.json(keyStore.toJSON());
};
