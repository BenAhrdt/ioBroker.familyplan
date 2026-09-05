import * as utils from "@iobroker/adapter-core";
import { DateTime } from "luxon";
import { FamilienPlanApiClient, ApiError } from "./lib/api-client";
import {
  birthdayItem,
  completeEvent,
  dayKey,
  eventsForDay,
  findBirthdayForChild,
  isEventActive,
  nextOccurrences,
  nextLocationChange,
  occurrenceKey,
  parseChildIds,
  renderRelative,
  timelineText,
  uniqueOccurrences,
  wasteItem,
} from "./lib/aggregation";
import { eventFolder, normalizeId, stableSegments } from "./lib/ids";
import {
  catchUpWindowSeconds,
  dueTriggers,
  futureTriggers,
  ruleMatches,
  triggerIsActive,
} from "./lib/triggers";
import { parseEvents } from "./lib/validation";
import { wasteReminder } from "./lib/waste-reminder";
import {
  birthdayBirthDate,
  birthdaySummaryText,
  upcomingBirthdays,
} from "./lib/birthdays";
import type {
  AdapterConfigShape,
  CalendarEvent,
  Child,
  TriggerPayload,
} from "./lib/types";

type StateType = "string" | "number" | "boolean";
export class FamilienPlan extends utils.Adapter {
  private apiTimer?: ioBroker.Timeout;
  private clockTimer?: ioBroker.Timeout;
  private syncing = false;
  private evaluating = false;
  private processingTriggers = false;
  private stopped = false;
  private hasKnownDataset = false;
  private events: CalendarEvent[] = [];
  private childrenData: Child[] = [];
  private childBirthdayEvents: CalendarEvent[] = [];
  private responsibleNames = new Map<number, string>();
  private stayResponsibleNames = new Map<string, string>();
  private readonly writtenStates = new Map<
    string,
    string | number | boolean | null
  >();
  private triggerHistory?: Record<string, string>;
  private wasteReminderQueue: Promise<void> = Promise.resolve();
  private lastTriggerCheck?: DateTime;
  private lastTriggerCheckPersistedAt?: DateTime;
  private readonly triggerResets = new Set<string>();
  private readonly triggerCounts = new Map<string, number>();
  private readonly triggerLastTriggered = new Map<string, DateTime>();

  /**
   *
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "familyplan" });
    this.on("ready", () => void this.onReady());
    this.on("stateChange", (id, state) => void this.onStateChange(id, state));
    this.on("message", (obj) => void this.onMessage(obj));
    this.on("unload", (callback) => this.onUnload(callback));
  }
  private get cfg(): AdapterConfigShape {
    return this.config;
  }
  private async onReady(): Promise<void> {
    await this.setStateAsync("info.connection", false, true);
    await this.setStateAsync("control.refresh", false, true);
    await this.ensureState(
      "info.lastTriggerCheck",
      "Letzter Trigger-Prüflauf",
      "string",
      "date",
      false,
      "",
    );
    this.subscribeStates("control.refresh");
    this.subscribeStates("triggers.*.reset");
    this.subscribeStates("waste.reminder.reset");
    if (!this.cfg.baseUrl?.trim() || !this.cfg.apiKey?.trim()) {
      await this.cleanupNeverConfiguredObjects();
      await this.setStateAsync("info.lastError", "", true);
      await this.setStateAsync("info.nextSync", "", true);
      this.log.info(
        "Adapter ist noch nicht konfiguriert. Warte auf Basis-URL und API-Schlüssel.",
      );
      return;
    }
    if (!this.cfg.verifySsl) {
      this.log.warn(
        "SSL-Zertifikatsprüfung ist deaktiviert. Das ist unsicher.",
      );
    }
    await this.restoreKnownEvents();
    this.scheduleClock();
    await this.sync();
  }
  private onUnload(callback: () => void): void {
    this.stopped = true;
    if (this.apiTimer) {
      this.clearTimeout(this.apiTimer);
    }
    if (this.clockTimer) {
      this.clearTimeout(this.clockTimer);
    }
    callback();
  }
  private async onStateChange(
    id: string,
    state: ioBroker.State | null | undefined,
  ): Promise<void> {
    if (
      id === `${this.namespace}.waste.reminder.reset` &&
      state?.val === true &&
      !state.ack
    ) {
      await this.updateWasteReminder(this.events, DateTime.now(), true);
      return;
    }
    const resetPrefix = `${this.namespace}.triggers.`;
    if (
      id.startsWith(resetPrefix) &&
      id.endsWith(".reset") &&
      state?.val === true &&
      !state.ack
    ) {
      const root = id.slice(this.namespace.length + 1, -".reset".length);
      if (
        !root.slice("triggers.".length).includes(".") &&
        (await this.getObjectAsync(`${root}.reset`))
      ) {
        this.triggerResets.add(root);
        await this.setStateAsync(`${root}.reset`, false, true);
        await this.processTriggers(
          this.events,
          DateTime.now().setZone(this.cfg.timezone || "Europe/Berlin"),
        );
      }
      return;
    }
    if (
      id === `${this.namespace}.control.refresh` &&
      state &&
      !state.ack &&
      state.val === true
    ) {
      await this.sync();
      await this.setStateAsync("control.refresh", false, true);
    }
  }
  private async onMessage(obj: ioBroker.Message): Promise<void> {
    if (!obj.callback) {
      return;
    }
    if (obj.command === "testConnection") {
      try {
        const data = (obj.message ?? {}) as Partial<AdapterConfigShape>;
        const api = this.client(data);
        const zone = data.timezone || this.cfg.timezone || "Europe/Berlin";
        const now = DateTime.now().setZone(zone);
        const { from, to } = this.queryRange(now, data);
        const status = await this.apiCall(
          "API-Status",
          () => api.status(),
          false,
        );
        const children = await this.apiCall(
          "Kinderliste",
          () => api.children(),
          false,
        );
        const selected = this.selectedChildIds(data.childIds);
        if (selected.length) {
          for (const childId of selected) {
            await this.fetchCalendarRange(api, from, to, childId, false);
          }
        } else {
          try {
            await this.fetchCalendarRange(api, from, to, undefined, false);
          } catch (error) {
            if (!children.length) {
              throw error;
            }
            await this.fetchPermittedChildCalendars(
              api,
              children,
              from,
              to,
              false,
            );
          }
        }
        this.sendTo(
          obj.from,
          obj.command,
          {
            result: `Verbindung und API-Berechtigungen erfolgreich geprüft (API ${status.api_version}).`,
            message: `Verbunden (API ${status.api_version})`,
            status,
          },
          obj.callback,
        );
      } catch (error) {
        this.sendTo(
          obj.from,
          obj.command,
          {
            error: this.errorText(error),
          },
          obj.callback,
        );
      }
    } else if (obj.command === "refresh") {
      await this.sync();
      this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
    }
  }
  private client(
    overrides: Partial<AdapterConfigShape> = {},
  ): FamilienPlanApiClient {
    return new FamilienPlanApiClient({
      baseUrl: overrides.baseUrl ?? this.cfg.baseUrl,
      apiKey: overrides.apiKey ?? this.cfg.apiKey,
      timeoutMs: overrides.httpTimeout ?? this.cfg.httpTimeout,
      verifySsl: overrides.verifySsl ?? this.cfg.verifySsl,
      onInvalidEvent: (index, reason) =>
        this.log.warn(
          `Ungültiges Kalenderereignis an Position ${index} übersprungen: ${reason}`,
        ),
    });
  }
  private scheduleApi(): void {
    if (this.stopped) {
      return;
    }
    const minutes = Math.max(1, Number(this.cfg.pollInterval) || 15);
    const next = DateTime.now()
      .setZone(this.cfg.timezone || "Europe/Berlin")
      .plus({ minutes });
    void this.setStateAsync("info.nextSync", next.toISO(), true);
    this.apiTimer = this.setTimeout(() => void this.sync(), minutes * 60000);
  }
  private scheduleClock(): void {
    if (this.stopped) {
      return;
    }
    const delay = 1000 - (Date.now() % 1000) + 20;
    this.clockTimer = this.setTimeout(() => {
      void this.clockTick();
    }, delay);
  }
  private async clockTick(): Promise<void> {
    try {
      if (this.hasKnownDataset) {
        const now = DateTime.now().setZone(
          this.cfg.timezone || "Europe/Berlin",
        );
        if (this.syncing) {
          await this.processTriggers(this.events, now);
        } else if (now.second === 0) {
          await this.evaluateKnownEvents(now);
        } else if (!this.evaluating) {
          await this.processTriggers(this.events, now);
        }
      }
    } catch (error) {
      this.log.warn(
        `Lokale Termin-Auswertung fehlgeschlagen: ${this.errorText(error)}`,
      );
    } finally {
      this.scheduleClock();
    }
  }
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.log.debug("Synchronisierung läuft bereits.");
      return;
    }
    this.syncing = true;
    let fetchedDataset = false;
    if (this.apiTimer) {
      this.clearTimeout(this.apiTimer);
      this.apiTimer = undefined;
    }
    const now = DateTime.now().setZone(this.cfg.timezone || "Europe/Berlin");
    await this.setStateAsync("info.lastSync", now.toISO(), true);
    try {
      if (!this.cfg.baseUrl || !this.cfg.apiKey) {
        throw new ApiError(
          "Basis-URL und API-Schlüssel müssen konfiguriert werden.",
        );
      }
      const api = this.client();
      const { from, to } = this.queryRange(now, this.cfg);
      const status = await this.apiCall("API-Status", () => api.status());
      const children = status.scopes.includes("read:children")
        ? await this.apiCall("Kinderliste", () => api.children())
        : [];
      const selected = this.selectedChildIds(this.cfg.childIds);
      let events: CalendarEvent[];
      if (selected.length) {
        events = (
          await Promise.all(
            selected.map((id) => this.fetchCalendarRange(api, from, to, id)),
          )
        ).flat();
      } else {
        try {
          events = await this.fetchCalendarRange(api, from, to);
        } catch (error) {
          if (!children.length) {
            throw error;
          }
          this.log.info(
            "Gesamtkalender nicht verfügbar; lade automatisch alle freigegebenen Kinder einzeln.",
          );
          events = await this.fetchPermittedChildCalendars(
            api,
            children,
            from,
            to,
          );
        }
      }
      events = this.deduplicate(events);
      this.childBirthdayEvents = events.filter(
        (event) => event.event_type.toLocaleUpperCase() === "BIRTHDAY",
      );
      if (
        status.scopes.includes("read:birthdays") &&
        this.cfg.rangePeriod !== "year" &&
        children.some(
          (child) =>
            !this.childBirthDate(child) && !this.findChildBirthday(child),
        )
      ) {
        try {
          const birthdayTo = now.startOf("day").plus({ days: 365 });
          let yearly: CalendarEvent[];
          try {
            yearly = await this.fetchCalendarRange(
              api,
              now.startOf("day"),
              birthdayTo,
            );
          } catch (error) {
            if (!children.length) {
              throw error;
            }
            yearly = await this.fetchPermittedChildCalendars(
              api,
              children,
              now.startOf("day"),
              birthdayTo,
            );
          }
          this.childBirthdayEvents = this.deduplicate(yearly).filter(
            (event) => event.event_type.toLocaleUpperCase() === "BIRTHDAY",
          );
        } catch (error) {
          this.log.debug(
            `Geburtsdaten konnten nicht über den Jahreskalender ergänzt werden: ${this.errorText(error)}`,
          );
        }
      }
      this.events = events;
      this.hasKnownDataset = true;
      fetchedDataset = true;
      this.childrenData = children;
      await this.process(
        status.api_version,
        status.scopes,
        children,
        events,
        from,
        to,
        now,
        api,
      );
      await this.setStateAsync("info.connection", true, true);
      await this.setStateAsync("info.lastSuccessfulSync", now.toISO(), true);
      await this.setStateAsync("info.lastError", "", true);
    } catch (error) {
      await this.setStateAsync("info.connection", false, true);
      await this.setStateAsync("info.lastError", this.errorText(error), true);
      this.log.warn(this.errorText(error));
      if (this.hasKnownDataset && !fetchedDataset) {
        try {
          await this.evaluateKnownEvents();
        } catch (evaluationError) {
          this.log.warn(
            `Lokale Auswertung der gespeicherten Termine fehlgeschlagen: ${this.errorText(evaluationError)}`,
          );
        }
      }
    } finally {
      this.syncing = false;
      this.scheduleApi();
    }
  }
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (
      let attempt = 0;
      attempt <= Math.max(0, this.cfg.retryCount);
      attempt++
    ) {
      try {
        return await operation();
      } catch (error) {
        last = error;
        if (
          !(error instanceof ApiError && error.retryable) ||
          attempt >= this.cfg.retryCount
        ) {
          throw error;
        }
        await new Promise<void>((resolve) =>
          this.setTimeout(
            () => resolve(),
            Math.max(100, this.cfg.retryBackoff) * 2 ** attempt,
          ),
        );
      }
    }
    throw last;
  }
  private async apiCall<T>(
    context: string,
    operation: () => Promise<T>,
    retry = true,
  ): Promise<T> {
    try {
      return retry ? await this.withRetry(operation) : await operation();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : undefined;
      throw new ApiError(
        `${context} fehlgeschlagen: ${this.errorText(error)}`,
        apiError?.status,
        apiError?.retryable,
      );
    }
  }
  private queryRange(
    now: DateTime,
    config: Partial<AdapterConfigShape>,
  ): { from: DateTime; to: DateTime } {
    const configuredPast = Number(config.pastDays ?? this.cfg.pastDays);
    const configuredFuture = Number(config.futureDays ?? this.cfg.futureDays);
    const pastDays = Math.min(
      365,
      Math.max(0, Number.isFinite(configuredPast) ? configuredPast : 31),
    );
    const futureDays = Math.min(
      365,
      Math.max(0, Number.isFinite(configuredFuture) ? configuredFuture : 31),
    );
    const period = config.rangePeriod ?? this.cfg.rangePeriod ?? "year";
    let periodStart: DateTime;
    let periodEnd: DateTime;
    if (period === "week") {
      periodStart = now.startOf("week");
      periodEnd = periodStart.plus({ weeks: 1 });
    } else if (period === "month") {
      periodStart = now.startOf("month");
      periodEnd = periodStart.plus({ months: 1 });
    } else if (period === "quarter") {
      const firstMonth = Math.floor((now.month - 1) / 3) * 3 + 1;
      periodStart = now.set({ month: firstMonth, day: 1 }).startOf("day");
      periodEnd = periodStart.plus({ months: 3 });
    } else {
      periodStart = now.startOf("year");
      periodEnd = periodStart.plus({ years: 1 });
    }
    return {
      from: periodStart.minus({ days: pastDays }),
      to: periodEnd.plus({ days: futureDays }),
    };
  }
  private selectedChildIds(value: string | undefined): number[] {
    return parseChildIds(value);
  }
  private calendarContext(
    from: DateTime,
    to: DateTime,
    childId?: number,
  ): string {
    const range = `${from.toISODate()} bis ${to.minus({ milliseconds: 1 }).toISODate()}`;
    return `Kalender (${range}${childId === undefined ? "" : `, Kind-ID ${childId}`})`;
  }
  private async fetchCalendarRange(
    api: FamilienPlanApiClient,
    from: DateTime,
    to: DateTime,
    childId?: number,
    retry = true,
  ): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let chunkFrom = from;
    // The API rejects long ranges. Smaller chunks also leave enough margin for
    // DST and inclusive/exclusive boundary handling on the server.
    while (chunkFrom < to) {
      const proposedEnd = chunkFrom.plus({ days: 180 });
      const chunkTo = proposedEnd < to ? proposedEnd : to;
      events.push(
        ...(await this.apiCall(
          this.calendarContext(chunkFrom, chunkTo, childId),
          () => api.calendar(chunkFrom.toISO()!, chunkTo.toISO()!, childId),
          retry,
        )),
      );
      chunkFrom = chunkTo;
    }
    return this.deduplicate(events);
  }
  private async fetchPermittedChildCalendars(
    api: FamilienPlanApiClient,
    children: Child[],
    from: DateTime,
    to: DateTime,
    retry = true,
  ): Promise<CalendarEvent[]> {
    const result: CalendarEvent[] = [];
    let permitted = 0;
    for (const child of children) {
      try {
        result.push(
          ...(await this.fetchCalendarRange(api, from, to, child.id, retry)),
        );
        permitted++;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 403) {
          throw error;
        }
        this.log.debug(
          `Kind-ID ${child.id} wird übersprungen: keine Kalenderberechtigung.`,
        );
      }
    }
    if (!permitted) {
      throw new ApiError(
        "Für keines der aufgelisteten Kinder besteht eine Kalenderberechtigung.",
        403,
      );
    }
    return result;
  }
  private deduplicate(events: CalendarEvent[]): CalendarEvent[] {
    return uniqueOccurrences(events);
  }
  private async process(
    apiVersion: string,
    scopes: string[],
    children: Child[],
    events: CalendarEvent[],
    from: DateTime,
    to: DateTime,
    now: DateTime,
    api: FamilienPlanApiClient,
  ): Promise<void> {
    await Promise.all([
      this.setStateAsync("info.apiVersion", apiVersion, true),
      this.setStateAsync("info.scopes", JSON.stringify(scopes), true),
      this.setStateAsync("info.eventCount", events.length, true),
      this.setStateAsync(
        "info.queryRange",
        JSON.stringify({ from: from.toISO(), to: to.toISO() }),
        true,
      ),
      this.setStateAsync(
        "calendar.json",
        JSON.stringify(events.map(completeEvent)),
        true,
      ),
      this.setStateAsync("calendar.count", events.length, true),
      this.setStateAsync("calendar.lastUpdated", now.toISO(), true),
    ]);
    await this.writeChildren(children, api, now);
    await this.loadStayResponsibleNames(events, api);
    await this.writeFields("calendar", {
      displayJson: JSON.stringify(
        events.map((event) => this.displayEvent(event)),
      ),
    });
    // API and projection work above can take longer than the trigger catch-up
    // window. Use the actual evaluation time as the trigger-check boundary.
    await this.evaluateKnownEvents();
  }
  private async restoreKnownEvents(): Promise<void> {
    const successfulSync = await this.getStateAsync("info.lastSuccessfulSync");
    if (!String(successfulSync?.val || "").trim()) {
      return;
    }
    const state = await this.getStateAsync("calendar.json");
    if (typeof state?.val !== "string") {
      return;
    }
    try {
      const value: unknown = JSON.parse(state.val);
      if (!Array.isArray(value)) {
        return;
      }
      this.events = parseEvents(value, (index, reason) =>
        this.log.warn(
          `Ungültiges gespeichertes Kalenderereignis an Position ${index} übersprungen: ${reason}`,
        ),
      );
      this.hasKnownDataset = true;
      this.log.debug(
        `${this.events.length} bekannte Ereignisse wiederhergestellt.`,
      );
    } catch (error) {
      this.log.warn(
        `Gespeicherte Kalenderdaten konnten nicht gelesen werden: ${this.errorText(error)}`,
      );
    }
  }
  private async cleanupNeverConfiguredObjects(): Promise<void> {
    for (const root of [
      "events",
      "appointments",
      "children",
      "locations",
      "timeline",
      "birthdays",
      "waste",
      "triggers",
      "calendar.current",
    ]) {
      const prefix = `${this.namespace}.${root}`;
      const objects = await this.getObjectListAsync({
        startkey: prefix,
        endkey: `${prefix}\u9999`,
      });
      const ids = objects.rows
        .map((row) => row.id)
        .filter((id) => id === prefix || id.startsWith(`${prefix}.`))
        .sort((a, b) => b.length - a.length);
      for (const id of ids) {
        await this.delObjectAsync(id.slice(this.namespace.length + 1), {
          recursive: true,
        });
      }
    }
  }
  private async evaluateKnownEvents(now?: DateTime): Promise<void> {
    if (this.evaluating) {
      return;
    }
    this.evaluating = true;
    const current =
      now ?? DateTime.now().setZone(this.cfg.timezone || "Europe/Berlin");
    try {
      // Trigger evaluation must run before the comparatively expensive object
      // projections so a due pulse is not delayed by large calendars.
      await this.processTriggers(this.events, current);
      await this.writeChildrenFromEvents(this.childrenData, current);
      await this.writeEvents(this.events, current);
      await this.writeCurrentEvents(this.events, current);
      await this.writeTimeline(this.events, current);
      await this.writeBirthdays(this.events, current);
      await this.writeWaste(this.events, current);
      await this.cleanupOldItems(current);
    } finally {
      this.evaluating = false;
    }
  }
  private async writeChildren(
    children: Child[],
    api: FamilienPlanApiClient,
    now: DateTime,
  ): Promise<void> {
    this.responsibleNames.clear();
    const childSegments = stableSegments(children.map((child) => child.name));
    const childNameCounts = new Map<string, number>();
    for (const child of children) {
      const key = child.name.toLocaleLowerCase();
      childNameCounts.set(key, (childNameCounts.get(key) ?? 0) + 1);
    }
    const currentRoots = new Set<string>();
    for (const child of children) {
      const baseSegment = childSegments.get(child.name)!;
      const segment =
        (childNameCounts.get(child.name.toLocaleLowerCase()) ?? 0) > 1
          ? `${baseSegment}_${child.id}`
          : baseSegment;
      const root = `children.${segment}`;
      currentRoots.add(root);
      await this.deleteObjects([`children.child_${child.id}`]);
      await this.ensureFolder(root, child.name);
      await this.deleteObjects([
        `${root}.id`,
        `${root}.defaultResponsibleUserId`,
        `${root}.location.currentUntil`,
        `${root}.location.responsibleUserId`,
        `${root}.location.source`,
      ]);
      await this.writeChildDetails(child, root, now);
      if (this.cfg.fetchLocations) {
        try {
          const loc = await this.withRetry(() =>
            api.location(child.id, now.toISO()!),
          );
          const lr = `${root}.location`;
          await this.ensureFolder(lr, "Aktuelle Betreuung");
          if (loc.responsible_user_id != null && loc.responsible_name) {
            this.responsibleNames.set(
              loc.responsible_user_id,
              loc.responsible_name,
            );
          }
          const nextChangeAt = nextLocationChange(loc, now);
          const locationJson = {
            responsibleName: loc.responsible_name ?? "",
            nextChangeAt,
            lastUpdated: now.toISO()!,
          };
          await this.writeFields(lr, {
            responsibleName: loc.responsible_name ?? "",
            nextChangeAt,
            lastUpdated: now.toISO()!,
            json: JSON.stringify(locationJson),
          });
          let forecastAt = nextChangeAt;
          for (const [key, label] of [
            ["next", "Nächste Betreuung"],
            ["nextAfter", "Darauffolgende Betreuung"],
          ] as const) {
            let forecast:
              | Awaited<ReturnType<FamilienPlanApiClient["location"]>>
              | undefined;
            const effectiveAt = forecastAt;
            if (effectiveAt) {
              try {
                forecast = await this.withRetry(() =>
                  api.location(
                    child.id,
                    DateTime.fromISO(effectiveAt).plus({ seconds: 1 }).toISO()!,
                  ),
                );
              } catch (error) {
                this.log.debug(
                  `${label} für Kind ${child.id} konnte nicht geladen werden: ${this.errorText(error)}`,
                );
              }
            }
            await this.writeLocationForecast(
              `${lr}.${key}`,
              label,
              forecast,
              effectiveAt,
              now,
            );
            forecastAt = forecast
              ? nextLocationChange(forecast, DateTime.fromISO(effectiveAt))
              : "";
          }
        } catch (error) {
          this.log.warn(
            `Standort für Kind ${child.id} konnte nicht geladen werden: ${this.errorText(error)}`,
          );
        }
      }
    }
    for (const id of await this.folderIds("children")) {
      const remainder = id.slice("children.".length);
      if (!remainder.includes(".") && !currentRoots.has(id)) {
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }

  private childRoot(child: Child, children: Child[]): string {
    const segments = stableSegments(children.map((item) => item.name));
    const duplicates = children.filter(
      (item) =>
        item.name.toLocaleLowerCase() === child.name.toLocaleLowerCase(),
    ).length;
    const segment = segments.get(child.name)!;
    return `children.${duplicates > 1 ? `${segment}_${child.id}` : segment}`;
  }

  /** Refresh projections which can change from the cached calendar alone. */
  private async writeChildrenFromEvents(
    children: Child[],
    now: DateTime,
  ): Promise<void> {
    for (const child of children) {
      const root = this.childRoot(child, children);
      await this.writeChildDetails(child, root, now);

      if (!this.cfg.fetchLocations) {
        continue;
      }
      const stays = this.events
        .filter(
          (event) =>
            event.event_type.toLocaleUpperCase() === "STAY" &&
            event.child_id === child.id &&
            DateTime.fromISO(event.ends_at).toMillis() > now.toMillis(),
        )
        .sort(
          (a, b) =>
            DateTime.fromISO(a.starts_at).toMillis() -
            DateTime.fromISO(b.starts_at).toMillis(),
        );
      const active = stays.find((event) => isEventActive(event, now));
      if (!active) {
        continue;
      }
      const changes: CalendarEvent[] = [];
      let previousResponsibleId = active.responsible_user_id;
      for (const stay of stays) {
        if (DateTime.fromISO(stay.starts_at).toMillis() <= now.toMillis()) {
          continue;
        }
        if (stay.responsible_user_id !== previousResponsibleId) {
          changes.push(stay);
          previousResponsibleId = stay.responsible_user_id;
        }
      }
      const lr = `${root}.location`;
      const nextChangeAt = changes[0]?.starts_at ?? "";
      const current = {
        responsibleName: this.responsibleName(active),
        nextChangeAt,
        lastUpdated: now.toISO()!,
      };
      await this.writeFields(lr, { ...current, json: JSON.stringify(current) });
      for (const [index, key, label] of [
        [0, "next", "Nächste Betreuung"],
        [1, "nextAfter", "Darauffolgende Betreuung"],
      ] as const) {
        const stay = changes[index];
        await this.writeLocationForecast(
          `${lr}.${key}`,
          label,
          stay
            ? {
                child_id: child.id,
                at: stay.starts_at,
                responsible_user_id: stay.responsible_user_id ?? null,
                responsible_name: this.responsibleName(stay),
                source: stay.source ?? "calendar",
                current_until: stay.ends_at,
                next_change_at: changes[index + 1]?.starts_at ?? null,
              }
            : undefined,
          stay?.starts_at ?? "",
          now,
        );
      }
    }
  }
  private async writeEvents(
    events: CalendarEvent[],
    now: DateTime,
  ): Promise<void> {
    const segments = {
      eventTypes: stableSegments(events.map((event) => event.event_type)),
      customTypes: stableSegments(
        events
          .filter((event) => event.event_type.toUpperCase() === "OTHER")
          .map((event) =>
            typeof event.custom_type_label === "string"
              ? event.custom_type_label
              : "unknown",
          ),
      ),
    };
    const groups = new Map<string, CalendarEvent[]>([
      ["appointments", []],
      ["events.appointment", []],
    ]);
    for (const event of events) {
      const paths = [
        "appointments",
        "events.appointment",
        eventFolder(event, segments),
      ];
      if (event.event_type.toUpperCase() === "OTHER") {
        paths.unshift("events.appointment.other");
      }
      for (const path of new Set(paths)) {
        groups.set(path, [...(groups.get(path) || []), event]);
      }
    }
    for (const [root, list] of groups) {
      await this.ensureFolder(root, this.groupName(root));
      const [next, nextAfter] = nextOccurrences(list, now);
      const active = list.filter((event) => isEventActive(event, now));
      await this.writeFields(root, {
        json: JSON.stringify(list.map((event) => this.displayEvent(event))),
        count: list.length,
        active: active.length > 0,
        activeJson: JSON.stringify(
          active.map((event) => this.displayEvent(event)),
        ),
        activeCount: active.length,
        lastUpdated: now.toISO()!,
      });
      await this.writeOccurrence(`${root}.next`, "Nächster Termin", next, now);
      await this.writeOccurrence(
        `${root}.nextAfter`,
        "Darauffolgender Termin",
        nextAfter,
        now,
      );
      for (let month = 1; month <= 12; month++) {
        const monthRoot = `${root}.month.${String(month).padStart(2, "0")}`;
        const monthEvents = list.filter(
          (event) =>
            DateTime.fromISO(event.starts_at).setZone(this.cfg.timezone)
              .month === month,
        );
        await this.ensureFolder(monthRoot, this.monthName(month));
        await this.writeFields(monthRoot, {
          count: monthEvents.length,
          json: JSON.stringify(
            monthEvents.map((event) => this.displayEvent(event)),
          ),
        });
      }
    }
    await this.resetMissingEventObjects(new Set(groups.keys()));
  }
  private async writeLocationForecast(
    root: string,
    name: string,
    location:
      Awaited<ReturnType<FamilienPlanApiClient["location"]>> | undefined,
    effectiveAt: string,
    now: DateTime,
  ): Promise<void> {
    await this.ensureFolder(root, name);
    const data = {
      responsibleName: location?.responsible_name ?? "",
      effectiveAt: location ? effectiveAt : "",
      nextChangeAt: location
        ? nextLocationChange(location, DateTime.fromISO(effectiveAt))
        : "",
      lastUpdated: now.toISO()!,
    };
    await this.writeFields(root, {
      ...data,
      json: JSON.stringify(data),
    });
  }

  private async writeOccurrence(
    root: string,
    name: string,
    event: CalendarEvent | undefined,
    now: DateTime,
    includeChild = true,
  ): Promise<void> {
    await this.ensureFolder(root, name);
    await this.deleteObjects([
      `${root}.childId`,
      `${root}.eventType`,
      `${root}.found`,
      `${root}.responsibleName`,
      `${root}.type`,
      ...(!includeChild ? [`${root}.child`] : []),
    ]);
    const start = event
      ? DateTime.fromISO(event.starts_at).setZone(this.cfg.timezone)
      : undefined;
    const data: Record<string, string | number | boolean> = {
      title: event ? this.displayTitle(event) : "",
      start: event?.starts_at ?? "",
      end: event?.ends_at ?? "",
      date: start?.toFormat(this.cfg.dateFormat) ?? "",
      daysLeft: start
        ? Math.floor(start.startOf("day").diff(now.startOf("day"), "days").days)
        : 0,
      allDay: Boolean(event?.all_day),
      description: event ? (completeEvent(event).description ?? "") : "",
      note: event ? (completeEvent(event).description ?? "") : "",
      json: JSON.stringify(event ? this.displayEvent(event) : {}),
    };
    if (includeChild) {
      data.child = this.childName(event?.child_id);
    }
    if (event?.event_type === "STAY") {
      data.responsibleName = this.responsibleName(event);
    }
    await this.writeFields(root, data);
  }

  private monthName(month: number): string {
    return DateTime.local(2024, month, 1).setLocale("de").toFormat("LLLL");
  }
  private async writeCurrentEvents(
    events: CalendarEvent[],
    now: DateTime,
  ): Promise<void> {
    const active = events.filter((event) => isEventActive(event, now));
    const eventIds = active.map(occurrenceKey).sort();
    const root = "calendar.current";
    await this.ensureFolder(root, "Gerade aktive Ereignisse");
    const previousIds = String(
      (await this.getStateAsync(`${root}.eventIds`))?.val || "[]",
    );
    const nextIds = JSON.stringify(eventIds);
    const oldRevision = Number(
      (await this.getStateAsync(`${root}.revision`))?.val || 0,
    );
    await this.writeFields(root, {
      active: active.length > 0,
      count: active.length,
      eventIds: nextIds,
      json: JSON.stringify(active.map((event) => this.displayEvent(event))),
      revision: previousIds === nextIds ? oldRevision : oldRevision + 1,
      lastUpdated: now.toISO()!,
    });
  }
  private async writeTimeline(
    events: CalendarEvent[],
    now: DateTime,
  ): Promise<void> {
    const keep = new Set<string>();
    if (!this.cfg.timelineEnabled) {
      await this.prunePreviewFolders("timeline", keep);
      return;
    }
    const types = this.csv(this.cfg.timelineTypes);
    for (let day = 0; day < Math.max(1, this.cfg.timelineDays); day++) {
      const key = dayKey(now, day),
        root = `timeline.${key}`,
        date = now.plus({ days: day });
      keep.add(root);
      const entries = eventsForDay(events, date, this.cfg.timezone)
        .filter(
          (event) =>
            !types.size || types.has(event.event_type.toLocaleLowerCase()),
        )
        .map((event) => ({ ...event, ...this.displayEvent(event) }));
      await this.ensureFolder(
        root,
        day === 0 ? "Heute" : day === 1 ? "Morgen" : `In ${day} Tagen`,
      );
      await this.writeFields(root, {
        json: JSON.stringify(entries),
        text: timelineText(
          entries,
          this.cfg.timelineTemplate,
          this.cfg.timelineSeparator,
          this.cfg.timezone,
          this.cfg.timeFormat,
          this.cfg.dateFormat,
        ),
        count: entries.length,
        next: JSON.stringify(entries[0] ?? {}),
        lastUpdated: now.toISO()!,
      });
    }
    await this.prunePreviewFolders("timeline", keep);
  }
  private async writeBirthdays(
    events: CalendarEvent[],
    now: DateTime,
  ): Promise<void> {
    if (!this.cfg.birthdaysEnabled) {
      await this.prunePreviewFolders("birthdays", new Set());
      return;
    }
    const all = uniqueOccurrences(
      events.filter((event) => event.event_type === "BIRTHDAY"),
    );
    const [next, nextAfter] = nextOccurrences(all, now);
    await this.writeBirthdayOccurrence(
      "birthdays.next",
      "Nächster Geburtstag",
      next,
      now,
    );
    await this.writeBirthdayOccurrence(
      "birthdays.nextAfter",
      "Darauffolgender Geburtstag",
      nextAfter,
      now,
    );
    const significant = all.find((event) => {
      const age = Number(event.age ?? 0);
      return age === 18 || (age >= 20 && age % 10 === 0);
    });
    await this.writeBirthdayOccurrence(
      "birthdays.nextSignificant",
      "Nächster bedeutender Geburtstag",
      significant,
      now,
    );
    await this.ensureFolder(
      "birthdays.summary",
      "Zusammenfassung der Geburtstage",
    );
    const upcoming = upcomingBirthdays(
      [...all, ...this.childBirthdayEvents],
      now,
      this.cfg.timezone,
      this.cfg.birthdayDateFormat,
      this.childrenData,
    );
    const summary = upcoming.map(({ event, ...item }) => ({
      ...this.displayEvent(event),
      ...item,
    }));
    await this.writeFields("birthdays.summary", {
      count: summary.length,
      json: JSON.stringify(summary),
      daysUntil: upcoming[0]?.daysUntil ?? null,
      text: birthdaySummaryText(upcoming) || this.cfg.birthdayEmptyText || "",
      nextJson: JSON.stringify(
        summary.filter((item) => item.daysUntil === upcoming[0]?.daysUntil),
      ),
      jsonSignificant: JSON.stringify(
        summary.filter(
          ({ age }) =>
            age != null && (age === 18 || (age >= 20 && age % 10 === 0)),
        ),
      ),
    });
    for (let month = 1; month <= 12; month++) {
      const root = `birthdays.month.${String(month).padStart(2, "0")}`;
      const monthEvents = all.filter(
        (event) =>
          DateTime.fromISO(event.starts_at).setZone(this.cfg.timezone).month ===
          month,
      );
      await this.ensureFolder(root, this.monthName(month));
      await this.writeFields(root, {
        count: monthEvents.length,
        json: JSON.stringify(
          monthEvents.map((event) => ({
            ...birthdayItem(
              event,
              now,
              this.cfg.timezone,
              this.cfg.birthdayDateFormat,
              this.childrenData.find((child) => child.id === event.child_id)
                ?.birth_date,
            ),
            ...this.displayEvent(event),
          })),
        ),
      });
    }
  }

  private async writeBirthdayOccurrence(
    root: string,
    name: string,
    event: CalendarEvent | undefined,
    now: DateTime,
  ): Promise<void> {
    await this.writeOccurrence(root, name, event, now, false);
    const item = event
      ? birthdayItem(
          event,
          now,
          this.cfg.timezone,
          this.cfg.birthdayDateFormat,
          this.childrenData.find((child) => child.id === event.child_id)
            ?.birth_date,
        )
      : undefined;
    await this.writeFields(root, {
      name: item?.name ?? "",
      age: item?.age ?? null,
      birthDate: item?.birthDate ?? "",
      text: item
        ? item.age == null
          ? birthdaySummaryText([{ ...item, event: event! }])
          : renderRelative(
              [item as unknown as Record<string, unknown>],
              item.daysUntil,
              {
                today: this.cfg.birthdayTodayTemplate,
                tomorrow: this.cfg.birthdayTomorrowTemplate,
                future: this.cfg.birthdayFutureTemplate,
              },
              this.cfg.birthdaySeparator,
            )
        : this.cfg.birthdayEmptyText,
    });
  }
  private async writeWaste(
    events: CalendarEvent[],
    now: DateTime,
  ): Promise<void> {
    await this.updateWasteReminder(events, now);
    if (!this.cfg.wasteEnabled) {
      await this.prunePreviewFolders("waste", new Set());
      return;
    }
    const all = events.filter((event) => event.event_type === "WASTE");
    const mapped = all.map((event) => ({
      event,
      item: wasteItem(
        event,
        now,
        this.cfg.timezone,
        this.cfg.wasteMappings || [],
      ),
    }));
    const types = stableSegments(mapped.map(({ item }) => item.wasteType));
    const [next, nextAfter] = nextOccurrences(
      mapped.map(({ event }) => event),
      now,
    );
    await this.writeOccurrence(
      "waste.next",
      "Nächste Abholung",
      next,
      now,
      false,
    );
    await this.writeOccurrence(
      "waste.nextAfter",
      "Darauffolgende Abholung",
      nextAfter,
      now,
      false,
    );
    await this.writeFields("waste", {
      count: mapped.length,
      json: JSON.stringify(
        mapped.map(({ event, item }) => ({
          ...item,
          ...this.displayEvent(event),
        })),
      ),
    });
    const currentTypeRoots = new Set<string>();
    for (const wasteType of new Set(mapped.map(({ item }) => item.wasteType))) {
      const root = `waste.type.${types.get(wasteType)!}`;
      currentTypeRoots.add(root);
      const entries = mapped.filter(({ item }) => item.wasteType === wasteType);
      const [typeNext, typeNextAfter] = nextOccurrences(
        entries.map(({ event }) => event),
        now,
      );
      await this.ensureFolder(root, wasteType);
      await this.writeOccurrence(
        `${root}.next`,
        "Nächste Abholung",
        typeNext,
        now,
        false,
      );
      await this.writeOccurrence(
        `${root}.nextAfter`,
        "Darauffolgende Abholung",
        typeNextAfter,
        now,
        false,
      );
      await this.writeFields(root, {
        count: entries.length,
        json: JSON.stringify(
          entries.map(({ event, item }) => ({
            ...item,
            ...this.displayEvent(event),
          })),
        ),
      });
    }
    for (const id of await this.folderIds("waste.type")) {
      const remainder = id.slice("waste.type.".length);
      if (!remainder.includes(".") && !currentTypeRoots.has(id)) {
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }

  private async updateWasteReminder(
    events: CalendarEvent[],
    now: DateTime,
    reset = false,
  ): Promise<void> {
    const update = this.wasteReminderQueue.then(() =>
      this.writeWasteReminder(events, now, reset),
    );
    this.wasteReminderQueue = update.catch(() => undefined);
    await update;
  }

  private async writeWasteReminder(
    events: CalendarEvent[],
    now: DateTime,
    reset: boolean,
  ): Promise<void> {
    const root = "waste.reminder";
    if (!this.cfg.wasteEnabled || this.cfg.wasteReminderEnabled === false) {
      await this.deleteEventGroup(root);
      return;
    }
    await this.ensureFolder(root, "Abfall-Erinnerung");
    await this.ensureState(
      `${root}.reset`,
      "Erinnerung quittieren",
      "boolean",
      "button",
      true,
      false,
    );
    await this.ensureState(
      `${root}._acknowledgedDates`,
      "Quittierte Abholtage",
      "string",
      "json",
      false,
      "[]",
    );
    let acknowledgedDates: string[] = [];
    try {
      const stored: unknown = JSON.parse(
        String(
          (await this.getStateAsync(`${root}._acknowledgedDates`))?.val || "[]",
        ),
      );
      if (Array.isArray(stored)) {
        const today = now
          .setZone(this.cfg.timezone || "Europe/Berlin")
          .toISODate()!;
        acknowledgedDates = stored.filter(
          (date): date is string =>
            typeof date === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(date) &&
            date >= today,
        );
      }
    } catch {
      this.log.warn(
        "Gespeicherte Abfall-Quittierungen konnten nicht gelesen werden.",
      );
    }
    const reminder = wasteReminder(events, now, this.cfg, acknowledgedDates);
    // Only acknowledge the displayed active reminder, never a future preview.
    if (
      reset &&
      reminder?.active &&
      (await this.getStateAsync(`${root}.active`))?.val === true &&
      (await this.getStateAsync(`${root}.collectionDate`))?.val === reminder.key
    ) {
      acknowledgedDates.push(reminder.key);
      reminder.active = false;
      reminder.acknowledged = true;
    }
    await this.setStateAsync(
      `${root}._acknowledgedDates`,
      JSON.stringify(acknowledgedDates),
      true,
    );
    await this.setStateAsync(`${root}.reset`, false, true);
    await this.writeFields(root, {
      collectionDate: reminder?.key ?? "",
      date: reminder?.date.toFormat(this.cfg.dateFormat || "dd.MM.yyyy") ?? "",
      daysLeft: reminder?.daysLeft ?? 0,
      remindAt: reminder?.remindAt.toISO() ?? "",
      expiresAt: reminder?.expiresAt.toISO() ?? "",
      types: reminder?.types.join(", ") ?? "",
      count: reminder?.entries.length ?? 0,
      text: reminder?.text ?? this.cfg.wasteEmptyText ?? "",
      json: JSON.stringify(
        reminder?.entries.map((event) => ({
          ...wasteItem(
            event,
            now,
            this.cfg.timezone,
            this.cfg.wasteMappings || [],
          ),
          ...this.displayEvent(event),
        })) ?? [],
      ),
      acknowledged: reminder?.acknowledged ?? false,
      active: reminder?.active ?? false,
    });
  }

  private async resetMissingEventObjects(
    currentGroups: Set<string>,
  ): Promise<void> {
    const folders = await this.folderIds("events");
    for (const id of folders) {
      if (id === "events.school_event" || id === "events.stay") {
        // Migration from the former API-oriented top-level structure.
        await this.deleteEventGroup(id);
      } else if (id.includes(".items.")) {
        // Legacy volatile event-ID objects are replaced by stable projections.
        await this.deleteEventGroup(id);
      } else if (/\.(?:month|next|nextAfter)(?:\.|$)/.test(id)) {
        // These are stable projection folders, not event groups.
        continue;
      } else if (!currentGroups.has(id)) {
        // A category no longer returned by the API must not retain old events.
        await this.deleteEventGroup(id);
      }
    }
  }

  private async deleteEventGroup(id: string): Promise<void> {
    await this.delObjectAsync(id, { recursive: true });
    for (const key of this.writtenStates.keys()) {
      if (key === id || key.startsWith(`${id}.`)) {
        this.writtenStates.delete(key);
      }
    }
  }

  private async prunePreviewFolders(
    parent: "timeline" | "birthdays" | "waste",
    keep: Set<string>,
  ): Promise<void> {
    for (const id of await this.folderIds(parent)) {
      const remainder = id.slice(parent.length + 1);
      if (!remainder.includes(".") && !keep.has(id)) {
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }

  private async folderIds(parent: string): Promise<string[]> {
    const view = await this.getObjectViewAsync("system", "folder", {
      startkey: `${this.namespace}.${parent}.`,
      endkey: `${this.namespace}.${parent}.\u9999`,
    });
    return view.rows.map((row) => row.id.slice(this.namespace.length + 1));
  }
  private async processTriggers(
    events: CalendarEvent[],
    now: DateTime,
  ): Promise<void> {
    if (this.processingTriggers) {
      return;
    }
    this.processingTriggers = true;
    try {
      await this.processTriggersInternal(events, now);
    } finally {
      this.processingTriggers = false;
    }
  }
  private async processTriggersInternal(
    events: CalendarEvent[],
    now: DateTime,
  ): Promise<void> {
    await this.ensureFolder("triggers", "Trigger");
    await this.ensureState(
      "triggers.event",
      "Letztes allgemeines Triggerereignis",
      "string",
      "json",
      false,
      "{}",
    );
    if (!(await this.getStateAsync("triggers.event"))) {
      await this.setStateAsync("triggers.event", "{}", true);
    }
    const rules = (this.cfg.triggerRules || [])
      .map((rule) => {
        const legacy = rule as typeof rule & {
          id?: string;
          catchUpMinutes?: number;
        };
        return {
          ...rule,
          name: rule.name?.trim() || legacy.id?.trim() || "",
          childName: rule.childName?.trim() || undefined,
          responsibleName: rule.responsibleName?.trim() || undefined,
          catchUpSeconds:
            rule.catchUpSeconds !== undefined
              ? rule.catchUpSeconds
              : legacy.catchUpMinutes !== undefined
                ? legacy.catchUpMinutes * 60
                : 60,
        };
      })
      .filter((rule) => Boolean(rule.name));
    const triggerEvents = events.map((event) => this.displayEvent(event));
    const ruleSegments = stableSegments(rules.map((rule) => rule.name));
    const ruleRoot = (name: string): string =>
      `triggers.${ruleSegments.get(name) ?? normalizeId(name)}`;
    await this.ensureState(
      "triggers._history",
      "Interner Triggerverlauf",
      "string",
      "json",
      false,
      "{}",
    );
    if (!this.triggerHistory) {
      const historyState = await this.getStateAsync("triggers._history");
      try {
        this.triggerHistory = JSON.parse(String(historyState?.val || "{}"));
      } catch {
        this.triggerHistory = {};
      }
    }
    const history = this.triggerHistory!;
    if (!this.lastTriggerCheck) {
      const checkState = await this.getStateAsync("info.lastTriggerCheck");
      const parsedLast = DateTime.fromISO(String(checkState?.val || ""));
      this.lastTriggerCheck = parsedLast.isValid
        ? parsedLast
        : now.minus({
            seconds: Math.max(...rules.map(catchUpWindowSeconds), 60),
          });
    }
    const last = this.lastTriggerCheck;
    const fired = new Set(Object.keys(history));
    for (const item of dueTriggers(rules, triggerEvents, last, now, fired)) {
      const root = ruleRoot(item.rule.name);
      await this.ensureFolder(root, item.rule.name);
      let old = this.triggerCounts.get(root);
      if (old === undefined) {
        old = Number((await this.getStateAsync(`${root}.count`))?.val || 0);
      }
      const payload: TriggerPayload = {
        triggerId: item.rule.name,
        active: true,
        triggerType: item.rule.position,
        configuredOffset: item.rule.offset,
        configuredUnit: item.rule.unit,
        triggeredAt: now.toISO()!,
        updatedAt: now.toISO()!,
        scheduledFor: this.localIso(item.scheduled.toISO()!),
        event: this.displayEvent(item.event),
      };
      await this.writeFields(root, {
        event: JSON.stringify(payload),
        lastEventId:
          item.event.id == null
            ? occurrenceKey(item.event)
            : String(item.event.id),
        scheduledFor: this.localIso(item.scheduled.toISO()!),
        lastTriggered: now.toISO()!,
        count: old + 1,
        active: true,
      });
      await this.writeFields("triggers", { event: JSON.stringify(payload) });
      this.triggerCounts.set(root, old + 1);
      this.triggerLastTriggered.set(root, now);
      history[item.key] = now.toISO()!;
    }
    const currentRuleRoots = new Set<string>();
    for (const rule of rules) {
      const root = ruleRoot(rule.name);
      currentRuleRoots.add(root);
      await this.ensureFolder(root, rule.name);
      const initialStates: Array<
        [string, StateType, string, string | number | boolean]
      > = [
        ["enabled", "boolean", "indicator", false],
        ["event", "string", "json", "{}"],
        ["lastEventId", "string", "text", ""],
        ["scheduledFor", "string", "date", ""],
        ["nextScheduledFor", "string", "date", ""],
        ["matchedEventCount", "number", "value", 0],
        ["lastTriggered", "string", "date", ""],
        ["count", "number", "value", 0],
      ];
      for (const [key, type, role, defaultValue] of initialStates) {
        const id = `${root}.${key}`;
        await this.ensureState(
          id,
          this.stateName(key),
          type,
          role,
          false,
          defaultValue,
        );
        if (!(await this.getStateAsync(id))) {
          await this.setStateAsync(id, defaultValue, true);
        }
      }
      let lastTriggered = this.triggerLastTriggered.get(root);
      if (!lastTriggered) {
        lastTriggered = DateTime.fromISO(
          String(
            (await this.getStateAsync(`${root}.lastTriggered`))?.val || "",
          ),
        );
        this.triggerLastTriggered.set(root, lastTriggered);
      }
      const activeState = await this.getStateAsync(`${root}.active`);
      const active = triggerIsActive(
        rule,
        lastTriggered,
        now,
        activeState?.val === true,
        this.triggerResets.delete(root),
      );
      await this.ensureState(
        `${root}.reset`,
        "Trigger zurücksetzen",
        "boolean",
        "button",
        true,
        false,
      );
      if (!(await this.getStateAsync(`${root}.reset`))) {
        await this.setStateAsync(`${root}.reset`, false, true);
      }
      if (activeState?.val === true && !active) {
        const eventState = await this.getStateAsync(`${root}.event`);
        try {
          const previous = JSON.parse(
            String(eventState?.val || "{}"),
          ) as Partial<TriggerPayload>;
          if (previous.triggerId && previous.event) {
            const payload: TriggerPayload = {
              ...(previous as TriggerPayload),
              active: false,
              updatedAt: now.toISO()!,
            };
            await this.writeFields(root, { event: JSON.stringify(payload) });
            await this.writeFields("triggers", {
              event: JSON.stringify(payload),
            });
          }
        } catch {
          this.log.warn(
            `Letztes Triggerereignis für ${rule.name} konnte nicht gelesen werden.`,
          );
        }
      }
      await this.writeFields(root, { enabled: rule.enabled, active });
    }
    for (const oldRoot of await this.folderIds("triggers")) {
      if (
        !oldRoot.slice("triggers.".length).includes(".") &&
        !currentRuleRoots.has(oldRoot)
      ) {
        await this.deleteEventGroup(oldRoot);
        this.triggerCounts.delete(oldRoot);
        this.triggerLastTriggered.delete(oldRoot);
        this.triggerResets.delete(oldRoot);
      }
    }
    const cutoff = now.minus({
      days: Math.max(1, this.cfg.triggerHistoryDays),
    });
    for (const [key, date] of Object.entries(history)) {
      if (DateTime.fromISO(date) < cutoff) {
        delete history[key];
      }
    }
    const future = futureTriggers(rules, triggerEvents, now).map((item) => ({
      ...item,
      scheduledFor: this.localIso(item.scheduledFor),
    }));
    for (const rule of rules) {
      const root = ruleRoot(rule.name);
      const matches = triggerEvents.filter((event) => ruleMatches(rule, event));
      const nextForRule = future.find(
        (item) => item.ruleId === rule.name && !item.triggered,
      );
      await this.writeFields(root, {
        matchedEventCount: matches.length,
        nextScheduledFor: nextForRule?.scheduledFor ?? "",
      });
    }
    await this.writeStateIfChanged(
      "info.scheduledTriggerCount",
      future.filter((t) => !t.triggered).length,
    );
    await this.ensureState(
      "triggers.schedule",
      "Triggerplan",
      "string",
      "json",
      false,
      "[]",
    );
    await this.writeStateIfChanged("triggers.schedule", JSON.stringify(future));
    await this.writeStateIfChanged(
      "triggers._history",
      JSON.stringify(history),
    );
    if (
      !this.lastTriggerCheckPersistedAt ||
      now.diff(this.lastTriggerCheckPersistedAt, "seconds").seconds >= 60
    ) {
      await this.writeStateIfChanged("info.lastTriggerCheck", now.toISO());
      this.lastTriggerCheckPersistedAt = now;
    }
    this.lastTriggerCheck = now;
  }
  private async cleanupOldItems(now: DateTime): Promise<void> {
    try {
      const view = await this.getObjectViewAsync("system", "folder", {
        startkey: `${this.namespace}.events.`,
        endkey: `${this.namespace}.events.\u9999`,
      });
      const cutoff = now
        .minus({ days: Math.max(0, this.cfg.eventRetentionDays) })
        .toMillis();
      for (const row of view.rows) {
        if (!row.id.includes(".items.")) {
          continue;
        }
        const lastSeen = Number(
          (
            row.value?.native as
              | {
                  lastSeen?: number;
                }
              | undefined
          )?.lastSeen || 0,
        );
        if (lastSeen && lastSeen < cutoff) {
          await this.delObjectAsync(row.id.slice(this.namespace.length + 1), {
            recursive: true,
          });
        }
      }
    } catch (error) {
      this.log.debug(`Bereinigung übersprungen: ${this.errorText(error)}`);
    }
  }
  private async ensureFolder(
    id: string,
    name: string,
    native: Record<string, unknown> = {},
  ): Promise<void> {
    await this.extendObjectAsync(id, {
      type: "folder",
      common: { name },
      native,
    });
  }
  private childBirthDate(child: Child): string | undefined {
    const raw = child as Child & Record<string, unknown>;
    return [
      raw.birth_date,
      raw.birthDate,
      raw.date_of_birth,
      raw.dateOfBirth,
      raw.birthday,
    ].find(
      (value): value is string =>
        typeof value === "string" && DateTime.fromISO(value).isValid,
    );
  }
  private async writeChildDetails(
    child: Child,
    root: string,
    now: DateTime,
  ): Promise<void> {
    const zone = this.cfg.timezone || "Europe/Berlin";
    const sourceDate = this.childBirthDate(child);
    const birthday = this.findChildBirthday(child);
    const date = sourceDate
      ? DateTime.fromISO(sourceDate, { zone }).startOf("day")
      : birthday
        ? birthdayBirthDate(birthday, zone)
        : undefined;
    const birthDate = date?.isValid
      ? date.toFormat(this.cfg.birthdayDateFormat || "dd.MM.yyyy")
      : "";
    const age = date?.isValid
      ? Math.max(
          0,
          Math.floor(
            now.setZone(zone).startOf("day").diff(date, "years").years,
          ),
        )
      : (child.age ?? null);
    const raw = child as Child & Record<string, unknown>;
    let username =
      typeof raw.default_responsible_username === "string"
        ? raw.default_responsible_username.trim()
        : "";
    const responsibleId = child.default_responsible_user_id;
    if (!username && responsibleId != null) {
      username = this.responsibleNames.get(responsibleId) ?? "";
      if (!username) {
        const stay = this.events.find(
          (event) =>
            event.event_type === "STAY" &&
            event.responsible_user_id === responsibleId &&
            this.responsibleName(event),
        );
        if (stay) {
          username = this.responsibleName(stay);
        }
      }
    }
    const childJson: Record<string, unknown> = {
      ...child,
      name: child.name,
      birthDate,
      age,
      default_responsible_username: username,
    };
    delete childJson.default_responsible_user_id;
    await this.writeFields(root, {
      name: child.name,
      birthDate,
      age,
      json: JSON.stringify(childJson),
    });
  }
  private findChildBirthday(child: Child): CalendarEvent | undefined {
    return findBirthdayForChild(
      [...this.childBirthdayEvents, ...this.events],
      child,
    );
  }
  private childName(childId: number | null | undefined): string {
    if (childId == null) {
      return "";
    }
    return (
      this.childrenData.find((child) => child.id === childId)?.name ??
      `Unbekanntes Kind (${childId})`
    );
  }
  private responsibleName(event: CalendarEvent): string {
    const apiName =
      typeof event.responsible_name === "string"
        ? event.responsible_name.trim()
        : "";
    if (apiName) {
      return apiName;
    }
    const occurrenceName = this.stayResponsibleNames.get(occurrenceKey(event));
    if (occurrenceName) {
      return occurrenceName;
    }
    const responsibleId =
      typeof event.responsible_user_id === "number"
        ? event.responsible_user_id
        : undefined;
    if (responsibleId !== undefined) {
      const known = this.responsibleNames.get(responsibleId);
      if (known) {
        return known;
      }
    }
    return "";
  }
  private displayTitle(event: CalendarEvent): string {
    return event.title ?? "";
  }
  private displayEvent(event: CalendarEvent): CalendarEvent {
    const responsibleName =
      event.event_type === "STAY" ? this.responsibleName(event) : "";
    const displayed: CalendarEvent = {
      ...completeEvent(event),
      starts_at: this.localIso(event.starts_at),
      ends_at: this.localIso(event.ends_at),
      ...(event.child_id != null
        ? { child_name: event.child_name ?? this.childName(event.child_id) }
        : {}),
      ...(responsibleName ? { responsible_name: responsibleName } : {}),
    };
    return displayed;
  }
  private async loadStayResponsibleNames(
    events: CalendarEvent[],
    api: FamilienPlanApiClient,
  ): Promise<void> {
    this.stayResponsibleNames.clear();
    for (const event of events) {
      if (event.event_type !== "STAY" || event.child_id == null) {
        continue;
      }
      const responsibleId =
        typeof event.responsible_user_id === "number"
          ? event.responsible_user_id
          : undefined;
      if (
        responsibleId !== undefined &&
        this.responsibleNames.has(responsibleId)
      ) {
        continue;
      }
      try {
        const location = await this.withRetry(() =>
          api.location(event.child_id!, event.starts_at),
        );
        if (location.responsible_name) {
          this.stayResponsibleNames.set(
            occurrenceKey(event),
            location.responsible_name,
          );
          if (location.responsible_user_id != null) {
            this.responsibleNames.set(
              location.responsible_user_id,
              location.responsible_name,
            );
          }
        }
      } catch (error) {
        this.log.debug(
          `Betreuende Person für Aufenthalt ${event.id} konnte nicht aufgelöst werden: ${this.errorText(error)}`,
        );
      }
    }
  }
  private async deleteObjects(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (await this.getObjectAsync(id)) {
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }
  private async ensureState(
    id: string,
    name: string,
    type: StateType,
    role: string,
    write = false,
    def?: string | number | boolean,
  ): Promise<void> {
    const defaultValue =
      def ?? (type === "number" ? 0 : type === "boolean" ? false : "");
    await this.extendObjectAsync(id, {
      type: "state",
      common: { name, type, role, read: true, write, def: defaultValue },
      native: {},
    });
  }
  private async writeFields(
    root: string,
    data: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      const localizedValue = this.localizeDateState(key, value);
      const id = `${root}.${key}`;
      if (this.writtenStates.get(id) === localizedValue) {
        continue;
      }
      const type =
        localizedValue === null
          ? key === "age" || key === "daysUntil"
            ? "number"
            : "string"
          : (typeof localizedValue as StateType);
      const role =
        key === "json" ||
        key === "event" ||
        key === "next" ||
        key === "eventIds" ||
        key.endsWith("Json")
          ? "json"
          : key === "count" || key.endsWith("Count") || key === "revision"
            ? "value"
            : key === "active" || key === "allDay"
              ? "indicator"
              : "text";
      await this.ensureState(id, this.stateName(key), type, role);
      await this.writeStateIfChanged(id, localizedValue);
    }
  }
  private async writeStateIfChanged(
    id: string,
    value: string | number | boolean | null,
  ): Promise<void> {
    if (this.writtenStates.get(id) === value) {
      return;
    }
    await this.setStateAsync(id, value, true);
    this.writtenStates.set(id, value);
  }
  private localizeDateState(
    key: string,
    value: string | number | boolean | null,
  ): string | number | boolean | null {
    if (
      typeof value !== "string" ||
      ![
        "start",
        "end",
        "startsAt",
        "endsAt",
        "effectiveAt",
        "nextChangeAt",
        "currentUntil",
        "scheduledFor",
        "lastTriggered",
        "lastUpdated",
        "updatedAt",
      ].includes(key)
    ) {
      return value;
    }
    return this.localIso(value);
  }
  private localIso(value: string): string {
    const parsed = DateTime.fromISO(value, { setZone: true });
    return parsed.isValid
      ? (parsed.setZone(this.cfg.timezone || "Europe/Berlin").toISO() ?? value)
      : value;
  }
  private csv(value: string): Set<string> {
    return new Set(
      String(value || "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  private groupName(root: string): string {
    const key = root.split(".").at(-1)!;
    const names: Record<string, string> = {
      appointment: "Termine",
      appointments: "Alle Termine",
      general: "Allgemein",
      cleaning: "Reinigung",
      waste: "Abfall",
      other: "Sonstige",
      stay: "Aufenthalt / Betreuung",
      school_event: "Schulveranstaltungen",
      school_holiday: "Schulferien",
    };
    return names[key] ?? key.replaceAll("_", " ");
  }
  private stateName(key: string): string {
    const names: Record<string, string> = {
      id: "ID",
      name: "Name",
      title: "Titel",
      note: "Notiz",
      description: "Beschreibung",
      type: "Typ",
      eventType: "Terminart",
      customTypeLabel: "Eigene Terminart",
      child: "Kind",
      childId: "Kind-ID",
      start: "Beginn",
      end: "Ende",
      startsAt: "Beginn",
      endsAt: "Ende",
      date: "Datum formatiert",
      daysLeft: "Verbleibende Tage",
      daysUntil: "Verbleibende Tage",
      allDay: "Ganztägig",
      active: "Aktiv",
      acknowledged: "Quittiert",
      collectionDate: "Abholtag (ISO)",
      remindAt: "Erinnerungszeitpunkt",
      expiresAt: "Ablauf der Erinnerung",
      types: "Abfallarten",
      event: "Triggerereignis als JSON",
      enabled: "Regel aktiviert",
      count: "Anzahl",
      json: "Daten als JSON",
      jsonSignificant: "Bedeutende Geburtstage als JSON",
      displayJson: "Aufbereitete Kalenderdaten als JSON",
      activeJson: "Aktive Termine als JSON",
      activeCount: "Anzahl aktiver Termine",
      matchedEventCount: "Passende Termine",
      nextScheduledFor: "Nächste geplante Auslösung",
      lastUpdated: "Letzte Aktualisierung",
      updatedAt: "Aktualisiert am",
      birthDate: "Geburtsdatum",
      age: "Alter",
      text: "Text",
      defaultResponsibleUserId: "Standardmäßig betreuende Person (ID)",
      responsibleUserId: "Aktuell betreuende Person (ID)",
      responsibleName: "Aktuell betreuende Person",
      source: "Quelle",
      currentUntil: "Aktuell bis",
      effectiveAt: "Gültig ab",
      nextChangeAt: "Nächster Wechsel",
      revision: "Änderungszähler",
      eventIds: "Aktive Ereignis-IDs",
    };
    return names[key] ?? key;
  }
  private errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return this.cfg.apiKey
      ? text
          .replaceAll(this.cfg.apiKey, "***")
          .replace(/Bearer\s+\S+/gi, "Bearer ***")
      : text;
  }
}
if (require.main === module) {
  new FamilienPlan();
}
