import { describe, expect, test } from "bun:test";
import {
  parseForegroundActivity,
  parsePackageInfo,
  parsePackageList,
  parseResolvedActivity,
} from "../../src/app/android-app.js";

describe("Android app parsers", () => {
  test("parses bounded package rows with optional source paths", () => {
    expect(
      parsePackageList(
        "package:/data/app/example/base.apk=com.example.app\npackage:com.android.settings\npackage:invalid\n",
      ),
    ).toEqual([
      { name: "com.android.settings" },
      { name: "com.example.app", sourcePath: "/data/app/example/base.apk" },
    ]);
  });

  test("parses launch and foreground components", () => {
    expect(parseResolvedActivity("priority=0\ncom.example.app/.MainActivity\n")).toEqual({
      applicationId: "com.example.app",
      activity: ".MainActivity",
    });
    expect(
      parseForegroundActivity(
        "mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity t12}",
      ),
    ).toEqual({ applicationId: "com.example.app", activity: ".MainActivity" });
  });

  test("parses stable package metadata and debuggable state", () => {
    expect(
      parsePackageInfo(
        "com.example.app",
        "Package [com.example.app]\n codePath=/data/app/example\n versionCode=42 minSdk=24 targetSdk=36\n versionName=1.2.3\n pkgFlags=[ DEBUGGABLE HAS_CODE ]\n firstInstallTime=2026-09-01 10:00:00\n lastUpdateTime=2026-09-10 09:00:00\n",
      ),
    ).toEqual({
      applicationId: "com.example.app",
      installed: true,
      sourcePath: "/data/app/example",
      versionName: "1.2.3",
      versionCode: 42,
      minSdk: 24,
      targetSdk: 36,
      debuggable: true,
      firstInstallTime: "2026-09-01 10:00:00",
      lastUpdateTime: "2026-09-10 09:00:00",
    });
  });
});
