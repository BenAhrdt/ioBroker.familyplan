/**
 *
 */
export interface StatusResponse {
  api_version: string;
  /**
   *
   */
  status: string;
  server_time: string;
  /**
   *
   */
  scopes: string[];
}

/**
 *
 */
export interface Child {
  /**
   *
   */
  id: number;
  name: string;
  default_responsible_user_id: number | null;
  birth_date?: string | null;
}

/**
 *
 */
export interface LocationState {
  /**
   *
   */
  child_id: number;
  at: string;
  responsible_user_id: number | null;
  responsible_name: string | null;
  source: string;
  /**
   *
   */
  current_until: string | null;
  next_change_at: string | null;
}

/**
 *
 */
export interface BaseCalendarEvent {
  event_type: string;
  /**
   *
   */
  id: string | number | null;
  /**
   *
   */
  title: string | null;
  starts_at: string;
  /**
   *
   */
  ends_at: string;
  child_id?: number | null;
  [key: string]: unknown;
}
export interface CalendarEvent extends BaseCalendarEvent {
  note?: string | null;
  custom_type_label?: string | null;
  all_day?: boolean;
  responsible_user_id?: number | null;
  age?: number | null;
  birth_date?: string | null;
  source?: string;
  generated?: boolean;
  child_name?: string;
}

export type TriggerPosition =
  "beforeStart" | "afterStart" | "beforeEnd" | "afterEnd";
export type TriggerUnit = "seconds" | "minutes" | "hours" | "days";
/**
 *
 */
export interface TriggerRule {
  name: string;
  enabled: boolean;
  /**
   *
   */
  eventType?: string;
  /**
   *
   */
  customTypeLabel?: string;
  childName?: string;
  /**
   *
   */
  position: TriggerPosition;
  offset: number;
  unit: TriggerUnit;
  /**
   *
   */
  catchUpSeconds?: number;
}
/**
 *
 */
export interface TriggerPayload {
  triggerId: string;
  active: boolean;
  /**
   *
   */
  triggerType: TriggerPosition;
  configuredOffset: number;
  /**
   *
   */
  configuredUnit: TriggerUnit;
  triggeredAt: string;
  updatedAt: string;
  scheduledFor: string;
  /**
   *
   */
  event: CalendarEvent;
}
export type TimelineEntry = CalendarEvent & {
  startsThisDay: boolean;
  endsThisDay: boolean;
  continuesThisDay: boolean;
};
/**
 *
 */
export interface BirthdayAggregation {
  id: string | number | null;
  name: string;
  birthDate: string;
  date: string;
  age: number;
  daysUntil: number;
}
/**
 *
 */
export interface WasteAggregation {
  id: string | number | null;
  title: string;
  wasteType: string;
  date: string;
  daysUntil: number;
  startsAt: string;
}

/**
 *
 */
export interface AdapterConfigShape {
  baseUrl: string;
  apiKey: string;
  timezone: string;
  httpTimeout: number;
  /**
   *
   */
  verifySsl: boolean;
  pastDays: number;
  futureDays: number;
  rangePeriod: "week" | "month" | "quarter" | "year";
  pollInterval: number;
  retryCount: number;
  /**
   *
   */
  retryBackoff: number;
  childIds: string;
  fetchLocations: boolean;
  /**
   *
   */
  eventRetentionDays: number;
  timelineEnabled: boolean;
  timelineDays: number;
  timelineTypes: string;
  timelineTemplate: string;
  /**
   *
   */
  timelineSeparator: string;
  timeFormat: string;
  dateFormat: string;
  birthdaysEnabled: boolean;
  /**
   *
   */
  birthdayTodayTemplate: string;
  birthdayTomorrowTemplate: string;
  /**
   *
   */
  birthdayFutureTemplate: string;
  birthdaySeparator: string;
  birthdayDateFormat: string;
  /**
   *
   */
  birthdayEmptyText: string;
  wasteEnabled: boolean;
  wasteTodayTemplate: string;
  /**
   *
   */
  wasteTomorrowTemplate: string;
  wasteFutureTemplate: string;
  wasteSeparator: string;
  wasteMappings: Array<{
    /**
     *
     */
    match: string;
    /**
     *
     */
    name: string;
  }>;
  /**
   *
   */
  wasteEmptyText: string;
  triggerRules: TriggerRule[];
  /**
   *
   */
  triggerHistoryDays: number;
}
