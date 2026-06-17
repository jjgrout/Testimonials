import { createHmac, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { readFile } from "node:fs/promises";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context
} from "aws-lambda";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object
} from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime";
import {
  GetSecretValueCommand,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import PDFDocument from "pdfkit";
import { lookup as lookupMimeType } from "mime-types";

const WordExtractor = require("word-extractor");

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});
const secrets = new SecretsManagerClient({});

const bucketName = requiredEnv("BUCKET_NAME");
const bucketPrefix = requiredEnv("BUCKET_PREFIX");
const authSecretArn = requiredEnv("AUTH_SECRET_ARN");
const sessionSecretArn = requiredEnv("SESSION_SECRET_ARN");
const bedrockModelId = requiredEnv("BEDROCK_MODEL_ID");
const maxContextChars = Number(process.env.MAX_CONTEXT_CHARS ?? "160000");
const sessionCookieName = "testimonial_session";
const sessionTtlSeconds = 8 * 60 * 60;
const supportedExtensions = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".htm",
  ".html",
  ".json",
  ".log",
  ".md",
  ".pdf",
  ".rtf",
  ".text",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

let cachedAuthSecret: AuthSecret | undefined;
let cachedSessionSecret: string | undefined;

type AuthSecret = {
  adminUsername?: string;
  adminPassword?: string;
  users?: Array<{
    username: string;
    password?: string;
    passwordHash?: string;
    salt?: string;
    iterations?: number;
  }>;
};

type SessionPayload = {
  exp: number;
  sub: string;
};

type Json = Record<string, unknown>;

type S3File = {
  extension: string;
  fileName: string;
  key: string;
  lastModified?: string;
  size?: number;
  supported: boolean;
};

type ParsedDocument = {
  fileName: string;
  key: string;
  text: string;
};

type BedrockResponse = {
  content?: Array<{ text?: string; type?: string }>;
};

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod.toUpperCase();
    const path = normalisePath(event.path);

    if (method === "GET" && !path.startsWith("/api/")) {
      return serveStaticAsset(path);
    }

    if (path === "/api/login" && method === "POST") {
      return login(event);
    }

    if (path === "/api/logout" && method === "POST") {
      return jsonResponse({ ok: true }, 200, {
        "Set-Cookie": clearSessionCookie()
      });
    }

    const session = await requireSession(event);
    if (!session) {
      return jsonResponse({ message: "Authentication required" }, 401);
    }

    if (path === "/api/me" && method === "GET") {
      return jsonResponse({ username: session.sub });
    }

    if (path === "/api/files/search" && method === "GET") {
      return searchFiles(event);
    }

    if (path === "/api/testimonial/generate" && method === "POST") {
      return generateTestimonial(event, session);
    }

    if (path === "/api/export/pdf" && method === "POST") {
      return exportPdf(event, session);
    }

    return jsonResponse({ message: "Not found" }, 404);
  } catch (error) {
    console.error("Unhandled request error", error);
    return jsonResponse(
      {
        message: error instanceof Error ? error.message : "Unexpected application error"
      },
      500
    );
  }
};

async function login(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{ username?: string; password?: string }>(event);
  const username = body.username?.trim();
  const password = body.password ?? "";

  if (!username || !password) {
    return jsonResponse({ message: "Username and password are required" }, 400);
  }

  if (!(await verifyCredentials(username, password))) {
    return jsonResponse({ message: "Invalid username or password" }, 401);
  }

  const token = await signSession({ sub: username, exp: epochSeconds() + sessionTtlSeconds });
  return jsonResponse(
    { username },
    200,
    {
      "Set-Cookie": buildSessionCookie(token)
    }
  );
}

async function searchFiles(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const identifier = event.queryStringParameters?.identifier?.trim();
  if (!identifier || identifier.length < 2) {
    return jsonResponse({ message: "Enter at least two identifier characters" }, 400);
  }

  const matches: S3File[] = [];
  let continuationToken: string | undefined;
  const lowerIdentifier = identifier.toLowerCase();

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
        Prefix: bucketPrefix
      })
    );

    for (const object of response.Contents ?? []) {
      const file = toS3File(object);
      if (file.fileName.toLowerCase().includes(lowerIdentifier)) {
        matches.push(file);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken && matches.length < 250);

  matches.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return jsonResponse({ files: matches.slice(0, 250) });
}

async function generateTestimonial(
  event: APIGatewayProxyEvent,
  session: SessionPayload
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{
    additionalInstructions?: string;
    identifier?: string;
    keys?: string[];
  }>(event);

  const identifier = body.identifier?.trim() || "ADF member";
  const keys = validateSelectedKeys(body.keys);
  const documents = await parseSelectedDocuments(keys);
  const context = buildContext(documents);
  const prompt = buildTestimonialPrompt(identifier, documents, context, body.additionalInstructions);

  const response = await bedrock.send(
    new InvokeModelCommand({
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1100,
        messages: [
          {
            content: [
              {
                text: prompt,
                type: "text"
              }
            ],
            role: "user"
          }
        ],
        system:
          "You are an experienced Australian Defence Force writing assistant. Write accurate, respectful, concise service testimonials using only the provided source context.",
        temperature: 0.35
      }),
      contentType: "application/json",
      modelId: bedrockModelId
    })
  );

  const decoded = JSON.parse(new TextDecoder().decode(response.body)) as BedrockResponse;
  const testimonial = decoded.content
    ?.map((item) => item.text)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!testimonial) {
    throw new Error("Bedrock returned an empty testimonial");
  }

  return jsonResponse({
    documents: documents.map((document) => ({
      fileName: document.fileName,
      key: document.key,
      textLength: document.text.length
    })),
    generatedBy: session.sub,
    testimonial
  });
}

async function exportPdf(
  event: APIGatewayProxyEvent,
  session: SessionPayload
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{
    identifier?: string;
    testimonial?: string;
  }>(event);

  const testimonial = body.testimonial?.trim();
  if (!testimonial) {
    return jsonResponse({ message: "Testimonial text is required" }, 400);
  }

  const identifier = body.identifier?.trim() || "ADF member";
  const pdf = await buildPdf(identifier, testimonial, session.sub);
  const fileSafeIdentifier = identifier.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "");

  return {
    body: pdf.toString("base64"),
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${fileSafeIdentifier || "testimonial"}-testimonial.pdf"`,
      "Content-Type": "application/pdf"
    },
    isBase64Encoded: true,
    statusCode: 200
  };
}

function buildTestimonialPrompt(
  identifier: string,
  documents: ParsedDocument[],
  context: string,
  additionalInstructions?: string
): string {
  const sourceList = documents.map((document) => `- ${document.fileName}`).join("\n");
  const optionalInstructions = additionalInstructions?.trim()
    ? `\nAdditional user instructions:\n${additionalInstructions.trim()}\n`
    : "";

  return `Write a 250-350 word testimonial for the service of an Australian Defence Force member on transition or exit from service.

Member identifier:
${identifier}

Purpose:
Create a polished service testimonial that can be reviewed and edited by an authorised user before PDF export. The testimonial should be suitable for a formal Australian context and should recognise the member's contribution, conduct, professional strengths, and service qualities.

Style and content requirements:
- Use Australian English.
- Maintain a respectful, formal, human tone.
- Ground every factual statement in the source context.
- Do not invent ranks, postings, awards, qualifications, dates, deployments, or achievements that are not supported by the source context.
- If the source material is sparse, write a conservative testimonial based on demonstrated general service qualities rather than fabricating details.
- Do not include headings, bullet points, markdown, citations, or source filenames in the final testimonial.
- Produce one coherent testimonial of 250-350 words.
${optionalInstructions}
Selected source files:
${sourceList}

Source context:
${context}`;
}

function buildContext(documents: ParsedDocument[]): string {
  const separator = "\n\n--- SOURCE DOCUMENT ---\n";
  let remaining = maxContextChars;
  const chunks: string[] = [];

  for (const document of documents) {
    if (remaining <= 0) {
      break;
    }
    const header = `${separator}File: ${document.fileName}\nS3 key: ${document.key}\n\n`;
    const available = Math.max(0, remaining - header.length);
    if (available <= 0) {
      break;
    }
    const text = normaliseWhitespace(document.text).slice(0, available);
    chunks.push(`${header}${text}`);
    remaining -= header.length + text.length;
  }

  return chunks.join("");
}

async function parseSelectedDocuments(keys: string[]): Promise<ParsedDocument[]> {
  const documents: ParsedDocument[] = [];
  const failures: string[] = [];

  for (const key of keys) {
    try {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key
        })
      );
      const body = await object.Body?.transformToByteArray();
      if (!body) {
        failures.push(`${basename(key)}: empty object`);
        continue;
      }

      const buffer = Buffer.from(body);
      const text = await parseDocumentText(key, buffer);
      if (!text.trim()) {
        failures.push(`${basename(key)}: no extractable text`);
        continue;
      }

      documents.push({
        fileName: basename(key),
        key,
        text
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown parsing error";
      failures.push(`${basename(key)}: ${message}`);
    }
  }

  if (!documents.length) {
    throw new Error(`No selected files produced extractable text. ${failures.join("; ")}`);
  }

  return documents;
}

async function parseDocumentText(key: string, buffer: Buffer): Promise<string> {
  const extension = extensionOf(key);

  if (extension === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (extension === ".doc") {
    const extractor = new WordExtractor();
    const document = await extractor.extract(buffer);
    return [
      document.getBody(),
      document.getFootnotes(),
      document.getEndnotes(),
      document.getHeaders(),
      document.getFooters(),
      document.getAnnotations(),
      document.getTextboxes()
    ]
      .filter(Boolean)
      .join("\n");
  }

  const decoded = buffer.toString("utf8");
  if (extension === ".html" || extension === ".htm" || extension === ".xml") {
    return stripMarkup(decoded);
  }
  if (extension === ".rtf") {
    return stripRtf(decoded);
  }

  return decoded;
}

function validateSelectedKeys(keys: string[] | undefined): string[] {
  if (!Array.isArray(keys) || !keys.length) {
    throw new Error("Select at least one source file");
  }
  if (keys.length > 20) {
    throw new Error("Select no more than 20 files for one testimonial");
  }

  return keys.map((key) => {
    if (typeof key !== "string" || !key.startsWith(bucketPrefix)) {
      throw new Error("Selected file is outside the configured S3 prefix");
    }
    if (!supportedExtensions.has(extensionOf(key))) {
      throw new Error(`${basename(key)} is not a supported text document type`);
    }
    return key;
  });
}

async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const auth = await getAuthSecret();
  const users = normaliseUsers(auth);
  const user = users.find((candidate) => candidate.username === username);

  if (!user) {
    return false;
  }

  if (user.passwordHash && user.salt) {
    const iterations = user.iterations ?? 310000;
    const actual = await import("node:crypto").then(
      ({ pbkdf2Sync }) =>
        pbkdf2Sync(password, user.salt ?? "", iterations, 32, "sha256").toString("base64")
    );
    return safeEqual(actual, user.passwordHash);
  }

  return safeEqual(password, user.password ?? "");
}

function normaliseUsers(auth: AuthSecret): Array<{
  username: string;
  password?: string;
  passwordHash?: string;
  salt?: string;
  iterations?: number;
}> {
  if (auth.users?.length) {
    return auth.users;
  }
  if (auth.adminUsername && auth.adminPassword) {
    return [
      {
        password: auth.adminPassword,
        username: auth.adminUsername
      }
    ];
  }
  return [];
}

async function getAuthSecret(): Promise<AuthSecret> {
  if (!cachedAuthSecret) {
    cachedAuthSecret = JSON.parse(await getSecretString(authSecretArn)) as AuthSecret;
  }
  return cachedAuthSecret;
}

async function getSessionSecret(): Promise<string> {
  if (!cachedSessionSecret) {
    cachedSessionSecret = await getSecretString(sessionSecretArn);
  }
  return cachedSessionSecret;
}

async function getSecretString(secretId: string): Promise<string> {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (response.SecretString) {
    return response.SecretString;
  }
  if (response.SecretBinary) {
    return Buffer.from(response.SecretBinary).toString("utf8");
  }
  throw new Error(`Secret ${secretId} has no readable value`);
}

async function requireSession(event: APIGatewayProxyEvent): Promise<SessionPayload | undefined> {
  const token = parseCookies(event.headers.Cookie ?? event.headers.cookie ?? "")[sessionCookieName];
  if (!token) {
    return undefined;
  }
  return verifySession(token);
}

async function signSession(payload: SessionPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", await getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

async function verifySession(token: string): Promise<SessionPayload | undefined> {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return undefined;
  }
  const expected = createHmac("sha256", await getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
  if (!safeEqual(signature, expected)) {
    return undefined;
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as
    | SessionPayload
    | undefined;
  if (!payload?.sub || !payload.exp || payload.exp < epochSeconds()) {
    return undefined;
  }
  return payload;
}

async function buildPdf(
  identifier: string,
  testimonial: string,
  preparedBy: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      bufferPages: true,
      margins: {
        bottom: 72,
        left: 72,
        right: 72,
        top: 72
      },
      size: "A4"
    });
    const chunks: Buffer[] = [];

    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    document
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("Australian Defence Force Service Testimonial", {
        align: "center"
      });
    document.moveDown(0.4);
    document
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#4b5563")
      .text(`Member identifier: ${identifier}`, { align: "center" })
      .text(`Prepared: ${new Date().toLocaleDateString("en-AU")}`, { align: "center" });

    document.moveDown(2);
    document
      .fillColor("#111827")
      .font("Helvetica")
      .fontSize(12)
      .lineGap(6)
      .text(testimonial, {
        align: "left"
      });

    document.moveDown(2);
    document
      .fontSize(10)
      .fillColor("#6b7280")
      .text(`Generated for review by ${preparedBy}. Final text should be verified before use.`, {
        align: "left"
      });

    const range = document.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      document.switchToPage(i);
      document
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#9ca3af")
        .text(`Page ${i + 1 - range.start} of ${range.count}`, 72, 780, {
          align: "center",
          width: 451
        });
    }

    document.end();
  });
}

async function serveStaticAsset(path: string): Promise<APIGatewayProxyResult> {
  const publicDir = join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "public");
  const requestedPath = path === "/" ? "/index.html" : path;
  const resolvedPath = normalize(join(publicDir, requestedPath));

  if (!resolvedPath.startsWith(publicDir)) {
    return jsonResponse({ message: "Invalid asset path" }, 400);
  }

  try {
    const file = await readFile(resolvedPath);
    const mimeType = lookupMimeType(resolvedPath) || "application/octet-stream";
    const isText =
      mimeType.startsWith("text/") ||
      mimeType === "application/javascript" ||
      mimeType === "application/json";
    return {
      body: isText ? file.toString("utf8") : file.toString("base64"),
      headers: {
        "Cache-Control": requestedPath === "/index.html" ? "no-store" : "private, max-age=31536000",
        "Content-Type": mimeType
      },
      isBase64Encoded: !isText,
      statusCode: 200
    };
  } catch {
    if (path !== "/index.html") {
      return serveStaticAsset("/index.html");
    }
    return jsonResponse({ message: "Frontend asset not found" }, 404);
  }
}

function toS3File(object: _Object): S3File {
  const key = object.Key ?? "";
  const extension = extensionOf(key);
  return {
    extension,
    fileName: basename(key),
    key,
    lastModified: object.LastModified?.toISOString(),
    size: object.Size,
    supported: supportedExtensions.has(extension)
  };
}

function parseJsonBody<T extends Json>(event: APIGatewayProxyEvent): T {
  if (!event.body) {
    return {} as T;
  }
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(body) as T;
}

function jsonResponse(body: unknown, statusCode = 200, headers?: Record<string, string>) {
  return {
    body: JSON.stringify(body),
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...headers
    },
    statusCode
  };
}

function buildSessionCookie(token: string): string {
  return `${sessionCookieName}=${token}; Path=/; Max-Age=${sessionTtlSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        if (index === -1) {
          return [cookie, ""];
        }
        return [cookie.slice(0, index), decodeURIComponent(cookie.slice(index + 1))];
      })
  );
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function extensionOf(key: string): string {
  return extname(key).toLowerCase();
}

function basename(key: string): string {
  return key.split("/").filter(Boolean).at(-1) ?? key;
}

function normalisePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function stripMarkup(value: string): string {
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function stripRtf(value: string): string {
  return value
    .replace(/\\'[0-9a-fA-F]{2}/g, " ")
    .replace(/\\[a-zA-Z]+\d* ?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ");
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
