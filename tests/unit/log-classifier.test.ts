import { describe, expect, test } from "bun:test";
import { classifyLogRecord } from "../../src/logs/classifier.js";

describe("classifyLogRecord", () => {
  test("classifies Android, native, ANR, and React Native fatal markers", () => {
    expect(classifyLogRecord(undefined, "FATAL EXCEPTION: main")?.code).toBe(
      "ANDROID_FATAL_EXCEPTION",
    );
    expect(classifyLogRecord(undefined, "ANR in com.example.demo")?.code).toBe("ANDROID_ANR");
    expect(classifyLogRecord(undefined, "Fatal signal 11 (SIGSEGV)")?.code).toBe(
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
      ),
    ).toBeUndefined();
  });
});
