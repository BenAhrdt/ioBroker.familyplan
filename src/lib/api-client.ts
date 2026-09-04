import { Agent, fetch as undiciFetch } from "undici";
import type {
  Child,
  LocationState,
  StatusResponse,
  CalendarEvent,
} from "./types";
import {
  parseChildren,
  parseEvents,
  parseLocation,
  parseStatus,
} from "./validation";

/**
 *
 */
export class ApiError extends Error {
  /**
   *
   */
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
/**
 *
 */
export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  verifySsl: boolean;
  fetchImpl?: FetchLike;
  onInvalidEvent?: (index: number, reason: string) => void;
}
type FetchInit = Omit<RequestInit, "dispatcher"> & { dispatcher?: Agent };
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
/**
 *
 */
export class FamilienPlanApiClient {
  private readonly fetchImpl: FetchLike;
  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchLike);
  }
  async status(): Promise<StatusResponse> {
    return parseStatus(await this.request("status"));
  }
  async children(): Promise<Child[]> {
    return parseChildren(await this.request("children"));
  }
  async calendar(
    from: string,
    to: string,
    childId?: number,
  ): Promise<CalendarEvent[]> {
    const query = new URLSearchParams({ from_at: from, to_at: to });
    if (childId !== undefined) {
      query.set("child_id", String(childId));
    }
    return parseEvents(
      await this.request(`calendar?${query.toString()}`),
      this.options.onInvalidEvent,
    );
  }
  async location(childId: number, at?: string): Promise<LocationState> {
    return parseLocation(
      await this.request(
        `children/${encodeURIComponent(childId)}/location${at ? `?${new URLSearchParams({ at }).toString()}` : ""}`,
      ),
    );
  }
  private async request(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let dispatcher: Agent | undefined;
    try {
      const base = this.options.baseUrl.replace(/\/+$/, "");
      const init: FetchInit = {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      };
      if (!this.options.verifySsl) {
        dispatcher = new Agent({
          connect: { rejectUnauthorized: false },
        });
        init.dispatcher = dispatcher;
      }
      const response = await this.fetchImpl(
        `${base}/api/v1/integrations/v1/${path}`,
        init as unknown as RequestInit,
      );
      if (!response.ok) {
        throw this.httpError(response.status);
      }
      try {
        return await response.json();
      } catch {
        throw new ApiError("Die API lieferte ungültiges JSON.");
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError(
          "Zeitüberschreitung beim API-Aufruf.",
          undefined,
          true,
        );
      }
      throw new ApiError(
        this.sanitize(error instanceof Error ? error.message : String(error)),
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
      await dispatcher?.close();
    }
  }
  private httpError(status: number): ApiError {
    const messages: Record<number, string> = {
      401: "API-Schlüssel ungültig oder widerrufen.",
      403: "Die Person besitzt nicht die benötigte Berechtigung.",
      422: "Abfragezeitraum oder Parameter ungültig.",
      429: "Die API begrenzt derzeit Anfragen.",
    };
    return new ApiError(
      messages[status] ??
        (status >= 500
          ? "Temporärer FamilienPlan-Serverfehler."
          : `FamilienPlan antwortete mit HTTP ${status}.`),
      status,
      status === 429 || status >= 500,
    );
  }
  private sanitize(message: string): string {
    return message
      .replaceAll(this.options.apiKey, "***")
      .replace(/Bearer\s+\S+/gi, "Bearer ***");
  }
}
