import dotenv from "dotenv";
import fs from "fs";
import jose from "node-jose";
import axios, { AxiosHeaders } from "axios";
import { JWTPayload } from "../types";
import { randomUUID } from "crypto";
import {
  CLIENT_ID,
  EPIC_TOKEN_ENDPOINT,
  FHIR_BASE_URL,
  GROUP_ID,
  RESOURCE_TYPE_KEY_MAPPING,
} from "../constants";
import { Observation, Patient } from "fhir/r4";
import nodemailer from "nodemailer";
import schedule from "node-schedule";

dotenv.config();

const transporter = nodemailer.createTransport({
  host: "smtp.ethereal.email",
  port: 587,
  auth: {
    user: "jacinto.heathcote99@ethereal.email",
    pass: "DkR9fA4661DmGNjUx9",
  },
});

const createJWTPayload = (): JWTPayload => {
  return {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: EPIC_TOKEN_ENDPOINT,
    jti: randomUUID(),
    // adds 4 minutes
    exp: Math.round((Date.now() + 240000) / 1000),
    nbf: Math.round(Date.now() / 1000),
    iat: Math.round(Date.now() / 1000),
  };
};

const createJWT = async () => {
  const ks = fs.readFileSync("keys.json");
  const payload = createJWTPayload();
  const keyStore = await jose.JWK.asKeyStore(ks.toString());
  const kid = JSON.parse(ks.toString()).keys[0].kid;
  const key = keyStore.get({ use: "sig", kid });

  return jose.JWS.createSign({ compact: true, fields: { typ: "JWT" } }, key)
    .update(JSON.stringify(payload))
    .final();
};

// Get Access Token from EPIC
const makeTokenRequest = async () => {
  const jwt = await createJWT();

  const data = {
    grant_type: "client_credentials",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: jwt,
  };

  const response = await axios.post(EPIC_TOKEN_ENDPOINT, data, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  return response.data;
};

// Kick off Bulk API Request
const initiateBulkRequest = async (accessToken: string) => {
  const response = await axios.get(
    `${FHIR_BASE_URL}/Group/${GROUP_ID}/$export`,
    {
      params: {
        _type: "Patient,Observation",
        _typeFilter: "Observation?category=laboratory",
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/fhir+json",
        Prefer: "respond-async",
        Accept: "application/fhir+json",
      },
    }
  );
  return response.headers;
};

const pollApi = async (
  endpoint: string,
  accessToken: string,
  timeout = 10000
) => {
  return new Promise((resolve, reject) => {
    // Start the interval to poll the API every 10 seconds
    const intervalId = setInterval(async () => {
      try {
        // Make the API request
        const response = await axios.get(endpoint, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (response.status === 200) {
          clearInterval(intervalId);
          // Resolve the promise with response data
          resolve(response.data);
        } else {
          const progress = (response.headers as AxiosHeaders).get("X-Progress");
          console.log(`Waiting for export to complete: ${progress}`);
        }
      } catch (error) {
        console.error("Error fetching the API: ", error);
        // You can reject the promise in case of error or handle retries here
        reject(error);
      }
    }, timeout);
  });
};

const processPollResults = async (
  contentLocation: string,
  accessToken: string
) => {
  const pollResult = (await pollApi(
    contentLocation as string,
    accessToken
  )) as {
    output: Array<{
      type: keyof typeof RESOURCE_TYPE_KEY_MAPPING;
      url: string;
    }>;
  };
  const resources: { patients: Patient[]; observations: Observation[] } = {
    patients: [],
    observations: [],
  };

  await Promise.all(
    pollResult.output.map(async (resource) => {
      const response = await axios.get(resource.url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const ndjsonData = response.data;
      const jsonObjects = ndjsonData
        .split("\n")
        .filter((line: string) => line.trim() !== "")
        .map((line: string) => JSON.parse(line));

      resources[RESOURCE_TYPE_KEY_MAPPING[resource.type]] = jsonObjects;
    })
  );

  return resources;
};

const parseText = (text: string) => {
  // Regular expression to capture the operator and the number separately
  const match = text.match(/([<>]=?|=)?\s*(-?\d*\.?\d+)/);

  if (match) {
    const operator = match[1] || "="; // Default to '=' if no operator is found
    const number = parseFloat(match[2]); // Parse the number part

    return { operator, number };
  }

  return null; // Return null if no match is found
};

const compareTextWithValue = (text: string, value: number) => {
  const parsed = parseText(text);

  if (parsed) {
    const { operator, number } = parsed;

    switch (operator) {
      case "<=":
        return value <= number;
      case ">=":
        return value >= number;
      case "<":
        return value < number;
      case ">":
        return value > number;
      case "=":
        return value === number;
    }
  }
  return false;
};

const isObservationNormal = (observation: Observation) => {
  const value = observation.valueQuantity?.value;
  const referenceRange = observation.referenceRange?.[0];
  const low = referenceRange?.low?.value;
  const high = referenceRange?.high?.value;
  const text = referenceRange?.text;

  if (value) {
    if (low && high) {
      if (value >= low && value <= high) {
        return {
          isNormal: true,
          value,
          reason: "Observation within reference range.",
        };
      }
    } else if (text) {
      const isNormal = compareTextWithValue(text, value);
      return {
        isNormal,
        value,
        reason: isNormal
          ? "Observation within provided range"
          : "Observation out of range.",
      };
    } else if (!low && !high) {
      return { isNormal: false, reason: "Reference range not found.", value };
    }
  }
  return { isNormal: false, reason: "Incomplete data." };
};

const createMessage = (
  reportResults: Array<{
    observation: Observation;
    patient: Patient;
    isNormal: boolean;
    reason: string;
    value?: number;
  }>
) => {
  const header = `<h1>Patients Lab Report Summary - ${new Date().toLocaleString()}</h1>`;

  const table = `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; width: 100%;">
    <thead>
      <tr>
        <th>Patient</th>
        <th>Observation</th>
        <th>Value</th>
        <th>Normal</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>
      ${reportResults.map((result) => {
        const code = result.observation.code.text;
        const value = result.value;
        const patientName = result.patient.name?.[0].given;
        const reason = result.reason;
        const isNormal = result.isNormal ? "✅" : "❌";

        return `<tr>
          <td>${patientName}</td>
          <td>${code}</td>
          <td>${value || "Not known"}</td>
          <td>${isNormal}</td>
          <td>${reason}</td>
        </tr>`;
      })}
    </tbody>
  </table>`;

  return header + table;
};

const sendEmail = (message: string) => {
  return transporter.sendMail({
    from: "Pratik Awaik <pratikawaik25@gmail.com>",
    to: "doctor@clinic.com",
    subject: `Patients Lab Report Summary - ${new Date().toLocaleString()}\n\n\n`,
    html: message,
  });
};

const main = async () => {
  const tokenResponse = await makeTokenRequest();
  const accessToken = tokenResponse.access_token;

  const initiateResponse = await initiateBulkRequest(accessToken);
  const contentLocation = (initiateResponse as AxiosHeaders)?.get?.(
    "content-location"
  );
  if (contentLocation) {
    const resources = await processPollResults(
      contentLocation as string,
      accessToken
    );

    const reportResults = resources.observations.map((observation) => {
      const { isNormal, reason, value } = isObservationNormal(observation);
      const referencePatient =
        observation.subject?.reference?.split("Patient/")[1];
      const patient = resources.patients.find(
        (patient) => referencePatient === patient.id
      )!;

      return {
        observation,
        patient,
        isNormal,
        reason,
        value,
      };
    });

    const message = createMessage(reportResults);
    await sendEmail(message);
    console.log(`Email Sent at ${new Date().toLocaleString()}`);
  }
};

// Schedule a job to run every 24 hours at midnight
schedule.scheduleJob("0 0 * * ", () => {
  main();
});
