import type { LogcatThreadtimeLine } from "../adb/parsers.js";

export type LogFindingCode =
  | "ANDROID_ANR"
  | "ANDROID_FATAL_EXCEPTION"
  | "ANDROID_NATIVE_CRASH"
  | "REACT_NATIVE_FATAL";

export interface LogFinding {
  code: LogFindingCode;
  summary: string;
  detail: string;
}

const FATAL_EXCEPTION = /\bFATAL EXCEPTION\b/iu;
const ANR = /(?:\bANR in\b|\bApplication Not Responding\b)/iu;
const NATIVE_CRASH = /(?:\bFatal signal \d+\b|\bbacktrace:\s*$|\btombstone\b)/iu;
const REACT_NATIVE_FATAL =
  /(?:\bUnhandled (?:JS )?Exception\b|\bUnhandled Promise Rejection\b|\bInvariant Violation\b)/iu;

export function classifyLogRecord(
  record: LogcatThreadtimeLine | undefined,
  raw: string,
): LogFinding | undefined {
  const message = record?.message ?? raw;
  if (ANR.test(message)) {
    return {
      code: "ANDROID_ANR",
      summary: "Android reported an application-not-responding event.",
      detail:
        "Inspect the surrounding main/system log timeline for the blocked component and process.",
    };
  }
  if (
    FATAL_EXCEPTION.test(message) ||
    (record?.tag === "AndroidRuntime" && record.priority === "F")
  ) {
    return {
      code: "ANDROID_FATAL_EXCEPTION",
      summary: "Android reported a fatal application exception.",
      detail: "Inspect the following stack frames in the saved session or exported AI context.",
    };
  }
  if (NATIVE_CRASH.test(message) || (record?.tag === "DEBUG" && record.priority === "F")) {
    return {
      code: "ANDROID_NATIVE_CRASH",
      summary: "Android reported a native application crash.",
      detail: "Inspect the crash buffer and adjacent tombstone or backtrace records.",
    };
  }
  if (
    (record?.tag === "ReactNativeJS" || record?.tag === "ReactNative") &&
    (record.priority === "E" || record.priority === "F" || REACT_NATIVE_FATAL.test(message))
  ) {
    return {
      code: "REACT_NATIVE_FATAL",
      summary: "React Native reported an application error.",
      detail: "Inspect the surrounding JavaScript error and component stack in the saved session.",
    };
  }
  return undefined;
}
