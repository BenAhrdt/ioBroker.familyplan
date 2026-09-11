"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FamilienPlanApiClient = exports.ApiError = void 0;
const timetable_1 = require("./timetable");
const undici_1 = require("undici");
const validation_1 = require("./validation");
/**
 *
 */
class ApiError extends Error {
    status;
    retryable;
    /**
     *
     */
    constructor(message, status, retryable = false) {
        super(message);
        this.status = status;
        this.retryable = retryable;
    }
}
exports.ApiError = ApiError;
/**
 *
 */
class FamilienPlanApiClient {
    options;
    fetchImpl;
    controllers = new Set();
    closed = false;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? undici_1.fetch;
    }
    async status() {
        return (0, validation_1.parseStatus)(await this.request("status"));
    }
    async children() {
        return (0, validation_1.parseChildren)(await this.request("children"));
    }
    async calendar(from, to, childId) {
        const query = new URLSearchParams({ from_at: from, to_at: to });
        if (childId !== undefined) {
            query.set("child_id", String(childId));
        }
        return (0, validation_1.parseEvents)(await this.request(`calendar?${query.toString()}`), this.options.onInvalidEvent);
    }
    async location(childId, at) {
        return (0, validation_1.parseLocation)(await this.request(`children/${encodeURIComponent(childId)}/location${at ? `?${new URLSearchParams({ at }).toString()}` : ""}`));
    }
    async timetable(childId) {
        const data = (0, timetable_1.parseTimetable)(await this.request(`children/${encodeURIComponent(childId)}/timetable`));
        if (data.childId !== childId) {
            throw new ApiError("Stundenplan-Antwort gehört zu einem anderen Kind.");
        }
        return data;
    }
    close() {
        this.closed = true;
        for (const controller of this.controllers) {
            controller.abort();
        }
    }
    async request(path) {
        if (this.closed) {
            throw new ApiError("API-Client wurde beendet.");
        }
        const controller = new AbortController();
        this.controllers.add(controller);
        const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(this.options.timeoutMs),
        ]);
        let dispatcher;
        try {
            const base = this.options.baseUrl
                .replace(/\/+$/, "")
                .replace(/\/api\/v1(?:\/integrations(?:\/v1)?)?$/, "");
            const init = {
                headers: {
                    Authorization: `Bearer ${this.options.apiKey}`,
                    Accept: "application/json",
                },
                signal,
            };
            if (!this.options.verifySsl) {
                dispatcher = new undici_1.Agent({
                    connect: { rejectUnauthorized: false },
                });
                init.dispatcher = dispatcher;
            }
            const response = await this.fetchImpl(`${base}/api/v1/integrations/v1/${path}`, init);
            if (!response.ok) {
                throw this.httpError(response.status);
            }
            try {
                return await response.json();
            }
            catch {
                throw new ApiError("Die API lieferte ungültiges JSON.");
            }
        }
        catch (error) {
            if (error instanceof ApiError) {
                throw error;
            }
            if (error instanceof Error &&
                (error.name === "AbortError" || error.name === "TimeoutError")) {
                throw new ApiError("Zeitüberschreitung beim API-Aufruf.", undefined, true);
            }
            throw new ApiError(this.sanitize(error instanceof Error ? error.message : String(error)), undefined, true);
        }
        finally {
            this.controllers.delete(controller);
            await dispatcher?.close();
        }
    }
    httpError(status) {
        const messages = {
            401: "API-Schlüssel ungültig oder widerrufen.",
            403: "Die Person besitzt nicht die benötigte Berechtigung.",
            422: "Abfragezeitraum oder Parameter ungültig.",
            429: "Die API begrenzt derzeit Anfragen.",
        };
        return new ApiError(messages[status] ??
            (status >= 500
                ? "Temporärer FamilienPlan-Serverfehler."
                : `FamilienPlan antwortete mit HTTP ${status}.`), status, status === 429 || status >= 500);
    }
    sanitize(message) {
        return message
            .replaceAll(this.options.apiKey, "***")
            .replace(/Bearer\s+\S+/gi, "Bearer ***");
    }
}
exports.FamilienPlanApiClient = FamilienPlanApiClient;
//# sourceMappingURL=api-client.js.map