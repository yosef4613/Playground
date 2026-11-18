import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import stream from "node:stream";
import url from "node:url";
import { createServer as createViteServer } from "vite";
import { checkIslandContentPolicy } from "./src/content_policy";
import { type AppEnv, resolveRuntimeEnv } from "./src/env_types";
import { resolveWorldLiveFeeds } from "./src/live_feeds";
import { chooseMoveWithGeminiFlashLite, validateMinigameRequest } from "./src/minigame_ai";
import { MultiplayerHub } from "./src/multiplayer_hub";
import {
  buildSecurityHeaders,
  readBoundedJsonBody,
  resolveVisitorIdentity,
  safeLogError,
  sanitizePlainText,
  validateImageDataUrl,
  verifyMutationSecurity,
} from "./src/security";
import type { TrafficIncidentReason } from "./src/types";
import { WorldStore } from "./src/world_store";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

type NodeIncomingReq = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

type NodeServerRes = {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string | string[]): void;
  end(chunk?: unknown): void;
};

type NodeUpgradeSocket = {
  write(chunk: string | Uint8Array): boolean;
  destroy(): void;
};

const minigameBuckets = new Map<string, { windowStart: number; count: number }>();
function allowMinigameMove(ipHash: string): boolean {
  const now = Date.now();
  if (minigameBuckets.size > 1024) {
    for (const [k, b] of minigameBuckets.entries()) {
      if (now - b.windowStart > 60_000) minigameBuckets.delete(k);
    }
  }
  const cur = minigameBuckets.get(ipHash);
  if (!cur || now - cur.windowStart > 60_000) {
    minigameBuckets.set(ipHash, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= 90) return false;
  cur.count++;
  return true;
}

const incidentBuckets = new Map<string, { windowStart: number; count: number }>();
function allowTrafficIncidentReport(ipHash: string): boolean {
  const now = Date.now();
  if (incidentBuckets.size > 1024) {
    for (const [k, b] of incidentBuckets.entries()) {
      if (now - b.windowStart > 60_000) incidentBuckets.delete(k);
    }
  }
  const cur = incidentBuckets.get(ipHash);
  if (!cur || now - cur.windowStart > 60_000) {
    incidentBuckets.set(ipHash, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= 24) return false;
  cur.count++;
  return true;
}

function jsonResponse(
  request: Request,
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const isHttps =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...buildSecurityHeaders(isHttps),
      ...(extraHeaders ?? {}),
    },
  });
}

function toWebRequest(req: NodeIncomingReq): Request {
  const proto =
    (typeof req.headers["x-forwarded-proto"] === "string" &&
      req.headers["x-forwarded-proto"].split(",")[0].trim()) ||
    "http";
  const host =
    (typeof req.headers["x-forwarded-host"] === "string" &&
      req.headers["x-forwarded-host"].split(",")[0].trim()) ||
    req.headers.host ||
    `localhost:${PORT}`;
  const fullUrl = `${proto}://${host}${req.url || "/"}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") {
      headers.set(k, v);
    } else if (Array.isArray(v)) {
      headers.set(k, v.join(", "));
    }
  }

  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
  };
  if (hasBody) {
    init.body = stream.Readable.toWeb(
      req as unknown as Parameters<typeof stream.Readable.toWeb>[0],
    ) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(fullUrl, init);
}

async function sendWebResponse(res: NodeServerRes, webRes: Response): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const setCookies = (webRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies && setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }
  if (!webRes.body) {
    res.end();
    return;
  }
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function tryServeStaticFile(req: NodeIncomingReq, res: NodeServerRes, rootDir: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const cleanRel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(rootDir, cleanRel);
  if (!resolved.startsWith(path.resolve(rootDir))) {
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return false;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.statusCode = 200;
  res.setHeader("content-type", MIME_BY_EXT[ext] || "application/octet-stream");
  res.setHeader("x-content-type-options", "nosniff");
  if (ext === ".png" || ext === ".jpg" || ext === ".ico") {
    res.setHeader("cache-control", "public, max-age=3600");
  }
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(resolved).pipe(res as unknown as NodeJS.WritableStream);
  return true;
}

export async function startServer(customPort?: number) {
  const mpHub = new MultiplayerHub();

  const worldStore = new WorldStore({
    getEnv: () => resolveRuntimeEnv(),
    onBroadcast: (payload) => {
      mpHub.broadcastWorldEvent(payload);
    },
  });

  async function handleApiRequest(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/mp") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const parsed = await readBoundedJsonBody(request, 32_768);
        if (!parsed.ok) {
          return jsonResponse(request, { ok: false, error: parsed.error }, parsed.status);
        }
        const syncRes = mpHub.handleHttpSync(parsed.data);
        return jsonResponse(request, syncRes, 200);
      }

      if (url.pathname === "/api/world") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const id = await resolveVisitorIdentity(request, env);
        const snapshot = worldStore.getWorldSnapshot(id.cookieId, id.dayKey);
        return jsonResponse(
          request,
          {
            ...snapshot,
            visitorToken: id.visitorToken,
          },
          200,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      if (url.pathname === "/api/job") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const id = await resolveVisitorIdentity(request, env);
        const jobId = sanitizePlainText(url.searchParams.get("id") ?? "", 64, true);
        const statusRes = worldStore.getBuildJobStatus(jobId || null, id.cookieId, id.dayKey);
        const feeds = statusRes.world
          ? await resolveWorldLiveFeeds(statusRes.world.creations)
          : undefined;
        return jsonResponse(
          request,
          {
            ok: true,
            job: statusRes.job,
            visitorToken: id.visitorToken,
            ...(statusRes.world ? { world: statusRes.world } : {}),
            ...(feeds ? { feeds } : {}),
          },
          200,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      if (url.pathname === "/api/feeds") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const snapshot = worldStore.getWorldSnapshot("", "");
        const feeds = await resolveWorldLiveFeeds(snapshot.creations);
        return jsonResponse(request, { ok: true, feeds }, 200, {
          "cache-control": "public, max-age=20",
        });
      }

      if (url.pathname === "/api/audit") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const report = worldStore.getWorldAuditReport();
        return jsonResponse(request, report, 200, {
          "cache-control": "public, max-age=10",
        });
      }

      if (url.pathname === "/api/eta") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const telemetry = worldStore.getBuildEtaTelemetry();
        const diagnostics = worldStore.getBuildDiagnostics();
        return jsonResponse(
          request,
          { ok: true, telemetry, diagnostics },
          200,
          { "cache-control": "public, max-age=5" },
        );
      }

      if (url.pathname === "/api/traffic-incident") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const id = await resolveVisitorIdentity(request, env);
        if (!allowTrafficIncidentReport(id.ipHash)) {
          return jsonResponse(request, { ok: false, error: "Rate limited." }, 429);
        }
        const parsedBody = await readBoundedJsonBody(request, 4_096);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const raw = parsedBody.data;
        const vehicleId = sanitizePlainText(raw.vehicleId, 64, true);
        const peerVehicleId = raw.peerVehicleId
          ? sanitizePlainText(raw.peerVehicleId, 64, true)
          : null;
        const allowedReasons = new Set<TrafficIncidentReason>([
          "clash_gridlock",
          "turnaround_blocked",
          "building_obstruction",
          "self_restored",
        ]);
        const rawReason = sanitizePlainText(raw.reason, 32, true) as TrafficIncidentReason;
        const reason: TrafficIncidentReason = allowedReasons.has(rawReason)
          ? rawReason
          : "self_restored";
        const x = typeof raw.x === "number" && Number.isFinite(raw.x) ? raw.x : 0;
        const z = typeof raw.z === "number" && Number.isFinite(raw.z) ? raw.z : 0;
        if (!vehicleId) {
          return jsonResponse(request, { ok: false, error: "vehicleId required." }, 400);
        }
        const result = worldStore.reportTrafficIncident({
          vehicleId,
          peerVehicleId,
          x,
          z,
          reason,
        });
        return jsonResponse(request, result, result.ok ? 200 : 404);
      }

      if (url.pathname === "/api/minigame-move") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return jsonResponse(
            request,
            { ok: false, error: "Gemini opponent is temporarily unavailable." },
            503,
          );
        }
        const id = await resolveVisitorIdentity(request, env);
        if (!allowMinigameMove(id.ipHash)) {
          return jsonResponse(
            request,
            { ok: false, error: "Too many rapid moves — pause a moment." },
            429,
          );
        }
        const parsedBody = await readBoundedJsonBody(request, 8_192);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const validated = validateMinigameRequest(parsedBody.data);
        if (!validated.ok) {
          return jsonResponse(request, { ok: false, error: validated.error }, 400);
        }
        const result = await chooseMoveWithGeminiFlashLite({
          apiKey,
          configuredModel: env.MINIGAME_MODEL,
          req: validated.req,
          validMoves: validated.validMoves,
        });
        return jsonResponse(request, { ok: true, ...result }, 200);
      }

      if (url.pathname === "/api/build") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return jsonResponse(
            request,
            { ok: false, error: "Sculpting service requires GEMINI_API_KEY." },
            503,
          );
        }

        const parsedBody = await readBoundedJsonBody(request, 5_000_000);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const body = parsedBody.data;
        const prompt = sanitizePlainText(body.prompt, 480, true);
        const imgCheck = validateImageDataUrl(body.imageDataUrl);
        if (!imgCheck.ok) {
          return jsonResponse(request, { ok: false, error: imgCheck.error }, imgCheck.status);
        }
        if (!prompt && !imgCheck.base64) {
          return jsonResponse(
            request,
            { ok: false, error: "Add a photo or short description first." },
            400,
          );
        }
        if (prompt) {
          const policyRes = checkIslandContentPolicy(prompt);
          if (!policyRes.allowed) {
            return jsonResponse(request, { ok: false, error: policyRes.reason }, 400);
          }
        }

        const id = await resolveVisitorIdentity(request, env);
        const cookieHeaders = id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined;

        const enqueued = await worldStore.enqueueBuildJob({
          ipHash: id.ipHash,
          cookieId: id.cookieId,
          dayKey: id.dayKey,
          prompt,
          imageBase64: imgCheck.base64,
          imageMimeType: imgCheck.mimeType,
          x: typeof body.x === "number" && Number.isFinite(body.x) ? body.x : null,
          z: typeof body.z === "number" && Number.isFinite(body.z) ? body.z : null,
          yaw: typeof body.yaw === "number" && Number.isFinite(body.yaw) ? body.yaw : null,
        });

        if (!enqueued.ok) {
          const extra = {
            ...(cookieHeaders ?? {}),
            ...(enqueued.retryAfterSec ? { "Retry-After": String(enqueued.retryAfterSec) } : {}),
          };
          return jsonResponse(
            request,
            {
              ok: false,
              ...(enqueued.alreadyPlaced
                ? { alreadyPlaced: true, myCreationId: enqueued.myCreationId }
                : {}),
              error: enqueued.error,
            },
            enqueued.status,
            extra,
          );
        }

        return jsonResponse(
          request,
          {
            ok: true,
            queued: true,
            job: enqueued.job,
            visitorToken: id.visitorToken,
          },
          200,
          cookieHeaders,
        );
      }

      return jsonResponse(request, { ok: false, error: "Not found." }, 404);
    } catch (err) {
      safeLogError("api_unhandled", err, [env.GEMINI_API_KEY, env.CREATOR_HMAC_SECRET]);
      return jsonResponse(request, { ok: false, error: "Internal server error." }, 500);
    }
  }

  const isProd = process.env.NODE_ENV === "production";
  const distDir = path.join(__dirname, "dist");
  const publicDir = path.join(__dirname, "public");

  const httpServer = http.createServer();

  let viteMiddleware: ((req: NodeIncomingReq, res: NodeServerRes, next: () => void) => void) | null =
    null;

  if (!isProd || !fs.existsSync(path.join(distDir, "index.html"))) {
    const vite = await createViteServer({
      root: __dirname,
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
        allowedHosts: true,
      },
      appType: "spa",
    });
    viteMiddleware = vite.middlewares as unknown as (
      req: NodeIncomingReq,
      res: NodeServerRes,
      next: () => void,
    ) => void;
  }

  httpServer.on("request", async (req: NodeIncomingReq, res: NodeServerRes) => {
    const urlPath = (req.url || "/").split("?")[0];

    if (urlPath.startsWith("/api/")) {
      const env = resolveRuntimeEnv();
      const webReq = toWebRequest(req);
      const webRes = await handleApiRequest(webReq, env);
      await sendWebResponse(res, webRes);
      return;
    }

    if (viteMiddleware) {
      viteMiddleware(req, res, () => {
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end("Not Found");
        }
      });
      return;
    }

    if (tryServeStaticFile(req, res, distDir)) return;
    if (tryServeStaticFile(req, res, publicDir)) return;

    const indexPath = path.join(distDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      fs.createReadStream(indexPath).pipe(res as unknown as NodeJS.WritableStream);
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });

  httpServer.on("upgrade", (req: NodeIncomingReq, socket: NodeUpgradeSocket, head: Uint8Array) => {
    const handled = mpHub.handleUpgrade(req, socket, head);
    if (!handled && !viteMiddleware) {
      socket.destroy();
    }
  });

  const listenPort = customPort ?? PORT;
  await new Promise<void>((resolve) => {
    httpServer.listen(listenPort, HOST, () => {
      console.log(`GeminIsland server listening on http://${HOST}:${listenPort}`);
      resolve();
    });
  });

  return {
    httpServer,
    worldStore,
    mpHub,
    close: () =>
      new Promise<void>((resolve) => {
        mpHub.dispose();
        httpServer.close(() => resolve());
      }),
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));

if (isMainModule) {
  void startServer();
}
