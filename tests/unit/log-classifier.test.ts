import { describe, expect, test } from "bun:test";
import { classifyLogRecord } from "../../src/logs/classifier.js";

describe("classifyLogRecord", () => {
  test("classifies Android, native, ANR, and React Native fatal markers", () => {
    expect(classifyLogRecord(undefined, "FATAL EXCEPTION: main", "application")?.code).toBe(
      "ANDROID_FATAL_EXCEPTION",
    );
    expect(classifyLogRecord(undefined, "ANR in com.example.demo", "application")?.code).toBe(
      "ANDROID_ANR",
    );
    expect(classifyLogRecord(undefined, "Fatal signal 11 (SIGSEGV)", "process")?.code).toBe(
      "ANDROID_NATIVE_CRASH",
    );
    expect(
      classifyLogRecord(
        {
          timestamp: "09-10 10:00:00.000",
          pid: 1,
          tid: 2,
          priority: "E",
          tag: "ReactNativeJS",
          message: "TypeError: undefined is not a function",
          raw: "fixture",
        },
        "fixture",
        "application",
      )?.code,
    ).toBe("REACT_NATIVE_FATAL");
  });

  test("does not promote ordinary error-priority application logs", () => {
    expect(
      classifyLogRecord(
        {
          timestamp: "09-10 10:00:00.000",
          pid: 1,
          tid: 2,
          priority: "E",
          tag: "DemoTag",
          message: "request failed but retrying",
          raw: "fixture",
        },
        "fixture",
        "device",
      ),
    ).toBeUndefined();
  });

  test("keeps the verified attribution in every finding", () => {
    expect(classifyLogRecord(undefined, "FATAL EXCEPTION: main", "unattributed")).toMatchObject({
      attribution: "unattributed",
      summary: expect.stringContaining("unattributed device process"),
    });
    expect(classifyLogRecord(undefined, "FATAL EXCEPTION: main", "application")).toMatchObject({
      attribution: "application",
      summary: expect.stringContaining("selected application"),
    });
  });
});
