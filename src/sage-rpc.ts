import { readFile } from "node:fs/promises";
import https from "node:https";
import { resolve } from "node:path";

import { PublicKey, fromHex } from "chia-wallet-sdk";
import type { PublicKey as PublicKeyType } from "chia-wallet-sdk";
import xdgAppPathsModule from "xdg-app-paths";
import type { XDGAppPaths } from "xdg-app-paths";

const DERIVATION_PAGE_SIZE = 500;
const DEFAULT_RPC_HOST = "127.0.0.1:9257";
const xdgAppPaths = xdgAppPathsModule as unknown as XDGAppPaths;

interface SageTls {
  cert: Buffer;
  key: Buffer;
}

interface SageDerivation {
  address: string;
  public_key: string;
  index: number;
}

interface GetDerivationsResponse {
  derivations: SageDerivation[];
  total: number;
}

export interface ReceiverDerivation {
  hardened: boolean;
  index: number;
  address: string;
}

export interface ReceiverKey {
  publicKey: PublicKeyType;
  derivation: ReceiverDerivation;
}

function defaultSageDataDirectory(): string {
  return resolve(xdgAppPaths.data(false), "com.rigidnetwork.sage");
}

function rpcBaseUrl(hostValue: string): URL {
  const host = hostValue.trim();
  if (!host) {
    throw new Error("SAGE_RPC_HOST must not be empty");
  }

  let url: URL;
  try {
    url = new URL(host.includes("://") ? host : `https://${host}`);
  } catch {
    throw new Error(`SAGE_RPC_HOST is invalid: ${hostValue}`);
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SAGE_RPC_HOST must be an HTTPS host and optional port without a path",
    );
  }
  return url;
}

export class SageRpc {
  private readonly baseUrl: URL;
  private readonly certPath: string;
  private readonly keyPath: string;
  private tls: SageTls | null = null;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const defaultDirectory = defaultSageDataDirectory();
    this.baseUrl = rpcBaseUrl(environment.SAGE_RPC_HOST ?? DEFAULT_RPC_HOST);
    this.certPath = resolve(
      environment.SAGE_RPC_CERT_PATH ??
        resolve(defaultDirectory, "ssl/wallet.crt"),
    );
    this.keyPath = resolve(
      environment.SAGE_RPC_KEY_PATH ??
        resolve(defaultDirectory, "ssl/wallet.key"),
    );
  }

  private async loadTls(): Promise<SageTls> {
    if (!this.tls) {
      const [cert, key] = await Promise.all([
        readFile(this.certPath),
        readFile(this.keyPath),
      ]);
      this.tls = { cert, key };
    }
    return this.tls;
  }

  async call<T = unknown>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const tls = await this.loadTls();
    const payload = JSON.stringify(body);
    const url = new URL(endpoint.replace(/^\//, ""), `${this.baseUrl}/`);

    return new Promise<T>((resolvePromise, rejectPromise) => {
      const request = https.request(
        url,
        {
          method: "POST",
          cert: tls.cert,
          key: tls.key,
          rejectUnauthorized: false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => {
            if (
              response.statusCode === undefined ||
              response.statusCode < 200 ||
              response.statusCode >= 300
            ) {
              rejectPromise(
                new Error(
                  `Sage RPC ${endpoint} failed (${response.statusCode ?? "unknown"}): ${text}`,
                ),
              );
              return;
            }
            try {
              resolvePromise((text ? JSON.parse(text) : {}) as T);
            } catch (error) {
              rejectPromise(
                new Error(
                  `Sage RPC ${endpoint} returned invalid JSON: ${error}`,
                ),
              );
            }
          });
        },
      );
      request.on("error", rejectPromise);
      request.end(payload);
    });
  }
}

export async function findReceiverPublicKey(
  rpc: SageRpc,
  receiverAddress: string,
): Promise<ReceiverKey> {
  for (const hardened of [false, true]) {
    let offset = 0;
    while (true) {
      const response = await rpc.call<GetDerivationsResponse>(
        "get_derivations",
        {
          hardened,
          offset,
          limit: DERIVATION_PAGE_SIZE,
        },
      );
      const match = response.derivations.find(
        (derivation) => derivation.address === receiverAddress,
      );
      if (match) {
        return {
          publicKey: PublicKey.fromBytes(fromHex(match.public_key)),
          derivation: {
            hardened,
            index: match.index,
            address: match.address,
          },
        };
      }

      offset += response.derivations.length;
      if (offset >= response.total || response.derivations.length === 0) {
        break;
      }
    }
  }

  throw new Error(
    `The selected Sage wallet does not own clawback receiver ${receiverAddress}`,
  );
}
